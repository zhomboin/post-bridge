const creator = 'creator.xiaohongshu.com';
const reads = new Set(['/api/galaxy/user/info', '/api/galaxy/v2/creator/note/user/posted']);
export function xiaohongshuRequestAllowed(
  value: string,
  method: string,
  resourceType: string,
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    return false;
  const host = url.hostname;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (/upload/i.test(host)) return false;
  const assetHost =
    host === creator || host.endsWith('.xhscdn.com') || host.endsWith('.xiaohongshu.com');
  if (
    method === 'GET' &&
    assetHost &&
    ['script', 'stylesheet', 'font'].includes(resourceType) &&
    /\.(?:m?js|css|woff2?|ttf|otf)$/i.test(path) &&
    !path.startsWith('/api/')
  )
    return true;
  if (/upload|publish|draft|delete|remove|edit|permit/i.test(path)) return false;
  if (host === creator) {
    if (method === 'GET' && reads.has(path)) return true;
    if (method === 'GET' && resourceType === 'document')
      return path === '/new/note-manager' || path === '/login';
    if (
      method === 'GET' &&
      ['script', 'stylesheet', 'image', 'font'].includes(resourceType) &&
      !path.startsWith('/api/')
    )
      return true;
    return false;
  }
  if (
    method === 'GET' &&
    ['script', 'stylesheet', 'image', 'font'].includes(resourceType) &&
    (host.endsWith('.xhscdn.com') || host.endsWith('.xiaohongshu.com'))
  )
    return true;
  if (method === 'POST') {
    return (
      (host === 'as.xiaohongshu.com' && (/^\/api\/sec\//.test(path) || path === '/api/p/pj')) ||
      (host === 'apm-fe.xiaohongshu.com' && path === '/api/data') ||
      (host === 't2.xiaohongshu.com' && path === '/api/v2/collect') ||
      (host === 'edith.xiaohongshu.com' &&
        ['/api/sns/web/racing_report', '/api/sns/web/racing_get'].includes(path))
    );
  }
  return false;
}
