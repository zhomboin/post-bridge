import { chromium } from 'playwright';
import { loadConfig, readPrivateToken } from './config.js';
import { WorkerAPI } from './api.js';
import { CSDNAdapter } from './csdn.js';
import { CSDNReadAdapter } from './csdn-read.js';
import { runWorker } from './worker.js';
import { RemoteLoginManager } from './remote-login.js';
import { startLoginControl } from './login-control.js';
import { openLoginBrowser } from './login-browser.js';

const stop = new AbortController();
let login: RemoteLoginManager | undefined;
let control: Awaited<ReturnType<typeof startLoginControl>> | undefined;
const shutdown = () => stop.abort();
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
try {
  const config = loadConfig();
  const token = await readPrivateToken(config.tokenFile);
  const api = new WorkerAPI(config.apiBaseURL, token, config.workerId);
  if (config.loginControlAddr) {
    login = new RemoteLoginManager(signal => openLoginBrowser(config, signal));
    control = await startLoginControl(config.loginControlAddr, token, login);
  }
  await runWorker(api, config.profileDir, async () => {
    // runWorker已持有专属目录锁；Chromium自身再取得同一profile的进程锁。
    const context = await chromium.launchPersistentContext(config.profileDir, { headless: config.headless, executablePath: config.executablePath, serviceWorkers: 'block', timeout: 30000, acceptDownloads: false });
    const adapter = new CSDNAdapter(context, { username: config.username, displayName: config.displayName });
    const reader = new CSDNReadAdapter(context, { username: config.username });
    return { run: (job, hooks, signal) => ['sync_articles', 'read_article'].includes(job.kind) ? reader.run(job, hooks, signal) : adapter.run(job, hooks, signal), close: async () => { await context.close(); } };
  }, stop.signal, config.pollIntervalMs, login);
} catch {
  console.error('执行器已停止，请检查内部服务、账号配置和专属浏览器锁。');
  process.exitCode = 1;
} finally {
  await login?.close();
  await control?.close();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}