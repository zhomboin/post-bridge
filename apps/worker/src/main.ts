import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrivateToken, type Config } from './config.js';
import { loadConfigs } from './accounts-config.js';
import { WorkerAPI } from './api.js';
import { CSDNAdapter } from './csdn.js';
import { CSDNReadAdapter } from './csdn-read.js';
import { XiaohongshuAdapter } from './xiaohongshu.js';
import { runWorker } from './worker.js';
import { RemoteLoginManager } from './remote-login.js';
import { startLoginControl } from './login-control.js';
import { openLoginBrowser } from './login-browser.js';

const stop = new AbortController();
const shutdown = () => stop.abort();
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
async function accountWorker(config: Config) {
  let login: RemoteLoginManager | undefined;
  let control: Awaited<ReturnType<typeof startLoginControl>> | undefined;
  try {
    const token = await readPrivateToken(config.tokenFile);
    const api = new WorkerAPI(config.apiBaseURL, token, config.workerId, {
      id: config.accountId!,
      platform: config.platform!,
    });
    if (config.platform === 'csdn' && config.loginControlAddr) {
      login = new RemoteLoginManager((signal) => openLoginBrowser(config, signal));
      control = await startLoginControl(config.loginControlAddr, token, login);
    }
    await runWorker(
      api,
      config.profileDir,
      async () => {
        const temp = await mkdtemp(join(tmpdir(), 'pb-'));
        try {
          const context = await chromium.launchPersistentContext(config.profileDir, {
            headless: config.headless,
            executablePath: config.executablePath,
            serviceWorkers: 'block',
            chromiumSandbox: true,
            timeout: 30000,
            acceptDownloads: false,
            env: { ...process.env, TMPDIR: temp },
          });
          const adapter = new CSDNAdapter(context, {
            username: config.username,
            displayName: config.displayName,
          });
          const reader = new CSDNReadAdapter(context, { username: config.username });
          const xhs = new XiaohongshuAdapter(context, {
            accountId: config.accountId!,
            username: config.username,
            userId: config.userId || '',
          });
          return {
            run: (job, hooks, signal) =>
              config.platform === 'xiaohongshu'
                ? xhs.run(job, hooks, signal)
                : ['sync_articles', 'read_article'].includes(job.kind)
                  ? reader.run(job, hooks, signal)
                  : adapter.run(job, hooks, signal),
            close: async () => {
              try {
                await context.close();
              } finally {
                await rm(temp, { recursive: true, force: true });
              }
            },
          };
        } catch (error) {
          await rm(temp, { recursive: true, force: true });
          throw error;
        }
      },
      stop.signal,
      config.pollIntervalMs,
      login,
    );
  } finally {
    await login?.close();
    await control?.close();
  }
}
try {
  const configs = await loadConfigs();
  const results = await Promise.allSettled(
    configs.map((config) =>
      accountWorker(config).catch((error) => {
        stop.abort();
        throw error;
      }),
    ),
  );
  if (results.some((result) => result.status === 'rejected')) throw Error('执行器停止');
} catch {
  stop.abort();
  console.error('执行器已停止，请检查内部服务、账号配置和专属浏览器锁。');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}
