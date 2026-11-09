import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function profilesOverlap(first: string, second: string): boolean {
  const inside = (root: string, path: string) => {
    const value = relative(root, path);
    return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep));
  };
  return inside(first, second) || inside(second, first);
}

export function containedProfile(root: string, reference: string): string {
  if (!isAbsolute(root) || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[1-9][0-9]*$/.test(reference))
    throw Error('账号会话引用无效');
  const path = resolve(root, reference);
  if (relative(root, path).startsWith('..')) throw Error('账号会话超出私有目录');
  return path;
}

// 子进程只挂载代码、运行库、浏览器和自身会话，不继承调度器私有文件系统。
export function sandboxArguments(
  repo: string,
  profile: string,
  browser: string,
  runner: string,
): string[] {
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop',
    'ALL',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  for (const path of [
    '/usr',
    '/bin',
    '/lib',
    '/lib64',
    '/etc/ssl',
    '/etc/fonts',
    '/etc/hosts',
    '/etc/resolv.conf',
    '/etc/nsswitch.conf',
    '/etc/passwd',
    '/etc/group',
  ])
    if (existsSync(path)) args.push('--ro-bind', path, path);
  args.push(
    '--dir',
    repo,
    '--ro-bind',
    resolve(repo, 'apps/worker/dist'),
    resolve(repo, 'apps/worker/dist'),
    '--ro-bind',
    resolve(repo, 'apps/worker/package.json'),
    resolve(repo, 'apps/worker/package.json'),
    '--ro-bind',
    resolve(repo, 'node_modules'),
    resolve(repo, 'node_modules'),
  );
  const runtimes = new Set([dirname(dirname(process.execPath)), dirname(dirname(browser))]);
  for (const path of runtimes) args.push('--ro-bind', path, path);
  args.push(
    '--bind',
    profile,
    profile,
    '--chdir',
    repo,
    '--setenv',
    'HOME',
    '/tmp',
    '--',
    process.execPath,
    runner,
  );
  return args;
}
