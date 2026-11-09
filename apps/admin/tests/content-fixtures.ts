// 将平台展示样例包装为公共 HTTP 契约，保留各页面的边界与错误样例。
export function contentFixture(value: unknown, platform: string): unknown {
  if (!value || typeof value !== 'object') return value;
  const data = value as Record<string, any>;
  const item = (entry: Record<string, unknown>) => ({
    id: entry.id,
    title: entry.title,
    status: entry.status,
    platform_status: entry.platform_status || '',
    posted_at: entry.posted_at || '',
    kind: platform === 'csdn' ? 'article' : entry.type || 'unknown',
    cover_urls: entry.cover_urls || [],
    metrics: {},
    extensions: { [platform]: entry },
  });
  if ('snapshot' in data && Array.isArray(data.items))
    return {
      ...data,
      items: data.items.map(item),
      snapshot: data.snapshot
        ? {
            identity: { username: 'synthetic', user_id: '' },
            scope: 'all',
            complete: true,
            synced_at: data.snapshot.synced_at,
            extensions: { [platform]: data.snapshot },
          }
        : null,
    };
  const entry = data.article || data.note;
  if (entry)
    return {
      platform,
      item: item(entry),
      fetched_at: data.fetched_at,
      read_job: data.read_job,
      body: data.body
        ? {
            id: data.body.id,
            format: platform === 'csdn' ? 'markdown' : 'text',
            text: data.body.markdown || data.body.text || '',
            html: data.body.html || '',
            images: data.body.images || [],
            tags: data.body.tags || [],
            extensions: { [platform]: data.body },
          }
        : null,
    };
  return value;
}
