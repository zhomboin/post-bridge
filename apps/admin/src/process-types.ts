import type { Job, LogEntry } from './runtime';

export type ProcessSummary = Job & {
  object_type: 'article' | 'account'; object_id: string; object_name: string; account_name: string;
  event_count: number; error_count: number; warning_count: number;
};
export type ProcessEvent = LogEntry & { stage: string; attempt: number; status?: string; outcome?: string; run_mode?: string };
export type HistoryPage = { items: ProcessEvent[]; transitions: ProcessEvent[]; total: number; page: number; page_size: number };
export type ProcessSnapshot = {
  id: number | string; attempt: number; phase: 'before' | 'after'; object_type: 'article' | 'account';
  title?: string; markdown?: string; status?: string; remote_id?: string; username?: string; display_name?: string; captured_at: string;
};
export type ContentChanges = { submitted: { title: string; markdown: string }; snapshots: ProcessSnapshot[]; attempts: number[]; content_retained: boolean };
export const operationName = (kind: string) => kind === 'check_account' ? '检查账号' : '保存草稿';
export const platformName = (value: string) => value === 'csdn' ? 'CSDN' : value || '平台未记录';
export const processHref = (id: string, back: string) => '/logs/' + encodeURIComponent(id) + '?back=' + encodeURIComponent(back);
