import type { Job, PageData } from './runtime';
export type Note = {
  id: string;
  title: string;
  status: string;
  platform_status?: string;
  posted_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares?: number | null;
  type?: 'image' | 'video' | 'unknown';
  cover_urls?: string[];
  note_url?: string;
};
export type NoteProfile = {
  nickname: string;
  avatar_url: string;
  description: string;
  following: number | null;
  followers: number | null;
  liked_and_collected: number | null;
};
export type NoteSnapshot = {
  synced_at: string;
  profile?: NoteProfile;
  stats?: {
    begin_at: string;
    end_at: string;
    published: number | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    favorites: number | null;
    shares: number | null;
    exposures: number | null;
    net_followers: number | null;
  };
  trend?: {
    date: string;
    views: number | null;
    likes: number | null;
    comments: number | null;
    favorites: number | null;
    exposures: number | null;
    followers: number | null;
  }[];
};
export type NotePage = PageData<Note> & { snapshot: NoteSnapshot | null; sync_job: Job | null };
export type NoteDetailData = {
  note: Note;
  body: { id: string; title: string; text: string; images: string[]; tags: string[] } | null;
  fetched_at: string | null;
  read_job: Job | null;
};
export const noteLabels: Record<string, string> = {
  published: '已发布',
  reviewing: '审核中',
  rejected: '未通过',
  unknown: '状态待确认',
};
export const noteNumber = (value: number | null | undefined) =>
  value == null ? '—' : value.toLocaleString('zh-CN');
export function noteHref(account: string, id: string, back: string) {
  return '/notes/' + id + '?' + new URLSearchParams({ account, back });
}
