import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { appFixture, session, job, response } from './app-fixture';
describe('管理员会话与任务闭环', () => {
  it('取消后的运行中核对继续只读，不显示取消中或自动保存承诺', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({
            ...job,
            status: 'running',
            outcome: 'unknown',
            external_started: true,
            cancel_requested: true,
            run_mode: 'reconcile',
            auto_reconcile_started: true,
          })
        : fallback(url, init);
    render(<App />);
    await screen.findByText('后台正在自动查询草稿');
    expect(screen.queryByText('取消中')).toBeNull();
    expect(screen.getByText(/核对只读取结果，不再自动保存/)).toBeTruthy();
    expect(screen.queryByText(/连续两次确认未保存/)).toBeNull();
  });

  it('无需候选ID即可重新自动核对，请求中禁止双击且人工结束默认折叠', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    let finish: (value: Response) => void = () => {};
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({
            ...job,
            status: 'failed',
            outcome: 'unknown',
            external_started: true,
            run_mode: 'reconcile',
            auto_reconcile_started: true,
            reconcile_count: 4,
          })
        : url.endsWith('/reconcile')
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : fallback(url, init);
    render(<App />);
    const button = await screen.findByRole('button', { name: '重新自动核对' });
    expect(screen.getByText('无法匹配完整稿件').closest('details')?.open).toBe(false);
    expect(screen.getByLabelText('候选草稿ID（可选，仅数字）')).toBeTruthy();
    fireEvent.click(button);
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(appFixture.calls.filter((c) => c.url.endsWith('/reconcile'))).toHaveLength(1);
    expect(
      JSON.parse(String(appFixture.calls.find((c) => c.url.endsWith('/reconcile'))?.init?.body)),
    ).toEqual({});
    await act(async () => finish(response({ ...job, status: 'reconciling' })));
  });

  it.each(['reconciling', 'running'])(
    '后台自动核对%s时展示进度和下一次时间，禁止重复核对',
    async (status) => {
      window.history.replaceState({}, '', '/jobs/job-1');
      const fallback = appFixture.handler;
      appFixture.handler = (url, init) =>
        url === '/api/jobs/job-1'
          ? response({
              ...job,
              status,
              outcome: 'unknown',
              external_started: true,
              run_mode: 'reconcile',
              auto_reconcile_started: true,
              reconcile_count: 1,
              absence_checks: 1,
              available_at: '2026-11-03T04:00:20Z',
            })
          : fallback(url, init);
      render(<App />);
      await screen.findByText('后台正在自动查询草稿');
      expect(screen.getByText(/查询进度 1 \/ 4/)).toBeTruthy();
      if (status === 'reconciling') expect(screen.getByText(/下一次查询/)).toBeTruthy();
      else expect(screen.queryByText(/下一次查询/)).toBeNull();
      expect(screen.queryByText(/连续两次确认未保存/)).toBeNull();
      const button = screen.getByRole('button', { name: '正在自动核对…' });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
      expect(appFixture.calls.some((c) => c.url.endsWith('/reconcile'))).toBe(false);
    },
  );

  it.each([
    ['reconcile_unavailable', '草稿查询未完成'],
    ['draft_conflict', '草稿核对存在冲突'],
    ['draft_mismatch', '草稿核对存在冲突'],
    ['reconcile_exhausted', '草稿查询未完成'],
  ])('核对终止%s时说明未知结果与账号限制，允许再次核对', async (error_code, title) => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({
            ...job,
            status: 'failed',
            outcome: 'unknown',
            external_started: true,
            run_mode: 'reconcile',
            auto_reconcile_started: true,
            reconcile_count: 4,
            error_code,
          })
        : fallback(url, init);
    render(<App />);
    await screen.findByText(title);
    expect(screen.getByLabelText('候选草稿ID（可选，仅数字）')).toBeTruthy();
    expect(screen.queryByText('后台正在自动查询草稿')).toBeNull();
    expect(
      (screen.getByRole('button', { name: '重新自动核对' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole('button', { name: '重试任务' })).toBeNull();
  });

  it('可选候选ID仍校验数字且人工结束任务不再次核对', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    let ended = false;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({
            ...job,
            status: 'failed',
            outcome: 'unknown',
            external_started: true,
            manual_resolved: ended,
          })
        : fallback(url, init);
    render(<App />);
    await screen.findByRole('button', { name: '重新自动核对' });
    fireEvent.change(screen.getByLabelText('候选草稿ID（可选，仅数字）'), {
      target: { value: 'abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: '重新自动核对' }));
    await screen.findByText('候选草稿ID仅接受数字。');
    expect(appFixture.calls.some((c) => c.url.endsWith('/reconcile'))).toBe(false);
    ended = true;
    fireEvent.click(screen.getAllByRole('button', { name: '刷新' })[0]);
    await screen.findByText('已人工结束，草稿可能保留');
    expect(screen.queryByRole('button', { name: '重新自动核对' })).toBeNull();
  });

  it('取消完成后待核对任务即使保留取消标志仍允许只读核对', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({
            ...job,
            status: 'reconciling',
            outcome: 'unknown',
            external_started: true,
            remote_id: '12345',
            cancel_requested: true,
          })
        : url.endsWith('/reconcile')
          ? response(job)
          : fallback(url, init);
    render(<App />);
    await screen.findByRole('heading', { name: '第一篇技术文章' });
    expect(
      (screen.getByRole('button', { name: '仅核对既有草稿' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText('取消中')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '仅核对既有草稿' }));
    await waitFor(() =>
      expect(appFixture.calls.some((c) => c.url.endsWith('/reconcile'))).toBe(true),
    );
  });

  it('等待登录时不显示服务端不支持的取消操作', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({ ...job, status: 'waiting_user' })
        : fallback(url, init);
    render(<App />);
    await screen.findByRole('heading', { name: '第一篇技术文章' });
    expect(screen.queryByText('取消此任务')).toBeNull();
  });

  it('提交内容冲突显示服务端原因，不误报浏览器空闲限制', async () => {
    window.history.replaceState({}, '', '/jobs/new');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs'
        ? response({ code: 'request_conflict', message: '请求标识对应的内容不一致' }, 409)
        : fallback(url, init);
    render(<App />);
    await screen.findByLabelText('文章标题');
    fireEvent.change(screen.getByLabelText('文章标题'), {
      target: { value: '一篇需要核实冲突的文章' },
    });
    fireEvent.change(screen.getByLabelText('Markdown 正文'), {
      target: { value: '确认后的文字稿' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存到CSDN草稿' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('请求标识对应的内容不一致');
    expect(alert.textContent).not.toContain('浏览器空闲');
  });

  it('未识别的新任务状态使用明确占位并保留详情入口', async () => {
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url.startsWith('/api/jobs?')
        ? response({
            items: [{ ...job, status: 'future_state' }],
            total: 1,
            page: 1,
            page_size: 50,
          })
        : fallback(url, init);
    render(<App />);
    await screen.findByText('未知状态');
    expect(screen.getByRole('link', { name: '第一篇技术文章' }).getAttribute('href')).toContain(
      '/jobs/job-1',
    );
  });

  it('日志本地时间转换为UTC查询并拒绝超过31天的范围', async () => {
    window.history.replaceState({}, '', '/logs?view=events');
    render(<App />);
    await screen.findByRole('heading', { name: '运行记录' });
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-11-01T09:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-11-02T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() => {
      const filtered = appFixture.calls.filter((c) => c.url.startsWith('/api/logs?')).at(-1);
      expect(filtered).toBeDefined();
      const params = new URL(filtered!.url, 'http://localhost').searchParams;
      expect(params.get('from')).toBe(new Date('2026-11-01T09:00').toISOString());
      expect(params.get('to')).toBe(new Date('2026-11-02T09:00').toISOString());
    });
    const before = appFixture.calls.length;
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-12-31T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByText(/范围最多 31 天/);
    expect(appFixture.calls).toHaveLength(before);
  });

  it('暂停自动刷新不额外请求，仍可手动刷新', async () => {
    render(<App />);
    await screen.findByText('第一篇技术文章');
    vi.useFakeTimers();
    const before = appFixture.calls.length;
    fireEvent.click(screen.getByLabelText('每 5 秒刷新'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(appFixture.calls).toHaveLength(before);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(appFixture.calls).toHaveLength(before + 1);
  });

  it('退出使用CSRF并清除当前页面请求和轮询', async () => {
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/logout' ? response({}) : fallback(url, init);
    render(<App />);
    await screen.findByText('第一篇技术文章');
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await screen.findByRole('button', { name: '登录工作台' });
    expect(
      new Headers(appFixture.calls.find((c) => c.url === '/api/logout')?.init?.headers).get(
        'X-CSRF-Token',
      ),
    ).toBe('csrf-test');
    expect(
      appFixture.calls.filter((c) => c.init?.signal).every((c) => c.init?.signal?.aborted),
    ).toBe(true);
  });

  it('取消中任务不重复提供取消操作', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({ ...job, status: 'running', cancel_requested: true })
        : fallback(url, init);
    render(<App />);
    await screen.findByRole('heading', { name: '第一篇技术文章' });
    expect(screen.getAllByText('取消中').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '确认取消任务' })).toBeNull();
  });

  it('只有服务端明确允许的失败任务可安全重试', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({
            ...job,
            status: 'failed',
            retry_allowed: true,
            error_message: '编辑器打开前网络中断',
          })
        : url.endsWith('/retry')
          ? response({ ...job, status: 'queued' })
          : fallback(url, init);
    render(<App />);
    await screen.findByRole('button', { name: '重试任务' });
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }));
    await waitFor(() => expect(appFixture.calls.some((c) => c.url.endsWith('/retry'))).toBe(true));
    expect(
      new Headers(appFixture.calls.find((c) => c.url.endsWith('/retry'))?.init?.headers).get(
        'X-CSRF-Token',
      ),
    ).toBe('csrf-test');
  });

  it('刷新失败保留既有任务并标明数据可能过期', async () => {
    render(<App />);
    await screen.findByText('第一篇技术文章');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url.startsWith('/api/jobs?')
        ? response({ code: 'unavailable', message: '服务暂不可用' }, 503)
        : fallback(url, init);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByText(/数据可能已过期/);
    expect(screen.getByText('第一篇技术文章')).toBeTruthy();
  });

  it('预览不加载图片或执行HTML，并拒绝图片稿件提交', async () => {
    window.history.replaceState({}, '', '/jobs/new');
    const { container } = render(<App />);
    await screen.findByLabelText('文章标题');
    fireEvent.change(screen.getByLabelText('文章标题'), {
      target: { value: '含不支持内容的文章' },
    });
    fireEvent.change(screen.getByLabelText('Markdown 正文'), {
      target: { value: '<script>alert(1)</script>\n![图片](https://example.com/private.png)' },
    });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '保存到CSDN草稿' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await screen.findByText(/本轮仅支持文字 Markdown/);
    expect(appFixture.calls.filter((c) => c.url === '/api/jobs')).toHaveLength(0);
  });

  it('账号检查创建后台任务并保留登录入口', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/account/check'
        ? response({ ...job, kind: 'check_account' }, 202)
        : fallback(url, init);
    render(<App />);
    await screen.findByText('测试账号');
    expect(screen.getByRole('button', { name: '开始远程登录' })).toBeTruthy();
    expect(screen.queryByText(/验证主机/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '检查登录状态' }));
    await waitFor(() =>
      expect(appFixture.calls.some((c) => c.url === '/api/account/check')).toBe(true),
    );
    const check = appFixture.calls.find((c) => c.url === '/api/account/check')!;
    expect(JSON.parse(String(check.init?.body)).request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(check.init?.headers).get('X-CSRF-Token')).toBe('csrf-test');
  });

  it('会话失效后登录并使用用户名字段和同站点Cookie', async () => {
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/session'
        ? response({ message: '会话已失效' }, 401)
        : url === '/api/login'
          ? response(session)
          : fallback(url, init);
    render(<App />);
    await screen.findByRole('button', { name: '登录工作台' });
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'operator' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'private' } });
    fireEvent.click(screen.getByRole('button', { name: '登录工作台' }));
    await screen.findByText('第一篇技术文章');
    const login = appFixture.calls.find((c) => c.url === '/api/login')!;
    expect(JSON.parse(String(login.init?.body))).toEqual({
      username: 'operator',
      password: 'private',
    });
    expect(login.init?.credentials).toBe('same-origin');
    expect(screen.getByText('管理员')).toBeTruthy();
  });

  it('提交禁用重复点击且网络失败重试保留同一请求标识和CSRF', async () => {
    let finish: (value: Response) => void = () => {};
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : fallback(url, init);
    render(<App />);
    await screen.findByText('第一篇技术文章');
    fireEvent.click(screen.getByRole('link', { name: '新建草稿' }));
    await waitFor(() =>
      expect((screen.getByLabelText('发布账号') as HTMLSelectElement).value).toBe('csdn-main'),
    );
    fireEvent.change(screen.getByLabelText('文章标题'), { target: { value: '保存到草稿的文章' } });
    fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '# 安全的正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到CSDN草稿' }));
    expect((screen.getByRole('button', { name: '正在提交…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () =>
      finish(response({ code: 'temporary', message: '连接中断，请重试' }, 503)),
    );
    await screen.findByText('连接中断，请重试');
    fireEvent.click(screen.getByRole('button', { name: '保存到CSDN草稿' }));
    const submissions = appFixture.calls.filter((c) => c.url === '/api/jobs');
    expect(submissions).toHaveLength(2);
    const body = JSON.parse(String(submissions[0].init?.body));
    expect(body).toMatchObject({
      kind: 'save_draft',
      platform: 'csdn',
      title: '保存到草稿的文章',
      markdown: '# 安全的正文',
    });
    expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.parse(String(submissions[1].init?.body)).request_id).toBe(body.request_id);
    expect(new Headers(submissions[0].init?.headers).get('X-CSRF-Token')).toBe('csrf-test');
    await act(async () => finish(response(job, 202)));
    await screen.findByRole('heading', { name: '第一篇技术文章' });
  });

  it('草稿保存结果明确标识且运行日志以纯文本显示', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({
            ...job,
            status: 'succeeded',
            outcome: 'draft_saved',
            remote_id: '123',
            remote_url: 'https://mp.csdn.net/mp_blog/creation/editor/123',
          })
        : url.startsWith('/api/jobs/job-1/history?')
          ? response({
              transitions: [],
              items: [
                {
                  id: 'log-1',
                  job_id: 'job-1',
                  stage: 'saving',
                  level: 'info',
                  message: '<img src=x onerror=alert(1)>',
                  created_at: job.created_at,
                },
              ],
              total: 1,
              page: 1,
              page_size: 50,
            })
          : fallback(url, init);
    const { container } = render(<App />);
    await screen.findByText('草稿已保存');
    expect(screen.queryByText('已公开')).toBeNull();
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: '查看CSDN草稿' }).getAttribute('href')).toBe(
      'https://mp.csdn.net/mp_blog/creation/editor/123',
    );
  });

  it('小红书等待登录返回指定账号设置且不显示草稿处理', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({
            ...job,
            platform: 'xiaohongshu',
            account_id: 'xhs-main',
            kind: 'sync_notes',
            status: 'waiting_user',
          })
        : fallback(url, init);
    render(<App />);
    expect((await screen.findByRole('link', { name: '检查小红书账号' })).getAttribute('href')).toBe(
      '/account?tab=settings&account=xhs-main',
    );
    expect(screen.queryByRole('link', { name: '登录 CSDN' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新自动核对' })).toBeNull();
  });

  it('等待登录任务提示远程验证并允许手动继续', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({ ...job, status: 'waiting_user' })
        : url.endsWith('/resume')
          ? response({ ...job, status: 'queued' })
          : fallback(url, init);
    render(<App />);
    expect((await screen.findByRole('link', { name: '登录 CSDN' })).getAttribute('href')).toBe(
      '/account?tab=settings',
    );
    fireEvent.click(screen.getByLabelText('我已完成指定账号登录'));
    fireEvent.click(screen.getByRole('button', { name: '登录完成，继续任务' }));
    await waitFor(() => expect(appFixture.calls.some((c) => c.url.endsWith('/resume'))).toBe(true));
  });

  it('未知结果支持可选数字候选ID并确认保留草稿后人工结束，409有下一步', async () => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({ ...job, status: 'reconciling', outcome: 'unknown', external_started: true })
        : url.endsWith('/reconcile')
          ? response({ ...job, status: 'reconciling', outcome: 'unknown', external_started: true })
          : url.endsWith('/resolve')
            ? response({ code: 'worker_not_idle', message: '执行器尚未确认空闲' }, 409)
            : fallback(url, init);
    render(<App />);
    await screen.findByRole('heading', { name: '第一篇技术文章' });
    expect(screen.queryByRole('button', { name: '重试任务' })).toBeNull();
    fireEvent.change(screen.getByLabelText('候选草稿ID（可选，仅数字）'), {
      target: { value: '12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: '重新自动核对' }));
    await waitFor(() =>
      expect(appFixture.calls.some((c) => c.url.endsWith('/reconcile'))).toBe(true),
    );
    expect(
      JSON.parse(String(appFixture.calls.find((c) => c.url.endsWith('/reconcile'))?.init?.body)),
    ).toEqual({ remote_id: '12345' });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '重新自动核对' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByText('无法匹配完整稿件'));
    fireEvent.click(screen.getByLabelText('我已确认本任务浏览器停止，并保留可能存在的草稿'));
    fireEvent.change(screen.getByLabelText('人工结束原因'), {
      target: { value: '保留半成品供后续人工检查' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保留草稿并结束任务' }));
    await screen.findByText(/45 秒/);
    expect(
      JSON.parse(String(appFixture.calls.find((c) => c.url.endsWith('/resolve'))?.init?.body)),
    ).toEqual({
      confirmed_browser_stopped: true,
      note: '保留半成品供后续人工检查',
    });
  });

  it('筛选分页恢复在URL中且后续401停止轮询回到登录', async () => {
    window.history.replaceState({}, '', '/jobs?q=保留&status=failed&page=2');
    render(<App />);
    await screen.findByText('第一篇技术文章');
    expect((screen.getByLabelText('搜索任务') as HTMLInputElement).value).toBe('保留');
    expect(
      appFixture.calls.some(
        (c) => c.url.includes('q=%E4%BF%9D%E7%95%99') && c.url.includes('page=2'),
      ),
    ).toBe(true);
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url.startsWith('/api/jobs?') ? response({ message: '会话已过期' }, 401) : fallback(url, init);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('button', { name: '登录工作台' });
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
  });

  it('离开页面和隐藏时清理轮询并中止在途请求', async () => {
    const { unmount } = render(<App />);
    await screen.findByText('第一篇技术文章');
    vi.useFakeTimers();
    const before = appFixture.calls.length;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(appFixture.calls).toHaveLength(before);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    unmount();
    expect(
      appFixture.calls.filter((c) => c.init?.signal).every((c) => c.init?.signal?.aborted),
    ).toBe(true);
    const after = appFixture.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(appFixture.calls).toHaveLength(after);
  });
});
