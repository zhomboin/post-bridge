import test from 'node:test';
import assert from 'node:assert/strict';
import { loginSession } from '../../scripts/login-session.mjs';

test('登录导航挂起时停止会立即关闭浏览器并释放账号锁', async () => {
  const controller = new AbortController();
  let closed = 0,
    released = 0,
    rejectNavigation;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const context = {
    async newPage() {
      return {
        goto() {
          markStarted();
          return new Promise((resolve, reject) => {
            rejectNavigation = reject;
          });
        },
      };
    },
    async close() {
      closed++;
      rejectNavigation(new Error('closed'));
    },
  };
  const task = loginSession(
    { profileDir: '/fixture', username: 'fixture' },
    {
      acquire: async () => ({
        release: async () => {
          released++;
        },
      }),
      launch: async () => context,
    },
    controller.signal,
  );
  await started;
  controller.abort();
  await assert.rejects(task, /closed/);
  assert.equal(closed, 1);
  assert.equal(released, 1);
});

test('浏览器尚在启动时停止，启动返回后立即关闭', async () => {
  const controller = new AbortController();
  let closed = 0,
    released = 0,
    finishLaunch;
  const launching = new Promise((resolve) => {
    finishLaunch = resolve;
  });
  const task = loginSession(
    { profileDir: '/fixture', username: 'fixture' },
    {
      acquire: async () => ({
        release: async () => {
          released++;
        },
      }),
      launch: () => launching,
    },
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  finishLaunch({
    close: async () => {
      closed++;
    },
  });
  assert.equal(await task, false);
  assert.equal(closed, 1);
  assert.equal(released, 1);
});
