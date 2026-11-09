import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { readLoginIdentity } from '../src/login-identity.js';

describe('跳转期间读取指定身份', () => {
  it.each([
    'Execution context was destroyed, most likely because of a navigation',
    'Cannot find context with specified id',
    'Frame was detached',
  ])('只把已知跳转竞态当作待确认：%s', async (message) => {
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce('connected');
    const page = { evaluate, isClosed: () => false } as unknown as Page;
    await expect(readLoginIdentity(page, 'expected-user')).resolves.toBe('pending');
    await expect(readLoginIdentity(page, 'expected-user')).resolves.toBe('connected');
  });
  it.each([true, false])('浏览器关闭与其他脚本错误不被忽略：closed=%s', async (closed) => {
    const error = new Error(closed ? 'Execution context was destroyed' : 'unrelated script error');
    const page = {
      evaluate: vi.fn().mockRejectedValue(error),
      isClosed: () => closed,
    } as unknown as Page;
    await expect(readLoginIdentity(page, 'expected-user')).rejects.toBe(error);
  });
});

describe('真实页面身份来源和可见登录状态', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  it.each([
    ['https://mp.csdn.net/', '<a href="https://blog.csdn.net/expected-user">主页</a>', 'connected'],
    [
      'https://mp.csdn.net/',
      '<a href="https://blog.csdn.net/expected-user">主页</a><a>登录</a>',
      'pending',
    ],
    ['https://mp.csdn.net/', '<a href="https://blog.csdn.net/other-user">主页</a>', 'wrong'],
    [
      'https://mp.csdn.net/',
      '<a href="https://blog.csdn.net/expected-user">主页</a><div>登录</div>',
      'pending',
    ],
    [
      'https://mp.csdn.net/',
      '<a href="https://blog.csdn.net/other-user">主页</a><p>登录</p>',
      'pending',
    ],
    [
      'https://mp.csdn.net/',
      '<a href="https://blog.csdn.net/expected-user">主页</a><div aria-hidden="true">登录</div>',
      'pending',
    ],
    [
      'https://mp.csdn.net/',
      '<a href="https://blog.csdn.net/expected-user">主页</a><div inert>登录</div>',
      'pending',
    ],
    ['https://other.test/', '<a href="https://blog.csdn.net/expected-user">主页</a>', 'pending'],
    [
      'https://mp.csdn.net/',
      '<a href="https://blog.csdn.net/expected-user">主页</a><button hidden>登录</button>',
      'connected',
    ],
  ] as const)('一次页面快照核对来源和身份：%s / %s', async (url, html, expected) => {
    const context = await browser.newContext();
    try {
      await context.route('**/*', (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
      );
      const page = await context.newPage();
      await page.goto(url);
      expect(await readLoginIdentity(page, 'expected-user')).toBe(expected);
    } finally {
      await context.close();
    }
  });
});
