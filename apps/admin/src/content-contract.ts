// 由 scripts/content-contract.mjs 生成，请修改 contracts/content-model.json。
export interface ContentIdentity {
  username: string;
  user_id: string;
}
export interface ContentMetric {
  value: number | null;
  unit: string;
  begin_at: string;
  end_at: string;
}
export interface ContentItem {
  id: string;
  title: string;
  status: string;
  platform_status: string;
  posted_at: string;
  kind: string;
  cover_urls: string[];
  metrics: Record<string, ContentMetric>;
  extensions: Record<string, unknown>;
}
export interface ContentSnapshot {
  identity: ContentIdentity;
  scope: string;
  complete: boolean;
  items: ContentItem[];
  extensions: Record<string, unknown>;
}
export interface ContentBody {
  id: string;
  format: string;
  text: string;
  html: string;
  images: string[];
  tags: string[];
  extensions: Record<string, unknown>;
}
export interface ContentCapability {
  enabled: boolean;
  formats: string[];
  kinds: string[];
}
export interface ContentPlatform {
  id: string;
  label: string;
  id_pattern: string;
  username_pattern: string;
  user_id_pattern: string;
  sync_job: string;
  read_job: string;
  sync_result: string;
  read_result: string;
  identity_result: string;
  body_ttl_seconds: number;
  invalidate_body_on_sync: boolean;
  read_statuses: string[];
  capabilities: Record<string, ContentCapability>;
}
export const contentPlatforms: readonly ContentPlatform[] = [
  {
    id: 'csdn',
    label: 'CSDN',
    id_pattern: '^[0-9]{1,32}$',
    username_pattern: '^[A-Za-z0-9_-]{1,100}$',
    user_id_pattern: '^$',
    sync_job: 'sync_articles',
    read_job: 'read_article',
    sync_result: 'articles',
    read_result: 'article',
    identity_result: '',
    body_ttl_seconds: 2592000,
    invalidate_body_on_sync: true,
    read_statuses: [],
    capabilities: {
      list: { enabled: true, formats: [], kinds: ['article'] },
      body: { enabled: true, formats: ['markdown', 'html'], kinds: ['article'] },
      profile: { enabled: true, formats: [], kinds: [] },
      stats: { enabled: true, formats: [], kinds: [] },
      save_draft: { enabled: true, formats: ['markdown'], kinds: ['article'] },
      publish: { enabled: true, formats: ['markdown'], kinds: ['article'] },
      check_account: { enabled: true, formats: [], kinds: [] },
      remote_login: { enabled: true, formats: [], kinds: [] },
    },
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    id_pattern: '^[a-f0-9]{24}$',
    username_pattern: '^[A-Za-z0-9_-]{1,100}$',
    user_id_pattern: '^[a-f0-9]{24}$',
    sync_job: 'sync_notes',
    read_job: 'read_note',
    sync_result: 'notes',
    read_result: 'note',
    identity_result: 'account_identity',
    body_ttl_seconds: 0,
    invalidate_body_on_sync: false,
    read_statuses: ['published'],
    capabilities: {
      list: { enabled: true, formats: [], kinds: ['image', 'video', 'unknown'] },
      body: { enabled: true, formats: ['text'], kinds: ['image', 'video', 'unknown'] },
      profile: { enabled: true, formats: [], kinds: [] },
      stats: { enabled: true, formats: [], kinds: [] },
      check_account: { enabled: true, formats: [], kinds: [] },
      remote_login: { enabled: true, formats: [], kinds: [] },
    },
  },
];
