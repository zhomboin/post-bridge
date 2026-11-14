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

test('公众号本地稿在桌面和窄屏可预览并确认', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        write: async (items: ClipboardItem[]) => {
          (window as unknown as { copiedHtml: string }).copiedHtml = await (
            await items[0].getType('text/html')
          ).text();
        },
      },
      configurable: true,
    });
  });
  let job: FormattingJob = {
    ...structuredClone(base),
    platform: 'wechat',
    model: '',
    prompt_version: '',
    rules_version: 'wechat-1',
    result: {
      ...structuredClone(output),
      wechat: {
        blocks: [
          { source_block_id: 'b0-synthetic', html: '<h2>技术说明</h2>' },
          {
            source_block_id: 'b1-synthetic',
            html: '<p>完整保留正文与代码。</p><pre><code>  example()</code></pre>',
          },
        ],
        issues: [],
      },
    },
  };
  const writes: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') writes.push(path);
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
      if (path.endsWith('/confirm')) job = { ...job, status: 'adopted', confirmed: true };
      value = job;
    }
    await route.fulfill({ json: value });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(origin + '/formatting/sample');
  await expect(
    page.frameLocator('iframe[title="公众号本地稿预览"]').getByText('完整保留正文与代码。'),
  ).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (process.env.UPDATE_FORMATTING_SCREENSHOTS === 'true')
      await page.screenshot({
        path: resolve(root, 'docs/assets/wechat-formatting-' + width + '.png'),
        fullPage: true,
      });
  }
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: '复制排版内容' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copiedHtml?: string }).copiedHtml))
    .toContain('<h2>技术说明</h2>');
  await page.getByRole('button', { name: '确认本地稿' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toBe('/api/formatting-jobs/sample/confirm');
  expect(await page.getByRole('button', { name: /上传|发布/ }).count()).toBe(0);
});

test('仅启用本地转换时从新建原稿生成公众号稿', async ({ page }) => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const job: FormattingJob = {
    ...structuredClone(base),
    platform: 'wechat',
    rules_version: 'wechat-1',
    prompt_version: '',
    model: '',
    result: {
      ...structuredClone(output),
      wechat: {
        blocks: [{ source_block_id: 'b0-synthetic', html: '<p>合成原稿正文。</p>' }],
        issues: [],
      },
    },
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'POST') requests.push({ path, body: req.postDataJSON() });
    let value: unknown = { items: [] };
    if (path === '/api/session')
      value = {
        user: { id: 'synthetic', username: '合成验证', role: 'admin' },
        csrf_token: 'synthetic',
      };
    else if (path === '/api/formatting-capabilities')
      value = { enabled: false, local_enabled: true, platforms: [], max_input_characters: 30000 };
    else if (path === '/api/formatting-sessions') value = { id: 'sample-session' };
    else if (path === '/api/formatting-sessions/sample-session/jobs') value = job;
    else if (path === '/api/formatting-jobs/sample') value = job;
    await route.fulfill({ json: value });
  });
  await page.goto(origin + '/formatting/new');
  await expect(page.getByLabel('目标平台')).toHaveValue('wechat');
  await page.getByLabel('原稿标题').fill('合成原稿标题');
  await page.getByLabel('原稿 Markdown').fill('合成原稿正文。');
  await page.getByRole('button', { name: '生成公众号本地稿' }).click();
  await expect(
    page.frameLocator('iframe[title="公众号本地稿预览"]').getByText('合成原稿正文。'),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0].body).toMatchObject({ platforms: ['wechat'], allow_ai_processing: false });
  expect(requests[1].body).toMatchObject({ platform: 'wechat', template: '' });
  expect(await page.getByRole('button', { name: /上传|发布/ }).count()).toBe(0);
});

