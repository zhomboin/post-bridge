import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { appFixture, session, job, response } from './app-fixture';
describe('后台远程登录验证', () => {
  it('账号页可创建远程登录会话且请求防双击', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/account/login'
        ? response({
            id: init?.method === 'POST' ? 'login-test' : '',
            status: init?.method === 'POST' ? 'pending' : 'idle',
            width: 1280,
            height: 800,
            expires_at: '',
          })
        : fallback(url, init);
    render(<App />);
    const start = await screen.findByRole('button', { name: '开始远程登录' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    fireEvent.click(start);
    await screen.findByText('正在等待执行器空闲');
    const created = appFixture.calls.filter(
      (c) => c.url === '/api/account/login' && c.init?.method === 'POST',
    );
    expect(created).toHaveLength(1);
    expect(new Headers(created[0].init?.headers).get('X-CSRF-Token')).toBe('csrf-test');
  });
  it('远程验证关闭后停止画面轮询并撤销会话', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
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
            id: 'login-test',
            status: 'active',
            width: 1280,
            height: 800,
            expires_at: '2026-11-03T12:00:00Z',
          })
        : url.endsWith('/frame')
          ? new Response('synthetic', { headers: { 'Content-Type': 'image/jpeg' } })
          : url.endsWith('/login/login-test') && init?.method === 'DELETE'
            ? response({ status: 'cancelled' })
            : fallback(url, init);
    render(<App />);
    await screen.findByRole('img', { name: 'CSDN 远程登录画面' });
    fireEvent.click(screen.getByRole('button', { name: '结束远程登录' }));
    await screen.findByText('远程登录已结束');
    expect(
      appFixture.calls.some(
        (c) => c.url === '/api/account/login/login-test' && c.init?.method === 'DELETE',
      ),
    ).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
  it('服务未配置时说明原因，不显示可用登录入口', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/account/login'
        ? response({ code: 'remote_login_disabled', message: '服务器尚未启用远程登录' }, 503)
        : fallback(url, init);
    render(<App />);
    await screen.findByText('服务器尚未启用远程登录');
    expect(
      (screen.getByRole('button', { name: '开始远程登录' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('远程登录输入', () => {
  it('手机号和短信验证码直接填写指定输入框，清空本地值且不自动发短信或确认登录', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:synthetic-frame'),
        revokeObjectURL: vi.fn(),
      }),
    );
    appFixture.handler = (url, init) =>
      url === '/api/account/login'
        ? response({ id: 'login-test', status: 'active', width: 1280, height: 800, expires_at: '' })
        : url.endsWith('/frame')
          ? new Response('synthetic', { headers: { 'Content-Type': 'image/jpeg' } })
          : url.endsWith('/input')
            ? response({ ok: true })
            : fallback(url, init);
    render(<App />);
    await screen.findByRole('img', { name: 'CSDN 远程登录画面' });
    const phone = screen.getByLabelText('手机号') as HTMLInputElement;
    const code = screen.getByLabelText('短信验证码') as HTMLInputElement;
    expect(phone.type).toBe('tel');
    expect(phone.inputMode).toBe('numeric');
    expect(phone.autocomplete).toBe('off');
    expect(code.type).toBe('password');
    expect(code.inputMode).toBe('numeric');
    expect(code.autocomplete).toBe('off');
    fireEvent.change(phone, { target: { value: '13800000000' } });
    fireEvent.click(screen.getByRole('button', { name: '填写手机号' }));
    expect(phone.value).toBe('');
    await screen.findByText('手机号已填入，请在画面获取验证码');
    fireEvent.change(code, { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: '填写验证码' }));
    expect(code.value).toBe('');
    await screen.findByText('验证码已填入，请在画面确认登录');
    expect(
      appFixture.calls
        .filter((c) => c.init?.method === 'POST')
        .map((c) => ({ url: c.url, body: JSON.parse(String(c.init?.body)) })),
    ).toEqual([
      {
        url: '/api/account/login/login-test/input',
        body: { type: 'fill', field: 'phone', text: '13800000000' },
      },
      {
        url: '/api/account/login/login-test/input',
        body: { type: 'fill', field: 'code', text: '654321' },
      },
    ]);
    expect(screen.queryByText(/13800000000|654321/)).toBeNull();
  });
  it('明确输入只接受指定长度的数字，失败时不显示成功提示并清空本地值', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:synthetic-frame'),
        revokeObjectURL: vi.fn(),
      }),
    );
    appFixture.handler = (url, init) =>
      url === '/api/account/login'
        ? response({ id: 'login-test', status: 'active', width: 1280, height: 800, expires_at: '' })
        : url.endsWith('/frame')
          ? new Response('synthetic', { headers: { 'Content-Type': 'image/jpeg' } })
          : url.endsWith('/input')
            ? response({ message: '登录输入框当前不可用' }, 409)
            : fallback(url, init);
    render(<App />);
    await screen.findByRole('img', { name: 'CSDN 远程登录画面' });
    const phone = screen.getByLabelText('手机号') as HTMLInputElement;
    const code = screen.getByLabelText('短信验证码') as HTMLInputElement;
    for (const value of ['1234', '123456789012345678901', '+8613800000000', '12345 ']) {
      fireEvent.change(phone, { target: { value } });
      expect(
        (screen.getByRole('button', { name: '填写手机号' }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    for (const value of ['123', '123456789', '１２３４', '123a']) {
      fireEvent.change(code, { target: { value } });
      expect(
        (screen.getByRole('button', { name: '填写验证码' }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(appFixture.calls.filter((c) => c.url.endsWith('/input'))).toHaveLength(0);
    fireEvent.change(phone, { target: { value: '13800000000' } });
    fireEvent.click(screen.getByRole('button', { name: '填写手机号' }));
    expect(phone.value).toBe('');
    await screen.findByText('登录输入框当前不可用');
    expect(screen.queryByText('手机号已填入，请在画面获取验证码')).toBeNull();
  });
  it('短信或密码文字仅发送到输入接口并立即清空，键盘支持切换输入框', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:synthetic-frame'),
        revokeObjectURL: vi.fn(),
      }),
    );
    appFixture.handler = (url, init) =>
      url === '/api/account/login'
        ? response({ id: 'login-test', status: 'active', width: 1280, height: 800, expires_at: '' })
        : url.endsWith('/frame')
          ? new Response('synthetic', { headers: { 'Content-Type': 'image/jpeg' } })
          : url.endsWith('/input')
            ? response({ ok: true })
            : fallback(url, init);
    render(<App />);
    const image = await screen.findByRole('img', { name: 'CSDN 远程登录画面' });
    const field = screen.getByLabelText('输入到页面的文字') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'synthetic-otp' } });
    fireEvent.click(screen.getByRole('button', { name: '发送文字' }));
    await waitFor(() => expect(appFixture.calls.some((c) => c.url.endsWith('/input'))).toBe(true));
    expect(field.value).toBe('');
    expect(
      JSON.parse(String(appFixture.calls.find((c) => c.url.endsWith('/input'))?.init?.body)),
    ).toEqual({
      type: 'text',
      text: 'synthetic-otp',
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '下一输入框' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '下一输入框' }));
    await waitFor(() =>
      expect(appFixture.calls.filter((c) => c.url.endsWith('/input'))).toHaveLength(2),
    );
    expect(
      JSON.parse(String(appFixture.calls.filter((c) => c.url.endsWith('/input'))[1].init?.body)),
    ).toEqual({ type: 'key', key: 'Tab' });
  });
});

