import type { AccountIdentity, Note } from './types.js';
import { xhsImageURL, xhsMetric, xhsText } from './xiaohongshu-insights.js';

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
  const items = data.notes.map((raw): Note => {
    const note = object(raw);
    if (typeof note.id !== 'string' || !id.test(note.id) || typeof note.display_title !== 'string')
      throw Error('adapter_mismatch');
    const time = note.time;
    let posted = '';
    if (time !== undefined && time !== null && time !== '') {
      if (
        typeof time === 'number' &&
        Number.isSafeInteger(time) &&
        time >= 0 &&
        time <= 8640000000000000
      )
        posted = new Date(time).toISOString();
      else if (typeof time === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?$/.test(time))
        posted = new Date(time.replace(' ', 'T') + '+08:00').toISOString();
      else throw Error('adapter_mismatch');
    }
    const images = note.images_list ?? [];
    if (!Array.isArray(images) || images.length > 50) throw Error('adapter_mismatch');
    const status = note.tab_status;
    if (status != null && (typeof status !== 'number' || !Number.isInteger(status)))
      throw Error('adapter_mismatch');
    return {
      id: note.id,
      title: xhsText(note.display_title, 2000).trim() || '无标题笔记',
      status:
        ({ 1: 'published', 2: 'reviewing', 3: 'rejected' } as Record<number, Note['status']>)[
          Number(status)
        ] || 'unknown',
      platform_status: status == null ? '' : String(status),
      posted_at: posted,
      views: metric(note.view_count),
      likes: metric(note.likes),
      comments: metric(note.comments_count),
      favorites: metric(note.collected_count),
      shares: xhsMetric(note.shared_count),
      type: note.type === 'normal' ? 'image' : note.type === 'video' ? 'video' : 'unknown',
      cover_urls: images.map((raw) => xhsImageURL(object(raw).url)).filter(Boolean),
      note_url: status === 1 ? 'https://www.xiaohongshu.com/explore/' + note.id : '',
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