test('公众号建议需单篇授权，窄屏可核对差异并恢复读取', async ({ page }) => {
  const original = '符合条件时才继续。';
  const candidate = '符合全部条件时才继续。';
  const writes: Record<string, unknown>[] = [];
  let rejectJobRead = true;
  const job: FormattingJob = {
    ...base,
    platform: 'wechat',
    mode: 'ai_assisted',
    result: {
      ...output,
      wechat: {
        blocks: [{ source_block_id: 'b0-synthetic', html: '<p>' + candidate + '</p>' }],
        candidate_markdown: candidate,
        issues: [],
        suggestions: {
          title: '合成建议标题',
          summary: '保留执行前提。',
          structure: [{ source_block_id: 'b0-synthetic', text: '先说明适用条件。' }],
          issues: [],
        },
      },
    },
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') writes.push(request.postDataJSON());
    let value: unknown = { items: [] };
    if (path === '/api/session')
      value = {
        user: { id: 'synthetic', username: '合成验证', role: 'admin' },
        csrf_token: 'synthetic',
      };
    else if (path === '/api/formatting-capabilities')
      value = {
        enabled: true,
        local_enabled: true,
        modes: { wechat: ['fidelity', 'ai_assisted'] },
      };
    else if (
      path === '/api/formatting-sessions' ||
      path === '/api/formatting-sessions/sample-session'
    )
      value = {
        id: 'sample-session',
        snapshot: { title: '合成原稿', body: original },
        preparation_id: '',
      };
    else if (path === '/api/formatting-sessions/sample-session/jobs') value = job;
    else if (path === '/api/formatting-jobs/sample') {
      if (rejectJobRead) {
        rejectJobRead = false;
        await route.fulfill({
          status: 503,
          json: { code: 'unavailable', message: '暂时无法读取任务。' },
        });
        return;
      }
      value = job;
    }
    await route.fulfill({ json: value });
  });
  await page.goto(origin + '/formatting/new');
  await page.getByLabel('目标平台').selectOption('wechat');
  await page.getByLabel('原稿标题').fill('合成原稿');
  await page.getByLabel('原稿 Markdown').fill(original);
  await page.getByLabel('处理模式').selectOption('ai_assisted');
  const consent = page.getByRole('checkbox', { name: '允许 DeepSeek 处理本篇原稿' });
  const generate = page.getByRole('button', { name: '生成公众号本地稿' });
  await expect(generate).toBeDisabled();
  await consent.check();
  await page.getByLabel('原稿标题').fill('更新的合成原稿');
  await expect(consent).not.toBeChecked();
  await consent.check();
  await generate.click();
  await expect(page.getByRole('alert')).toContainText('暂时无法读取任务');
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ mode: 'ai_assisted', allow_ai_processing: true });
  expect(writes[1]).toMatchObject({ mode: 'ai_assisted', platform: 'wechat' });
  await page.getByRole('button', { name: '重试读取' }).click();
  const suggestions = page.locator('summary').filter({ hasText: 'AI 辅助建议' });
  await expect(suggestions).toBeVisible();
  await page.goto(origin + '/formatting/sample');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await suggestions.click();
  await expect(page.getByText('原稿第 1 段：先说明适用条件。')).toBeVisible();
  const difference = page.getByText('正文差异', { exact: true });
  await difference.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('mark.after')).toHaveText('全部');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (process.env.UPDATE_FORMATTING_SCREENSHOTS === 'true')
      await page.screenshot({
        path: resolve(root, 'docs/assets/wechat-review-' + width + '.png'),
        fullPage: true,
      });
  }
  const edit = page.getByRole('button', { name: '编辑候选稿' });
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('候选稿 Markdown')).toBeFocused();
  await page.getByRole('button', { name: '取消编辑' }).click();
  await expect(edit).toBeFocused();
  expect(writes).toHaveLength(2);
});

