export interface Article {
  id: string;
  title: string;
  status: 'published' | 'draft' | 'rejected' | 'recycled' | 'unknown';
  platform_status: string;
  posted_at: string;
  type: 'original' | 'repost' | 'translated' | 'unknown';
  views: number;
  likes: number;
  comments: number;
  favorites: number;
  exposures: number;
  gained_fans: number | null;
  quality_score: number | null;
  is_top: boolean;
  fans_only: boolean;
  vip_only: boolean;
  editor_type: number;
  cover_urls: string[];
}
export interface ArticleProfile {
  nickname: string;
  avatar_url: string;
  level: number | null;
  points: number | null;
  original_articles: number | null;
  followers: number | null;
}
export interface ArticleStats {
  articles: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  exposures: number | null;
  followers: number | null;
  yesterday_views: number | null;
  yesterday_followers: number | null;
  yesterday_favorites: number | null;
}
export interface ArticleTrend {
  date: string;
  views: number | null;
  comments: number | null;
  favorites: number | null;
  followers: number | null;
  promotion_clicks: number | null;
  outlink_clicks: number | null;
}
export interface ArticleSnapshot {
  username: string;
  profile: ArticleProfile;
  counts: {
    total: number;
    published: number;
    draft: number;
    rejected: number;
    recycled: number;
    unknown: number;
  };
  stats: ArticleStats;
  trend: ArticleTrend[];
  items: Article[];
}
export interface ArticleBody {
  id: string;
  title: string;
  markdown: string;
  html: string;
  description: string;
  tags: string[];
  categories: string[];
  type: string;
  visibility: string;
  platform_status: string;
  reason: string;
}
export interface PublishOptions {
  tags: string[];
  summary: string;
  categories: string[];
  article_type: 'original' | 'repost' | 'translated';
  creation_declaration: 'none' | 'ai_assisted' | 'online_recreation' | 'personal_opinion';
  visibility: 'public' | 'private' | 'fans' | 'vip';
  template: 'default' | 'simple' | 'moyan';
  cover_image_url: string;
  original_url?: string;
  rights_confirmed?: boolean;
}
export interface Job {
  id: string;
  platform?: string;
  account_id?: string;
  account_native_id?: string;
  kind:
    'sync_notes' | 'save_draft' | 'publish' | 'check_account' | 'sync_articles' | 'read_article';
  title: string;
  markdown: string;
  image_urls?: string[];
  platform_markdown?: string;
  publish_options?: PublishOptions;
  published_html_sha256?: string;
  article_id?: string;
  account_username?: string;
  run_mode: 'execute' | 'reconcile';
  external_started: boolean;
  remote_id: string | null;
  reconcile_candidate_id: string | null;
}
export interface Claim {
  job: Job;
  lease_token: string;
  lease_seconds: number;
  lease_expires_at: string;
}
export interface Observation {
  phase: 'before' | 'after';
  title: string;
  markdown: string;
  status: string;
  remote_id?: string;
}
export interface Progress {
  stage: string;
  external_started?: boolean;
  remote_id?: string;
  message?: string;
  observation?: Observation;
  platform_markdown?: string;
  published_html_sha256?: string;
}
export interface JobResult {
  status: 'succeeded' | 'failed' | 'waiting_user' | 'reconciling' | 'cancelled';
  remote_id?: string;
  publish_accepted?: boolean;
  error_code?: string;
  error_message?: string;
  retryable?: boolean;
  notes?: NotesSnapshot;
  account_identity?: AccountIdentity;
  articles?: ArticleSnapshot;
  article?: ArticleBody;
}
export interface Hooks {
  progress(value: Progress): Promise<void>;
}
export interface Session {
  run(job: Job, hooks: Hooks, signal: AbortSignal): Promise<JobResult>;
  close(): Promise<void>;
}
export interface JobAPI {
  heartbeat(id: string, token: string): Promise<{ cancel_requested: boolean }>;
  progress(id: string, token: string, value: Progress): Promise<void>;
  complete(id: string, token: string, value: JobResult): Promise<void>;
}

export interface AccountIdentity {
  username: string;
  user_id: string;
}
export interface Note {
  id: string;
  title: string;
  status: 'published' | 'reviewing' | 'rejected' | 'unknown';
  platform_status: string;
  posted_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
}
export interface NotesSnapshot extends AccountIdentity {
  items: Note[];
}
