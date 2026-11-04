import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const session = { user: { username: '管理员' }, csrf_token: 'csrf-test' };
const job = { id: 'job-1', title: '第一篇技术文章', platform: 'csdn', kind: 'save_draft', status: 'queued', outcome: 'not_submitted', stage: 'queued', attempts: 0, retry_count: 0, max_retries: 3, retry_allowed: false, external_started: false, cancel_requested: false, markdown: '# 文章正文', created_at: '2026-11-03T04:00:00Z', updated_at: '2026-11-03T04:00:00Z' };
let handler: (url: string, init?: RequestInit) => unknown | Promise<unknown>;
let calls: { url: string; init?: RequestInit }[];
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
beforeEach(() => {
  window.history.replaceState({}, '', '/jobs');
  calls = [];
  handler = (url) => {
    if (url === '/api/session') return response(session);
    if (url.startsWith('/api/jobs?')) return response({ items: [job], total: 1, page: 1, page_size: 50 });
    if (url === '/api/jobs/job-1') return response(job);
    if (url.startsWith('/api/jobs/job-1/history?')) return response({ items: [], transitions: [], total: 0, page: 1, page_size: 50 });
    if (url.startsWith('/api/logs?')) return response({ items: [], total: 0, page: 1, page_size: 50 });
    if (url === '/api/account') return response({ id: 'csdn-main', platform: 'csdn', display_name: '测试账号', status: 'needs_login' });
    if (url === '/api/settings') return response({ draft_only: true, platform: 'csdn', limits: {}, poll_interval_ms: 5000 });
    if (url === '/api/overview') return response({ counts: { queued: 1 }, account: { status: 'connected' } });
    return response({ code: 'not_found', message: '不存在' }, 404);
  };
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => { const url = String(input); calls.push({ url, init }); return Promise.resolve(handler(url, init)); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('管理员会话与任务闭环', () => {
  it('取消后的运行中核对继续只读，不显示取消中或自动保存承诺', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'running', outcome: 'unknown', external_started: true, cancel_requested: true, run_mode: 'reconcile', auto_reconcile_started: true }) : fallback(url, init);
    render(<App />);
    await screen.findByText('后台正在自动查询草稿');
    expect(screen.queryByText('取消中')).toBeNull();
    expect(screen.getByText(/核对只读取结果，不再自动保存/)).toBeTruthy();
    expect(screen.queryByText(/连续两次确认未保存/)).toBeNull();
  });

  it('无需候选ID即可重新自动核对，请求中禁止双击且人工结束默认折叠', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    let finish: (value: Response) => void = () => {};
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'failed', outcome: 'unknown', external_started: true, run_mode: 'reconcile', auto_reconcile_started: true, reconcile_count: 4 }) : url.endsWith('/reconcile') ? new Promise<Response>(resolve => { finish = resolve; }) : fallback(url, init);
    render(<App />);
    const button = await screen.findByRole('button', { name: '重新自动核对' });
    expect(screen.getByText('无法匹配完整稿件').closest('details')?.open).toBe(false);
    expect(screen.getByLabelText('候选草稿ID（可选，仅数字）')).toBeTruthy();
    fireEvent.click(button);
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter(c => c.url.endsWith('/reconcile'))).toHaveLength(1);
    expect(JSON.parse(String(calls.find(c => c.url.endsWith('/reconcile'))?.init?.body))).toEqual({});
    await act(async () => finish(response({ ...job, status: 'reconciling' })));
  });

  it.each(['reconciling', 'running'])('后台自动核对%s时展示进度和下一次时间，禁止重复核对', async status => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status, outcome: 'unknown', external_started: true, run_mode: 'reconcile', auto_reconcile_started: true, reconcile_count: 1, absence_checks: 1, available_at: '2026-11-03T04:00:20Z' }) : fallback(url, init);
    render(<App />);
    await screen.findByText('后台正在自动查询草稿');
    expect(screen.getByText(/查询进度 1 \/ 4/)).toBeTruthy();
    if (status === 'reconciling') expect(screen.getByText(/下一次查询/)).toBeTruthy();
    else expect(screen.queryByText(/下一次查询/)).toBeNull();
    expect(screen.queryByText(/连续两次确认未保存/)).toBeNull();
    const button = screen.getByRole('button', { name: '正在自动核对…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(calls.some(c => c.url.endsWith('/reconcile'))).toBe(false);
  });

  it.each([
    ['reconcile_unavailable', '草稿查询未完成'],
    ['draft_conflict', '草稿核对存在冲突'],
    ['draft_mismatch', '草稿核对存在冲突'],
    ['reconcile_exhausted', '草稿查询未完成'],
  ])('核对终止%s时说明未知结果与账号限制，允许再次核对', async (error_code, title) => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'failed', outcome: 'unknown', external_started: true, run_mode: 'reconcile', auto_reconcile_started: true, reconcile_count: 4, error_code }) : fallback(url, init);
    render(<App />);
    await screen.findByText(title);
    expect(screen.getByLabelText('候选草稿ID（可选，仅数字）')).toBeTruthy();
    expect(screen.queryByText('后台正在自动查询草稿')).toBeNull();
    expect((screen.getByRole('button', { name: '重新自动核对' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: '重试任务' })).toBeNull();
  });

  it('可选候选ID仍校验数字且人工结束任务不再次核对', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    let ended = false;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'failed', outcome: 'unknown', external_started: true, manual_resolved: ended }) : fallback(url, init);
    render(<App />);
    await screen.findByRole('button', { name: '重新自动核对' });
    fireEvent.change(screen.getByLabelText('候选草稿ID（可选，仅数字）'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '重新自动核对' }));
    await screen.findByText('候选草稿ID仅接受数字。');
    expect(calls.some(c => c.url.endsWith('/reconcile'))).toBe(false);
    ended = true;
    fireEvent.click(screen.getAllByRole('button', { name: '刷新' })[0]);
    await screen.findByText('已人工结束，草稿可能保留');
    expect(screen.queryByRole('button', { name: '重新自动核对' })).toBeNull();
  });

  it('取消完成后待核对任务即使保留取消标志仍允许只读核对', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'reconciling', outcome: 'unknown', external_started: true, remote_id: '12345', cancel_requested: true }) : url.endsWith('/reconcile') ? response(job) : fallback(url, init);
    render(<App />);
    await screen.findByRole('heading', { name: '第一篇技术文章' });
    expect((screen.getByRole('button', { name: '仅核对既有草稿' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('取消中')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '仅核对既有草稿' }));
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/reconcile'))).toBe(true));
  });

  it('等待登录时不显示服务端不支持的取消操作', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'waiting_user' }) : fallback(url, init);
    render(<App />);
    await screen.findByRole('heading', { name: '第一篇技术文章' });
    expect(screen.queryByText('取消此任务')).toBeNull();
  });

  it('提交内容冲突显示服务端原因，不误报浏览器空闲限制', async () => {
    window.history.replaceState({}, '', '/jobs/new');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs' ? response({ code: 'request_conflict', message: '请求标识对应的内容不一致' }, 409) : fallback(url, init);
    render(<App />);
    await screen.findByLabelText('文章标题');
    fireEvent.change(screen.getByLabelText('文章标题'), { target: { value: '一篇需要核实冲突的文章' } });
    fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '确认后的文字稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到CSDN草稿' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('请求标识对应的内容不一致');
    expect(alert.textContent).not.toContain('浏览器空闲');
  });

  it('未识别的新任务状态使用明确占位并保留详情入口', async () => {
    const fallback = handler;
    handler = (url, init) => url.startsWith('/api/jobs?') ? response({ items: [{ ...job, status: 'future_state' }], total: 1, page: 1, page_size: 50 }) : fallback(url, init);
    render(<App />);
    await screen.findByText('未知状态');
    expect(screen.getByRole('link', { name: '第一篇技术文章' }).getAttribute('href')).toContain('/jobs/job-1');
  });

  it('日志本地时间转换为UTC查询并拒绝超过31天的范围', async () => {
    window.history.replaceState({}, '', '/logs?view=events');
    render(<App />);
    await screen.findByRole('heading', { name: '运行记录' });
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-11-01T09:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-11-02T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() => expect(calls.filter(c => c.url.startsWith('/api/logs?')).length).toBeGreaterThan(1));
    const filtered = calls.filter(c => c.url.startsWith('/api/logs?')).at(-1)!;
    expect(new URL(filtered.url, 'http://localhost').searchParams.get('from')).toBe(new Date('2026-11-01T09:00').toISOString());
    const before = calls.length;
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-12-31T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText(/范围最多 31 天/);
    expect(calls).toHaveLength(before);
  });

  it('暂停自动刷新不额外请求，仍可手动刷新', async () => {
    render(<App />);
    await screen.findByText('第一篇技术文章');
    vi.useFakeTimers();
    const before = calls.length;
    fireEvent.click(screen.getByLabelText('每 5 秒刷新'));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(calls).toHaveLength(before);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls).toHaveLength(before + 1);
  });

  it('退出使用CSRF并清除当前页面请求和轮询', async () => {
    const fallback = handler;
    handler = (url, init) => url === '/api/logout' ? response({}) : fallback(url, init);
    render(<App />);
    await screen.findByText('第一篇技术文章');
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await screen.findByRole('button', { name: '登录工作台' });
    expect(new Headers(calls.find(c => c.url === '/api/logout')?.init?.headers).get('X-CSRF-Token')).toBe('csrf-test');
    expect(calls.filter(c => c.init?.signal).every(c => c.init?.signal?.aborted)).toBe(true);
  });

  it('取消中任务不重复提供取消操作', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'running', cancel_requested: true }) : fallback(url, init);
    render(<App />);
    await screen.findByRole('heading', { name: '第一篇技术文章' });
    expect(screen.getAllByText('取消中').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '确认取消任务' })).toBeNull();
  });

  it('只有服务端明确允许的失败任务可安全重试', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'failed', retry_allowed: true, error_message: '编辑器打开前网络中断' }) : url.endsWith('/retry') ? response({ ...job, status: 'queued' }) : fallback(url, init);
    render(<App />);
    await screen.findByRole('button', { name: '重试任务' });
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }));
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/retry'))).toBe(true));
    expect(new Headers(calls.find(c => c.url.endsWith('/retry'))?.init?.headers).get('X-CSRF-Token')).toBe('csrf-test');
  });

  it('刷新失败保留既有任务并标明数据可能过期', async () => {
    render(<App />);
    await screen.findByText('第一篇技术文章');
    const fallback = handler;
    handler = (url, init) => url.startsWith('/api/jobs?') ? response({ code: 'unavailable', message: '服务暂不可用' }, 503) : fallback(url, init);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByText(/数据可能已过期/);
    expect(screen.getByText('第一篇技术文章')).toBeTruthy();
  });

  it('预览不加载图片或执行HTML，并拒绝图片稿件提交', async () => {
    window.history.replaceState({}, '', '/jobs/new');
    const { container } = render(<App />);
    await screen.findByLabelText('文章标题');
    fireEvent.change(screen.getByLabelText('文章标题'), { target: { value: '含不支持内容的文章' } });
    fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '<script>alert(1)</script>\n![图片](https://example.com/private.png)' } });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存到CSDN草稿' }));
    await screen.findByText(/本轮仅支持文字 Markdown/);
    expect(calls.filter(c => c.url === '/api/jobs')).toHaveLength(0);
  });

  it('账号检查创建后台任务并保留登录入口', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = handler;
    handler = (url, init) => url === '/api/account/check' ? response({ ...job, kind: 'check_account' }, 202) : fallback(url, init);
    render(<App />);
    await screen.findByText('测试账号');
    expect(screen.getByRole('button', { name: '开始远程登录' })).toBeTruthy();
    expect(screen.queryByText(/验证主机/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '检查登录状态' }));
    await waitFor(() => expect(calls.some(c => c.url === '/api/account/check')).toBe(true));
    const check = calls.find(c => c.url === '/api/account/check')!;
    expect(JSON.parse(String(check.init?.body)).request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(check.init?.headers).get('X-CSRF-Token')).toBe('csrf-test');
  });

  it('会话失效后登录并使用用户名字段和同站点Cookie', async () => {
    const fallback = handler;
    handler = (url, init) => url === '/api/session' ? response({ message: '会话已失效' }, 401) : url === '/api/login' ? response(session) : fallback(url, init);
    render(<App />);
    await screen.findByRole('button', { name: '登录工作台' });
    fireEvent.change(screen.getByLabelText('管理员账号'), { target: { value: 'operator' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'private' } });
    fireEvent.click(screen.getByRole('button', { name: '登录工作台' }));
    await screen.findByText('第一篇技术文章');
    const login = calls.find(c => c.url === '/api/login')!;
    expect(JSON.parse(String(login.init?.body))).toEqual({ username: 'operator', password: 'private' });
    expect(login.init?.credentials).toBe('same-origin');
    expect(screen.getByText('管理员')).toBeTruthy();
  });

  it('提交禁用重复点击且网络失败重试保留同一请求标识和CSRF', async () => {
    let finish: (value: Response) => void = () => {};
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs' ? new Promise<Response>(resolve => { finish = resolve; }) : fallback(url, init);
    render(<App />);
    await screen.findByText('第一篇技术文章');
    fireEvent.click(screen.getByRole('link', { name: '新建草稿' }));
    fireEvent.change(screen.getByLabelText('文章标题'), { target: { value: '保存到草稿的文章' } });
    fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '# 安全的正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到CSDN草稿' }));
    expect((screen.getByRole('button', { name: '正在提交…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(response({ code: 'temporary', message: '连接中断，请重试' }, 503)));
    await screen.findByText('连接中断，请重试');
    fireEvent.click(screen.getByRole('button', { name: '保存到CSDN草稿' }));
    const submissions = calls.filter(c => c.url === '/api/jobs');
    expect(submissions).toHaveLength(2);
    const body = JSON.parse(String(submissions[0].init?.body));
    expect(body).toMatchObject({ kind: 'save_draft', platform: 'csdn', title: '保存到草稿的文章', markdown: '# 安全的正文' });
    expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.parse(String(submissions[1].init?.body)).request_id).toBe(body.request_id);
    expect(new Headers(submissions[0].init?.headers).get('X-CSRF-Token')).toBe('csrf-test');
    await act(async () => finish(response(job, 202)));
    await screen.findByRole('heading', { name: '第一篇技术文章' });
  });

  it('草稿保存结果明确标识且运行日志以纯文本显示', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'succeeded', outcome: 'draft_saved', remote_id: '123', remote_url: 'https://mp.csdn.net/mp_blog/creation/editor/123' }) : url.startsWith('/api/jobs/job-1/history?') ? response({ transitions: [], items: [{ id: 'log-1', job_id: 'job-1', stage: 'saving', level: 'info', message: '<img src=x onerror=alert(1)>', created_at: job.created_at }], total: 1, page: 1, page_size: 50 }) : fallback(url, init);
    const { container } = render(<App />);
    await screen.findByText('草稿已保存');
    expect(screen.queryByText('已公开')).toBeNull();
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: '查看CSDN草稿' }).getAttribute('href')).toBe('https://mp.csdn.net/mp_blog/creation/editor/123');
  });

  it('等待登录任务提示远程验证并允许手动继续', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'waiting_user' }) : url.endsWith('/resume') ? response({ ...job, status: 'queued' }) : fallback(url, init);
    render(<App />);
    expect((await screen.findByRole('link', { name: '登录 CSDN' })).getAttribute('href')).toBe('/account?tab=settings');
    fireEvent.click(screen.getByLabelText('我已完成指定账号登录'));
    fireEvent.click(screen.getByRole('button', { name: '登录完成，继续任务' }));
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/resume'))).toBe(true));
  });

  it('未知结果支持可选数字候选ID并确认保留草稿后人工结束，409有下一步', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'reconciling', outcome: 'unknown', external_started: true }) : url.endsWith('/reconcile') ? response({ ...job, status: 'reconciling', outcome: 'unknown', external_started: true }) : url.endsWith('/resolve') ? response({ code: 'worker_not_idle', message: '执行器尚未确认空闲' }, 409) : fallback(url, init);
    render(<App />);
    await screen.findByRole('heading', { name: '第一篇技术文章' });
    expect(screen.queryByRole('button', { name: '重试任务' })).toBeNull();
    fireEvent.change(screen.getByLabelText('候选草稿ID（可选，仅数字）'), { target: { value: '12345' } });
    fireEvent.click(screen.getByRole('button', { name: '重新自动核对' }));
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/reconcile'))).toBe(true));
    expect(JSON.parse(String(calls.find(c => c.url.endsWith('/reconcile'))?.init?.body))).toEqual({ remote_id: '12345' });
    await waitFor(() => expect((screen.getByRole('button', { name: '重新自动核对' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('无法匹配完整稿件'));
    fireEvent.click(screen.getByLabelText('我已确认本任务浏览器停止，并保留可能存在的草稿'));
    fireEvent.change(screen.getByLabelText('人工结束原因'), { target: { value: '保留半成品供后续人工检查' } });
    fireEvent.click(screen.getByRole('button', { name: '保留草稿并结束任务' }));
    await screen.findByText(/45 秒/);
    expect(JSON.parse(String(calls.find(c => c.url.endsWith('/resolve'))?.init?.body))).toEqual({ confirmed_browser_stopped: true, note: '保留半成品供后续人工检查' });
  });

  it('筛选分页恢复在URL中且后续401停止轮询回到登录', async () => {
    window.history.replaceState({}, '', '/jobs?q=保留&status=failed&page=2');
    render(<App />);
    await screen.findByText('第一篇技术文章');
    expect((screen.getByLabelText('搜索任务') as HTMLInputElement).value).toBe('保留');
    expect(calls.some(c => c.url.includes('q=%E4%BF%9D%E7%95%99') && c.url.includes('page=2'))).toBe(true);
    const fallback = handler;
    handler = (url, init) => url.startsWith('/api/jobs?') ? response({ message: '会话已过期' }, 401) : fallback(url, init);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('button', { name: '登录工作台' });
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
  });

  it('离开页面和隐藏时清理轮询并中止在途请求', async () => {
    const { unmount } = render(<App />);
    await screen.findByText('第一篇技术文章');
    vi.useFakeTimers();
    const before = calls.length;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(calls).toHaveLength(before);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    unmount();
    expect(calls.filter(c => c.init?.signal).every(c => c.init?.signal?.aborted)).toBe(true);
    const after = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(calls).toHaveLength(after);
  });
});

