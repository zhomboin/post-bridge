import { test as base, expect } from '@playwright/test';
import { preview } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const client = { id: 'client-example', name: '演示内容中心', source_id: 'editorial', environment: 'test', service_id: 'post-bridge', status: 'active', scopes: ['targets:read', 'preparations:write', 'preparations:read', 'distributions:write', 'distributions:read'], accounts: ['csdn-example'], operations: ['save_draft'], grant_version: 1, expires_at: '2099-01-01T00:00:00Z', rate_limit_per_minute: 60 };
const test = base.extend<{}, { previewUrl: string }>({
  previewUrl: [async ({}, use) => {
    const server = await preview({ root: resolve(root, 'apps/admin'), configFile: false, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
    try {
      const address = server.httpServer.address();
      if (!address || typeof address === 'string') throw Error('未取得独立预览地址');
      await use('http://127.0.0.1:' + address.port);
    } finally {
      await new Promise<void>((done, reject) => server.httpServer.close(error => error ? reject(error) : done()));
    }
  }, { scope: 'worker' }],
});

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const value = path === '/api/session' ? { user: { username: '演示管理员' }, csrf_token: 'synthetic-csrf' }
      : path === '/api/integration-clients' ? { items: [client] }
      : path === '/api/integration-clients/client-example' ? client
      : path === '/api/integration-registrations' ? { items: [{ ...client, grant_version: undefined, status: 'pending', created_at: '2026-01-01T00:00:00Z' }] }
      : { items: [], total: 0, page: 1, page_size: 50 };
    await route.fulfill({ json: value });
  });
});

test('固定授权表单只提交本地身份与权限，桌面和窄屏可完整操作', async ({ page, previewUrl }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(previewUrl + '/integrations?tab=clients');
    await page.getByRole('button', { name: '演示内容中心', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存应用配置', exact: true })).toBeVisible();
    await expect(page.getByText('反向来源', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('来源地址', { exact: true })).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('应用授权-' + width + '.png'), fullPage: true });
    const request = page.waitForRequest(request => request.method() === 'PUT');
    await page.getByRole('button', { name: '保存应用配置', exact: true }).click();
    const sent = await request;
    expect(Object.keys(sent.postDataJSON()).sort()).toEqual(['source_id', 'scopes', 'accounts', 'operations', 'expires_at', 'rate_limit_per_minute'].sort());
    expect(sent.postDataJSON().operations).toEqual(['save_draft']);
    expect(sent.headers()['x-csrf-token']).toBe('synthetic-csrf');
  }
  expect(errors).toEqual([]);
});

test('审批不要求反向服务，邀请弹窗支持键盘关闭与焦点返回', async ({ page, previewUrl }) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.goto(previewUrl + '/integrations?tab=registrations');
  await page.getByRole('button', { name: '审批', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '批准 演示内容中心' })).toBeVisible();
  await expect(page.getByLabel('允许账号（逗号分隔）')).toHaveValue('csdn-example');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '批准并签发密钥', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const tab = page.getByRole('tab', { name: '申请', exact: true });
  await tab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '邀请', exact: true })).toBeFocused();
  const open = page.getByRole('button', { name: '创建邀请', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: '创建邀请' });
  const close = dialog.getByRole('button', { name: '关闭', exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '生成邀请', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});