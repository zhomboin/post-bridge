import { describe, expect, it, vi } from 'vitest';
import {
  LoginPageUnavailable,
  RemoteLoginManager,
  validateLoginInput,
} from '../src/remote-login.js';
import { startLoginControl } from '../src/login-control.js';

function setup(options: { now?: () => number; ttlMs?: number; idleMs?: number } = {}) {
  let connected: 'pending' | 'connected' | 'wrong' = 'pending';
  let closed = 0;
  const input = vi.fn(async () => {});
  const manager = new RemoteLoginManager(
    async () => ({
      connected: async () => connected,
      frame: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      input,
      close: async () => {
        closed++;
      },
    }),
    { ...options, pollMs: 5 },
  );
  return {
    manager,
    input,
    setConnected: (value: typeof connected) => {
      connected = value;
    },
    closed: () => closed,
  };
}

describe('远程登录会话', () => {
  it('创建立即pending，空闲维护时激活，指定身份确认后关闭', async () => {
    const fixture = setup();
    const { manager } = fixture;
    expect(manager.status().status).toBe('idle');
    const state = manager.create();
    expect(state.status).toBe('pending');
    expect(manager.pending()).toBe(true);
    expect(() => manager.create()).toThrow();
    const running = manager.run(new AbortController().signal);
    try {
      await vi.waitFor(() => expect(manager.status().status).toBe('active'));
      expect((await manager.frame(state.id)).length).toBeGreaterThan(0);
      fixture.setConnected('connected');
      await running;
      expect(manager.status().status).toBe('succeeded');
      expect(fixture.closed()).toBe(1);
      await expect(manager.input(state.id, { type: 'click', x: 10, y: 10 })).rejects.toThrow();
    } finally {
      await manager.close();
    }
  });
  it('错误账号不成功，取消只允许当前ID，停止关闭浏览器', async () => {
    const fixture = setup();
    const { manager } = fixture;
    const state = manager.create();
    const running = manager.run(new AbortController().signal);
    try {
      await vi.waitFor(() => expect(manager.status().status).toBe('active'));
      expect(() => manager.cancel('wrong-id')).toThrow();
      fixture.setConnected('wrong');
      await running;
      expect(manager.status().status).toBe('failed');
      expect(fixture.closed()).toBe(1);
    } finally {
      await manager.close();
    }
  });
  it.each(['ttl', 'idle'])('期限与无画面超时都会关闭浏览器：%s', async (kind) => {
    let now = 1000;
    const fixture = setup({ now: () => now, ttlMs: 100, idleMs: 50 });
    const { manager } = fixture;
    manager.create();
    const running = manager.run(new AbortController().signal);
    try {
      await vi.waitFor(() => expect(manager.status().status).toBe('active'));
      now += kind === 'ttl' ? 101 : 51;
      manager.status();
      await running;
      expect(manager.status().status).toBe('expired');
      expect(fixture.closed()).toBe(1);
    } finally {
      await manager.close();
    }
  });
  it('纯状态轮询不能为遗失所有权的会话续命', async () => {
    let now = 1000;
    const { manager } = setup({ now: () => now, idleMs: 50 });
    manager.create();
    const running = manager.run(new AbortController().signal);
    try {
      await vi.waitFor(() => expect(manager.status().status).toBe('active'));
      now += 30;
      manager.status();
      now += 30;
      manager.status();
      await running;
      expect(manager.status().status).toBe('expired');
    } finally {
      await manager.close();
    }
  });
  it('画面与输入串行执行，浏览器启动中取消也关闭后创建的上下文', async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    let closed = 0;
    const action = async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    };
    const manager = new RemoteLoginManager(
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          connected: async () => 'pending' as const,
          input: action,
          frame: async () => {
            await action();
            return Buffer.from('jpeg');
          },
          close: async () => {
            closed++;
          },
        };
      },
      { pollMs: 5 },
    );
    const state = manager.create();
    const running = manager.run(new AbortController().signal);
    release();
    try {
      await vi.waitFor(() => expect(manager.status().status).toBe('active'));
      await Promise.all([
        manager.input(state.id, { type: 'text', text: '合成' }),
        manager.frame(state.id),
      ]);
      expect(maximum).toBe(1);
      manager.cancel(state.id);
      await running;
      expect(closed).toBe(1);
    } finally {
      await manager.close();
    }
  });
  it('浏览器尚未启动完毕时取消也会关闭后创建的上下文', async () => {
    let release!: () => void;
    let closed = 0;
    const manager = new RemoteLoginManager(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        connected: async () => 'pending' as const,
        input: async () => {},
        frame: async () => Buffer.from('jpeg'),
        close: async () => {
          closed++;
        },
      };
    });
    const state = manager.create();
    const running = manager.run(new AbortController().signal);
    manager.cancel(state.id);
    release();
    await running;
    await manager.close();
    expect(closed).toBe(1);
    expect(manager.status().status).toBe('cancelled');
  });
  it('停止和取消后不接受输入且等待上下文关闭', async () => {
    const fixture = setup();
    const { manager } = fixture;
    const state = manager.create();
    const stop = new AbortController();
    const running = manager.run(stop.signal);
    await vi.waitFor(() => expect(manager.status().status).toBe('active'));
    manager.cancel(state.id);
    await running;
    await manager.close();
    expect(fixture.closed()).toBe(1);
    expect(manager.status().status).toBe('cancelled');
    await expect(manager.input(state.id, { type: 'text', text: '不能写入' })).rejects.toThrow();
  });
});

