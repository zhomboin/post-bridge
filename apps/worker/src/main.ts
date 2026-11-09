import { runAccountScheduler } from './account-scheduler.js';
const stop = new AbortController();
const shutdown = () => stop.abort();
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
try {
  await runAccountScheduler(stop.signal);
} catch {
  stop.abort();
  console.error('执行器已停止，请检查账号配置、内部服务和浏览器隔离环境。');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}
