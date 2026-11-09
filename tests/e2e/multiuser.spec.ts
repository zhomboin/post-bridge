import { randomBytes } from 'node:crypto';
import { test, expect, login } from './fixtures';

test('独立用户绑定同平台多个账号，任务归属及窄屏上下文隔离', async ({
  page,
  stack,
  browser,
  request,
}, info) => {
  await login(page, stack);
  await page.getByRole('link', { name: '用户管理', exact: true }).click();
  const password = randomBytes(24).toString('hex');
  await page.getByLabel('账号', { exact: true }).fill('synthetic-writer');
  await page.getByLabel('初始密码').fill(password);
  await page.getByRole('button', { name: '创建用户', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'synthetic-writer', exact: true })).toBeVisible();
  await expect(page.getByLabel('初始密码')).toHaveValue('');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await page.screenshot({
      path: info.outputPath('multiuser-users-' + width + '.png'),
      fullPage: true,
    });
  }
  const context = await browser.newContext({ baseURL: stack.url, locale: 'zh-CN' });
  try {
    await context.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    const own = await context.newPage();
    await login(own, { ...stack, username: 'synthetic-writer', password });
    await expect(own.getByRole('link', { name: '用户管理', exact: true })).toHaveCount(0);
    await own.getByRole('link', { name: '平台账号', exact: true }).click();
    await expect(own.getByText('尚未绑定平台账号', { exact: true })).toBeVisible();
    expect((await own.request.get('/api/accounts/csdn-main')).status()).toBe(404);
    const ids: string[] = [];
    for (const [username, label] of [
      ['synthetic_alpha', '合成账号甲'],
      ['synthetic_beta', '合成账号乙'],
    ]) {
      await own.getByRole('button', { name: '绑定账号', exact: true }).click();
      await own.getByLabel('CSDN 用户名').fill(username);
      await own.getByLabel('显示名称').fill(label);
      const response = own.waitForResponse(
        (r) => r.url().endsWith('/api/accounts') && r.request().method() === 'POST',
      );
      await own.getByRole('button', { name: '绑定并登录', exact: true }).click();
      const result = await (await response).json();
      ids.push(result.account.id);
      await expect(own).toHaveURL(new RegExp('account=' + result.account.id));
      // 固定模拟执行器证明身份，不访问真实平台，也不把执行凭据写入浏览器。
      const descriptor = await request.get(stack.url + '/internal/worker/accounts', {
        headers: { Authorization: 'Bearer ' + stack.workerToken },
      });
      const account = (await descriptor.json()).items.find(
        (item: { id: string }) => item.id === result.account.id,
      );
      const verified = await request.post(stack.url + '/internal/worker/identity', {
        headers: { Authorization: 'Bearer ' + account.token },
        data: {},
      });
      expect(verified.status()).toBe(200);
    }
    await own.reload();
    const picker = own.getByRole('combobox', { name: '选择平台账号' });
    await expect(picker.locator('option')).toHaveCount(2);
    await picker.selectOption(ids[0]);
    await picker.focus();
    await own.keyboard.press('End');
    await own.keyboard.press('Enter');
    await expect(picker).toHaveValue(
      (await picker.locator('option').last().getAttribute('value'))!,
    );
    await picker.selectOption(ids[1]);
    await expect(own).toHaveURL(new RegExp('account=' + ids[1]));
    for (const width of [1440, 390, 320]) {
      await own.setViewportSize({ width, height: 1000 });
      await own.emulateMedia({ reducedMotion: 'reduce' });
      expect(
        await own.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBeTruthy();
      await own.screenshot({
        path: info.outputPath('multiuser-accounts-' + width + '.png'),
        fullPage: true,
      });
    }
    await own.goto('/jobs/new?account=' + ids[1]);
    await own.getByLabel('文章标题', { exact: true }).fill('合成账号独立草稿验证');
    await own.getByLabel('Markdown 正文').fill('只包含合成正文，不访问真实平台。');
    const created = own.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/jobs' && r.request().method() === 'POST',
    );
    await own.getByRole('button', { name: '保存到CSDN草稿', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(202);
    const job = await response.json();
    expect(job.account_id).toBe(ids[1]);
    expect((await page.request.get(stack.url + '/api/jobs/' + job.id)).status()).toBe(404);
    await own.goto('/account?account=' + ids[1]);
    await own.getByRole('button', { name: '解绑当前账号', exact: true }).click();
    await expect(own.getByRole('group', { name: '确认解绑账号' })).toBeVisible();
    await own.getByRole('button', { name: '确认解绑', exact: true }).click();
    await expect(own.getByRole('combobox', { name: '选择平台账号' }).locator('option')).toHaveCount(
      1,
    );
    expect((await own.request.get('/api/jobs/' + job.id)).status()).toBe(200);
  } finally {
    await context.close();
  }
});
