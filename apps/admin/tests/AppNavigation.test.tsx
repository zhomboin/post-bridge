import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { appFixture, session, job, response } from './app-fixture';
it.each(['/jobs/%', '/logs/%E0%A4%A', '/integration-preparations/%FF'])(
  '无效编码路由 %s 显示不存在且保留工作台',
  async (path) => {
    window.history.replaceState({}, '', path);
    render(<App />);
    await screen.findByRole('heading', { name: '页面不存在' });
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeTruthy();
  },
);
it('从处理详情进入任务后返回原处理及筛选上下文', async () => {
  const back = '/logs/job-1?back=' + encodeURIComponent('/logs?status=failed');
  window.history.replaceState({}, '', '/jobs/job-1?back=' + encodeURIComponent(back));
  render(<App />);
  const link = await screen.findByRole('link', { name: '返回处理详情' });
  expect(link.getAttribute('href')).toBe(back);
});

it('离开账号设置页签中止画面与输入并撤销登录，返回时不自动创建会话', async () => {
  window.history.replaceState({}, '', '/account?tab=settings&q=保留&page=2');
  const fallback = appFixture.handler;
  let active = true;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:synthetic-frame'),
      revokeObjectURL: vi.fn(),
    }),
  );
  appFixture.handler = (url, init) =>
    url === '/api/account/login'
      ? response({
          id: active ? 'tab-login' : '',
          status: active ? 'active' : 'idle',
          width: 1280,
          height: 800,
          expires_at: '',
        })
      : url.endsWith('/frame')
        ? new Response('synthetic', { headers: { 'Content-Type': 'image/jpeg' } })
        : url.endsWith('/input')
          ? new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              );
            })
          : url === '/api/account/login/tab-login' && init?.method === 'DELETE'
            ? ((active = false), response({ status: 'cancelled' }))
            : fallback(url, init);
  render(<App />);
  await screen.findByRole('img', { name: 'CSDN 远程登录画面' });
  fireEvent.change(screen.getByLabelText('输入到页面的文字'), {
    target: { value: 'temporary-secret' },
  });
  fireEvent.click(screen.getByRole('button', { name: '发送文字' }));
  await waitFor(() =>
    expect(appFixture.calls.some((call) => call.url.endsWith('/input'))).toBe(true),
  );
  act(() => {
    window.history.replaceState({}, '', '/account?tab=stats&q=保留&page=2');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await waitFor(() =>
    expect(
      appFixture.calls.some(
        (call) => call.url === '/api/account/login/tab-login' && call.init?.method === 'DELETE',
      ),
    ).toBe(true),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    appFixture.calls
      .filter((call) => call.url.endsWith('/input'))
      .every((call) => call.init?.signal?.aborted),
  ).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: '账号设置' }));
  await screen.findByRole('button', { name: '开始远程登录' });
  expect(
    appFixture.calls.some(
      (call) => call.url === '/api/account/login' && call.init?.method === 'POST',
    ),
  ).toBe(false);
  expect(screen.queryByDisplayValue('temporary-secret')).toBeNull();
});