describe('远程登录输入与销毁边界', () => {
  it('画面快速输入逐字串行发送且Tab可离开画面', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    let finish: (r: Response) => void = () => {};
    let count = 0;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:synthetic-frame'),
        revokeObjectURL: vi.fn(),
      }),
    );
    appFixture.handler = (url, init) =>
      url === '/api/account/login'
        ? response({ id: 'login-test', status: 'active', width: 1280, height: 800, expires_at: '' })
        : url.endsWith('/frame')
          ? new Response('synthetic', { headers: { 'Content-Type': 'image/jpeg' } })
          : url.endsWith('/input')
            ? ++count === 1
              ? new Promise<Response>((r) => {
                  finish = r;
                })
              : response({ ok: true })
            : fallback(url, init);
    render(<App />);
    const image = await screen.findByRole('img', { name: 'CSDN 远程登录画面' });
    fireEvent.keyDown(image, { key: '1' });
    fireEvent.keyDown(image, { key: '2' });
    fireEvent.keyDown(image, { key: '3' });
    await waitFor(() => expect(count).toBe(1));
    finish(response({ ok: true }));
    await waitFor(() =>
      expect(appFixture.calls.filter((c) => c.url.endsWith('/input'))).toHaveLength(3),
    );
    expect(
      appFixture.calls
        .filter((c) => c.url.endsWith('/input'))
        .map((c) => JSON.parse(String(c.init?.body)).text),
    ).toEqual(['1', '2', '3']);
    expect(fireEvent.keyDown(image, { key: 'Tab' })).toBe(true);
  });
  it('创建已提交但响应迟到时离开页面仍撤销新会话', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    let finish: (r: Response) => void = () => {};
    appFixture.handler = (url, init) =>
      url === '/api/account/login'
        ? init?.method === 'POST'
          ? new Promise<Response>((r) => {
              finish = r;
            })
          : response({ id: '', status: 'idle', width: 1280, height: 800, expires_at: '' })
        : url === '/api/account/login/late-id'
          ? response({ status: 'cancelled' })
          : fallback(url, init);
    render(<App />);
    const start = await screen.findByRole('button', { name: '开始远程登录' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    fireEvent.click(screen.getByRole('link', { name: '平台任务' }));
    finish(
      response({ id: 'late-id', status: 'pending', width: 1280, height: 800, expires_at: '' }, 202),
    );
    await waitFor(() =>
      expect(
        appFixture.calls.some(
          (c) => c.url === '/api/account/login/late-id' && c.init?.method === 'DELETE',
        ),
      ).toBe(true),
    );
  });
});

