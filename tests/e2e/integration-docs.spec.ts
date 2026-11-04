import { test as base, expect } from '@playwright/test';
import { preview } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const test = base.extend<{}, { docsUrl: string }>({
  docsUrl: [async ({}, use) => {
    const server = await preview({ root: resolve(root, 'apps/admin'), configFile: false, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
    try {
      const address = server.httpServer.address();
      if (!address || typeof address === 'string') throw Error('未取得独立文档预览地址');
      await use('http://127.0.0.1:' + address.port);
    } finally {
      await new Promise<void>((done, reject) => server.httpServer.close(error => error ? reject(error) : done()));
    }
  }, { scope: 'worker' }],
});

test.beforeEach(async ({ page }) => {
  // 仅使用合成会话，不连接真实 API、数据库或外部平台。
  await page.route('**/api/**', async route => {
    const session = new URL(route.request().url()).pathname === '/api/session';
    await route.fulfill({ json: session ? { user: { username: '演示管理员' }, csrf_token: 'synthetic-csrf' } : { items: [], total: 0, page: 1, page_size: 50 } });
  });
});

test('文档图标支持键盘进入、刷新、浏览器历史以及实际契约下载', async ({ page, docsUrl }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(docsUrl + '/jobs?page=2');
  const icon = page.getByRole('link', { name: '接入文档', exact: true });
  const target = await icon.boundingBox();
  expect(target?.width).toBeGreaterThanOrEqual(36);
  expect(target?.height).toBeGreaterThanOrEqual(36);
  await icon.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '外部系统接入', level: 1 })).toBeFocused();
  expect(new URL(page.url()).pathname).toBe('/docs/integrations');
  await page.reload();
  await expect(page.getByRole('columnheader', { name: '负责方', exact: true })).toBeVisible();
  const contractDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'OpenAPI', exact: true }).click();
  const contract = await contractDownload;
  expect(contract.suggestedFilename()).toBe('cms.openapi.yaml');
  const contractStream = await contract.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of contractStream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8')).openapi).toBe('3.1.0');
  const vectorDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: '测试向量', exact: true }).click();
  expect((await vectorDownload).suggestedFilename()).toBe('integration-contract.json');
  await page.goBack();
  await expect(page.getByRole('heading', { name: '草稿任务', level: 1 })).toBeVisible();
  expect(new URL(page.url()).search).toBe('?page=2');
  expect(errors).toEqual([]);
});

test('文档在桌面和窄屏无整页溢出，目录与横向表格可键盘操作', async ({ page, docsUrl }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(docsUrl + '/docs/integrations');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(docsUrl + '/docs/integrations');
    await expect(page.getByRole('heading', { name: '外部系统接入', level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('接入文档-' + width + '.png') });
    if (width < 720) {
      const table = page.getByRole('region', { name: '接入参数表' }).first();
      await table.focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      const summary = page.locator('.docs-mobile-contents summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      const chapter = page.getByRole('navigation', { name: '文档章节（窄屏）' }).getByRole('link', { name: '签名协议', exact: true });
      const href = await chapter.getAttribute('href');
      await chapter.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: '签名协议', level: 2 })).toBeFocused();
      expect(new URL(page.url()).hash).toBe(href);
      await expect(page.locator('.docs-mobile-contents')).not.toHaveAttribute('open');
      await page.reload();
      await expect(page.getByRole('heading', { name: '签名协议', level: 2 })).toBeFocused();
    }
  }
});

test('未登录访问文档仍进入管理员登录', async ({ page, docsUrl }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401, json: { code: 'unauthorized' } }));
  await page.goto(docsUrl + '/docs/integrations');
  await expect(page.getByRole('heading', { name: '登录发布工作台' })).toBeVisible();
  await expect(page.getByRole('link', { name: '接入文档', exact: true })).toHaveCount(0);
});

test('文档资源加载失败时保留工作台并可刷新恢复', async ({ page, docsUrl }) => {
  let fail = true;
  await page.route('**/assets/IntegrationDocs-*.js', async route => {
    if (fail) await route.abort();
    else await route.continue();
  });
  await page.goto(docsUrl + '/jobs');
  await page.getByRole('link', { name: '接入文档', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('接入文档加载失败');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: '刷新页面', exact: true }).click();
  await expect(page.getByRole('heading', { name: '外部系统接入', level: 1 })).toBeVisible();
});