describe('后台远程登录验证', () => {
  it('账号页可创建远程登录会话且请求防双击', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback=handler;
    handler=(url,init)=>url==='/api/account/login' ? response({id:init?.method==='POST'?'login-test':'',status:init?.method==='POST'?'pending':'idle',width:1280,height:800,expires_at:''}) : fallback(url,init);
    render(<App />);
    const start=await screen.findByRole('button',{name:'开始远程登录'});
    await waitFor(()=>expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);fireEvent.click(start);
    await screen.findByText('正在等待执行器空闲');
    const created=calls.filter(c=>c.url==='/api/account/login'&&c.init?.method==='POST');
    expect(created).toHaveLength(1);
    expect(new Headers(created[0].init?.headers).get('X-CSRF-Token')).toBe('csrf-test');
  });
  it('远程验证关闭后停止画面轮询并撤销会话', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback=handler;
    vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn(()=> 'blob:synthetic-frame'),revokeObjectURL:vi.fn()}));
    handler=(url,init)=>url==='/api/account/login' ? response({id:'login-test',status:'active',width:1280,height:800,expires_at:'2026-11-03T12:00:00Z'}) : url.endsWith('/frame') ? new Response('synthetic',{headers:{'Content-Type':'image/jpeg'}}) : url.endsWith('/login/login-test')&&init?.method==='DELETE' ? response({status:'cancelled'}) : fallback(url,init);
    render(<App />);
    await screen.findByRole('img',{name:'CSDN 远程登录画面'});
    fireEvent.click(screen.getByRole('button',{name:'结束远程登录'}));
    await screen.findByText('远程登录已结束');
    expect(calls.some(c=>c.url==='/api/account/login/login-test'&&c.init?.method==='DELETE')).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
  it('服务未配置时说明原因，不显示可用登录入口', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');const fallback=handler;
    handler=(url,init)=>url==='/api/account/login'?response({code:'remote_login_disabled',message:'服务器尚未启用远程登录'},503):fallback(url,init);
    render(<App />);await screen.findByText('服务器尚未启用远程登录');
    expect((screen.getByRole('button',{name:'开始远程登录'}) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('远程登录输入',()=>{
 it('手机号和短信验证码直接填写指定输入框，清空本地值且不自动发短信或确认登录',async()=>{
  window.history.replaceState({},'', '/account?tab=settings');const fallback=handler;
  vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn(()=> 'blob:synthetic-frame'),revokeObjectURL:vi.fn()}));
  handler=(url,init)=>url==='/api/account/login'?response({id:'login-test',status:'active',width:1280,height:800,expires_at:''}):url.endsWith('/frame')?new Response('synthetic',{headers:{'Content-Type':'image/jpeg'}}):url.endsWith('/input')?response({ok:true}):fallback(url,init);
  render(<App/>);await screen.findByRole('img',{name:'CSDN 远程登录画面'});
  const phone=screen.getByLabelText('手机号') as HTMLInputElement;
  const code=screen.getByLabelText('短信验证码') as HTMLInputElement;
  expect(phone.type).toBe('tel');expect(phone.inputMode).toBe('numeric');expect(phone.autocomplete).toBe('off');
  expect(code.type).toBe('password');expect(code.inputMode).toBe('numeric');expect(code.autocomplete).toBe('off');
  fireEvent.change(phone,{target:{value:'13800000000'}});fireEvent.click(screen.getByRole('button',{name:'填写手机号'}));
  expect(phone.value).toBe('');await screen.findByText('手机号已填入，请在画面获取验证码');
  fireEvent.change(code,{target:{value:'654321'}});fireEvent.click(screen.getByRole('button',{name:'填写验证码'}));
  expect(code.value).toBe('');await screen.findByText('验证码已填入，请在画面确认登录');
  expect(calls.filter(c=>c.init?.method==='POST').map(c=>({url:c.url,body:JSON.parse(String(c.init?.body))}))).toEqual([
   {url:'/api/account/login/login-test/input',body:{type:'fill',field:'phone',text:'13800000000'}},
   {url:'/api/account/login/login-test/input',body:{type:'fill',field:'code',text:'654321'}},
  ]);
  expect(screen.queryByText(/13800000000|654321/)).toBeNull();
 });
 it('明确输入只接受指定长度的数字，失败时不显示成功提示并清空本地值',async()=>{
  window.history.replaceState({},'', '/account?tab=settings');const fallback=handler;
  vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn(()=> 'blob:synthetic-frame'),revokeObjectURL:vi.fn()}));
  handler=(url,init)=>url==='/api/account/login'?response({id:'login-test',status:'active',width:1280,height:800,expires_at:''}):url.endsWith('/frame')?new Response('synthetic',{headers:{'Content-Type':'image/jpeg'}}):url.endsWith('/input')?response({message:'登录输入框当前不可用'},409):fallback(url,init);
  render(<App/>);await screen.findByRole('img',{name:'CSDN 远程登录画面'});
  const phone=screen.getByLabelText('手机号') as HTMLInputElement;const code=screen.getByLabelText('短信验证码') as HTMLInputElement;
  for(const value of ['1234','123456789012345678901','+8613800000000','12345 ']){
   fireEvent.change(phone,{target:{value}});expect((screen.getByRole('button',{name:'填写手机号'}) as HTMLButtonElement).disabled).toBe(true);
  }
  for(const value of ['123','123456789','１２３４','123a']){
   fireEvent.change(code,{target:{value}});expect((screen.getByRole('button',{name:'填写验证码'}) as HTMLButtonElement).disabled).toBe(true);
  }
  expect(calls.filter(c=>c.url.endsWith('/input'))).toHaveLength(0);
  fireEvent.change(phone,{target:{value:'13800000000'}});fireEvent.click(screen.getByRole('button',{name:'填写手机号'}));
  expect(phone.value).toBe('');await screen.findByText('登录输入框当前不可用');
  expect(screen.queryByText('手机号已填入，请在画面获取验证码')).toBeNull();
 });
 it('短信或密码文字仅发送到输入接口并立即清空，键盘支持切换输入框',async()=>{
  window.history.replaceState({},'', '/account?tab=settings');const fallback=handler;
  vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn(()=> 'blob:synthetic-frame'),revokeObjectURL:vi.fn()}));
  handler=(url,init)=>url==='/api/account/login'?response({id:'login-test',status:'active',width:1280,height:800,expires_at:''}):url.endsWith('/frame')?new Response('synthetic',{headers:{'Content-Type':'image/jpeg'}}):url.endsWith('/input')?response({ok:true}):fallback(url,init);
  render(<App/>);const image=await screen.findByRole('img',{name:'CSDN 远程登录画面'});
  const field=screen.getByLabelText('输入到页面的文字') as HTMLInputElement;
  fireEvent.change(field,{target:{value:'synthetic-otp'}});fireEvent.click(screen.getByRole('button',{name:'发送文字'}));
  await waitFor(()=>expect(calls.some(c=>c.url.endsWith('/input'))).toBe(true));
  expect(field.value).toBe('');expect(JSON.parse(String(calls.find(c=>c.url.endsWith('/input'))?.init?.body))).toEqual({type:'text',text:'synthetic-otp'});
  await waitFor(()=>expect((screen.getByRole('button',{name:'下一输入框'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'下一输入框'}));await waitFor(()=>expect(calls.filter(c=>c.url.endsWith('/input'))).toHaveLength(2));
  expect(JSON.parse(String(calls.filter(c=>c.url.endsWith('/input'))[1].init?.body))).toEqual({type:'key',key:'Tab'});
 });
});

