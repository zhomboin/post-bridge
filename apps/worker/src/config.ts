import { readFile, stat } from 'node:fs/promises';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const allowedHosts = new Set(['mp.csdn.net', 'editor.csdn.net', 'bizapi.csdn.net', 'blog.csdn.net', 'passport.csdn.net', 'g.csdnimg.cn', 'csdnimg.cn', 'img-blog.csdnimg.cn', 'img-home.csdnimg.cn', 'i.csdnimg.cn', 'gimg.csdnimg.cn']);
export function safeRequestURL(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') && allowedHosts.has(url.hostname); }
  catch { return false; }
}
export interface ImageDestination { url: string; start: number; end: number }

function nestedImage(line: string, position: number): boolean {
  let label = 0;
  let destination = 0;
  let code = 0;
  for (let index = 0; index < position; index++) {
    const token = line[index];
    if (token === '\\' && !code) { index++; continue; }
    if (token === '`' && !destination) {
      const start = index;
      while (line[index + 1] === '`') index++;
      const length = index - start + 1;
      if (!code) code = length;
      else if (code === length) code = 0;
      continue;
    }
    if (code) continue;
    if (destination) {
      if (token === '(') destination++;
      else if (token === ')') destination--;
      continue;
    }
    if (token === '[') label++;
    else if (token === ']' && label) {
      label--;
      if (line[index + 1] === '(') { destination = 1; index++; }
    }
  }
  return label > 0 || destination > 0 || code > 0;
}

export function contentImages(title: string, markdown: string, fixtureCopyOrigin?: string): ImageDestination[] | undefined {
  if ([...title].length < 5 || [...title].length > 100 || !markdown.trim() || [...markdown].length > 200000) return undefined;
  const images: ImageDestination[] = [];
  const outside: string[] = [];
  const inline = /(?<!\\)!\[([^\[\]\\\r\n]*)\]\((https?:\/\/[^\s()[\]\\<>"]+)\)/gd;
  let fence = '';
  let offset = 0;
  for (const entry of markdown.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    const line = entry[0].replace(/[\r\n]+$/, '');
    const position = offset;
    offset += entry[0].length;
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = '';
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) { fence = opening[1]; continue; }
    outside.push(line.replace(inline, (_, alt: string) => alt));
    for (const match of line.matchAll(inline)) {
      if (images.length >= 20 || nestedImage(line, match.index)) return undefined;
      let url: URL;
      try { url = new URL(match[2]); } catch { return undefined; }
      if ((url.protocol !== 'https:' && url.origin !== fixtureCopyOrigin) || url.username || url.password || (url.port && url.origin !== fixtureCopyOrigin) || url.pathname === '/' ||
          match[2].length > 2048 || /[?#]|%(?:5c|0d|0a|09)/i.test(match[2]) || match[2] !== url.href) return undefined;
      const [start, end] = match.indices![2]!;
      images.push({ url: match[2], start: position + start, end: position + end });
    }
  }
  if (/!\s*\[|<\s*\/?\s*[a-zA-Z]|\b(?:javascript|vbscript|data)\s*:/i.test(outside.join('\n'))) return undefined;
  return images;
}

export function validContent(title: string, markdown: string): boolean {
  return contentImages(title, markdown)?.length === 0;
}
export interface Config {
  platform?: string; accountId?: string; userId?: string;
  apiBaseURL: string; tokenFile: string; username: string; displayName: string; profileDir: string;
  executablePath?: string; headless: boolean; workerId: string; pollIntervalMs: number; loginControlAddr?: string;
}
function canonicalCandidate(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(existing), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) throw new Error('无法核对浏览器配置目录');
      missing.push(basename(existing)); existing = dirname(existing);
    }
  }
}
function repositoryRoots(): string[] {
  const repository = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const roots = [repository];
  for (let cursor = repository; dirname(cursor) !== cursor; cursor = dirname(cursor)) if (basename(cursor) === '.worktrees') roots.push(dirname(cursor));
  return roots.map(root => realpathSync(root));
}
function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function profileWorkerID(profile: string): string {
  if (process.platform !== 'linux') throw new Error('正式执行器必须在Linux环境中运行');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const directory = statSync(profile);
  if (realpathSync(profile) !== profile || !directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid!()) throw new Error('浏览器配置目录必须属于当前用户且权限为0700');
  const path = join(profile, '.post-bridge-worker-id');
  let created: number | undefined;
  try {
    created = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(created, `worker-${randomUUID()}\n`, 'utf8');
    fsyncSync(created);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('无法建立专属执行器身份');
  } finally { if (created !== undefined) closeSync(created); }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid!() || info.size > 100) throw new Error('invalid identity');
    const value = readFileSync(fd, 'utf8').trim();
    if (!/^worker-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error('invalid identity');
    return value;
  } catch { throw new Error('专属执行器身份文件必须为当前用户的0600常规私有文件'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const api = new URL(env.API_BASE_URL || 'http://127.0.0.1:8080');
  if (api.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', 'api'].includes(api.hostname) || api.username || api.password || api.pathname !== '/' || api.search || api.hash) throw new Error('内部服务地址必须为受限本地HTTP地址');
  if (env.LOGIN_CONTROL_ADDR && (!/^127\.0\.0\.1:[0-9]{1,5}$/.test(env.LOGIN_CONTROL_ADDR) || Number(env.LOGIN_CONTROL_ADDR.split(':')[1]) < 1 || Number(env.LOGIN_CONTROL_ADDR.split(':')[1]) > 65535)) throw new Error('登录控制服务必须使用IPv4回环非零端口');
  const username = env.CSDN_USERNAME || '';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(username)) throw new Error('必须配置预期CSDN账号');
  const suppliedProfile = env.CSDN_PROFILE_DIR || '';
  if (!isAbsolute(suppliedProfile)) throw new Error('浏览器配置目录必须位于仓库外的专属目录');
  const profileDir = canonicalCandidate(suppliedProfile);
  if (repositoryRoots().some(root => inside(root, profileDir))) throw new Error('浏览器配置目录必须位于仓库外的专属目录');
  if (!env.WORKER_TOKEN_FILE || !isAbsolute(env.WORKER_TOKEN_FILE)) throw new Error('必须配置私有执行器凭据文件');
  return { apiBaseURL: api.origin, tokenFile: env.WORKER_TOKEN_FILE, username, displayName: env.CSDN_DISPLAY_NAME || '', profileDir: resolve(profileDir), executablePath: env.PLAYWRIGHT_EXECUTABLE_PATH || undefined, headless: env.WORKER_HEADLESS !== 'false', workerId: profileWorkerID(resolve(profileDir)), pollIntervalMs: 1500, loginControlAddr: env.LOGIN_CONTROL_ADDR || undefined };
}
export async function readPrivateToken(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('执行器凭据文件必须为私有文件');
  const token = (await readFile(path, 'utf8')).trim();
  if (token.length < 32 || token.length > 4096 || /\s/.test(token)) throw new Error('执行器凭据格式无效');
  return token;
}