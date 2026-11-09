import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface ProfileOwner {
  path: string;
  nonce: string;
  release(): Promise<void>;
}
const lockName = '.post-bridge-owner';
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function browserRunning(profile: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0');
      for (let i = 0; i < args.length; i++) {
        const candidate = args[i].startsWith('--user-data-dir=')
          ? args[i].slice(16)
          : args[i] === '--user-data-dir'
            ? args[i + 1]
            : undefined;
        if (candidate && resolve(candidate) === profile) return true;
      }
    } catch {
      /* 已退出或属于其他用户的进程不需要操作。 */
    }
  }
  return false;
}
export async function profileAvailable(path: string, owner?: ProfileOwner): Promise<boolean> {
  const profile = resolve(path);
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie'])
    if (await exists(join(profile, name))) return false;
  if (await browserRunning(profile)) return false;
  const lock = join(profile, lockName);
  if (!(await exists(lock))) return true;
  if (!owner || owner.path !== profile) return false;
  try {
    const value = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    return value.nonce === owner.nonce && value.pid === process.pid;
  } catch {
    return false;
  }
}
async function filesystemGuard(profile: string): Promise<() => Promise<void>> {
  const handle = await open(
    join(profile, '.post-bridge-flock'),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid!()
    )
      throw new Error('执行器系统锁必须为当前用户私有文件');
  } catch (error) {
    await handle.close();
    throw error;
  }
  // 固定命令和继承文件描述符避免shell与路径替换；stdin EOF使辅助进程自动释放OS锁。
  const child = spawn(
    '/usr/bin/flock',
    ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '/proc/self/fd/3', '/usr/bin/cat'],
    { stdio: ['pipe', 'pipe', 'ignore', handle.fd], detached: true },
  );
  const input = child.stdin!;
  const output = child.stdout!;
  let failedToSpawn = false;
  child.on('error', () => {
    failedToSpawn = true;
  });
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  input.on('error', () => {});
  await handle.close();
  const release = async () => {
    input.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (child.pid) {
              try {
                process.kill(-child.pid, 'SIGTERM');
              } catch {
                /* 辅助进程已经退出。 */
              }
            }
            resolve();
          }, 2000);
        }),
      ]);
      await exited;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      if (failedToSpawn || child.exitCode !== null || child.signalCode !== null) {
        reject(new Error('执行器系统锁未启动'));
        return;
      }
      let text = '';
      const timeout = setTimeout(() => finish(new Error('执行器系统锁未响应')), 3000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        output.off('data', data);
        child.off('error', failed);
        child.off('close', failed);
        error ? reject(error) : resolve();
      };
      const failed = () => finish(new Error('浏览器配置被其他执行器占用或缺少flock'));
      const data = (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (text === 'post-bridge-profile-lock\n') finish();
        else if (text.length > 64) failed();
      };
      output.on('data', data);
      child.once('error', failed);
      child.once('close', failed);
      input.write('post-bridge-profile-lock\n');
    });
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
async function clearDeadBrowserLinks(profile: string): Promise<void> {
  const lock = join(profile, 'SingletonLock');
  const names = ['SingletonSocket', 'SingletonCookie', 'SingletonLock'];
  if (!(await exists(lock))) {
    for (const name of names.slice(0, 2))
      if (await exists(join(profile, name))) throw new Error('无法确认浏览器遗留锁');
    return;
  }
  const info = await lstat(lock);
  if (!info.isSymbolicLink()) throw new Error('浏览器锁格式未知');
  const target = await readlink(lock);
  const prefix = `${hostname()}-`;
  if (!target.startsWith(prefix) || !/^[1-9][0-9]{0,9}$/.test(target.slice(prefix.length)))
    throw new Error('浏览器锁不属于本机已知进程');
  const pid = Number(target.slice(prefix.length));
  let absent = false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    absent = (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  if (!absent || (await browserRunning(profile))) throw new Error('账号浏览器仍在运行');
  const links: { path: string; ino: number; dev: number }[] = [];
  for (const name of names) {
    const path = join(profile, name);
    if (!(await exists(path))) continue;
    const value = await lstat(path);
    if (!value.isSymbolicLink()) throw new Error('浏览器锁入口不是符号链接');
    links.push({ path, ino: value.ino, dev: value.dev });
  }
  if ((await readlink(lock)) !== target || (await browserRunning(profile)))
    throw new Error('浏览器锁在检查期间发生变化');
  for (const link of links) {
    const current = await lstat(link.path);
    if (!current.isSymbolicLink() || current.ino !== link.ino || current.dev !== link.dev)
      throw new Error('浏览器锁在检查期间发生变化');
  }
  // 仅解除profile内的三个已验证链接，不跟随或删除它们指向的临时路径。
  for (const link of links) await unlink(link.path);
}
async function reclaimStale(profile: string, lock: string): Promise<void> {
  const directory = await lstat(lock);
  const file = await lstat(join(lock, 'owner.json'));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid!() ||
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    (file.mode & 0o077) !== 0 ||
    file.uid !== process.getuid!() ||
    file.size > 256
  )
    throw new Error('无法证明遗留执行器锁可安全恢复');
  const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as {
    pid?: unknown;
    nonce?: unknown;
  };
  if (
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) < 2 ||
    Number(owner.pid) > 2147483647 ||
    typeof owner.nonce !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.nonce)
  )
    throw new Error('遗留执行器锁格式无效');
  let absent = false;
  try {
    process.kill(Number(owner.pid), 0);
  } catch (error) {
    absent = (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  if (!absent || (await browserRunning(profile))) throw new Error('原执行器或账号浏览器仍在运行');
  await clearDeadBrowserLinks(profile);
  await rm(lock, { recursive: true });
}
export async function acquireProfile(path: string): Promise<ProfileOwner> {
  if (process.platform !== 'linux') throw new Error('正式执行器必须在Linux环境中运行');
  const profile = resolve(path);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const info = await stat(profile);
  if (
    (await realpath(profile)) !== profile ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid!()
  )
    throw new Error('浏览器配置目录必须属于当前用户且权限为0700');
  const releaseGuard = await filesystemGuard(profile);
  try {
    const lock = join(profile, lockName);
    if (await exists(lock)) await reclaimStale(profile, lock);
    if (!(await profileAvailable(profile))) throw new Error('浏览器配置被其他实例或残留进程占用');
    await mkdir(lock, { mode: 0o700 });
    const nonce = randomUUID();
    try {
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      await rm(lock, { recursive: true, force: true });
      throw new Error('无法建立浏览器配置互斥锁');
    }
    let released = false;
    const owner: ProfileOwner = {
      path: profile,
      nonce,
      async release() {
        if (released) return;
        try {
          const value = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
          if (value.nonce !== nonce || value.pid !== process.pid)
            throw new Error('浏览器配置互斥锁已改变');
          await rm(lock, { recursive: true });
          released = true;
        } finally {
          await releaseGuard();
        }
      },
    };
    if (!(await profileAvailable(profile, owner))) {
      await owner.release();
      throw new Error('浏览器配置存在尚未停止的浏览器');
    }
    return owner;
  } catch (error) {
    await releaseGuard();
    throw error;
  }
}
