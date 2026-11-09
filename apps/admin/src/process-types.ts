import type { Job, LogEntry } from './runtime';

export type ProcessSummary = Job & {
  object_type: 'article' | 'account';
  object_id: string;
  object_name: string;
  account_name: string;
  event_count: number;
  error_count: number;
  warning_count: number;
};
export type ProcessEvent = Omit<LogEntry, 'id'> & {
  id: string | number;
  stage: string;
  attempt: number;
  status?: string;
  outcome?: string;
  run_mode?: string;
};
export type HistoryPage = {
  items: ProcessEvent[];
  transitions: ProcessEvent[];
  total: number;
  page: number;
  page_size: number;
};
export type ProcessSnapshot = {
  id: number | string;
  attempt: number;
  phase: 'before' | 'after';
  object_type: 'article' | 'account';
  title?: string;
  markdown?: string;
  status?: string;
  remote_id?: string;
  username?: string;
  display_name?: string;
  captured_at: string;
};
export type ContentChanges = {
  submitted: { title: string; markdown: string };
  snapshots: ProcessSnapshot[];
  attempts: number[];
  content_retained: boolean;
};
export const operationName = (kind: string) =>
  (
    ({
      check_account: '检查账号',
      save_draft: '保存草稿',
      publish: '正式发布',
      sync_notes: '同步笔记',
      sync_articles: '同步文章',
      read_article: '读取正文',
      read_note: '读取笔记正文',
    }) as Record<string, string>
  )[kind] || '未知操作';
export const platformName = (value: string) =>
  value === 'csdn' ? 'CSDN' : value === 'xiaohongshu' ? '小红书' : value || '平台未记录';
export const processHref = (id: string, back: string) =>
  '/logs/' + encodeURIComponent(id) + '?back=' + encodeURIComponent(back);
