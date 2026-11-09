import { afterEach, beforeEach, vi } from 'vitest';
export const session = { user: { username: '管理员' }, csrf_token: 'csrf-test' };
export const job = {
  id: 'job-1',
  title: '第一篇技术文章',
  platform: 'csdn',
  kind: 'save_draft',
  status: 'queued',
  outcome: 'not_submitted',
  stage: 'queued',
  attempts: 0,
  retry_count: 0,
  max_retries: 3,
  retry_allowed: false,
  external_started: false,
  cancel_requested: false,
  markdown: '# 文章正文',
  created_at: '2026-11-03T04:00:00Z',
  updated_at: '2026-11-03T04:00:00Z',
};
export const appFixture: {
  handler: (url: string, init?: RequestInit) => unknown | Promise<unknown>;
  calls: { url: string; init?: RequestInit }[];
} = { handler: () => undefined, calls: [] };
export function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
beforeEach(() => {
  window.history.replaceState({}, '', '/jobs');
  appFixture.calls = [];
  appFixture.handler = (url) => {
    if (url === '/api/session') return response(session);
    if (url === '/api/accounts')
      return response({
        items: [
          {
            account: {
              id: 'csdn-main',
              platform: 'csdn',
              display_name: '测试账号',
              status: 'needs_login',
            },
          },
        ],
      });
    if (url.startsWith('/api/jobs?'))
      return response({ items: [job], total: 1, page: 1, page_size: 50 });
    if (url === '/api/jobs/job-1') return response(job);
    if (url.startsWith('/api/jobs/job-1/history?'))
      return response({ items: [], transitions: [], total: 0, page: 1, page_size: 50 });
    if (url.startsWith('/api/logs?'))
      return response({ items: [], total: 0, page: 1, page_size: 50 });
    if (url === '/api/account')
      return response({
        id: 'csdn-main',
        platform: 'csdn',
        display_name: '测试账号',
        status: 'needs_login',
      });
    if (url === '/api/settings')
      return response({ draft_only: true, platform: 'csdn', limits: {}, poll_interval_ms: 5000 });
    if (url === '/api/overview')
      return response({ counts: { queued: 1 }, account: { status: 'connected' } });
    return response({ code: 'not_found', message: '不存在' }, 404);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      appFixture.calls.push({ url, init });
      return Promise.resolve(appFixture.handler(url, init));
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
