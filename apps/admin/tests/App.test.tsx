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
    window.history.replaceState({}, '', '/logs');
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

  it('账号检查创建后台任务并清楚说明本地登录下一步', async () => {
    window.history.replaceState({}, '', '/account');
    const fallback = handler;
    handler = (url, init) => url === '/api/account/check' ? response({ ...job, kind: 'check_account' }, 202) : fallback(url, init);
    render(<App />);
    await screen.findByText('测试账号');
    expect(screen.getByText(/验证主机/)).toBeTruthy();
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
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'succeeded', outcome: 'draft_saved', remote_id: '123', remote_url: 'https://mp.csdn.net/mp_blog/creation/editor/123' }) : url.startsWith('/api/logs?') ? response({ items: [{ id: 'log-1', job_id: 'job-1', stage: 'saving', level: 'info', message: '<img src=x onerror=alert(1)>', created_at: job.created_at }], total: 1, page: 1, page_size: 50 }) : fallback(url, init);
    const { container } = render(<App />);
    await screen.findByText('草稿已保存');
    expect(screen.queryByText('已公开')).toBeNull();
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: '查看CSDN草稿' }).getAttribute('href')).toBe('https://mp.csdn.net/mp_blog/creation/editor/123');
  });

  it('等待登录任务提示验证主机操作并允许继续', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'waiting_user' }) : url.endsWith('/resume') ? response({ ...job, status: 'queued' }) : fallback(url, init);
    render(<App />);
    await screen.findByText(/^请在验证主机/);
    fireEvent.click(screen.getByLabelText('我已在验证主机完成登录'));
    fireEvent.click(screen.getByRole('button', { name: '登录完成，继续任务' }));
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/resume'))).toBe(true));
  });

  it('未知结果只核对数字候选ID并确认保留草稿后人工结束，409有下一步', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = handler;
    handler = (url, init) => url === '/api/jobs/job-1' ? response({ ...job, status: 'reconciling', outcome: 'unknown', external_started: true }) : url.endsWith('/reconcile') ? response({ ...job, status: 'reconciling', outcome: 'unknown', external_started: true }) : url.endsWith('/resolve') ? response({ code: 'worker_not_idle', message: '执行器尚未确认空闲' }, 409) : fallback(url, init);
    render(<App />);
    await screen.findByRole('heading', { name: '第一篇技术文章' });
    expect(screen.queryByRole('button', { name: '重试任务' })).toBeNull();
    fireEvent.change(screen.getByLabelText('候选草稿ID（仅数字）'), { target: { value: '12345' } });
    fireEvent.click(screen.getByRole('button', { name: '仅核对既有草稿' }));
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/reconcile'))).toBe(true));
    expect(JSON.parse(String(calls.find(c => c.url.endsWith('/reconcile'))?.init?.body))).toEqual({ remote_id: '12345' });
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
