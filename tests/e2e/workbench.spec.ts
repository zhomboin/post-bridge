import { test, expect, login, csrf, finishDraft, worker } from './fixtures';
import { randomUUID } from 'node:crypto';

test('隔离后台 API 已就绪且管理数据要求登录', async ({ request }) => {
  const ready = await request.get('/healthz').then(response => response.status() === 200).catch(() => false);
  expect(ready, '测试应启动独立真实 Go API 和数据库 schema').toBe(true);
  expect((await request.get('/api/jobs')).status()).toBe(401);
  expect((await request.get('/api/logs')).status()).toBe(401);
  expect((await request.post('/internal/worker/claim', { data: { worker_id: 'anonymous' } })).status()).toBe(401);
});

test('管理员在后台新建草稿并查看固定执行器结果及脱敏日志', async ({ page, stack }, info) => {
  await login(page, stack);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('总览-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: '新建草稿', exact: true }).click();
  await page.getByLabel('文章标题', { exact: true }).fill('独立后台草稿验证');
  const markdown = '# 合成稿件\n\n此正文仅供本地模拟验证，不访问真实平台。';
  await page.getByLabel('Markdown 正文').fill(markdown);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.getByLabel('Markdown 预览')).toContainText('合成稿件');
  const posted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/jobs'));
  await page.getByRole('button', { name: '保存到CSDN草稿', exact: true }).click();
  const response = await posted;
  expect(response.status()).toBe(202);
  const job = await response.json();
  await expect(page.getByRole('heading', { name: job.title, exact: true })).toBeVisible();
  await expect(page.locator('.snapshot')).toHaveText(markdown);
  await finishDraft(page.request, stack, job.id);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '查看CSDN草稿' })).toHaveAttribute('href', 'https://editor.csdn.net/md/?articleId=123456789');
  await page.getByRole('button', { name: '刷新日志', exact: true }).click();
  await expect(page.getByText('执行器已上报任务结果', { exact: true })).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('任务详情-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const logs = await page.request.get('/api/logs?job_id=' + job.id);
  const text = await logs.text();
  expect(text).not.toContain('synthetic-secret');
  expect(text).not.toContain('此正文');
  await page.getByRole('link', { name: '处理记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '处理记录', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '全部日志', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部日志', exact: true })).toBeVisible();
  await page.getByLabel('关联任务ID', { exact: true }).fill(job.id);
  const filtered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/logs' && new URL(response.url()).searchParams.get('job_id') === job.id);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await filtered;
  await expect(page.getByText('任务已加入队列', { exact: true })).toHaveCount(1);
  await expect(page.getByText('任务已加入队列', { exact: true })).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByRole('heading', { name: '全部日志', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('日志-' + width + '.png'), fullPage: true });
  }
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录发布工作台' })).toBeVisible();
  expect((await page.request.get('/api/jobs')).status()).toBe(401);
});

test('真实管理接口拒绝公开发布与跨站写入并保证请求幂等', async ({ page, stack }) => {
  await login(page, stack);
  const token = await csrf(page.request);
  const headers = { Origin: stack.url, 'X-CSRF-Token': token };
  const body = { request_id: randomUUID(), kind: 'save_draft', platform: 'csdn', title: '安全边界合成稿件', markdown: '仅供安全接口验证。' };
  expect((await page.request.post('/api/jobs', { headers: { Origin: stack.url }, data: body })).status()).toBe(403);
  expect((await page.request.post('/api/jobs', { headers: { ...headers, Origin: 'https://invalid.example' }, data: body })).status()).toBe(403);
  expect((await page.request.post('/api/jobs', { headers, data: { ...body, kind: 'publish' } })).status()).toBe(400);
  const first = await page.request.post('/api/jobs', { headers, data: body });
  expect(first.status()).toBe(202);
  const original = await first.json();
  const replay = await page.request.post('/api/jobs', { headers, data: body });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).id).toBe(original.id);
  expect((await page.request.post('/api/jobs', { headers, data: { ...body, markdown: '同标识不同内容。' } })).status()).toBe(409);
  expect((await page.request.post('/internal/worker/claim', { headers, data: { worker_id: 'admin-cookie' } })).status()).toBe(401);
  const cancelled = await page.request.post('/api/jobs/' + original.id + '/cancel', { headers, data: {} });
  expect(cancelled.status()).toBe(200);
  expect((await cancelled.json()).status).toBe('cancelled');
  expect((await page.request.get('/assets/absent.js')).status()).toBe(404);
  const missing = await page.request.get('/api/absent');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');
});

