import { contentPlatforms } from './content-contract';

export const contentOperations: Record<string, { label: string; result: string; sync: boolean }> = {
  sync_contents: { label: '同步内容', result: '内容同步', sync: true },
  read_content: { label: '读取内容正文', result: '正文读取', sync: false },
  sync_articles: { label: '同步文章', result: '文章同步', sync: true },
  read_article: { label: '读取正文', result: '正文读取', sync: false },
  sync_notes: { label: '同步笔记', result: '笔记同步', sync: true },
  read_note: { label: '读取笔记正文', result: '笔记正文读取', sync: false },
};
export function platformLabel(platform: string) {
  return contentPlatforms.find((entry) => entry.id === platform)?.label || platform || '平台未记录';
}