it('创建响应迟到时切换页签仍补充撤销，不重新显示登录', async () => {
  window.history.replaceState({}, '', '/account?tab=settings');
  const fallback = appFixture.handler;
  let finish: (value: Response) => void = () => {};
  appFixture.handler = (url, init) =>
    url === '/api/account/login'
      ? init?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : response({ id: '', status: 'idle', width: 1280, height: 800, expires_at: '' })
      : url === '/api/account/login/tab-late'
        ? response({ status: 'cancelled' })
        : fallback(url, init);
  render(<App />);
  const start = await screen.findByRole('button', { name: '开始远程登录' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  act(() => {
    window.history.replaceState({}, '', '/account?tab=stats');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await act(async () =>
    finish(
      response({ id: 'tab-late', status: 'pending', width: 1280, height: 800, expires_at: '' }),
    ),
  );
  await waitFor(() =>
    expect(
      appFixture.calls.some(
        (call) => call.url === '/api/account/login/tab-late' && call.init?.method === 'DELETE',
      ),
    ).toBe(true),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('tab', { name: '数据统计' }).getAttribute('aria-selected')).toBe('true');
});

it('登录画面请求未完成时离开设置会中止请求并释放页面锁定', async () => {
  window.history.replaceState({}, '', '/account?tab=settings');
  const fallback = appFixture.handler;
  appFixture.handler = (url, init) =>
    url === '/api/account/login'
      ? response({
          id: 'frame-pending',
          status: 'active',
          width: 1280,
          height: 800,
          expires_at: '',
        })
      : url.endsWith('/frame')
        ? new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          })
        : url === '/api/account/login/frame-pending'
          ? response({ status: 'cancelled' })
          : fallback(url, init);
  render(<App />);
  await screen.findByRole('dialog', { name: 'CSDN 登录' });
  await waitFor(() =>
    expect(appFixture.calls.some((call) => call.url.endsWith('/frame'))).toBe(true),
  );
  act(() => {
    window.history.replaceState({}, '', '/account');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await waitFor(() =>
    expect(
      appFixture.calls.some(
        (call) => call.url === '/api/account/login/frame-pending' && call.init?.method === 'DELETE',
      ),
    ).toBe(true),
  );
  expect(appFixture.calls.find((call) => call.url.endsWith('/frame'))?.init?.signal?.aborted).toBe(
    true,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.style.overflow).toBe('');
});

it('检查任务返回保留完整设置页签及列表筛选上下文', async () => {
  const back = '/account?tab=settings&q=保留&status=draft&page=2';
  window.history.replaceState({}, '', back);
  const fallback = appFixture.handler;
  appFixture.handler = (url, init) =>
    url === '/api/account/check'
      ? response({ ...job, kind: 'check_account' }, 202)
      : fallback(url, init);
  render(<App />);
  const check = await screen.findByRole('button', { name: '检查登录状态' });
  await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(check);
  expect(
    decodeURI((await screen.findByRole('link', { name: '返回账号设置' })).getAttribute('href')!),
  ).toBe(back);
  fireEvent.click(screen.getByRole('link', { name: '返回账号设置' }));
  await screen.findByRole('button', { name: '检查登录状态' });
  expect(screen.getByRole('tab', { name: '账号设置' }).getAttribute('aria-selected')).toBe('true');
  expect(new URLSearchParams(window.location.search).get('q')).toBe('保留');
});

it('总览查看账号直接进入账号设置', async () => {
  window.history.replaceState({}, '', '/');
  render(<App />);
  expect((await screen.findByRole('link', { name: '查看账号' })).getAttribute('href')).toBe(
    '/account?tab=settings',
  );
});

it.each(['source_guard_failed', 'source_changed'])(
  '来源暂停%s只提供来源授权入口，不引导登录或普通恢复',
  async (error_code) => {
    window.history.replaceState({}, '', '/jobs/job-1');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/jobs/job-1'
        ? response({
            ...job,
            status: 'waiting_user',
            error_code,
            error_message: '来源授权检查未通过，需要重新确认',
            integration_distribution_id: 'distribution-one',
          })
        : fallback(url, init);
    render(<App />);
    const link = await screen.findByRole('link', { name: '处理来源授权' });
    expect(link.getAttribute('href')).toBe(
      '/integrations?tab=distributions&distribution_id=distribution-one',
    );
    expect(screen.getByText('来源待处理')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '登录 CSDN' })).toBeNull();
    expect(screen.queryByLabelText('我已完成指定账号登录')).toBeNull();
    expect(screen.queryByRole('button', { name: /登录完成/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试任务' })).toBeNull();
    expect(appFixture.calls.some((call) => call.url.endsWith('/resume'))).toBe(false);
  },
);
it('任务列表对来源暂停显示来源待处理，实际账号等待仍保留登录流程', async () => {
  const fallback = appFixture.handler;
  appFixture.handler = (url, init) =>
    url.startsWith('/api/jobs?')
      ? response({
          items: [
            {
              ...job,
              status: 'waiting_user',
              error_code: 'source_changed',
              integration_distribution_id: 'distribution-one',
            },
          ],
          total: 1,
          page: 1,
          page_size: 50,
        })
      : fallback(url, init);
  render(<App />);
  expect(await screen.findByText('来源待处理')).toBeTruthy();
  expect(screen.queryByText('等待登录')).toBeNull();
});
it('来源异常后的未知外站结果仅核对，不提供普通恢复', async () => {
  window.history.replaceState({}, '', '/jobs/job-1');
  const fallback = appFixture.handler;
  appFixture.handler = (url, init) =>
    url === '/api/jobs/job-1'
      ? response({
          ...job,
          status: 'reconciling',
          outcome: 'unknown',
          external_started: true,
          error_code: 'source_guard_failed',
          integration_distribution_id: 'distribution-one',
        })
      : fallback(url, init);
  render(<App />);
  expect(await screen.findByRole('button', { name: '重新自动核对' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: '登录 CSDN' })).toBeNull();
  expect(screen.queryByRole('button', { name: /继续任务|恢复原任务/ })).toBeNull();
});
it('外部分发的实际账号登录等待仍允许登录后继续', async () => {
  window.history.replaceState({}, '', '/jobs/job-1');
  const fallback = appFixture.handler;
  appFixture.handler = (url, init) =>
    url === '/api/jobs/job-1'
      ? response({
          ...job,
          status: 'waiting_user',
          error_code: 'needs_login',
          integration_distribution_id: 'distribution-one',
        })
      : fallback(url, init);
  render(<App />);
  expect(await screen.findByRole('link', { name: '登录 CSDN' })).toBeTruthy();
  expect(screen.getByLabelText('我已完成指定账号登录')).toBeTruthy();
  expect(screen.queryByRole('link', { name: '处理来源授权' })).toBeNull();
});

describe('接入文档入口', () => {
  it('通过有名称的文档图标进入站内现行文档，显示表格和可下载契约', async () => {
    render(<App />);
    const link = await screen.findByRole('link', { name: '接入文档' });
    expect(link.getAttribute('href')).toBe('/docs/integrations');
    fireEvent.click(link);
    await screen.findByRole('heading', { level: 1, name: '外部系统接入' });
    expect(window.location.pathname).toBe('/docs/integrations');
    expect(screen.getAllByRole('table').length).toBeGreaterThan(5);
    expect(screen.getByRole('columnheader', { name: '负责方' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'OpenAPI' }).getAttribute('download')).toBe(
      'cms.openapi.yaml',
    );
    expect(screen.getByRole('link', { name: '测试向量' }).getAttribute('download')).toBe(
      'integration-contract.json',
    );
    expect(screen.getByRole('link', { name: '返回内容来源' }).getAttribute('href')).toBe(
      '/integrations',
    );
    expect(appFixture.calls.every((call) => !call.init?.method || call.init.method === 'GET')).toBe(
      true,
    );
  });

  it('直接访问文档可刷新，浏览器后退恢复原页面', async () => {
    window.history.replaceState({}, '', '/docs/integrations');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: '外部系统接入' });
    await act(async () => {
      window.history.replaceState({}, '', '/jobs?page=2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { level: 1, name: '平台任务' });
    fireEvent.click(screen.getByRole('link', { name: '接入文档' }));
    await screen.findByRole('heading', { level: 1, name: '外部系统接入' });
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await screen.findByRole('heading', { level: 1, name: '平台任务' });
    expect(window.location.search).toBe('?page=2');
  });

  it('未登录时直接访问文档保留管理员登录流程', async () => {
    window.history.replaceState({}, '', '/docs/integrations');
    appFixture.handler = () => response({ code: 'unauthorized' }, 401);
    render(<App />);
    await screen.findByRole('heading', { name: '登录发布工作台' });
    expect(screen.queryByRole('heading', { name: '外部系统接入' })).toBeNull();
  });
});