test('公众号候选编辑与本地图片建立新修订', async ({ page }) => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9QAAAABJRU5ErkJggg==';
  const image = {
    id: 'b0-image:0',
    source_block_id: 'b0-image',
    source: 'https://example.test/image.png',
    alt: '合成图片',
  };
  let job: FormattingJob = {
    ...structuredClone(base),
    platform: 'wechat',
    rules_version: 'wechat-1',
    status: 'needs_review',
    result: {
      ...structuredClone(output),
      wechat: {
        blocks: [{ source_block_id: 'b0-image', html: '<span>[图片：合成图片]</span>' }],
        issues: [
          { code: 'image_unavailable', field: 'b0-image', message: '图片需要核对', blocking: true },
        ],
        images: [image],
        candidate_markdown: '![合成图片](https://example.test/image.png)',
      },
    },
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') writes.push({ path, body: req.postDataJSON() });
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
          body: '![合成图片](https://example.test/image.png)',
          body_format: 'markdown',
          tags: [],
        },
      };
    else if (path === '/api/formatting-jobs/sample/wechat') {
      job = { ...job, revision: 2, status: 'queued', operation: 'wechat_edit' };
      value = job;
    } else if (path === '/api/formatting-jobs/sample') {
      if (job.status === 'queued')
        job = {
          ...job,
          status: 'succeeded',
          result: {
            ...job.result!,
            wechat: {
              ...job.result!.wechat!,
              blocks: [
                {
                  source_block_id: 'b0-image',
                  html: `<img src="data:image/png;base64,${png}" alt="合成图片">`,
                },
              ],
              issues: [],
              attachments: [
                { image_id: image.id, data: png, media_type: 'image/png', sha256: 'synthetic' },
              ],
            },
          },
        };
      value = job;
    }
    await route.fulfill({ json: value });
  });
  await page.goto(origin + '/formatting/sample');
  await page.getByRole('button', { name: '编辑候选稿' }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (process.env.UPDATE_FORMATTING_SCREENSHOTS === 'true')
      await page.screenshot({
        path: resolve(root, 'docs/assets/wechat-edit-' + width + '.png'),
        fullPage: true,
      });
  }
  await page
    .getByLabel('选择第 1 张图片')
    .setInputFiles({ name: '合成.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByRole('button', { name: '移除第 1 张素材' })).toBeVisible();
  await page.getByRole('button', { name: '保存并重新排版' }).click();
  await expect(
    page.frameLocator('iframe[title="公众号本地稿预览"]').getByAltText('合成图片'),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .frameLocator('iframe[title="公众号本地稿预览"]')
        .getByAltText('合成图片')
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({
    revision: 1,
    attachments: [{ image_id: image.id, data: png }],
  });
  await expect(page.getByRole('button', { name: '确认本地稿' })).toBeVisible();
});

test('公众号预览和复制不会加载外站图片或执行危险内容', async ({ page }) => {
  let externalRequests = 0;
  await page.route('https://example.test/**', async (route) => {
    externalRequests++;
    await route.abort();
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          (window as unknown as { copiedHtml: string }).copiedHtml = await (
            await items[0].getType('text/html')
          ).text();
        },
      },
    });
  });
  const job: FormattingJob = {
    ...structuredClone(base),
    platform: 'wechat',
    result: {
      ...structuredClone(output),
      wechat: {
        blocks: [
          {
            source_block_id: 'b0',
            html: '<script>window.unsafe=true</script><img src="https://example.test/pixel.png" onerror="alert(1)"><a href="javascript:alert(1)">危险链接</a><p onclick="alert(1)">正常正文</p>',
          },
        ],
        issues: [],
      },
    },
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
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
          body: '合成原文',
          body_format: 'markdown',
          tags: [],
        },
      };
    else if (path === '/api/formatting-jobs/sample') value = job;
    await route.fulfill({ json: value });
  });
  await page.goto(origin + '/formatting/sample');
  const frame = page.frameLocator('iframe[title="公众号本地稿预览"]');
  await expect(frame.getByText('正常正文')).toBeVisible();
  await expect(frame.getByText('[图片不可用]')).toBeVisible();
  expect(await frame.locator('script, img, [onclick], [onerror]').count()).toBe(0);
  await page.getByRole('button', { name: '复制排版内容' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as unknown as { copiedHtml?: string }).copiedHtml),
    )
    .toBe('string');
  const copied = await page.evaluate(
    () => (window as unknown as { copiedHtml: string }).copiedHtml,
  );
  expect(copied).not.toContain('<script');
  expect(copied).not.toContain('javascript:');
  expect(copied).not.toContain('https://example.test');
  expect(externalRequests).toBe(0);
});
