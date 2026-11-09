import { mkdir, readdir, lstat, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { LoginBrowser } from './remote-login.js';
import { acquireProfile } from './profile.js';

// 调用方须已持有账号根目录锁；保留互斥锁、执行器身份与私有令牌。
export async function activeBrowserProfile(root: string): Promise<string> {
  const active = join(root, 'browser');
  await mkdir(active, { mode: 0o700, recursive: true });
  const marker = join(root, '.credential-layout');
  try {
    await lstat(marker);
    return active;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const entry of await readdir(root)) {
    if (entry === 'browser' || entry.startsWith('.')) continue;
    const source = join(root, entry);
    if ((await lstat(source)).isSymbolicLink()) throw Error('账号会话包含未核对的链接');
    await rename(source, join(active, entry));
  }
  await writeFile(marker, '1\n', { mode: 0o600, flag: 'wx' });
  return active;
}

export async function candidateLogin(
  root: string,
  open: (profile: string) => Promise<LoginBrowser>,
  signal?: AbortSignal,
): Promise<LoginBrowser> {
  const active = await activeBrowserProfile(root);
  const candidate = join(root, '.candidate-' + randomUUID());
  await mkdir(candidate, { mode: 0o700 });
  let browser: LoginBrowser;
  try {
    browser = await open(candidate);
  } catch (error) {
    await rm(candidate, { recursive: true, force: true });
    throw error;
  }
  let verified = false;
  let closing: Promise<void> | undefined;
  return {
    frame: () => browser.frame(),
    input: (value) => browser.input(value),
    connected: async () => {
      const status = await browser.connected();
      verified = status === 'connected';
      return status;
    },
    close: () =>
      (closing ??= (async () => {
        await browser.close();
        if (verified && !signal?.aborted) {
          const retired = join(root, '.retired-' + randomUUID());
          await rename(active, retired);
          try {
            await rename(candidate, active);
            await browser.commit?.();
          } catch (error) {
            await rm(active, { recursive: true, force: true });
            await rename(retired, active);
            await rm(candidate, { recursive: true, force: true });
            throw error;
          }
          await rm(retired, { recursive: true, force: true });
        } else await rm(candidate, { recursive: true, force: true });
      })()),
  };
}

export async function purgeAccountCredentials(root: string): Promise<void> {
  const owner = await acquireProfile(root);
  try {
    for (const entry of await readdir(root)) {
      if (['.post-bridge-owner', '.post-bridge-flock', '.post-bridge-worker-id'].includes(entry))
        continue;
      await rm(join(root, entry), { recursive: true, force: true });
    }
  } finally {
    await owner.release();
  }
}
