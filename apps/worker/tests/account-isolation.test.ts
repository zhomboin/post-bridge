import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { containedProfile, sandboxArguments } from '../src/account-sandbox.js';
import {
  activeBrowserProfile,
  candidateLogin,
  purgeAccountCredentials,
} from '../src/account-credentials.js';
import { acquireProfile, profileAvailable } from '../src/profile.js';
import { xiaohongshuLoginRequestAllowed } from '../src/xiaohongshu-login.js';

const bwrap = process.env.ACCOUNT_SANDBOX_EXECUTABLE || '/usr/bin/bwrap';
if (process.env.CI && !existsSync(bwrap)) throw Error('CI 必须安装 bubblewrap');
const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'post-bridge-account-isolation-'));
  directories.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('账号认证隔离', () => {
  it('拒绝目录穿越和用户提交的绝对目录', () => {
    expect(containedProfile('/private/accounts', 'usr_a/acc_b/1')).toBe(
      '/private/accounts/usr_a/acc_b/1',
    );
    for (const path of [
      '../secret',
      '/private/secret',
      'usr_a/../1',
      'usr_a/acc_b/0',
      'usr_a/acc_b/1/other',
    ])
      expect(() => containedProfile('/private/accounts', path)).toThrow();
  });
  it('保留已有浏览器数据，并且重复初始化不覆盖', async () => {
    const root = await fixture();
    await mkdir(join(root, 'Default'));
    await writeFile(join(root, 'Default', 'Cookies'), 'existing');
    await writeFile(join(root, '.executor-token'), 'private');
    const active = await activeBrowserProfile(root);
    expect(await readFile(join(active, 'Default', 'Cookies'), 'utf8')).toBe('existing');
    expect(await activeBrowserProfile(root)).toBe(active);
    expect(await readFile(join(root, '.executor-token'), 'utf8')).toBe('private');
  });
  it('错误账号不能覆盖有效会话，正确身份关闭后才切换', async () => {
    const root = await fixture();
    const active = await activeBrowserProfile(root);
    await writeFile(join(active, 'session'), 'original');
    let closed = 0;
    const open = async (path: string, connected: 'connected' | 'wrong') => {
      await writeFile(join(path, 'session'), 'replacement');
      return {
        frame: async () => Buffer.alloc(0),
        input: async () => {},
        connected: async () => connected,
        close: async () => {
          closed++;
        },
      };
    };
    const wrong = await candidateLogin(root, (path) => open(path, 'wrong'));
    expect(await wrong.connected()).toBe('wrong');
    await wrong.close();
    expect(await readFile(join(active, 'session'), 'utf8')).toBe('original');
    const correct = await candidateLogin(root, (path) => open(path, 'connected'));
    expect(await correct.connected()).toBe('connected');
    expect(await readFile(join(active, 'session'), 'utf8')).toBe('original');
    await correct.close();
    await correct.close();
    expect(closed).toBe(2);
    expect(await readFile(join(active, 'session'), 'utf8')).toBe('replacement');
  });
  it('身份核验后取消仍不替换有效会话', async () => {
    const root = await fixture();
    const active = await activeBrowserProfile(root);
    await writeFile(join(active, 'session'), 'original');
    const stop = new AbortController();
    const browser = await candidateLogin(
      root,
      async (path) => {
        await writeFile(join(path, 'session'), 'candidate');
        return {
          frame: async () => Buffer.alloc(0),
          input: async () => {},
          connected: async () => 'connected' as const,
          close: async () => {
            stop.abort();
          },
        };
      },
      stop.signal,
    );
    await browser.connected();
    await browser.close();
    expect(await readFile(join(active, 'session'), 'utf8')).toBe('original');
  });
  it('归属提交失败时恢复有效会话', async () => {
    const root = await fixture();
    const active = await activeBrowserProfile(root);
    await writeFile(join(active, 'session'), 'original');
    const login = await candidateLogin(root, async (path) => {
      await writeFile(join(path, 'session'), 'candidate');
      return {
        frame: async () => Buffer.alloc(0),
        input: async () => {},
        connected: async () => 'connected' as const,
        close: async () => {},
        commit: async () => {
          throw Error('归属冲突');
        },
      };
    });
    await login.connected();
    await expect(login.close()).rejects.toThrow('归属冲突');
    expect(await readFile(join(active, 'session'), 'utf8')).toBe('original');
  });
  it('父调度器持锁时账号子进程可借用身份，错误父进程身份被拒绝', async () => {
    const root = await fixture();
    const owner = await acquireProfile(root);
    try {
      expect(await profileAvailable(root, { ...owner, pid: process.pid })).toBe(true);
      expect(await profileAvailable(root, { ...owner, pid: process.pid + 1 })).toBe(false);
      await expect(acquireProfile(root)).rejects.toThrow();
    } finally {
      await owner.release();
    }
    const next = await acquireProfile(root);
    await next.release();
  });
  it('解绑清除凭据并保留执行器身份，不触及其他账号', async () => {
    const parent = await fixture();
    const own = join(parent, 'own');
    const other = join(parent, 'other');
    await mkdir(own, { mode: 0o700 });
    await mkdir(other, { mode: 0o700 });
    await writeFile(join(own, '.post-bridge-worker-id'), 'identity');
    await writeFile(join(own, '.executor-token'), 'secret');
    await writeFile(join(other, 'session'), 'other');
    await purgeAccountCredentials(own);
    expect(await readFile(join(own, '.post-bridge-worker-id'), 'utf8')).toBe('identity');
    await expect(access(join(own, '.executor-token'))).rejects.toThrow();
    expect(await readFile(join(other, 'session'), 'utf8')).toBe('other');
  });
  it('登录网络只允许平台登录请求，阻止外站写入', () => {
    expect(
      xiaohongshuLoginRequestAllowed('https://creator.xiaohongshu.com/api/galaxy/user/info', 'GET'),
    ).toBe(true);
    expect(
      xiaohongshuLoginRequestAllowed('https://customer.xiaohongshu.com/api/login/qrcode', 'POST'),
    ).toBe(true);
    for (const url of [
      'https://creator.xiaohongshu.com/api/publish',
      'https://creator.xiaohongshu.com/api/upload',
      'https://xiaohongshu.com.evil.invalid/login',
      'http://127.0.0.1/private',
    ])
      expect(xiaohongshuLoginRequestAllowed(url, 'POST')).toBe(false);
  });
  it.skipIf(!existsSync(bwrap))('真实账号沙箱无法读取其他账号、调度器密钥或源码配置', async () => {
    const root = await fixture();
    const own = join(root, 'own');
    await mkdir(own, { mode: 0o700 });
    await writeFile(join(root, 'other-secret'), 'private');
    const script = join(own, 'probe.mjs');
    await writeFile(
      script,
      `import{existsSync}from'node:fs';if(!existsSync(${JSON.stringify(own)})||existsSync(${JSON.stringify(join(root, 'other-secret'))})||existsSync(${JSON.stringify(resolve('..', '..', '.git'))}))process.exit(1);`,
    );
    const browser = process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();
    await writeFile(
      script,
      `import{existsSync}from'node:fs';import{chromium}from${JSON.stringify(resolve('../../node_modules/playwright/index.mjs'))};if(!existsSync(${JSON.stringify(own)})||existsSync(${JSON.stringify(join(root, 'other-secret'))})||existsSync(${JSON.stringify(resolve('../..', '.git'))}))process.exit(1);const context=await chromium.launchPersistentContext(${JSON.stringify(join(own, 'browser'))},{headless:true,chromiumSandbox:true,executablePath:${JSON.stringify(browser)}});try{const page=await context.newPage();await page.setContent('<title>账号隔离验证</title>');if(await page.title()!=='账号隔离验证')process.exitCode=1;}finally{await context.close()}`,
    );
    const owner = await acquireProfile(own);
    const previous = await readFile(script, 'utf8');
    await writeFile(
      script,
      `import{profileAvailable}from${JSON.stringify(resolve('dist/profile.js'))};if(!await profileAvailable(${JSON.stringify(own)},{path:${JSON.stringify(own)},nonce:${JSON.stringify(owner.nonce)},pid:${process.pid}}))process.exit(2);` +
        previous,
    );
    const args = sandboxArguments(resolve('../..'), own, browser, script);
    const result = spawnSync(bwrap, args, {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      timeout: 15000,
    });
    await owner.release();
    expect(result.status, result.stderr).toBe(0);
  });
});
