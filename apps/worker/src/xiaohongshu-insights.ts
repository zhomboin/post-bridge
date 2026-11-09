import type { NoteProfile, NoteStats, NoteTrend } from './types.js';

export function xhsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('adapter_mismatch');
  return value as Record<string, unknown>;
}
export function xhsData(value: unknown): Record<string, unknown> {
  const root = xhsObject(value);
  if (root.success !== true || root.code !== 0) throw Error('adapter_mismatch');
  return xhsObject(root.data);
}
export function xhsMetric(value: unknown, signed = false): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!signed && value < 0))
    throw Error('adapter_mismatch');
  return value;
}
export function xhsText(value: unknown, max: number): string {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    throw Error('adapter_mismatch');
  return value;
}
export function xhsImageURL(value: unknown): string {
  const text = xhsText(value, 4096);
  if (!text) return '';
  const url = new URL(text);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    /[\s\\]/.test(text) ||
    !(url.hostname === 'img.xiaohongshu.com' || url.hostname.endsWith('.xhscdn.com'))
  )
    throw Error('adapter_mismatch');
  return url.href;
}
export function profilePayload(value: unknown, username: string): NoteProfile {
  const d = xhsData(value);
  if (d.red_num !== username) throw Error('account_mismatch');
  return {
    nickname: xhsText(d.name, 400),
    avatar_url: xhsImageURL(d.avatar),
    description: xhsText(d.personal_desc, 4000),
    following: xhsMetric(d.follow_count),
    followers: xhsMetric(d.fans_count),
    liked_and_collected: xhsMetric(d.faved_count),
  };
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8640000000000000
  )
    throw Error('adapter_mismatch');
  return new Date(value).toISOString();
}
// 官方数据中心的 seven 为固定七日区间，不能与累计账号数据混用。
export function statsPayload(value: unknown): { stats: NoteStats; trend: NoteTrend[] } {
  const d = xhsObject(xhsData(value).seven);
  const stats: NoteStats = {
    begin_at: timestamp(d.begin_time),
    end_at: timestamp(d.end_time),
    published: xhsMetric(d.publish_note_num),
    views: xhsMetric(d.view_count),
    likes: xhsMetric(d.like_count),
    comments: xhsMetric(d.comment_count),
    favorites: xhsMetric(d.collect_count),
    shares: xhsMetric(d.share_count),
    exposures: xhsMetric(d.impl_count),
    net_followers: xhsMetric(d.net_rise_fans_count, true),
  };
  if (
    stats.begin_at > stats.end_at ||
    Date.parse(stats.end_at) - Date.parse(stats.begin_at) > 7 * 86400000
  )
    throw Error('adapter_mismatch');
  const days = new Map<string, NoteTrend>();
  for (const [field, key] of [
    ['view_list', 'views'],
    ['like_list', 'likes'],
    ['comment_list', 'comments'],
    ['collect_list', 'favorites'],
    ['impl_count_list', 'exposures'],
    ['net_rise_fans_count_list', 'followers'],
  ] as const) {
    const series = d[field];
    if (series === undefined || series === null) continue;
    if (!Array.isArray(series) || series.length > 31) throw Error('adapter_mismatch');
    const seen = new Set<string>();
    for (const raw of series) {
      const point = xhsObject(raw);
      const instant = timestamp(point.date);
      if (instant < stats.begin_at || instant > stats.end_at) throw Error('adapter_mismatch');
      const date = new Date(Number(point.date) + 8 * 3600000).toISOString().slice(0, 10);
      if (seen.has(date)) throw Error('adapter_mismatch');
      seen.add(date);
      const row = days.get(date) || {
        date,
        views: null,
        likes: null,
        comments: null,
        favorites: null,
        exposures: null,
        followers: null,
      };
      row[key] = xhsMetric(point.count, key === 'followers');
      days.set(date, row);
    }
  }
  return { stats, trend: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