describe('远程登录输入与销毁边界',()=>{
 it('画面快速输入逐字串行发送且Tab可离开画面',async()=>{
  window.history.replaceState({},'', '/account?tab=settings');const fallback=handler;let finish:(r:Response)=>void=()=>{};let count=0;
  vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn(()=> 'blob:synthetic-frame'),revokeObjectURL:vi.fn()}));
  handler=(url,init)=>url==='/api/account/login'?response({id:'login-test',status:'active',width:1280,height:800,expires_at:''}):url.endsWith('/frame')?new Response('synthetic',{headers:{'Content-Type':'image/jpeg'}}):url.endsWith('/input')?(++count===1?new Promise<Response>(r=>{finish=r}):response({ok:true})):fallback(url,init);
  render(<App/>);const image=await screen.findByRole('img',{name:'CSDN 远程登录画面'});
  fireEvent.keyDown(image,{key:'1'});fireEvent.keyDown(image,{key:'2'});fireEvent.keyDown(image,{key:'3'});
  await waitFor(()=>expect(count).toBe(1));finish(response({ok:true}));await waitFor(()=>expect(calls.filter(c=>c.url.endsWith('/input'))).toHaveLength(3));
  expect(calls.filter(c=>c.url.endsWith('/input')).map(c=>JSON.parse(String(c.init?.body)).text)).toEqual(['1','2','3']);
  expect(fireEvent.keyDown(image,{key:'Tab'})).toBe(true);
 });
 it('创建已提交但响应迟到时离开页面仍撤销新会话',async()=>{
  window.history.replaceState({},'', '/account?tab=settings');const fallback=handler;let finish:(r:Response)=>void=()=>{};
  handler=(url,init)=>url==='/api/account/login'?(init?.method==='POST'?new Promise<Response>(r=>{finish=r}):response({id:'',status:'idle',width:1280,height:800,expires_at:''})):url==='/api/account/login/late-id'?response({status:'cancelled'}):fallback(url,init);
  render(<App/>);const start=await screen.findByRole('button',{name:'开始远程登录'});await waitFor(()=>expect((start as HTMLButtonElement).disabled).toBe(false));fireEvent.click(start);
  fireEvent.click(screen.getByRole('link',{name:'草稿任务'}));finish(response({id:'late-id',status:'pending',width:1280,height:800,expires_at:''},202));
  await waitFor(()=>expect(calls.some(c=>c.url==='/api/account/login/late-id'&&c.init?.method==='DELETE')).toBe(true));
 });
});


