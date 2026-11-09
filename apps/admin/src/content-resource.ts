import type { ContentBody, ContentItem, ContentPlatform } from './content-contract';
export { platformLabel } from './content-operations';
import { useResource, type Job, type PageData } from './runtime';

export type ContentPage = PageData<ContentItem> & {
  snapshot: { synced_at: string; complete: boolean; extensions: Record<string, unknown> } | null;
  sync_job: Job | null;
};
export type ContentDetail = {
  platform: string;
  item: ContentItem;
  body: ContentBody | null;
  fetched_at: string | null;
  read_job: Job | null;
};

export function contentBase(account: string) {
  return '/api/accounts/' + encodeURIComponent(account) + '/contents';
}
export function contentAccount(route: string) {
  return new URLSearchParams(route.split('?')[1]).get('account') || 'csdn-main';
}

// 平台专属展示只读取对应扩展；加载、刷新、取消和错误仍由公共资源处理。
export function legacyContentPage(page: ContentPage, platform: string) {
  return {
    ...page,
    items: page.items.map((item) => item.extensions[platform]),
    snapshot: page.snapshot?.extensions[platform] || null,
  };
}
export function legacyContentDetail(detail: ContentDetail, platform: string, itemKey: string) {
  return {
    [itemKey]: detail.item.extensions[platform],
    body: detail.body?.extensions[platform] || null,
    fetched_at: detail.fetched_at,
    read_job: detail.read_job,
  };
}
export function useContentPage<T>(path: string, platform: string) {
  const resource = useResource<ContentPage>(path);
  return {
    ...resource,
    data: resource.data ? (legacyContentPage(resource.data, platform) as T) : undefined,
  };
}
export function useContentDetail<T>(path: string, platform: string, itemKey: string) {
  const resource = useResource<ContentDetail>(path);
  return {
    ...resource,
    data: resource.data ? (legacyContentDetail(resource.data, platform, itemKey) as T) : undefined,
  };
}
export function canReadContent(platform: ContentPlatform, item: ContentItem) {
  return (
    platform.capabilities.body?.enabled &&
    (!platform.read_statuses.length || platform.read_statuses.includes(item.status))
  );
}
