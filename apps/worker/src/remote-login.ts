import { randomUUID } from 'node:crypto';

export const loginWidth = 1280;
export const loginHeight = 800;
export type LoginStatus = 'idle' | 'pending' | 'active' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
export interface LoginState { id: string; status: LoginStatus; expires_at: string; width: number; height: number; error?: string }
export type LoginInput = { type: 'fill'; field: 'phone' | 'code'; text: string } | { type: 'click'; x: number; y: number } | { type: 'text'; text: string } | { type: 'key'; key: string } | { type: 'drag'; points: { x: number; y: number }[] } | { type: 'scroll'; deltaY: number };
export interface LoginBrowser { frame(): Promise<Buffer>; input(value: LoginInput): Promise<void>; connected(): Promise<'pending' | 'connected' | 'wrong'>; close(): Promise<void> }
export class LoginError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
const keys = new Set(['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape', 'Space']);
const coordinate = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < limit;
export function validateLoginInput(value: unknown): LoginInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LoginError(400, '登录操作格式无效');
  const input = value as Record<string, unknown>;
  const point = (value: unknown): boolean => !!value && typeof value === 'object' && coordinate((value as Record<string, unknown>).x, loginWidth) && coordinate((value as Record<string, unknown>).y, loginHeight);
  if (input.type === 'fill' && Object.keys(input).length === 3 && typeof input.text === 'string' && ((input.field === 'phone' && /^[0-9]{5,20}$/.test(input.text)) || (input.field === 'code' && /^[0-9]{4,8}$/.test(input.text)))) return structuredClone(input) as LoginInput;
  if ((input.type === 'click' && point(input)) || (input.type === 'text' && typeof input.text === 'string' && input.text.length > 0 && [...input.text].length <= 2000 && !/[\u0000-\u001f\u007f]/.test(input.text)) || (input.type === 'key' && typeof input.key === 'string' && keys.has(input.key)) || (input.type === 'drag' && Array.isArray(input.points) && input.points.length >= 2 && input.points.length <= 128 && input.points.every(point)) || (input.type === 'scroll' && typeof input.deltaY === 'number' && Number.isFinite(input.deltaY) && input.deltaY !== 0 && Math.abs(input.deltaY) <= 1600)) return structuredClone(input) as LoginInput;
  throw new LoginError(400, '登录操作超出允许范围');
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true }); });
}
export class RemoteLoginManager {
  private state: LoginState = { id: '', status: 'idle', expires_at: '', width: loginWidth, height: loginHeight };
  private browser?: LoginBrowser;
  private controller?: AbortController;
  private running?: Promise<void>;
  private closing?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private disabled = false;
  private expires = 0;
  private seen = 0;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly idle: number;
  private readonly poll: number;
  constructor(private readonly open: (signal: AbortSignal) => Promise<LoginBrowser>, options: { now?: () => number; ttlMs?: number; idleMs?: number; pollMs?: number } = {}) { this.now = options.now ?? Date.now; this.ttl = options.ttlMs ?? 600000; this.idle = options.idleMs ?? 60000; this.poll = options.pollMs ?? 250; }
  status(): LoginState { this.expire(); return { ...this.state }; }
  create(): LoginState {
    this.expire();
    if (this.disabled || this.running || ['pending', 'active'].includes(this.state.status)) throw new LoginError(409, '已有登录会话或执行器正在关闭');
    this.expires = this.now() + this.ttl; this.seen = this.now(); this.closing = undefined;
    this.state = { id: randomUUID(), status: 'pending', expires_at: new Date(this.expires).toISOString(), width: loginWidth, height: loginHeight };
    return this.status();
  }
  pending(): boolean { return this.status().status === 'pending'; }
  cancel(id: string): LoginState { this.id(id); this.finish('cancelled'); return this.status(); }
  private id(id: string): void { if (!id || id !== this.state.id) throw new LoginError(404, '登录会话不存在'); }
  private expire(): void { if (['pending', 'active'].includes(this.state.status) && (this.now() >= this.expires || (this.state.status === 'active' && this.now() - this.seen >= this.idle))) this.finish('expired'); }
  private finish(status: LoginStatus, error?: string): void {
    if (!['pending', 'active'].includes(this.state.status)) return;
    this.state = { ...this.state, status, ...(error ? { error } : {}) }; this.controller?.abort();
    void this.closeBrowser().catch(() => {});
  }
  private closeBrowser(): Promise<void> { if (!this.browser) return Promise.resolve(); return this.closing ??= this.browser.close(); }
  private operation<T>(id: string, action: (browser: LoginBrowser) => Promise<T>, touch: boolean): Promise<T> {
    try { this.id(id); this.expire(); if (this.state.status !== 'active' || !this.browser || this.disabled) throw new LoginError(409, '登录画面尚未就绪或会话已结束'); if (this.queued >= 4) throw new LoginError(429, '登录操作过于频繁'); } catch (error) { return Promise.reject(error); }
    this.queued++; if (touch) this.seen = this.now();
    const operation = this.tail.then(async () => {
      this.id(id); this.expire(); if (this.state.status !== 'active' || !this.browser || this.disabled) throw new LoginError(409, '登录会话已结束');
      return action(this.browser);
    }).finally(() => { this.queued--; });
    this.tail = operation.catch(() => {}); return operation;
  }
  frame(id: string): Promise<Buffer> { return this.operation(id, async browser => { const frame = await browser.frame(); if (frame.length > 2097152) throw new LoginError(502, '登录画面暂不可用'); return frame; }, true); }
  input(id: string, value: unknown): Promise<void> { let input: LoginInput; try { input = validateLoginInput(value); } catch (error) { return Promise.reject(error); } return this.operation(id, browser => browser.input(input), true); }
  run(signal: AbortSignal): Promise<void> {
    if (this.running) return this.running;
    if (!this.pending() || this.disabled) return Promise.resolve();
    const running = this.perform(signal); this.running = running;
    return running.finally(() => { if (this.running === running) this.running = undefined; });
  }
  private async perform(signal: AbortSignal): Promise<void> {
    this.controller = new AbortController(); const controller = this.controller;
    const abort = () => this.finish('cancelled'); signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) { abort(); return; }
      this.browser = await this.open(controller.signal);
      if (controller.signal.aborted) return;
      this.state = { ...this.state, status: 'active' }; this.seen = this.now();
      while (!controller.signal.aborted) {
        this.expire(); if (controller.signal.aborted) break;
        const matched = await this.operation(this.state.id, browser => browser.connected(), false);
        if (matched === 'connected') { this.finish('succeeded'); break; }
        if (matched === 'wrong') { this.finish('failed', '登录账号与配置不符'); break; }
        await pause(this.poll, controller.signal);
      }
    } catch { this.finish('failed', '登录浏览器暂不可用，请重新发起登录'); }
    finally { signal.removeEventListener('abort', abort); await this.closeBrowser().catch(() => {}); await this.tail; this.browser = undefined; }
  }
  async close(): Promise<void> { this.disabled = true; this.finish('cancelled'); await this.closeBrowser().catch(() => {}); await this.running; await this.tail; }
}
