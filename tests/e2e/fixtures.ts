import { remoteLoginFixture } from './login-fixture';
import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export type Stack = {
  url: string;
  username: string;
  password: string;
  workerToken: string;
  xhsWorkerToken?: string;
  startWorker(): () => Promise<void>;
};
const go = process.env.E2E_GO_BIN || 'go';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function port() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('无法分配隔离测试端口');
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let count = 0; count < 50 && child.exitCode === null && child.signalCode === null; count++)
    await delay(100);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((done) => child.once('exit', () => done()));
  }
}
export const test = base.extend<
  {},
  { stack: Stack; remoteLoginMethod: 'sms' | 'qr'; xiaohongshu: boolean }
>({
  xiaohongshu: [false, { scope: 'worker', option: true }],
  remoteLoginMethod: ['sms', { scope: 'worker', option: true }],
  stack: [
    async ({ remoteLoginMethod, xiaohongshu }, use) => {
      const database = process.env.TEST_DATABASE_URL;
      if (!database) throw Error('端到端验证必须提供 TEST_DATABASE_URL');
      const schema = 'e2e_' + randomBytes(12).toString('hex');
      const directory = mkdtempSync(resolve(tmpdir(), 'post-bridge-e2e-'));
      let child: ChildProcess | undefined;
      let remote: Awaited<ReturnType<typeof remoteLoginFixture>> | undefined;
      let created = false;
      const db = (action: string) => {
        try {
          execFileSync(go, ['run', resolve(root, 'tests/e2e/database.go'), action, schema], {
            cwd: resolve(root, 'apps/api'),
            env: { ...process.env, TEST_DATABASE_URL: database },
            stdio: 'pipe',
            timeout: 120_000,
          });
        } catch {
          throw Error('端到端隔离数据库操作失败，连接详情已隐藏');
        }
      };
      try {
        db('create');
        created = true;
        const username = 'e2e-admin';
        const password = randomBytes(24).toString('hex');
        const workerToken = randomBytes(32).toString('hex');
        remote = await remoteLoginFixture(directory, workerToken, remoteLoginMethod);
        const passwordFile = resolve(directory, 'admin.secret');
        const workerFile = resolve(directory, 'worker.secret');
        writeFileSync(passwordFile, password, { mode: 0o600 });
        writeFileSync(workerFile, workerToken, { mode: 0o600 });
        const xhsWorkerToken = xiaohongshu ? randomBytes(32).toString('hex') : undefined;
        const accountsFile = resolve(directory, 'accounts.json');
        if (xhsWorkerToken) {
          const tokenFile = resolve(directory, 'xhs.secret');
          writeFileSync(tokenFile, xhsWorkerToken, { mode: 0o600 });
          writeFileSync(
            accountsFile,
            JSON.stringify({
              accounts: [
                {
                  id: 'xhs-main',
                  platform: 'xiaohongshu',
                  username: 'synthetic-red',
                  user_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
                  display_name: '合成小红书作者',
                  profile_dir: resolve(directory, 'xhs-profile'),
                  worker_token_file: tokenFile,
                },
              ],
            }),
            { mode: 0o600 },
          );
        }
        const binary = resolve(directory, 'api');
        try {
          execFileSync(go, ['build', '-o', binary, './cmd/server'], {
            cwd: resolve(root, 'apps/api'),
            stdio: 'pipe',
            timeout: 120_000,
          });
        } catch {
          throw Error('端到端 Go API 构建失败');
        }
        const address = '127.0.0.1:' + (await port());
        const url = 'http://' + address;
        const isolatedDatabase = new URL(database);
        isolatedDatabase.searchParams.set('search_path', schema);
        const dist = resolve(root, 'apps/admin/dist');
        if (!existsSync(resolve(dist, 'index.html'))) throw Error('请先构建后台，再运行端到端用例');
        child = spawn(binary, [], {
          cwd: root,
          stdio: 'ignore',
          env: {
            ...process.env,
            DATABASE_URL: isolatedDatabase.href,
            API_ADDR: address,
            API_BASE_URL: url,
            REMOTE_LOGIN_URL: remote.url,
            PLATFORM_ACCOUNTS_FILE: xiaohongshu ? accountsFile : undefined,
            ADMIN_USERNAME: username,
            ADMIN_PASSWORD_FILE: passwordFile,
            WORKER_TOKEN_FILE: workerFile,
            CSDN_USERNAME: 'synthetic-csdn-account',
            CSDN_DISPLAY_NAME: '演示创作者',
            ADMIN_DIST_DIR: dist,
          },
        });
        for (let count = 0; ; count++) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw Error('隔离 API 未能启动，配置详情已隐藏');
          if (
            await fetch(url + '/healthz')
              .then((response) => response.ok)
              .catch(() => false)
          )
            break;
          if (count > 100) throw Error('隔离 API 启动超时');
          await delay(100);
        }
        await use({
          url,
          username,
          password,
          workerToken,
          xhsWorkerToken,
          startWorker: () => remote!.startWorker(url),
        });
      } finally {
        try {
          await remote?.close();
        } finally {
          await stop(child);
          try {
            if (created) db('drop');
          } finally {
            rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  baseURL: async ({ stack }, use) => {
    await use(stack.url);
  },
  context: async ({ context }, use) => {
    // 浏览器只访问本轮回环 API，不允许真实平台请求。
    await context.route('**/*', async (route) => {
      const hostname = new URL(route.request().url()).hostname;
      if (hostname === '127.0.0.1' || hostname === 'localhost') await route.continue();
      else await route.abort('blockedbyclient');
    });
    await use(context);
  },
});
export { expect };

export async function login(page: Page, stack: Stack) {
  await page.goto('/');
  await page.getByLabel('账号').fill(stack.username);
  await page.getByLabel('密码', { exact: true }).fill(stack.password);
  await page.getByRole('button', { name: '登录工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '发布工作台', exact: true })).toBeVisible();
}
export async function csrf(request: APIRequestContext) {
  const response = await request.get('/api/session');
  expect(response.status()).toBe(200);
  return (await response.json()).csrf_token as string;
}
export async function worker(request: APIRequestContext, stack: Stack, path: string, data: object) {
  const response = await request.post(path, {
    headers: { Authorization: 'Bearer ' + stack.workerToken },
    data,
  });
  expect(response.status(), '受限模拟执行器请求应成功').toBe(200);
  return response;
}
export async function finishDraft(request: APIRequestContext, stack: Stack, id: string) {
  const response = await worker(request, stack, '/internal/worker/claim', {
    worker_id: 'e2e-fixed-worker',
  });
  const claim = await response.json();
  expect(claim.job.id).toBe(id);
  expect(claim.job.kind).toBe('save_draft');
  const path = '/internal/worker/jobs/' + id;
  const lease = { lease_token: claim.lease_token };
  await worker(request, stack, path + '/progress', { ...lease, stage: 'checking_login' });
  await worker(request, stack, path + '/progress', {
    ...lease,
    stage: 'opening_editor',
    external_started: true,
  });
  await worker(request, stack, path + '/progress', {
    ...lease,
    stage: 'draft_acquired',
    remote_id: '123456789',
  });
  await worker(request, stack, path + '/progress', {
    ...lease,
    stage: 'filling',
    message: 'Cookie=synthetic-secret 正文不可进入日志',
  });
  await worker(request, stack, path + '/progress', { ...lease, stage: 'saving' });
  await worker(request, stack, path + '/progress', { ...lease, stage: 'verifying' });
  await worker(request, stack, path + '/complete', {
    ...lease,
    status: 'succeeded',
    remote_id: '123456789',
  });
  await worker(request, stack, '/internal/worker/heartbeat', {
    worker_id: 'e2e-fixed-worker',
    browser_idle: true,
    profile_available: true,
  });
}
