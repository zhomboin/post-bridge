import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { XiaohongshuAdapter } from '../src/xiaohongshu.js';
import type { Job } from '../src/types.js';

it('从原生笔记卡片只读打开正文，校验作者，不触发编辑或发布', async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  });
  const id = 'bbbbbbbbbbbbbbbbbbbbbbbb',
    user = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  let writes = 0;
  try {
    for (const wrong of [false, true]) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (route) => {
        const req = route.request(),
          url = new URL(req.url());
        if (req.method() !== 'GET') writes++;
        if (url.pathname === '/new/note-manager')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<div class="note-card"><button class="note-card__cover" onclick="window.open('https://www.xiaohongshu.com/explore/${id}?xsec_token=synthetic')">查看封面</button><span class="note-card__title">合成正文</span></div><script>fetch('/api/galaxy/user/info');fetch('/api/galaxy/v2/creator/note/user/posted?tab=0&page=0');fetch('/api/galaxy/note/publish',{method:'POST'});</script>`,
          });
        if (url.pathname === '/api/galaxy/user/info')
          return route.fulfill({
            json: { success: true, code: 0, data: { redId: 'synthetic', userId: user } },
          });
        if (url.pathname.includes('/note/user/posted'))
          return route.fulfill({
            json: {
              success: true,
              code: 0,
              data: { notes: [{ id, display_title: '合成正文', tab_status: 1 }], page: -1 },
            },
          });
        if (url.pathname === '/explore/' + id)
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<script>window.__INITIAL_STATE__={note:{noteDetailMap:{'${id}':{note:{noteId:'${id}',user:{userId:'${wrong ? id : user}'},title:'合成正文',desc:'只读正文',imageList:[{urlDefault:'https://sns-webpic-qc.xhscdn.com/image.jpg'}],tagList:[]}}}}}</script>`,
          });
        return route.abort();
      });
      const job: Job = {
        id: 'read',
        account_id: 'xhs',
        platform: 'xiaohongshu',
        kind: 'read_note',
        article_id: id,
        account_username: 'synthetic',
        account_native_id: user,
        title: '',
        markdown: '',
        run_mode: 'execute',
        external_started: false,
        remote_id: null,
        reconcile_candidate_id: null,
      };
      const stages: string[] = [];
      const result = await new XiaohongshuAdapter(context, {
        accountId: 'xhs',
        username: 'synthetic',
        userId: user,
      }).run(
        job,
        {
          progress: async (p) => {
            stages.push(p.stage);
          },
        },
        new AbortController().signal,
      );
      expect(result.status, JSON.stringify(result)).toBe(wrong ? 'failed' : 'succeeded');
      if (wrong) {
        expect(result.error_code).toBe('account_mismatch');
        expect(result.note).toBeUndefined();
      } else {
        expect(result.note?.text).toBe('只读正文');
        expect(stages).toEqual(['checking_login', 'verifying']);
      }
      await context.close();
    }
    expect(writes).toBe(0);
  } finally {
    await browser.close();
  }
}, 30000);