describe('登录弹窗', () => {
  it('点击开始立即打开弹窗，关闭后恢复焦点并撤销等待会话', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = handler;
    handler = (url, init) => url === '/api/account/login'
      ? response({ id: init?.method === 'POST' ? 'modal-test' : '', status: init?.method === 'POST' ? 'pending' : 'idle', width: 1280, height: 800, expires_at: '' })
      : url === '/api/account/login/modal-test' ? response({ status: 'cancelled' }) : fallback(url, init);
    render(<App />);
    const start = await screen.findByRole('button', { name: '开始远程登录' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    start.focus(); fireEvent.click(start);
    const dialog = await screen.findByRole('dialog', { name: 'CSDN 登录' });
    await screen.findByText('正在等待执行器空闲');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(calls.some(c => c.url === '/api/account/login/modal-test' && c.init?.method === 'DELETE')).toBe(true));
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(start);
  });

  it('创建响应迟到时关闭弹窗仍撤销会话，不重新打开', async () => {
    window.history.replaceState({}, '', '/account?tab=settings'); const fallback = handler;
    let finish: (value: Response) => void = () => {};
    handler = (url, init) => url === '/api/account/login' ? init?.method === 'POST'
      ? new Promise<Response>(resolve => { finish = resolve; })
      : response({ id: '', status: 'idle', width: 1280, height: 800, expires_at: '' })
      : url === '/api/account/login/late-modal' ? response({ status: 'cancelled' }) : fallback(url, init);
    render(<App />);
    const start = await screen.findByRole('button', { name: '开始远程登录' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    fireEvent.click(await screen.findByRole('button', { name: '关闭登录弹窗' }));
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter(c => c.init?.method === 'POST')).toHaveLength(1);
    await act(async () => finish(response({ id: 'late-modal', status: 'pending', width: 1280, height: 800, expires_at: '' })));
    await waitFor(() => expect(calls.some(c => c.url === '/api/account/login/late-modal' && c.init?.method === 'DELETE')).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});


describe('弹窗终态清理', () => {
  it('输入未返回而轮询先成功时，关闭弹窗仍解锁入口并清理输入', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = handler; let status = 'active';
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:synthetic-frame'), revokeObjectURL: vi.fn() }));
    handler = (url, init) => url === '/api/account/login'
      ? response({ id: 'finished-input', status, width: 1280, height: 800, expires_at: '' })
      : url.endsWith('/frame') ? new Response('synthetic', { headers: { 'Content-Type': 'image/jpeg' } })
      : url.endsWith('/input') ? new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); })
      : fallback(url, init);
    vi.useFakeTimers();
    await act(async () => { render(<App />); await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('img', { name: 'CSDN 远程登录画面' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('输入到页面的文字'), { target: { value: 'temporary-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '发送文字' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    status = 'succeeded';
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('指定账号登录成功，等待任务已恢复')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭登录弹窗' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect((screen.getByRole('button', { name: '开始远程登录' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter(c => c.url.endsWith('/input')).every(c => c.init?.signal?.aborted)).toBe(true);
    expect(screen.queryByDisplayValue('temporary-secret')).toBeNull();
  });
});


it('从处理详情进入任务后返回原处理及筛选上下文', async () => {
  const back = '/logs/job-1?back=' + encodeURIComponent('/logs?status=failed');
  window.history.replaceState({}, '', '/jobs/job-1?back=' + encodeURIComponent(back));
  render(<App />);
  const link = await screen.findByRole('link', { name: '返回处理详情' });
  expect(link.getAttribute('href')).toBe(back);
});


it('离开账号设置页签中止画面与输入并撤销登录，返回时不自动创建会话', async () => {
  window.history.replaceState({}, '', '/account?tab=settings&q=保留&page=2');
  const fallback = handler; let active = true;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:synthetic-frame'), revokeObjectURL: vi.fn() }));
  handler = (url, init) => url === '/api/account/login'
    ? response({ id: active ? 'tab-login' : '', status: active ? 'active' : 'idle', width: 1280, height: 800, expires_at: '' })
    : url.endsWith('/frame') ? new Response('synthetic', { headers: { 'Content-Type': 'image/jpeg' } })
    : url.endsWith('/input') ? new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); })
    : url === '/api/account/login/tab-login' && init?.method === 'DELETE' ? (active = false, response({ status: 'cancelled' }))
    : fallback(url, init);
  render(<App />);
  await screen.findByRole('img', { name: 'CSDN 远程登录画面' });
  fireEvent.change(screen.getByLabelText('输入到页面的文字'), { target: { value: 'temporary-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '发送文字' }));
  await waitFor(() => expect(calls.some(call => call.url.endsWith('/input'))).toBe(true));
  act(() => { window.history.replaceState({}, '', '/account?tab=stats&q=保留&page=2'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await waitFor(() => expect(calls.some(call => call.url === '/api/account/login/tab-login' && call.init?.method === 'DELETE')).toBe(true));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(calls.filter(call => call.url.endsWith('/input')).every(call => call.init?.signal?.aborted)).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: '账号设置' }));
  await screen.findByRole('button', { name: '开始远程登录' });
  expect(calls.some(call => call.url === '/api/account/login' && call.init?.method === 'POST')).toBe(false);
  expect(screen.queryByDisplayValue('temporary-secret')).toBeNull();
});


it('创建响应迟到时切换页签仍补充撤销，不重新显示登录', async () => {
  window.history.replaceState({}, '', '/account?tab=settings');
  const fallback = handler; let finish: (value: Response) => void = () => {};
  handler = (url, init) => url === '/api/account/login' ? init?.method === 'POST'
    ? new Promise<Response>(resolve => { finish = resolve; })
    : response({ id: '', status: 'idle', width: 1280, height: 800, expires_at: '' })
    : url === '/api/account/login/tab-late' ? response({ status: 'cancelled' }) : fallback(url, init);
  render(<App />);
  const start = await screen.findByRole('button', { name: '开始远程登录' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  act(() => { window.history.replaceState({}, '', '/account?tab=stats'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await act(async () => finish(response({ id: 'tab-late', status: 'pending', width: 1280, height: 800, expires_at: '' })));
  await waitFor(() => expect(calls.some(call => call.url === '/api/account/login/tab-late' && call.init?.method === 'DELETE')).toBe(true));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('tab', { name: '数据统计' }).getAttribute('aria-selected')).toBe('true');
});

it('登录画面请求未完成时离开设置会中止请求并释放页面锁定', async () => {
  window.history.replaceState({}, '', '/account?tab=settings');
  const fallback = handler;
  handler = (url, init) => url === '/api/account/login'
    ? response({ id: 'frame-pending', status: 'active', width: 1280, height: 800, expires_at: '' })
    : url.endsWith('/frame') ? new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); })
    : url === '/api/account/login/frame-pending' ? response({ status: 'cancelled' }) : fallback(url, init);
  render(<App />);
  await screen.findByRole('dialog', { name: 'CSDN 登录' });
  await waitFor(() => expect(calls.some(call => call.url.endsWith('/frame'))).toBe(true));
  act(() => { window.history.replaceState({}, '', '/account'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await waitFor(() => expect(calls.some(call => call.url === '/api/account/login/frame-pending' && call.init?.method === 'DELETE')).toBe(true));
  expect(calls.find(call => call.url.endsWith('/frame'))?.init?.signal?.aborted).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.style.overflow).toBe('');
});

it('检查任务返回保留完整设置页签及列表筛选上下文', async () => {
  const back = '/account?tab=settings&q=保留&status=draft&page=2';
  window.history.replaceState({}, '', back);
  const fallback = handler;
  handler = (url, init) => url === '/api/account/check' ? response({ ...job, kind: 'check_account' }, 202) : fallback(url, init);
  render(<App />);
  const check = await screen.findByRole('button', { name: '检查登录状态' });
  await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(check);
  expect(decodeURI((await screen.findByRole('link', { name: '返回账号设置' })).getAttribute('href')!)).toBe(back);
  fireEvent.click(screen.getByRole('link', { name: '返回账号设置' }));
  await screen.findByRole('button', { name: '检查登录状态' });
  expect(screen.getByRole('tab', { name: '账号设置' }).getAttribute('aria-selected')).toBe('true');
  expect(new URLSearchParams(window.location.search).get('q')).toBe('保留');
});

it('总览查看账号直接进入账号设置', async () => {
  window.history.replaceState({}, '', '/');
  render(<App />);
  expect((await screen.findByRole('link', { name: '查看账号' })).getAttribute('href')).toBe('/account?tab=settings');
});
