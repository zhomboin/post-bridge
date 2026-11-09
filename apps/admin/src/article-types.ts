import type { Job, PageData } from './runtime';
export type ArticleStatus = 'published' | 'draft' | 'rejected' | 'recycled' | 'unknown';
export type Article = {
  id: string;
  title: string;
  status: ArticleStatus;
  platform_status: string;
  posted_at: string;
  type: string;
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
  blog_url?: string;
  editor_url?: string;
};
type Metrics = Record<string, number | null>;
export type ArticleSnapshot = {
  username: string;
  profile: {
    nickname: string;
    avatar_url: string;
    level: number | null;
    points: number | null;
    original_articles: number | null;
    followers: number | null;
  };
  counts: Record<string, number>;
  stats: Metrics;
  trend: {
    date: string;
    views: number | null;
    comments: number | null;
    favorites: number | null;
    followers: number | null;
    promotion_clicks: number | null;
    outlink_clicks: number | null;
  }[];
  synced_at: string;
};
export type ArticleBody = {
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
};
export type ArticlePage = PageData<Article> & {
  snapshot: ArticleSnapshot | null;
  sync_job: Job | null;
};
export type ArticleDetailData = {
  article: Article;
  body: ArticleBody | null;
  fetched_at: string | null;
  read_job: Job | null;
};
