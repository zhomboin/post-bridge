import { chromium } from 'playwright';
import { acquireProfile } from '../apps/worker/dist/profile.js';
import { loadConfig } from '../apps/worker/dist/config.js';
import { loginSession } from './login-session.mjs';

const stop = new AbortController();
const shutdown = () => stop.abort();
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
try {
  const config = loadConfig();
  console.log('请在隔离窗口完成 CSDN 登录，指定身份确认后自动关闭，最长等待五分钟。');
  const matched = await loginSession(config, { launch: chromium.launchPersistentContext.bind(chromium), acquire: acquireProfile }, stop.signal);
  console.log(matched ? '指定账号登录已确认。请重新启动后台执行器。' : '未确认指定账号，本次登录窗口已关闭。');
  if (!matched) process.exitCode = 1;
} catch {
  console.error('登录助手未完成，请检查图形环境和专属浏览器目录。');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}