import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { renderCards } from '../../apps/formatter/src/render';
import type { FormattingJob, FormattingOutput } from '../../apps/admin/src/formatting-contract';

const root = resolve(import.meta.dirname, '../..');
let server: Server;
let origin: string;
let images: { data: string }[];
const output: FormattingOutput = {
  title: '技术文章排版指南',
  summary: '保留技术原意，整理阅读结构。',
  markdown: '## 技术说明\n\n完整保留正文与代码。\n\n~~~go\nfmt.Println("hello")\n~~~',
  tags: ['技术笔记'],
  body: '整理技术文章时，先核对原意，再调整层级与段落。\n代码独立展示，完成后核对图片。',
  topics: ['技术笔记', '写作技巧'],
  cover_title: '技术笔记\n排版指南',
  cover_subtitle: '从原稿到清晰图文',
  cards: [
    {
      title: '先核对，再排版',
      paragraphs: ['保留技术原意，整理标题和段落。', '代码独立展示，完成后逐页核对。'],
      code_refs: [],
      source_block_ids: [],
    },
  ],
  omissions: ['原始长代码未进入文字卡片，请核对正文。'],
  issues: [],
  assets: [],
};
const base: FormattingJob = {
  id: 'sample',
  title: '技术文章排版指南',
  session_id: 'sample-session',
  platform: 'csdn',
  operation: 'generate',
  edit_request_id: '',
  edit_fingerprint: '',
  status: 'succeeded',
  stage: 'finished',
  revision: 1,
  base_revision: 1,
  request_id: 'sample-request',
  result: output,
  error_code: '',
  created_at: '2026-11-10T00:00:00Z',
  updated_at: '2026-11-10T00:00:00Z',
  prompt_version: 'test',
  rules_version: 'test',
  template: 'technical',
  model: 'deepseek-flash',
  input_tokens: 100,
  output_tokens: 50,
  confirmed: false,
  confirmation_fingerprint: '',
};
test.beforeAll(async () => {
  images = await renderCards(
    {
      template: 'technical',
      title: output.cover_title,
      subtitle: output.cover_subtitle,
      cards: output.cards,
      markdown: '合成原稿',
    },
    new AbortController().signal,
  );
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url!, 'http://localhost').pathname;
      const file = pathname.startsWith('/assets/')
        ? resolve(root, 'apps/admin/dist', '.' + pathname)
        : resolve(root, 'apps/admin/dist/index.html');
      if (!file.startsWith(resolve(root, 'apps/admin/dist') + '/')) {
        res.writeHead(403).end();
        return;
      }
      const data = await readFile(file);
      res.setHeader(
        'Content-Type',
        (
          { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' } as Record<
            string,
            string
          >
        )[extname(file)] ?? 'application/octet-stream',
      );
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('测试服务不可用');
  origin = 'http://127.0.0.1:' + address.port;
});
test.afterAll(async () => {
  if (server)
    await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
});
for (const platform of ['csdn', 'xiaohongshu'] as const) {
  test(platform + ' 格式化稿在桌面和窄屏支持明确确认', async ({ page }) => {
    let job = structuredClone({ ...base, platform });
    job.result!.assets =
      platform === 'xiaohongshu'
        ? images.map((_, i) => ({
            id: 'asset-' + i,
            url: '/api/formatting-assets/' + i,
            sha256: 'synthetic',
            width: 1080,
            height: 1440,
            revision: 1,
          }))
        : [];
    const writes: string[] = [];
    await page.route('**/api/**', async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (req.method() !== 'GET') writes.push(path);
      if (path.startsWith('/api/formatting-assets/')) {
        await route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(images[Number(path.split('/').at(-1))].data, 'base64'),
        });
        return;
      }
      let value: unknown = { items: [] };
      if (path === '/api/session')
        value = {
          user: { id: 'synthetic', username: '合成验证', role: 'admin' },
          csrf_token: 'synthetic',
        };
      else if (path === '/api/formatting-sessions/sample-session')
        value = {
          id: 'sample-session',
          snapshot: {
            title: '技术文章排版指南',
            body: '# 技术说明\n\n完整保留正文与代码。',
            body_format: 'markdown',
            tags: [],
          },
        };
      else if (path.startsWith('/api/formatting-jobs/sample')) {
        if (path.endsWith('/adopt')) {
          job = { ...job, status: 'adopted' };
          value = { job };
        } else if (path.endsWith('/confirm')) {
          job = { ...job, status: 'adopted', confirmed: true };
          value = job;
        } else value = job;
      }
      await route.fulfill({ json: value });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(origin + '/formatting/sample');
    await expect(page.getByRole('heading', { name: '平台稿', exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: output.title, exact: true }).last(),
    ).toBeVisible();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      if (platform === 'xiaohongshu') await expect(page.getByAltText('封面')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (process.env.UPDATE_FORMATTING_SCREENSHOTS === 'true')
        await page.screenshot({
          path: resolve(root, 'docs/assets/ai-formatting-' + platform + '-' + width + '.png'),
          fullPage: true,
        });
    }
    expect(writes).toEqual([]);
    const action = page.getByRole('button', {
      name: platform === 'csdn' ? '采用CSDN平台稿' : '确认图文素材',
      exact: true,
    });
    await action.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(writes).toEqual([]);
    await action.click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: platform === 'csdn' ? '确认' : '确认当前修订', exact: true })
      .click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toBe(
      '/api/formatting-jobs/sample/' + (platform === 'csdn' ? 'adopt' : 'confirm'),
    );
    expect(await page.getByRole('button', { name: /上传|发布/ }).count()).toBe(0);
  });
}