describe('登录弹窗', () => {
  it('点击开始立即打开弹窗，关闭后恢复焦点并撤销等待会话', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    appFixture.handler = (url, init) =>
      url === '/api/account/login'
        ? response({
            id: init?.method === 'POST' ? 'modal-test' : '',
            status: init?.method === 'POST' ? 'pending' : 'idle',
            width: 1280,
            height: 800,
            expires_at: '',
          })
        : url === '/api/account/login/modal-test'
          ? response({ status: 'cancelled' })
          : fallback(url, init);
    render(<App />);
    const start = await screen.findByRole('button', { name: '开始远程登录' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    start.focus();
    fireEvent.click(start);
    const dialog = await screen.findByRole('dialog', { name: 'CSDN 登录' });
    await screen.findByText('正在等待执行器空闲');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(
        appFixture.calls.some(
          (c) => c.url === '/api/account/login/modal-test' && c.init?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(start);
  });

  it('创建响应迟到时关闭弹窗仍撤销会话，不重新打开', async () => {
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
        : url === '/api/account/login/late-modal'
          ? response({ status: 'cancelled' })
          : fallback(url, init);
    render(<App />);
    const start = await screen.findByRole('button', { name: '开始远程登录' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    fireEvent.click(await screen.findByRole('button', { name: '关闭登录弹窗' }));
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(appFixture.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
    await act(async () =>
      finish(
        response({ id: 'late-modal', status: 'pending', width: 1280, height: 800, expires_at: '' }),
      ),
    );
    await waitFor(() =>
      expect(
        appFixture.calls.some(
          (c) => c.url === '/api/account/login/late-modal' && c.init?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('弹窗终态清理', () => {
  it('输入未返回而轮询先成功时，关闭弹窗仍解锁入口并清理输入', async () => {
    window.history.replaceState({}, '', '/account?tab=settings');
    const fallback = appFixture.handler;
    let status = 'active';
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:synthetic-frame'),
        revokeObjectURL: vi.fn(),
      }),
    );
    appFixture.handler = (url, init) =>
      url === '/api/account/login'
        ? response({ id: 'finished-input', status, width: 1280, height: 800, expires_at: '' })
        : url.endsWith('/frame')
          ? new Response('synthetic', { headers: { 'Content-Type': 'image/jpeg' } })
          : url.endsWith('/input')
            ? new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () =>
                  reject(new DOMException('Aborted', 'AbortError')),
                );
              })
            : fallback(url, init);
    vi.useFakeTimers();
    await act(async () => {
      render(<App />);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('img', { name: 'CSDN 远程登录画面' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('输入到页面的文字'), {
      target: { value: 'temporary-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送文字' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    status = 'succeeded';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('指定账号登录成功，等待任务已恢复')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭登录弹窗' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      (screen.getByRole('button', { name: '开始远程登录' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      appFixture.calls
        .filter((c) => c.url.endsWith('/input'))
        .every((c) => c.init?.signal?.aborted),
    ).toBe(true);
    expect(screen.queryByDisplayValue('temporary-secret')).toBeNull();
  });
});
