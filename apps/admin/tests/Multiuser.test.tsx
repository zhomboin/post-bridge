import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App';

let role = 'user';
let accounts = [
  {
    id: 'acc_one',
    platform: 'csdn',
    username: 'one',
    display_name: '第一个账号',
    status: 'connected',
  },
  {
    id: 'acc_two',
    platform: 'csdn',
    username: 'two',
    display_name: '第二个账号',
    status: 'connected',
  },
];
let calls: { url: URL; init?: RequestInit }[];
let created = false;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  role = 'user';
  created = false;
  calls = [];
  accounts = [
    {
      id: 'acc_one',
      platform: 'csdn',
      username: 'one',
      display_name: '第一个账号',
      status: 'connected',
    },
    {
      id: 'acc_two',
      platform: 'csdn',
      username: 'two',
      display_name: '第二个账号',
      status: 'connected',
    },
  ];
  window.history.replaceState({}, '', '/account?account=acc_two');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), location.origin);
      calls.push({ url, init });
      if (url.pathname === '/api/session')
        return json({
          user: { id: 'usr_current', username: '当前用户', role },
          csrf_token: 'csrf-current',
        });
      if (url.pathname === '/api/accounts') {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          const account = {
            id: 'acc_three',
            platform: body.platform,
            username: body.username,
            display_name: body.display_name,
            status: 'unchecked',
          };
          accounts = [...accounts, account];
          return json({ account }, 201);
        }
        return json({ items: accounts.map((account) => ({ account, capabilities: {} })) });
      }
      if (url.pathname.startsWith('/api/accounts/') && init?.method === 'DELETE') {
        accounts = accounts.filter((account) => account.id !== url.pathname.split('/').at(-1));
        return json({ ok: true });
      }
      if (/^\/api\/accounts\/[^/]+\/contents$/.test(url.pathname)) {
        const account = url.pathname.split('/')[3];
        if (!accounts.some((entry) => entry.id === account)) throw Error('请求未绑定所选账号');
        return json({
          items: [],
          total: 0,
          page: 1,
          page_size: 20,
          snapshot: null,
          sync_job: null,
        });
      }
      if (url.pathname.startsWith('/api/account')) {
        const id = url.searchParams.get('account_id');
        if (!id || !accounts.some((account) => account.id === id))
          throw Error('请求未绑定所选账号');
        if (url.pathname === '/api/account')
          return json(accounts.find((account) => account.id === id));
        if (url.pathname === '/api/account/articles')
          return json({
            items: [],
            total: 0,
            page: 1,
            page_size: 20,
            snapshot: null,
            sync_job: null,
          });
        return json({ message: '正在等待账号执行器就绪' }, 503);
      }
      if (url.pathname === '/api/users') {
        if (init?.method === 'POST') {
          created = true;
          return json({ id: 'usr_new', username: 'new-user', role: 'user', enabled: true }, 201);
        }
        return json({
          items: [
            { id: 'usr_current', username: '当前用户', role: 'admin', enabled: true },
            ...(created
              ? [{ id: 'usr_new', username: 'new-user', role: 'user', enabled: true }]
              : []),
          ],
        });
      }
      return json({ message: '未找到' }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it('同平台账号切换带上明确账号范围，普通用户不显示用户管理', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: '第二个账号' });
  expect(screen.queryByRole('link', { name: '用户管理' })).toBeNull();
  fireEvent.change(screen.getByLabelText('选择平台账号'), { target: { value: 'acc_one' } });
  await screen.findByRole('heading', { name: '第一个账号' });
  expect(
    calls
      .filter((call) => call.url.pathname === '/api/account')
      .map((call) => call.url.searchParams.get('account_id')),
  ).toEqual(['acc_two', 'acc_one']);
});

it('绑定账号只提交平台身份，由服务器决定归属和会话目录', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: '第二个账号' });
  fireEvent.click(screen.getByRole('button', { name: '绑定账号' }));
  fireEvent.change(screen.getByLabelText('CSDN 用户名'), { target: { value: 'third' } });
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '第三个账号' } });
  fireEvent.click(screen.getByRole('button', { name: '绑定并登录' }));
  await screen.findByRole('heading', { name: '第三个账号' });
  const submission = calls.find(
    (call) => call.url.pathname === '/api/accounts' && call.init?.method === 'POST',
  )!;
  expect(JSON.parse(String(submission.init?.body))).toEqual({
    platform: 'csdn',
    username: 'third',
    display_name: '第三个账号',
  });
  expect(new Headers(submission.init?.headers).get('X-CSRF-Token')).toBe('csrf-current');
  expect(location.search).toBe('?account=acc_three&tab=settings');
});

it('解绑必须确认，并切换到仍属于自己的账号', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: '第二个账号' });
  fireEvent.click(screen.getByRole('button', { name: '解绑当前账号' }));
  expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认解绑' }));
  await screen.findByRole('heading', { name: '第一个账号' });
  expect(
    calls.some(
      (call) => call.url.pathname === '/api/accounts/acc_two' && call.init?.method === 'DELETE',
    ),
  ).toBe(true);
});

it('管理员创建普通用户后清除初始密码', async () => {
  role = 'admin';
  window.history.replaceState({}, '', '/users');
  render(<App />);
  await screen.findByRole('heading', { name: '用户管理' });
  fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'new-user' } });
  fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'synthetic-password' } });
  fireEvent.click(screen.getByRole('button', { name: '创建用户' }));
  await screen.findByRole('cell', { name: 'new-user' });
  await waitFor(() =>
    expect((screen.getByLabelText('初始密码') as HTMLInputElement).value).toBe(''),
  );
  expect(document.body.textContent).not.toContain('synthetic-password');
});
