import { test, expect, login } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import type { Stack } from './fixtures';
test.use({ xiaohongshu: true });
async function xhs(request: APIRequestContext, stack: Stack, path: string, data: object) {
  return request.post(stack.url + path, {
    headers: { Authorization: 'Bearer ' + stack.xhsWorkerToken },
    data,
  });
}
test('小红书账号隔离、只读快照、键盘及窄屏', async ({ page, stack, request }, info) => {
  await login(page, stack);
  await page.getByRole('link', { name: '平台账号', exact: true }).click();
  const picker = page.getByRole('combobox', { name: '选择平台账号' });
  await expect(picker.locator('option')).toHaveCount(2);
  await picker.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveValue('xhs-main');
  await expect(page.getByText('尚未同步笔记', { exact: true })).toBeVisible();
  const accepted = page.waitForResponse(
    (r) => r.url().endsWith('/api/accounts/xhs-main/notes/sync') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '同步笔记', exact: true }).click();
  const job = await (await accepted).json();
  const csdnClaim = await request.post(stack.url + '/internal/worker/claim', {
    headers: { Authorization: 'Bearer ' + stack.workerToken },
    data: { worker_id: 'synthetic-csdn' },
  });
  expect(csdnClaim.status()).toBe(204);
  const claimed = await (
    await xhs(request, stack, '/internal/worker/claim', { worker_id: 'synthetic-xhs' })
  ).json();
  expect(claimed.job.id).toBe(job.id);
  const base = '/internal/worker/jobs/' + job.id;
  const lease = { lease_token: claimed.lease_token };
  for (const stage of ['checking_login', 'verifying'])
    expect((await xhs(request, stack, base + '/progress', { ...lease, stage })).ok()).toBeTruthy();
  const identity = { username: 'synthetic-red', user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
  const entries = Array.from({ length: 21 }, (_, n) => ({
    id: n.toString(16).padStart(24, 'b'),
    title: '合成笔记 ' + n,
    status: 'unknown',
    platform_status: '',
    posted_at: '',
    views: null,
    likes: 0,
    comments: null,
    favorites: null,
  }));
  expect(
    (
      await xhs(request, stack, base + '/complete', {
        ...lease,
        status: 'succeeded',
        account_identity: identity,
        notes: { ...identity, items: entries },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByRole('button', { name: '刷新本地状态', exact: true }).click();
  await expect(page.getByText('合成笔记 0', { exact: true })).toBeVisible();
  await expect(page.getByText('共 21 条记录', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '公开发布', exact: true })).toHaveCount(0);
  await expect(page.getByText('发布预设', { exact: true })).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await page.screenshot({
      path: info.outputPath('xiaohongshu-' + width + '.png'),
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByText('合成笔记 20', { exact: true })).toBeVisible();
  await page.getByLabel('搜索笔记').fill('合成笔记 1');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByText('共 11 条记录', { exact: true })).toBeVisible();
  await picker.selectOption('csdn-main');
  await expect(page.getByRole('button', { name: '同步文章', exact: true })).toBeVisible();
  await expect(page.getByText('合成笔记 1', { exact: true })).toHaveCount(0);
  await picker.selectOption('xhs-main');
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '检查登录状态', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始远程登录', exact: true })).toHaveCount(0);
});
