import type { AccountIdentity, Note } from './types.js';

const id = /^[a-f0-9]{24}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('adapter_mismatch');
  return value as Record<string, unknown>;
}
export function identityPayload(value: unknown): AccountIdentity {
  const root = object(value);
  if (root.success !== true || root.code !== 0) throw Error('needs_login');
  const data = object(root.data);
  if (
    typeof data.redId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(data.redId) ||
    typeof data.userId !== 'string' ||
    !id.test(data.userId)
  )
    throw Error('adapter_mismatch');
  return { username: data.redId, user_id: data.userId };
}
function metric(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw Error('adapter_mismatch');
  return value;
}
// 创作中心原始字段仅保留列表所需内容；未知状态、缺失统计不推断。
export function notesPayload(value: unknown): { items: Note[]; next: number } {
  const root = object(value);
  const data = object(root.data);
  if (
    root.success !== true ||
    root.code !== 0 ||
    !Array.isArray(data.notes) ||
    data.notes.length > 2000 ||
    !Number.isInteger(data.page) ||
    Number(data.page) < -1 ||
    Number(data.page) > 2000
  )
    throw Error('adapter_mismatch');
  const items = data.notes.map((raw) => {
    const note = object(raw);
    if (
      typeof note.id !== 'string' ||
      !id.test(note.id) ||
      typeof note.title !== 'string' ||
      note.title.length > 2000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(note.title)
    )
      throw Error('adapter_mismatch');
    const time = note.time;
    if (
      time !== undefined &&
      time !== null &&
      (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0 || time > 8640000000000)
    )
      throw Error('adapter_mismatch');
    return {
      id: note.id,
      title: note.title.trim() || '无标题笔记',
      status: 'unknown' as const,
      platform_status: '',
      posted_at: typeof time === 'number' ? new Date(time * 1000).toISOString() : '',
      views: metric(note.views),
      likes: metric(note.likes),
      comments: metric(note.comments),
      favorites: metric(note.collects),
    };
  });
  if (!items.length && data.page !== -1) throw Error('adapter_mismatch');
  return { items, next: Number(data.page) };
}

export class NotesCollector {
  readonly items: Note[] = [];
  private seen = new Set<string>();
  private pages = new Set<number>();
  done = false;
  add(page: number, payload: unknown): number {
    if (this.done || this.pages.has(page) || this.pages.size >= 100)
      throw Error('adapter_mismatch');
    const result = notesPayload(payload);
    for (const note of result.items) {
      if (this.seen.has(note.id) || this.items.length >= 2000) throw Error('adapter_mismatch');
      this.seen.add(note.id);
      this.items.push(note);
    }
    this.pages.add(page);
    if (result.next === -1) this.done = true;
    else if (result.next <= page || this.pages.has(result.next)) throw Error('adapter_mismatch');
    return result.next;
  }
}
