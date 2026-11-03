import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile, stat, readlink, lstat } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, safeRequestURL, validContent } from '../src/config.js';
import { acquireProfile, profileAvailable } from '../src/profile.js';
import { once } from 'node:events';
import { WorkerAPI } from '../src/api.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'post-bridge-worker-')); dirs.push(dir); return dir; }

describe('运行安全边界', () => {
  it('正式入口只接受固定平台与回环API，拒绝可执行内容和图片但保留代码示例', () => {
    expect(safeRequestURL('https://editor.csdn.net/md/')).toBe(true);
    expect(safeRequestURL('https://evil.test/a')).toBe(false);
    expect(safeRequestURL('javascript:alert(1)')).toBe(false);
    expect(safeRequestURL('https://csdn.net.evil.test/')).toBe(false);
    expect(validContent('标题测试文章', '正常\n\n```html\n<script>alert(1)</script>\n```')).toBe(true);
    expect(validContent('标题测试文章', '<script>alert(1)</script>')).toBe(false);
    expect(validContent('标题测试文章', '![图片](https://example.com/image.png)')).toBe(false);
    expect(validContent('标题测试文章', '<Component />')).toBe(false);
    expect(() => loadConfig({ API_BASE_URL: 'https://evil.test', CSDN_USERNAME: 'test' })).toThrow();
  });
  it('精确允许实测CSDN业务API域名，并拒绝相似域名与其他端口', () => {
    expect(safeRequestURL('https://bizapi.csdn.net/blog-console-api/v3/editor/getArticle')).toBe(true);
    expect(safeRequestURL('https://bizapi.csdn.net.evil.test/blog-console-api/v3/editor/getArticle')).toBe(false);
    expect(safeRequestURL('https://bizapi.csdn.net:8443/blog-console-api/v3/editor/getArticle')).toBe(false);
  });
  it('围栏遵循Markdown开闭规则，避免错误隐藏可执行HTML', () => {
    const title = '围栏边界验证文章';
    expect(validContent(title, '```js`invalid\n<script>alert(1)</script>\n```')).toBe(false);
    expect(validContent(title, '```html\n```notclose\n<script>这里只是代码</script>\n```')).toBe(true);
    expect(validContent(title, '\t```html\n<script>alert(1)</script>\n\t```')).toBe(false);
    expect(validContent(title, '```html\r\n普通代码\r\n```\r\n<script>alert(1)</script>')).toBe(false);
    expect(validContent(title, '~~~html`info\n<script>这里只是代码</script>\n~~~~  ')).toBe(true);
  });
  it('围栏外缩进内容仍接受安全校验，不把单独缩进行当作代码围栏', () => {
    expect(validContent('缩进边界验证文章', '正文段落\n    <script>alert(1)</script>')).toBe(false);
    expect(validContent('缩进边界验证文章', '正文段落\n\t![图片](https://example.com/a.png)')).toBe(false);
  });
  it('拒绝仓库内以两个点开头的profile目录', async () => {
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const profile = await mkdtemp(join(repository, '..worker-profile-test-')); dirs.push(profile);
    expect(() => loadConfig({ CSDN_USERNAME: 'fixture-user', CSDN_PROFILE_DIR: profile, WORKER_TOKEN_FILE: '/private/token' })).toThrow('仓库外');
  });
  it('worktree运行时同样拒绝外层主仓库作为profile', () => {
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const marker = repository.lastIndexOf('/.worktrees/');
    if (marker < 0) return;
    const mainRepository = repository.slice(0, marker);
    expect(() => loadConfig({ CSDN_USERNAME: 'fixture-user', CSDN_PROFILE_DIR: mainRepository, WORKER_TOKEN_FILE: '/private/token' })).toThrow('仓库外');
  });
  it('profile符号链接解析后的目标也必须位于仓库外', async () => {
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const target = await mkdtemp(join(repository, 'worker-profile-test-')); dirs.push(target);
    const base = await temporary(); const link = join(base, 'profile-link'); await symlink(target, link);
    expect(() => loadConfig({ CSDN_USERNAME: 'fixture-user', CSDN_PROFILE_DIR: link, WORKER_TOKEN_FILE: '/private/token' })).toThrow('仓库外');
  });
  it('同一专属profile跨配置加载与新执行器进程保留稳定身份', async () => {
    const profile = await temporary();
    const env = { CSDN_USERNAME: 'fixture-user', CSDN_PROFILE_DIR: profile, WORKER_TOKEN_FILE: join(profile, 'token') };
    const first = loadConfig(env);
    expect(loadConfig(env).workerId).toBe(first.workerId);
    const source = `import {loadConfig} from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)}; console.log(loadConfig(${JSON.stringify(env)}).workerId);`;
    const restarted = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { encoding: 'utf8' });
    expect(restarted.status).toBe(0);
    expect(restarted.stdout.trim()).toBe(first.workerId);
    expect((await stat(join(profile, '.post-bridge-worker-id'))).mode & 0o777).toBe(0o600);
    const other = await temporary();
    expect(loadConfig({ ...env, CSDN_PROFILE_DIR: other }).workerId).not.toBe(first.workerId);
  });
  it('远程登录默认关闭且只能使用IPv4回环非零端口', async () => {
    const profile = await temporary(); const env = { CSDN_USERNAME: 'fixture-user', CSDN_PROFILE_DIR: profile, WORKER_TOKEN_FILE: join(profile, 'token') };
    expect(loadConfig(env).loginControlAddr).toBeUndefined();
    expect(loadConfig({ ...env, LOGIN_CONTROL_ADDR: '127.0.0.1:18181' }).loginControlAddr).toBe('127.0.0.1:18181');
    for (const address of ['0.0.0.0:18181', 'localhost:18181', '127.0.0.1:0', '127.0.0.1:65536', 'http://127.0.0.1:18181']) expect(() => loadConfig({ ...env, LOGIN_CONTROL_ADDR: address })).toThrow();
  });
  it('稳定身份文件不接受符号链接或可被其他用户读取的文件', async () => {
    const profile = await temporary();
    const target = join(profile, 'other-file');
    await writeFile(target, 'worker-00000000-0000-4000-8000-000000000000');
    await symlink(target, join(profile, '.post-bridge-worker-id'));
    const env = { CSDN_USERNAME: 'fixture-user', CSDN_PROFILE_DIR: profile, WORKER_TOKEN_FILE: join(profile, 'token') };
    expect(() => loadConfig(env)).toThrow();
    await rm(join(profile, '.post-bridge-worker-id'));
    await writeFile(join(profile, '.post-bridge-worker-id'), 'worker-00000000-0000-4000-8000-000000000000', { mode: 0o644 });
    expect(() => loadConfig(env)).toThrow();
  });
  it('本地profile锁排他且不接管另一个实例或Chromium遗留锁', async () => {
    const dir = await temporary();
    const owner = await acquireProfile(dir);
    expect(await profileAvailable(dir)).toBe(false);
    await expect(acquireProfile(dir)).rejects.toThrow();
    expect(await profileAvailable(dir, owner)).toBe(true);
    await owner.release();
    expect(await profileAvailable(dir)).toBe(true);
    await symlink(`host-${process.pid}`, join(dir, 'SingletonLock'));
    expect(await profileAvailable(dir)).toBe(false);
    await expect(acquireProfile(dir)).rejects.toThrow();
  });
  it('安全恢复已不存在PID的私有锁，并发恢复只允许一个执行器', async () => {
    const dir = await temporary(); await mkdir(join(dir, '.post-bridge-owner'), { mode: 0o700 });
    await writeFile(join(dir, '.post-bridge-owner', 'owner.json'), JSON.stringify({ pid: 2147483647, nonce: '00000000-0000-4000-8000-000000000000' }), { mode: 0o600 });
    const attempts = await Promise.allSettled([acquireProfile(dir), acquireProfile(dir)]);
    const owners = attempts.flatMap(value => value.status === 'fulfilled' ? [value.value] : []);
    try { expect(owners).toHaveLength(1); expect(await profileAvailable(dir, owners[0])).toBe(true); }
    finally { await Promise.all(owners.map(owner => owner.release())); }
  });
  it('执行器SIGKILL后OS互斥随stdin关闭释放，遗留元数据可恢复', async () => {
    const dir = await temporary();
    const source = `import {acquireProfile} from ${JSON.stringify(new URL('../src/profile.ts', import.meta.url).href)}; await acquireProfile(process.argv[1]); process.stdout.write('ready'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source, dir], { stdio: ['ignore', 'pipe', 'ignore'] });
    let owner: Awaited<ReturnType<typeof acquireProfile>> | undefined;
    try {
      await once(child.stdout, 'data'); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      await vi.waitFor(async () => { owner = await acquireProfile(dir); expect(owner).toBeDefined(); }, { timeout: 3000 });
      expect(await profileAvailable(dir, owner)).toBe(true);
    } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } await owner?.release(); }
  });
  it('真实Chromium被SIGKILL后只清理已证明失效的Singleton符号链接', async () => {
    const dir = await temporary();
    const source = `import {chromium} from 'playwright'; import {acquireProfile} from ${JSON.stringify(new URL('../src/profile.ts', import.meta.url).href)}; await acquireProfile(process.argv[1]); await chromium.launchPersistentContext(process.argv[1],{headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||chromium.executablePath()}); process.stdout.write('ready'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source, dir], { stdio: ['ignore', 'pipe', 'ignore'] });
    let browserPID: number | undefined; let owner: Awaited<ReturnType<typeof acquireProfile>> | undefined;
    try {
      await once(child.stdout, 'data'); const target = await readlink(join(dir, 'SingletonLock')); browserPID = Number(target.slice(target.lastIndexOf('-') + 1));
      process.kill(-browserPID, 'SIGKILL');
      await vi.waitFor(() => { expect(() => process.kill(browserPID!, 0)).toThrow(); });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      expect((await lstat(join(dir, 'SingletonLock'))).isSymbolicLink()).toBe(true);
      await vi.waitFor(async () => { owner = await acquireProfile(dir); expect(owner).toBeDefined(); }, { timeout: 3000 });
      expect(await profileAvailable(dir, owner)).toBe(true);
    } finally {
      if (browserPID) { try { process.kill(-browserPID, 'SIGKILL'); } catch {} }
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
      await owner?.release();
    }
  }, 15000);
  it('PID已消失但Chromium锁仍在时拒绝恢复', async () => {
    const dir = await temporary(); await mkdir(join(dir, '.post-bridge-owner'), { mode: 0o700 });
    await writeFile(join(dir, '.post-bridge-owner', 'owner.json'), JSON.stringify({ pid: 2147483647, nonce: '00000000-0000-4000-8000-000000000000' }), { mode: 0o600 });
    await symlink('retained-browser', join(dir, 'SingletonLock'));
    await expect(acquireProfile(dir)).rejects.toThrow();
    expect((await stat(join(dir, '.post-bridge-owner'))).isDirectory()).toBe(true);
  });
  it('本机活PID的Chromium锁或非symlink入口均不能回收', async () => {
    for (const kind of ['live', 'regular']) {
      const dir = await temporary(); await mkdir(join(dir, '.post-bridge-owner'), { mode: 0o700 });
      await writeFile(join(dir, '.post-bridge-owner', 'owner.json'), JSON.stringify({ pid: 2147483647, nonce: '00000000-0000-4000-8000-000000000000' }), { mode: 0o600 });
      await symlink(`${hostname()}-${kind === 'live' ? process.pid : 2147483647}`, join(dir, 'SingletonLock'));
      if (kind === 'regular') await writeFile(join(dir, 'SingletonSocket'), '不得删除');
      await expect(acquireProfile(dir)).rejects.toThrow();
      expect((await lstat(join(dir, 'SingletonLock'))).isSymbolicLink()).toBe(true);
    }
  });
  it('不删除另一个进程持有的互斥目录，也不泄露原始网络错误', async () => {
    const dir = await temporary();
    await mkdir(join(dir, '.post-bridge-owner'));
    await writeFile(join(dir, '.post-bridge-owner', 'owner.json'), JSON.stringify({ pid: process.pid }));
    await expect(acquireProfile(dir)).rejects.toThrow();
    const api = new WorkerAPI('http://127.0.0.1:1', 'private-secret', 'worker-test');
    await expect(api.claim()).rejects.toThrow('内部服务暂不可用');
  });
});