test('未知结果阻止新建且人工结束保留事实并禁止重试', async ({ page, stack }, info) => {
  await login(page, stack);
  const token = await csrf(page.request);
  const headers = { Origin: stack.url, 'X-CSRF-Token': token };
  const create = async (title: string) => {
    const response = await page.request.post('/api/jobs', { headers, data: {
      request_id: randomUUID(), kind: 'save_draft', platform: 'csdn', title, markdown: '独立模拟的不可变文字快照。',
    } });
    expect(response.status()).toBe(202);
    return response.json();
  };
  const original = await create('需要核对的合成草稿');
  let claim = await (await worker(page.request, stack, '/internal/worker/claim', { worker_id: 'e2e-fixed-worker' })).json();
  expect(claim.job.id).toBe(original.id);
  const path = '/internal/worker/jobs/' + original.id;
  await worker(page.request, stack, path + '/progress', { lease_token: claim.lease_token, stage: 'opening_editor', external_started: true });
  await worker(page.request, stack, path + '/complete', { lease_token: claim.lease_token, status: 'failed', error_code: 'timeout', error_message: 'Cookie=synthetic-secret' });
  const queued = await create('未决结果之后的合成稿');
  const blocked = await page.request.post('/internal/worker/claim', { headers: { Authorization: 'Bearer ' + stack.workerToken }, data: { worker_id: 'e2e-fixed-worker' } });
  expect(blocked.status()).toBe(204);
  await page.goto('/jobs/' + original.id);
  await expect(page.getByText('后台正在自动查询草稿', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试任务', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('候选草稿ID（可选，仅数字）', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '正在自动核对…', exact: true })).toBeDisabled();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('草稿自动核对-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (let round = 0; round < 4; round++) {
    const schedule = await page.request.post('/api/jobs/' + original.id + '/reconcile', { headers, data: {} });
    expect(schedule.status()).toBe(200);
    claim = await (await worker(page.request, stack, '/internal/worker/claim', { worker_id: 'e2e-fixed-worker' })).json();
    expect(claim.job.id).toBe(original.id);
    expect(claim.job.run_mode).toBe('reconcile');
    await worker(page.request, stack, path + '/progress', { lease_token: claim.lease_token, stage: 'verifying' });
    await worker(page.request, stack, path + '/complete', { lease_token: claim.lease_token, status: 'failed', error_code: 'reconcile_unavailable' });
  }
  const exhausted = await (await page.request.get('/api/jobs/' + original.id)).json();
  expect(exhausted.status).toBe('failed');
  expect(exhausted.outcome).toBe('unknown');
  expect(exhausted.error_code).toBe('reconcile_exhausted');
  expect(exhausted.reconcile_count).toBe(4);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('草稿查询未完成', { exact: true })).toBeVisible();
  await expect(page.getByLabel('候选草稿ID（可选，仅数字）', { exact: true })).toBeEnabled();
  await page.getByLabel('候选草稿ID（可选，仅数字）', { exact: true }).fill('987654321');
  const manualReconcile = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/jobs/' + original.id + '/reconcile'));
  await page.getByRole('button', { name: '重新自动核对', exact: true }).click();
  expect((await manualReconcile).status()).toBe(200);
  claim = await (await worker(page.request, stack, '/internal/worker/claim', { worker_id: 'e2e-fixed-worker' })).json();
  expect(claim.job.run_mode).toBe('reconcile');
  expect(claim.job.remote_id).toBe('');
  expect(claim.job.reconcile_candidate_id).toBe('987654321');
  await worker(page.request, stack, path + '/progress', { lease_token: claim.lease_token, stage: 'verifying' });
  await worker(page.request, stack, path + '/complete', { lease_token: claim.lease_token, status: 'failed', error_code: 'draft_mismatch' });
  await worker(page.request, stack, '/internal/worker/heartbeat', { worker_id: 'e2e-fixed-worker', browser_idle: true, profile_available: true });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('草稿核对存在冲突', { exact: true })).toBeVisible();
  await page.getByText('无法匹配完整稿件', { exact: true }).click();
  await page.getByLabel('我已确认本任务浏览器停止，并保留可能存在的草稿').check();
  await page.getByLabel('人工结束原因').fill('合成用例：保留已有草稿，不再次提交。');
  await page.getByRole('button', { name: '保留草稿并结束任务', exact: true }).click();
  await expect(page.getByText('已人工结束，草稿可能保留', { exact: true })).toBeVisible();
  const ended = await (await page.request.get('/api/jobs/' + original.id)).json();
  expect(ended.manual_resolved).toBe(true);
  expect(ended.outcome).toBe('unknown');
  expect(ended.external_started).toBe(true);
  expect(ended.retry_allowed).toBe(false);
  expect((await page.request.post('/api/jobs/' + original.id + '/retry', { headers, data: {} })).status()).toBe(409);
  expect((await page.request.post('/api/jobs/' + queued.id + '/cancel', { headers, data: {} })).status()).toBe(200);
});
