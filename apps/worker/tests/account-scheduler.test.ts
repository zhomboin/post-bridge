import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
const sandbox = process.env.ACCOUNT_SANDBOX_EXECUTABLE || '/usr/bin/bwrap';
if (process.env.CI && !existsSync(sandbox)) throw Error('CI 必须安装 bubblewrap');
afterEach(() => vi.unstubAllEnvs());
it.skipIf(!existsSync(sandbox))(
  '真实账号调度器登记独立入口、发送可用心跳并在空闲后释放子进程',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'post-bridge-scheduler-'));
    const initial = join(root, 'initial');
    const managed = join(root, 'managed');
    const tokenFile = join(root, 'scheduler-token');
    const scopedToken = 'synthetic-account-token-12345678901234567890';
    let wanted = true;
    let control = '';
    let available = false;
    let deregistered = false;
    const stop = new AbortController();
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/internal/worker/accounts') {
        expect(request.headers.authorization).toBe(
          'Bearer synthetic-scheduler-token-12345678901234567890',
        );
        response.end(
          JSON.stringify({
            items: [
              {
                id: 'acc_one',
                platform: 'csdn',
                username: 'synthetic',
                user_id: '',
                owner_user_id: 'usr_one',
                connection_version: 1,
                profile_ref: 'usr_one/acc_one/1',
                enabled: true,
                wanted,
                control_url: control,
                token: scopedToken,
              },
            ],
          }),
        );
        return;
      }
      if (request.headers.authorization !== 'Bearer ' + scopedToken) {
        response.writeHead(401);
        response.end('{}');
        return;
      }
      if (request.url === '/internal/worker/control') {
        if (request.method === 'POST') control = body.url;
        if (request.method === 'DELETE') deregistered = true;
      } else if (request.url === '/internal/worker/heartbeat') {
        available ||= body.profile_available === true;
      } else if (request.url === '/internal/worker/claim') {
        response.writeHead(204);
        response.end();
        return;
      }
      response.end('{}');
    });
    let running: Promise<void> | undefined;
    try {
      await mkdir(initial, { mode: 0o700 });
      await writeFile(tokenFile, 'synthetic-scheduler-token-12345678901234567890', { mode: 0o600 });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('缺少测试端口');
      for (const [key, value] of Object.entries({
        API_BASE_URL: 'http://127.0.0.1:' + address.port,
        CSDN_USERNAME: 'synthetic',
        CSDN_DISPLAY_NAME: '合成账号',
        CSDN_PROFILE_DIR: initial,
        WORKER_TOKEN_FILE: tokenFile,
        WORKER_PROFILE_ROOT: managed,
        ACCOUNT_SANDBOX_EXECUTABLE: sandbox,
      }))
        vi.stubEnv(key, value);
      vi.stubEnv('PLATFORM_ACCOUNTS_FILE', undefined);
      vi.stubEnv('LOGIN_CONTROL_ADDR', undefined);
      const { runAccountScheduler } = await import(
        pathToFileURL(resolve('dist/account-scheduler.js')).href
      );
      running = runAccountScheduler(stop.signal);
      await expect.poll(() => control, { timeout: 10000 }).not.toBe('');
      await expect.poll(() => available, { timeout: 10000 }).toBe(true);
      wanted = false;
      await expect.poll(() => deregistered, { timeout: 12000 }).toBe(true);
      stop.abort();
      await running;
      await expect(access(join(managed, 'usr_one/acc_one/1/.post-bridge-owner'))).rejects.toThrow();
      await expect(
        fetch(control + '/login', { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow();
    } finally {
      stop.abort();
      await running?.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
