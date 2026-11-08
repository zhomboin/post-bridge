import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfigs } from '../src/accounts-config.js';
let directory: string;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'pb-config-'));
  const csdnToken = join(directory, 'csdn-token'),
    xhsToken = join(directory, 'xhs-token');
  await writeFile(csdnToken, 'c'.repeat(32), { mode: 0o600 });
  await writeFile(xhsToken, 'x'.repeat(32), { mode: 0o600 });
  const account = {
    id: 'xhs-main',
    platform: 'xiaohongshu',
    username: 'synthetic-red',
    user_id: 'a'.repeat(24),
    display_name: '合成小红书账号',
    profile_dir: join(directory, 'xhs-profile'),
    worker_token_file: xhsToken,
  };
  const file = join(directory, 'accounts.json');
  await writeFile(file, JSON.stringify({ accounts: [account] }), { mode: 0o600 });
  const env = {
    API_BASE_URL: 'http://127.0.0.1:8080',
    WORKER_TOKEN_FILE: csdnToken,
    CSDN_USERNAME: 'synthetic-csdn',
    CSDN_PROFILE_DIR: join(directory, 'csdn-profile'),
    PLATFORM_ACCOUNTS_FILE: file,
  };
  return { account, file, env };
}
describe('平台执行器私有账号配置', () => {
  it('分别绑定稳定身份、凭据和目录，未启用时保持 CSDN', async () => {
    const { env } = await fixture();
    const configs = await loadConfigs(env);
    expect(configs.map((c) => c.platform)).toEqual(['csdn', 'xiaohongshu']);
    expect(configs[0].workerId).not.toBe(configs[1].workerId);
    expect(configs[1].userId).toBe('a'.repeat(24));
    expect(configs[1].loginControlAddr).toBeUndefined();
    expect(await loadConfigs({ ...env, PLATFORM_ACCOUNTS_FILE: undefined })).toHaveLength(1);
  });
  it('拒绝共享凭据或会话、非私有文件与未支持平台', async () => {
    const { account, file, env } = await fixture();
    for (const patch of [
      { worker_token_file: env.WORKER_TOKEN_FILE },
      { profile_dir: env.CSDN_PROFILE_DIR },
      { platform: 'other' },
      { user_id: 'invalid' },
      { id: 'csdn-main' },
    ]) {
      await writeFile(file, JSON.stringify({ accounts: [{ ...account, ...patch }] }));
      await expect(loadConfigs(env)).rejects.toThrow();
    }
    await writeFile(file, JSON.stringify({ accounts: [account] }));
    await chmod(file, 0o644);
    await expect(loadConfigs(env)).rejects.toThrow();
  });
});
