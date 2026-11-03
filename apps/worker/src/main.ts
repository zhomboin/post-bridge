import { chromium } from 'playwright';
import { loadConfig, readPrivateToken } from './config.js';
import { WorkerAPI } from './api.js';
import { CSDNAdapter } from './csdn.js';
import { runWorker } from './worker.js';

const stop = new AbortController();
const shutdown = () => stop.abort();
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
try {
  const config = loadConfig();
  const api = new WorkerAPI(config.apiBaseURL, await readPrivateToken(config.tokenFile), config.workerId);
  await runWorker(api, config.profileDir, async () => {
    // runWorker已持有专属目录锁；Chromium自身再取得同一profile的进程锁。
    const context = await chromium.launchPersistentContext(config.profileDir, { headless: config.headless, executablePath: config.executablePath, serviceWorkers: 'block', timeout: 30000, acceptDownloads: false });
    const adapter = new CSDNAdapter(context, { username: config.username, displayName: config.displayName });
    return { run: adapter.run.bind(adapter), close: async () => { await context.close(); } };
  }, stop.signal, config.pollIntervalMs);
} catch {
  console.error('执行器已停止，请检查内部服务、账号配置和专属浏览器锁。');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}