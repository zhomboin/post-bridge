import { test, expect, login } from './fixtures';

test('登录弹窗限制焦点，Escape 撤销验证并停止画面请求', async ({ page, stack }) => {
  await login(page, stack);
  const stopWorker = stack.startWorker();
  try {
    await page.goto('/account');
    const start = page.getByRole('button', { name: '开始远程登录', exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    const dialog = page.getByRole('dialog', { name: 'CSDN 登录' });
    await expect(dialog).toBeVisible();
    const image = dialog.getByRole('img', { name: 'CSDN 远程登录画面' });
    await expect(image).toBeVisible();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog.getByRole('button', { name: '向下滚动', exact: true }).focus();
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
    }
    await image.focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('远程登录已结束', { exact: true })).toBeVisible();
    await expect(start).toBeFocused();
    let frames = 0;
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/frame')) frames++; });
    await expect.poll(async () => (await (await page.request.get('/api/account/login')).json()).status).toBe('idle');
    await page.waitForTimeout(1300);
    expect(frames).toBe(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  } finally { await stopWorker(); }
});