describe('远程登录输入限制', () => {
  it.each([
    { type: 'click', x: -1, y: 2 },
    { type: 'click', x: 1280, y: 2 },
    { type: 'text', text: 'x'.repeat(2001) },
    { type: 'key', key: 'Control+L' },
    { type: 'drag', points: [{ x: 1, y: 1 }] },
    { type: 'scroll', deltaY: 99999 },
    { type: 'navigate', url: 'https://evil.test' },
  ])('拒绝越界操作：%j', (value) => {
    expect(() => validateLoginInput(value)).toThrow();
  });
  it('允许点击文字安全按键拖动与滚动', () => {
    for (const input of [
      { type: 'click', x: 12, y: 34 },
      { type: 'text', text: '合成验证码' },
      { type: 'key', key: 'Tab' },
      {
        type: 'drag',
        points: [
          { x: 1, y: 2 },
          { x: 8, y: 2 },
        ],
      },
      { type: 'scroll', deltaY: -500 },
    ])
      expect(validateLoginInput(input)).toEqual(input);
  });
});

describe('回环登录控制服务', () => {
  it('校验密钥、禁缓存、消息大小及会话ID，不接受任意路径', async () => {
    const { manager } = setup();
    const token = 'test-token-'.repeat(4);
    const control = await startLoginControl('127.0.0.1:0', token, manager);
    try {
      expect((await fetch(control.url + '/login')).status).toBe(401);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const response = await fetch(control.url + '/login', { method: 'POST', headers });
      expect(response.status).toBe(202);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const state = (await response.json()) as { id: string };
      expect((await fetch(control.url + '/login/incorrect/frame', { headers })).status).toBe(404);
      expect(
        (
          await fetch(control.url + '/login/' + state.id + '/input', {
            method: 'POST',
            headers,
            body: 'x'.repeat(17000),
          })
        ).status,
      ).toBe(413);
      expect((await fetch(control.url + '/other', { headers })).status).toBe(404);
      expect(
        (await fetch(control.url + '/login/' + state.id, { method: 'DELETE', headers })).status,
      ).toBe(200);
      await expect(startLoginControl('0.0.0.0:12345', token, manager)).rejects.toThrow();
    } finally {
      await control.close();
      await manager.close();
    }
  });
});

describe('明确手机号和验证码的输入校验', () => {
  it.each([
    { type: 'fill', field: 'phone', text: '12345678901' },
    { type: 'fill', field: 'code', text: '123456' },
  ])('接受受限表单填写 $field', (value) => {
    expect(validateLoginInput(value)).toEqual(value);
  });
  it.each([
    { type: 'fill', field: 'other', text: '123456' },
    { type: 'fill', field: 'phone', text: 'not-a-number' },
    { type: 'fill', field: 'phone', text: '1234' },
    { type: 'fill', field: 'code', text: '123' },
    { type: 'fill', field: 'code', text: '123456789' },
    { type: 'fill', field: 'phone', text: '12345\n' },
    { type: 'fill', field: 'code', text: '1234\n' },
  ])('拒绝非法表单输入', (value) => {
    expect(() => validateLoginInput(value)).toThrow();
  });
});

it('认证页未就绪时保持pending，有限加载失败给出明确原因，不接收输入', async () => {
  let reject!: (error: Error) => void;
  const manager = new RemoteLoginManager(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const state = manager.create();
  const running = manager.run(new AbortController().signal);
  expect(manager.status().status).toBe('pending');
  await expect(manager.input(state.id, { type: 'text', text: '123456' })).rejects.toThrow();
  reject(new LoginPageUnavailable());
  await running;
  expect(manager.status()).toMatchObject({
    status: 'failed',
    error: 'CSDN 登录页面未能加载，请稍后重新开始',
  });
  await manager.close();
});

it('画面或输入占满队列时身份轮询等待，不关闭仍可用的登录会话', async () => {
  let release!: () => void;
  let first = true;
  let matched = false;
  const manager = new RemoteLoginManager(
    async () => ({
      connected: async () => (matched ? ('connected' as const) : ('pending' as const)),
      frame: async () => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Buffer.from('jpeg');
      },
      input: async () => {},
      close: async () => {},
    }),
    { pollMs: 5 },
  );
  const state = manager.create();
  const running = manager.run(new AbortController().signal);
  await vi.waitFor(() => expect(manager.status().status).toBe('active'));
  const operations = Array.from({ length: 4 }, () => manager.frame(state.id));
  const settled = Promise.allSettled(operations);
  try {
    await expect(manager.frame(state.id)).rejects.toMatchObject({ statusCode: 429 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.status().status).toBe('active');
    matched = true;
    release();
    await settled;
    await running;
    expect(manager.status().status).toBe('succeeded');
  } finally {
    release?.();
    await settled;
    await manager.close();
  }
});
