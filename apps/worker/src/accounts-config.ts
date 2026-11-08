import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { loadConfig, readPrivateToken, type Config } from './config.js';

export async function loadConfigs(env: NodeJS.ProcessEnv = process.env): Promise<Config[]> {
  const csdn = { ...loadConfig(env), platform: 'csdn', accountId: 'csdn-main' };
  const configs: Config[] = [csdn];
  const file = env.PLATFORM_ACCOUNTS_FILE;
  if (!file) return configs;
  const info = lstatSync(file);
  if (!isAbsolute(file) || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid!() || info.size > 65536) throw Error('平台账号配置必须为私有文件');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!data || Object.keys(data).join() !== 'accounts' || !Array.isArray(data.accounts) || data.accounts.length !== 1) throw Error('平台账号配置无效');
  const a = data.accounts[0];
  const keys = ['id', 'platform', 'username', 'user_id', 'display_name', 'profile_dir', 'worker_token_file'];
  if (!a || Object.keys(a).some(key => !keys.includes(key)) || a.platform !== 'xiaohongshu' || typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(a.id) || a.id === 'csdn-main' || typeof a.user_id !== 'string' || !/^[a-f0-9]{24}$/.test(a.user_id) || typeof a.display_name !== 'string' || !a.display_name.trim() || a.display_name.length > 400 || typeof a.username !== 'string' || typeof a.profile_dir !== 'string' || typeof a.worker_token_file !== 'string') throw Error('平台账号配置无效');
  const xhs = loadConfig({ ...env, CSDN_USERNAME: a.username, CSDN_DISPLAY_NAME: a.display_name, CSDN_PROFILE_DIR: a.profile_dir, WORKER_TOKEN_FILE: a.worker_token_file, LOGIN_CONTROL_ADDR: undefined });
  if (xhs.profileDir === csdn.profileDir || await readPrivateToken(xhs.tokenFile) === await readPrivateToken(csdn.tokenFile)) throw Error('不同账号必须使用独立会话与执行器凭据');
  configs.push({ ...xhs, platform: 'xiaohongshu', accountId: a.id, userId: a.user_id });
  return configs;
}
