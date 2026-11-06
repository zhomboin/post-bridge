import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { Job } from '../src/runtime';

const draft: Job = {
  id: 'draft-one', request_id: 'request-one', platform: 'csdn', account_id: 'csdn-main', kind: 'save_draft',
  title: '已核验的文章标题', status: 'succeeded', outcome: 'draft_saved', stage: 'finished',
  attempts: 1, retry_count: 0, max_retries: 3, retry_allowed: false, external_started: true,
  integration_distribution_id: 'distribution-one', remote_id: '123456', cancel_requested: false,
  created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:01Z',
};
const publish: Job = {
  ...draft, id: 'publish-one', kind: 'publish', status: 'queued', outcome: 'not_submitted',
  external_started: false, publish_from_job_id: draft.id, integration_distribution_id: undefined,
};
const review = {
  title: draft.title, account_username: 'fixture-writer', confirmation_token: 'fixture-token',
  options: {
    visibility: 'fans', article_type: 'original', creation_declaration: 'none', template: 'default',
    tags: ['技术笔记'], categories: ['开发实践'], summary: '', cover_image_url: '',
  },
};
const endpoint = '/api/jobs/' + draft.id + '/publish';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type RequestCall = { url: string; init?: RequestInit };
afterEach(() => vi.unstubAllGlobals());

function openJob(job: Job, override?: (call: RequestCall) => Response | undefined) {
  window.history.replaceState({}, '', '/jobs/' + job.id);
  const calls: RequestCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const response = override?.(call);
    if (response) return response;
    if (url === '/api/session') return json({ user: { username: '管理员' }, csrf_token: 'csrf' });
    if (url === '/api/jobs/' + job.id) return json(job);
    if (url === '/api/jobs/' + publish.id) return json(publish);
    if (url === endpoint) return init?.method === 'POST' ? json(publish, 202) : json(review);
    return json({ items: [], transitions: [], total: 0 });
  }));
  render(<App />);
  return calls;
}

