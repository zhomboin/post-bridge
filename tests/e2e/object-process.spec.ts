import { test, expect, login, csrf, worker } from './fixtures';
import { randomUUID } from 'node:crypto';

test('对象处理记录可查看真实字段前后值、状态流程与最终结果', async ({ page, stack }, info) => {
  await login(page, stack);
  const token = await csrf(page.request),
    headers = { Origin: stack.url, 'X-CSRF-Token': token };
  const title = '对象处理记录合成文章';
  const markdown = '第一行保持不变\n新文字\n```html\n<script>合成代码</script>\n```';
  const created = await page.request.post('/api/jobs', {
    headers,
    data: { request_id: randomUUID(), kind: 'save_draft', platform: 'csdn', title, markdown },
  });
  expect(created.status()).toBe(202);
  const job = await created.json();
  const claim = await (
    await worker(page.request, stack, '/internal/worker/claim', {
      worker_id: 'object-process-worker',
    })
  ).json();
  const path = '/internal/worker/jobs/' + job.id,
    lease = { lease_token: claim.lease_token };
  await worker(page.request, stack, path + '/progress', { ...lease, stage: 'checking_login' });
  await worker(page.request, stack, path + '/progress', {
    ...lease,
    stage: 'opening_editor',
    external_started: true,
  });
  await worker(page.request, stack, path + '/progress', {
    ...lease,
    stage: 'draft_acquired',
    remote_id: '223456789',
  });
  await worker(page.request, stack, path + '/progress', {
    ...lease,
    stage: 'filling',
    observation: {
      phase: 'before',
      title: '【无标题】',
      markdown: '第一行保持不变\n编辑器原有文字',
      status: 'editor',
      remote_id: '223456789',
    },
  });
  await worker(page.request, stack, path + '/progress', { ...lease, stage: 'saving' });
  await worker(page.request, stack, path + '/progress', {
    ...lease,
    stage: 'verifying',
    observation: { phase: 'after', title, markdown, status: '2', remote_id: '223456789' },
  });
  await worker(page.request, stack, path + '/complete', {
    ...lease,
    status: 'succeeded',
    remote_id: '223456789',
  });
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: '处理记录', exact: true })).toBeVisible();
  const link = page.getByRole('link', { name: title, exact: true });
  await expect(link).toHaveCount(1);
  const row = page.getByRole('row').filter({ has: link });
  await expect(row).toContainText('CSDN');
  await expect(row).toContainText('演示创作者');
  await expect(row).toContainText('草稿已保存');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('对象处理列表-' + width + '.png'),
      fullPage: true,
    });
  }
  await link.click();
  await expect(page.getByRole('region', { name: '状态流转' })).toBeVisible();
  await expect(page.getByRole('region', { name: '状态流转' })).toContainText('保存草稿');
  await expect(page.getByRole('region', { name: '状态流转' })).toContainText('执行完成');
  await page.getByRole('button', { name: '查看内容变更', exact: true }).click();
  const comparison = page.getByRole('region', { name: '内容变更' });
  await expect(comparison).toContainText('编辑器原有文字');
  await expect(comparison).toContainText('新文字');
  await expect(comparison).toContainText('<script>合成代码</script>');
  await expect(comparison.locator('mark')).not.toHaveCount(0);
  await expect(comparison.locator('script')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '处理日志' })).toContainText(
    '执行器已上报任务结果',
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('对象处理详情-' + width + '.png'),
      fullPage: true,
    });
  }
  await page.getByRole('link', { name: '任务详情', exact: true }).click();
  await page.getByRole('link', { name: '返回处理详情', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/logs/' + job.id));
  const logs = await (await page.request.get('/api/logs?job_id=' + job.id)).text();
  expect(logs).not.toContain('编辑器原有文字');
  expect(logs).not.toContain('合成代码');
  await page.getByRole('link', { name: '返回处理记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '处理记录', exact: true })).toBeVisible();
  await page.route('**/api/jobs/' + job.id + '/history?*', async (route) => {
    const response = await route.fetch(),
      history = await response.json();
    const stagesOnly = (entries: Record<string, unknown>[]) =>
      entries.map((entry) => ({ ...entry, status: '', outcome: '', run_mode: '' }));
    await route.fulfill({
      response,
      json: {
        ...history,
        items: stagesOnly(history.items),
        transitions: stagesOnly(history.transitions),
      },
    });
  });
  await page.goto('/logs/' + job.id);
  const observed = page.getByRole('region', { name: '状态流转' });
  await expect(observed).toContainText('部分状态未采集');
  await expect(observed).toContainText('保存草稿');
  await expect(
    observed.locator('.workflow-node').getByText('执行完成', { exact: true }),
  ).toHaveCount(0);
  await expect(
    observed.locator('.workflow-node').getByText('只读核对', { exact: true }),
  ).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('已有步骤流程-' + width + '.png'),
      fullPage: true,
    });
  }
});

test('同一账号两次检查分成两条处理记录', async ({ page, stack }) => {
  await login(page, stack);
  const token = await csrf(page.request),
    headers = { Origin: stack.url, 'X-CSRF-Token': token };
  for (let i = 0; i < 2; i++) {
    const created = await page.request.post('/api/account/check', {
      headers,
      data: { request_id: randomUUID() },
    });
    expect(created.status()).toBe(202);
    const job = await created.json();
    const claim = await (
      await worker(page.request, stack, '/internal/worker/claim', {
        worker_id: 'account-check-worker',
      })
    ).json();
    expect(claim.job.id).toBe(job.id);
    await worker(page.request, stack, '/internal/worker/jobs/' + job.id + '/progress', {
      lease_token: claim.lease_token,
      stage: 'checking_login',
    });
    await worker(page.request, stack, '/internal/worker/jobs/' + job.id + '/complete', {
      lease_token: claim.lease_token,
      status: 'succeeded',
    });
  }
  await page.goto('/logs?kind=check_account');
  const records = page.getByRole('link', { name: '演示创作者', exact: true });
  await expect(records).toHaveCount(2);
  await records.first().click();
  await page.getByRole('button', { name: '查看内容变更', exact: true }).click();
  await expect(page.getByRole('region', { name: '内容变更' })).toContainText('连接状态');
  await expect(page.getByRole('region', { name: '内容变更' })).toContainText('已连接');
});
