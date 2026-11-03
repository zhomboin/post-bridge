import type { BrowserContext, Page, Response } from 'playwright';
import { safeRequestURL, validContent } from './config.js';
import type { Hooks, Job, JobResult, Progress } from './types.js';

interface Identity { username: string; displayName?: string; timeoutMs?: number }
interface Snapshot { id?: string; title: string; markdown: string; status: unknown }
interface FixtureSite { origin: string; accountPath: string; editorPath: string }
class CheckpointFailure extends Error {}
class AdapterFailure extends Error { constructor(readonly code: string) { super(code); } }
const numericID = (value: unknown): string | undefined => typeof value === 'string' || typeof value === 'number' ? /^\d{1,30}$/.test(String(value)) ? String(value) : undefined : undefined;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class CSDNAdapter {
  private readonly site: FixtureSite;
  private readonly timeout: number;
  private readonly fixture: boolean;
  constructor(private readonly context: BrowserContext, private readonly identity: Identity, fixtureSite?: FixtureSite) {
    if (fixtureSite && (process.env.NODE_ENV !== 'test' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureSite.origin))) throw new Error('模拟站点仅限测试回环地址');
    this.fixture = !!fixtureSite;
    this.site = fixtureSite ?? { origin: 'https://editor.csdn.net', accountPath: 'https://mp.csdn.net/', editorPath: '/md/?not_checkout=1' };
    this.timeout = identity.timeoutMs ?? 20000;
  }
  private allowed(url: string): boolean { return safeRequestURL(url) || (this.fixture && new URL(url).origin === this.site.origin); }
  private readOnlyRequest(url: string, method: string): boolean {
    if (method === 'GET' || method === 'HEAD') return true;
    if (method !== 'POST') return false;
    const target = new URL(url);
    const confirmedOrigin = target.origin === 'https://bizapi.csdn.net' || target.origin === 'https://editor.csdn.net' || (this.fixture && target.origin === this.site.origin);
    return confirmedOrigin && target.pathname === '/blog-console-api/v3/editor/getArticle';
  }
  private editorURL(id?: string): string {
    const url = new URL(this.site.editorPath, this.site.origin);
    if (id) url.searchParams.set('articleId', id);
    return url.href;
  }
  private async account(page: Page, signal: AbortSignal): Promise<'connected' | 'needs_login' | 'account_mismatch'> {
    await page.goto(new URL(this.site.accountPath, this.site.origin).href, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + this.timeout;
    let login = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const matches = await page.locator('a[href]').evaluateAll((nodes, username) => nodes.some(node => {
        try { const url = new URL((node as HTMLAnchorElement).href); return url.protocol === 'https:' && url.hostname === 'blog.csdn.net' && url.pathname.replace(/\/+$/, '') === `/${username}`; } catch { return false; }
      }), this.identity.username);
      login = await page.getByText(/^登录$/).filter({ visible: true }).count() > 0;
      if (matches && !login) return 'connected';
      await sleep(100);
    }
    return login ? 'needs_login' : 'account_mismatch';
  }
  async run(job: Job, hooks: Hooks, signal: AbortSignal): Promise<JobResult> {
    let external = job.external_started;
    let writesAllowed = false;
    let remoteID = numericID(job.remote_id);
    let pendingID: string | undefined;
    let queue = Promise.resolve();
    let checkpointFailure: unknown;
    let page: Page | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const snapshotState: { value?: Snapshot } = {};
    const readSnapshot = (): Snapshot | undefined => snapshotState.value;
    let lastStage = 'checking_login';
    let progressTail = Promise.resolve();
    const stageRanks: Record<string, number> = { checking_login: 1, opening_editor: 2, draft_acquired: 3, filling: 4, saving: 5, verifying: 6 };
    const progress = (value: Progress): Promise<void> => {
      const operation = progressTail.then(async () => {
        signal.throwIfAborted();
        const actual = value.remote_id && stageRanks[value.stage] < stageRanks[lastStage] ? { ...value, stage: lastStage } : value;
        try { await hooks.progress(actual); lastStage = actual.stage; }
        catch { throw new CheckpointFailure('任务检查点未确认'); }
      });
      progressTail = operation.catch(() => {});
      return operation;
    };
    const persistID = (value: unknown) => {
      const id = numericID(value);
      if (!id || job.run_mode === 'reconcile' || remoteID === id || pendingID === id) return;
      if (remoteID && remoteID !== id) { checkpointFailure = new AdapterFailure('adapter_mismatch'); void page?.close().catch(() => {}); return; }
      pendingID = id;
      queue = queue.then(async () => { await progress({ stage: 'draft_acquired', remote_id: id, message: '已取得平台草稿标识' }); remoteID = id; }).catch(error => { checkpointFailure = error; void page?.close().catch(() => {}); });
    };
    const captureURL = () => {
      if (!page || page.isClosed()) return;
      try { const url = new URL(page.url()); persistID(url.searchParams.get('articleId') ?? url.searchParams.get('articleID') ?? url.searchParams.get('article_id')); } catch { /* 页面尚未导航。 */ }
    };
    const observe = async (response: Response) => {
      try {
        const url = new URL(response.url());
        const editorResponse = /\/editor\/(?:getArticle|saveArticle|autoSave)/i.test(url.pathname) || (this.fixture && url.pathname === '/acquired');
        if (!editorResponse || !this.allowed(url.href) || response.status() !== 200) return;
        const length = response.headers()['content-length'];
        if (length && Number(length) > 1500000) return;
        const body = await response.json() as { data?: Record<string, unknown>; articleId?: unknown };
        const data = body.data;
        const id = numericID(data?.articleId ?? data?.article_id ?? data?.articleID ?? data?.id ?? body.articleId) ?? numericID(url.searchParams.get('articleId'));
        if (job.run_mode !== 'reconcile') persistID(id);
        if (/\/getArticle$/i.test(url.pathname) && typeof data?.title === 'string' && typeof data?.markdowncontent === 'string') snapshotState.value = { id, title: data.title, markdown: data.markdowncontent, status: data.status };
      } catch { /* 无法读取的响应不证明保存成功。 */ }
    };
    const abort = () => { void page?.close().catch(() => {}); };
    try {
      if (job.kind !== 'check_account' && !validContent(job.title, job.markdown)) return { status: 'failed', error_code: 'adapter_mismatch', error_message: '任务内容不符合当前草稿范围', retryable: false };
      signal.throwIfAborted();
      await this.context.route('**/*', route => {
        const request = route.request();
        const allowed = this.allowed(request.url()) && (writesAllowed || this.readOnlyRequest(request.url(), request.method()));
        return allowed ? route.continue() : route.abort('blockedbyclient');
      });
      await this.context.routeWebSocket('**/*', socket => socket.close());
      page = await this.context.newPage();
      page.setDefaultTimeout(this.timeout); page.setDefaultNavigationTimeout(this.timeout);
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      page.on('response', response => { void observe(response); });
      signal.addEventListener('abort', abort, { once: true });
      await progress({ stage: 'checking_login', message: '正在核验平台账号' });
      const account = await this.account(page, signal);
      if (account !== 'connected') return { status: account === 'needs_login' ? 'waiting_user' : 'failed', error_code: account, error_message: account === 'needs_login' ? '平台账号需要人工登录' : '平台账号与配置不一致', retryable: false };
      if (job.kind === 'check_account') return { status: 'succeeded' };
      if (job.run_mode === 'reconcile') {
        const id = remoteID ?? numericID(job.reconcile_candidate_id);
        if (!id) return { status: 'reconciling', error_code: 'draft_not_found', error_message: '需要提供草稿标识进行只读核对' };
        await progress({ stage: 'verifying', message: '正在只读核对已有草稿' });
        await page.goto(this.editorURL(id), { waitUntil: 'domcontentloaded' });
        const match = await this.waitSnapshot(() => snapshotState.value, job, signal);
        if (!match || (snapshotState.value?.id && snapshotState.value.id !== id)) return { status: 'reconciling', error_code: 'draft_mismatch', error_message: '草稿内容或草稿状态未通过核对' };
        return { status: 'succeeded', remote_id: id };
      }
      if (external || remoteID) return { status: 'reconciling', error_code: 'draft_mismatch', error_message: '任务已有外站操作，需要只读核对' };
      await progress({ stage: 'opening_editor', external_started: true, message: '即将打开平台草稿编辑器' });
      external = true;
      writesAllowed = true;
      signal.throwIfAborted();
      await page.goto(this.editorURL(), { waitUntil: 'domcontentloaded' });
      timer = setInterval(captureURL, 50);
      captureURL();
      const titleInput = page.locator('input.article-bar__title');
      const titleDisplay = page.locator('div.article-bar__title-display');
      const body = page.locator('pre[contenteditable="true"].editor__inner');
      await body.waitFor({ state: 'visible' });
      const initialTitle = await titleInput.count() === 1 ? (await titleInput.inputValue()).trim() : (await titleDisplay.textContent())?.trim();
      if (initialTitle && initialTitle !== '【无标题】') throw new AdapterFailure('adapter_mismatch');
      if (!await titleInput.isVisible()) await titleDisplay.click();
      await titleInput.waitFor({ state: 'visible' });
      const save = page.locator('button:text-is("保存草稿")').filter({ visible: true });
      await save.waitFor({ state: 'visible', timeout: this.timeout });
      if (await save.count() !== 1 || await body.count() !== 1 || await titleInput.count() !== 1) throw new AdapterFailure('adapter_mismatch');
      await queue; if (checkpointFailure) throw checkpointFailure;
      await progress({ stage: 'filling', message: '正在填入任务快照' });
      await titleInput.fill(job.title);
      await this.context.grantPermissions(['clipboard-write'], { origin: new URL(page.url()).origin });
      await page.evaluate(text => navigator.clipboard.writeText(text), job.markdown);
      try { await body.focus(); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+V'); }
      finally { await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => {}); }
      if ((await body.textContent())?.trim() !== job.markdown.trim() || await titleInput.inputValue() !== job.title) throw new AdapterFailure('adapter_mismatch');
      captureURL(); await queue; if (checkpointFailure) throw checkpointFailure;
      await progress({ stage: 'saving', message: '正在保存平台草稿' });
      await save.click();
      const idDeadline = Date.now() + this.timeout;
      while (!remoteID && Date.now() < idDeadline) { signal.throwIfAborted(); captureURL(); await queue; if (checkpointFailure) throw checkpointFailure; await sleep(50); }
      if (!remoteID) throw new AdapterFailure('timeout');
      // 保存按钮可能异步提交；重新载入前等待浏览器完成对应保存请求。
      await page.waitForLoadState('networkidle', { timeout: Math.min(this.timeout, 5000) }).catch(() => {});
      signal.throwIfAborted();
      writesAllowed = false;
      await progress({ stage: 'verifying', message: '正在从平台重新读取草稿' });
      snapshotState.value = undefined;
      await page.reload({ waitUntil: 'domcontentloaded' });
      if (!await this.waitSnapshot(readSnapshot, job, signal) || (readSnapshot()?.id && readSnapshot()?.id !== remoteID)) throw new AdapterFailure('draft_mismatch');
      await queue; if (checkpointFailure) throw checkpointFailure;
      return { status: 'succeeded', remote_id: remoteID };
    } catch (error) {
      if (error instanceof CheckpointFailure || checkpointFailure instanceof CheckpointFailure) throw new CheckpointFailure('任务检查点未确认');
      if (signal.aborted) return { status: external ? 'reconciling' : 'cancelled', ...(remoteID ? { remote_id: remoteID } : {}), error_code: 'cancelled', error_message: '浏览器操作已停止' };
      const code = error instanceof AdapterFailure ? error.code : 'timeout';
      return { status: external ? 'reconciling' : 'failed', ...(remoteID ? { remote_id: remoteID } : {}), error_code: code, error_message: external ? '平台结果尚未确认，需要只读核对' : '平台页面未通过安全检查', retryable: !external && code === 'timeout' };
    } finally {
      if (timer) clearInterval(timer);
      signal.removeEventListener('abort', abort);
      await queue;
      // 浏览器上下文由执行器关闭；单次适配仅保留本任务页面。
      await page?.close().catch(() => {});
    }
  }
  private async waitSnapshot(snapshot: () => Snapshot | undefined, job: Job, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) { signal.throwIfAborted(); const value = snapshot(); // 状态2仅作为目标账号已实测的适配条件；其他或缺失值均停止核对。
      if (value && (value.status === 2 || value.status === '2') && value.title === job.title && value.markdown.trim() === job.markdown.trim()) return true; await sleep(50); }
    return false;
  }
}