it('正式发布须核对冻结选项并明确确认后才提交', async () => {
  const calls = openJob(draft);
  fireEvent.click(await screen.findByRole('button', { name: '正式发布' }));
  const modal = await screen.findByRole('dialog', { name: '确认发布到 CSDN' });
  await within(modal).findByText('粉丝可见');
  expect(within(modal).getByText('fixture-writer')).toBeTruthy();
  expect(within(modal).getByText('开发实践')).toBeTruthy();
  expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(0);
  expect(document.activeElement).toBe(within(modal).getByRole('button', { name: '关闭' }));
  const confirm = within(modal).getByRole('button', { name: '确认发布' });
  fireEvent.keyDown(modal, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(confirm);
  fireEvent.click(confirm);
  await screen.findByText('等待提交发布');
  const writes = calls.filter(call => call.init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(writes[0].url).toBe(endpoint);
  expect(JSON.parse(String(writes[0].init?.body))).toEqual({ confirmation_token: 'fixture-token' });
  expect(new Headers(writes[0].init?.headers).get('X-CSRF-Token')).toBe('csrf');
  expect(screen.getByRole('link', { name: '返回关联草稿' }).getAttribute('href')).toBe('/jobs/draft-one');
});

it('重复打开只链接既有发布任务', async () => {
  const calls = openJob(draft, ({ url }) => url === endpoint ? json({ ...review, job: publish }) : undefined);
  const opener = await screen.findByRole('button', { name: '正式发布' });
  opener.focus();
  fireEvent.click(opener);
  const modal = await screen.findByRole('dialog', { name: '确认发布到 CSDN' });
  expect((await within(modal).findByRole('link', { name: '查看发布任务' })).getAttribute('href')).toContain('/jobs/publish-one');
  expect(within(modal).queryByRole('button', { name: '确认发布' })).toBeNull();
  expect(calls.some(call => call.init?.method === 'POST')).toBe(false);
  fireEvent.click(within(modal).getByRole('button', { name: '关闭' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '正式发布' }));
});

it('提交响应不明时先重新读取，恢复已经创建的任务', async () => {
  let attempted = false;
  const calls = openJob(draft, ({ url, init }) => {
    if (url !== endpoint) return undefined;
    if (init?.method === 'POST') {
      attempted = true;
      return json({ message: '暂时无法完成请求' }, 503);
    }
    return attempted ? json({ ...review, job: publish }) : undefined;
  });
  fireEvent.click(await screen.findByRole('button', { name: '正式发布' }));
  const modal = await screen.findByRole('dialog');
  fireEvent.click(await within(modal).findByRole('button', { name: '确认发布' }));
  await within(modal).findByRole('alert');
  expect(within(modal).queryByRole('button', { name: '确认发布' })).toBeNull();
  fireEvent.click(within(modal).getByRole('button', { name: '重新读取发布状态' }));
  await within(modal).findByRole('link', { name: '查看发布任务' });
  expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
});

it('未关联来源的草稿保持现有界面', async () => {
  const calls = openJob({ ...draft, integration_distribution_id: undefined });
  await screen.findByText('草稿已保存');
  expect(screen.queryByRole('button', { name: '正式发布' })).toBeNull();
  expect(calls.some(call => call.url === endpoint)).toBe(false);
});

it('未知发布结果只能只读核对，不提供重试或恢复写入', async () => {
  const job: Job = { ...publish, status: 'failed', outcome: 'unknown', external_started: true, retry_allowed: true };
  const path = '/api/jobs/' + job.id + '/reconcile';
  const calls = openJob(job, ({ url }) => url === path ? json({ ...job, status: 'reconciling', run_mode: 'reconcile' }) : undefined);
  await screen.findByText('发布结果待核对');
  expect(screen.queryByRole('button', { name: /重试|继续/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '仅核对发布结果' }));
  await waitFor(() => expect(calls.some(call => call.url === path && call.init?.method === 'POST')).toBe(true));
  expect(JSON.parse(String(calls.find(call => call.url === path)?.init?.body))).toEqual({});
});

it('平台受理仍然等待结果，只提供只读核对', async () => {
  openJob({ ...publish, status: 'failed', outcome: 'submitted', stage: 'verifying', external_started: true });
  await screen.findByText('CSDN 已受理，等待发布结果');
  expect(screen.getByRole('button', { name: '仅核对发布结果' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: '查看 CSDN 文章' })).toBeNull();
});

it('已核实发布后只链接同账号同文章的 CSDN 正文', async () => {
  const url = 'https://blog.csdn.net/fixture-writer/article/details/' + draft.remote_id;
  openJob({
    ...publish, status: 'succeeded', outcome: 'published', stage: 'finished', external_started: true,
    account_username: 'fixture-writer', remote_url: url,
  });
  await screen.findByText('已发布到 CSDN');
  const article = screen.getByRole('link', { name: '查看 CSDN 文章' });
  expect(article.getAttribute('href')).toBe(url);
  expect(article.getAttribute('rel')).toBe('noopener noreferrer');
});

it('拒绝发布任务的非 CSDN 正文链接', async () => {
  openJob({
    ...publish, status: 'succeeded', outcome: 'published', stage: 'finished', external_started: true,
    account_username: 'fixture-writer', remote_url: 'https://evil.example/fixture-writer/article/details/' + draft.remote_id,
  });
  await screen.findByText('已发布到 CSDN');
  expect(screen.queryByRole('link', { name: '查看 CSDN 文章' })).toBeNull();
});

it('来源守卫暂停时不提供登录后继续发布', async () => {
  openJob({ ...publish, status: 'waiting_user', error_code: 'source_guard_failed' });
  await screen.findByText('来源授权待处理');
  expect(screen.queryByRole('button', { name: '登录完成，继续发布' })).toBeNull();
  expect(screen.queryByRole('link', { name: '登录 CSDN' })).toBeNull();
});

it('非原创确认窗显示原文链接和已确认授权', async () => {
  const link = 'https://author.example.test/final-note';
  openJob(draft, ({ url }) => url === endpoint ? json({
    ...review, options: { ...review.options, article_type: 'translated', original_url: link, rights_confirmed: true },
  }) : undefined);
  fireEvent.click(await screen.findByRole('button', { name: '正式发布' }));
  const modal = await screen.findByRole('dialog');
  await within(modal).findByText(link);
  expect(within(modal).getByText('已确认')).toBeTruthy();
  expect(within(modal).getByRole('button', { name: '确认发布' })).toBeTruthy();
});
