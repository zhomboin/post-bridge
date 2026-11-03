import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ProfileOwner { path: string; nonce: string; release(): Promise<void> }
const lockName = '.post-bridge-owner';
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function browserRunning(profile: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0');
      for (let i = 0; i < args.length; i++) {
        const candidate = args[i].startsWith('--user-data-dir=') ? args[i].slice(16) : args[i] === '--user-data-dir' ? args[i + 1] : undefined;
        if (candidate && resolve(candidate) === profile) return true;
      }
    } catch { /* 已退出或属于其他用户的进程不需要操作。 */ }
  }
  return false;
}
export async function profileAvailable(path: string, owner?: ProfileOwner): Promise<boolean> {
  const profile = resolve(path);
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) if (await exists(join(profile, name))) return false;
  if (await browserRunning(profile)) return false;
  const lock = join(profile, lockName);
  if (!await exists(lock)) return true;
  if (!owner || owner.path !== profile) return false;
  try { const value = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); return value.nonce === owner.nonce && value.pid === process.pid; }
  catch { return false; }
}
export async function acquireProfile(path: string): Promise<ProfileOwner> {
  if (process.platform !== 'linux') throw new Error('正式执行器必须在Linux环境中运行');
  const profile = resolve(path);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const info = await stat(profile);
  if (await realpath(profile) !== profile || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('浏览器配置目录必须属于当前用户且权限为0700');
  if (!await profileAvailable(profile)) throw new Error('浏览器配置被其他实例或残留进程占用');
  const lock = join(profile, lockName);
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('浏览器配置被其他执行器占用'); }
  const nonce = randomUUID();
  try { await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 }); }
  catch { await rm(lock, { recursive: true, force: true }); throw new Error('无法建立浏览器配置互斥锁'); }
  let released = false;
  const owner: ProfileOwner = { path: profile, nonce, async release() {
    if (released) return;
    const value = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    if (value.nonce !== nonce || value.pid !== process.pid) throw new Error('浏览器配置互斥锁已改变');
    await rm(lock, { recursive: true }); released = true;
  } };
  if (!await profileAvailable(profile, owner)) { await owner.release(); throw new Error('浏览器配置存在尚未停止的浏览器'); }
  return owner;
}