import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { NotesCollector, identityPayload, notesPayload } from '../src/xiaohongshu-model.js';
import { xiaohongshuRequestAllowed as allowed } from '../src/xiaohongshu-network.js';
import { XiaohongshuAdapter } from '../src/xiaohongshu.js';
import type { Job } from '../src/types.js';

const user = { username: 'synthetic-red', user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
const note = { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', title: '合成笔记', views: 0, likes: 2 };
const payload = (notes: unknown[], page = -1) => ({
  success: true,
  code: 0,
  data: { notes, page },
});
const job: Job = {
  id: 'sync',
  kind: 'sync_notes',
  platform: 'xiaohongshu',
  account_id: 'xhs-main',
  account_username: user.username,
  account_native_id: user.user_id,
  title: '',
  markdown: '',
  run_mode: 'execute',
  external_started: false,
  remote_id: null,
  reconcile_candidate_id: null,
};
describe('小红书只读数据边界', () => {
  it('缺失统计为未知，空列表有明确结束标记', () => {
    expect(notesPayload(payload([note])).items[0]).toMatchObject({
      views: 0,
      likes: 2,
      comments: null,
      favorites: null,
      status: 'unknown',
    });
    expect(notesPayload(payload([]))).toEqual({ items: [], next: -1 });
    expect(() => notesPayload(payload([], 0))).toThrow();
    expect(() => notesPayload(payload([{ ...note, views: -1 }]))).toThrow();
    expect(() => notesPayload(payload([{ ...note, id: 'unsafe' }]))).toThrow();
  });
  it('跨页重复、倒退、未结束或异常结构不能作为完整快照', () => {
    const collector = new NotesCollector();
    expect(collector.add(0, payload([note], 1))).toBe(1);
    expect(collector.done).toBe(false);
    expect(() => collector.add(1, payload([note]))).toThrow();
    expect(() => new NotesCollector().add(0, payload([note], 0))).toThrow();
    expect(() => notesPayload({ success: true, code: 0, data: { items: [] } })).toThrow();
    expect(() =>
      identityPayload({ success: true, code: 0, data: { redId: user.username, userId: 'wrong' } }),
    ).toThrow();
  });
  it('禁止编辑器、上传许可及写接口；只保留必要原生安全请求', () => {
    for (const [url, method, type] of [
      ['https://creator.xiaohongshu.com/publish/publish', 'GET', 'document'],
      ['https://creator.xiaohongshu.com/api/media/v1/upload/creator/permit', 'GET', 'xhr'],
      ['https://ros-upload.xiaohongshu.com/file', 'PUT', 'fetch'],
      ['https://creator.xiaohongshu.com/api/galaxy/note/publish', 'POST', 'xhr'],
      ['https://creator.xiaohongshu.com/api/galaxy/user/info', 'POST', 'xhr'],
      ['https://creator.xiaohongshu.com.evil.test/new/note-manager', 'GET', 'document'],
      ['https://evil.test/a.js', 'GET', 'script'],
    ])
      expect(allowed(url, method, type)).toBe(false);
    expect(allowed('https://creator.xiaohongshu.com/api/galaxy/user/info', 'GET', 'xhr')).toBe(
      true,
    );
    expect(allowed('https://as.xiaohongshu.com/api/sec/v1/report', 'POST', 'xhr')).toBe(true);
    expect(
      allowed('https://fe-static.xhscdn.com/resource/project-publish.js', 'GET', 'script'),
    ).toBe(true);
    expect(
      allowed('https://creator.xiaohongshu.com/api/galaxy/note/publish.js', 'GET', 'script'),
    ).toBe(false);
  });
});
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  });
}, 30000);
afterAll(async () => {
  await browser?.close();
});
describe('小红书真实浏览器合成页面', () => {
  async function run(
    mode: 'stale' | 'empty' | 'pages' | 'mismatch' | 'expired' | 'schema' | 'incomplete',
    kind: 'check_account' | 'sync_notes' = 'sync_notes',
  ) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let pageOneRequests = 0;
    let markStaleStarted = () => {};
    let releaseStale = () => {};
    const staleStarted = new Promise<void>((resolve) => {
      markStaleStarted = resolve;
    });
    const staleReleased = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let writes = 0;
    let editor = 0;
    const stages: string[] = [];
    await context.route('**/*', async (route) => {
      const r = route.request();
      const url = new URL(r.url());
      if (r.method() !== 'GET') writes++;
      if (/publish|upload|draft/.test(url.pathname)) editor++;
      if (url.pathname === '/new/note-manager')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="fetch('/api/galaxy/v2/creator/note/user/posted?tab=0&page=1')">下一页</button><script>fetch('/api/galaxy/user/info');fetch('/api/galaxy/v2/creator/note/user/posted?tab=0&page=0');${mode === 'stale' ? "fetch('/api/galaxy/v2/creator/note/user/posted?tab=0&page=1');" : ''}fetch('/api/media/v1/upload/creator/permit');fetch('/api/galaxy/note/publish',{method:'POST'});</script>`,
        });
      if (url.pathname === '/api/galaxy/user/info')
        return route.fulfill({
          status: mode === 'expired' ? 401 : 200,
          json: {
            success: true,
            code: 0,
            data: { redId: mode === 'mismatch' ? 'other' : user.username, userId: user.user_id },
          },
        });
      if (url.pathname.includes('/note/user/posted')) {
        const first = url.searchParams.get('page') === '0';
        if (mode === 'stale') {
          if (first) await staleStarted;
          else if (++pageOneRequests === 1) {
            markStaleStarted();
            await staleReleased;
            return route.fulfill({ json: payload([]) });
          } else {
            releaseStale();
            await new Promise((resolve) => setTimeout(resolve, 80));
          }
        }
        const body =
          mode === 'schema'
            ? { data: {} }
            : ['pages', 'stale'].includes(mode)
              ? payload(
                  [{ ...note, id: first ? note.id : 'cccccccccccccccccccccccc' }],
                  first ? 1 : -1,
                )
              : mode === 'incomplete'
                ? payload([], 1)
                : payload([]);
        return route.fulfill({ json: body });
      }
      return route.abort();
    });
    try {
      const result = await new XiaohongshuAdapter(context, {
        accountId: 'xhs-main',
        username: user.username,
        userId: user.user_id,
      }).run(
        { ...job, kind },
        {
          progress: async (value) => {
            stages.push(value.stage);
          },
        },
        new AbortController().signal,
      );
      expect(writes).toBe(0);
      expect(editor).toBe(0);
      return { result, stages };
    } finally {
      await context.close();
    }
  }
  it('验证身份、读取完整分页且没有外站写入', async () => {
    const { result, stages } = await run('pages');
    expect(result.status).toBe('succeeded');
    expect(result.notes?.items).toHaveLength(2);
    expect(result.account_identity).toEqual(user);
    expect(stages).toEqual(['checking_login', 'verifying']);
  });
  it('原生分页只接受点击后新请求的响应，忽略预取滞后的空页', async () => {
    const { result } = await run('stale');
    expect(result.status).toBe('succeeded');
    expect(result.notes?.items.map((item) => item.id)).toEqual([
      note.id,
      'cccccccccccccccccccccccc',
    ]);
  });
  it('空列表与单独登录检查都可完成', async () => {
    expect((await run('empty')).result.notes?.items).toEqual([]);
    const { result } = await run('empty', 'check_account');
    expect(result.status).toBe('succeeded');
    expect(result.notes).toBeUndefined();
  });
  it.each(['mismatch', 'expired', 'schema', 'incomplete'] as const)(
    '%s 不返回快照',
    async (mode) => {
      const { result } = await run(mode);
      expect(result.status).toBe(mode === 'expired' ? 'waiting_user' : 'failed');
      expect(result.notes).toBeUndefined();
    },
  );
});
