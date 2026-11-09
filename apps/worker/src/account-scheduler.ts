import { chromium } from 'playwright';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { loginControlAddress } from './login-control.js';
import { purgeAccountCredentials } from './account-credentials.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, realpath, stat, open, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireProfile, type ProfileOwner } from './profile.js';
import { loadConfigs } from './accounts-config.js';
import { readPrivateToken } from './config.js';
import { containedProfile, sandboxArguments, profilesOverlap } from './account-sandbox.js';

type Descriptor = {
  id: string;
  platform: string;
  username: string;
  user_id: string;
  owner_user_id: string;
  connection_version: number;
  profile_ref?: string;
  enabled: boolean;
  wanted?: boolean;
  credentials_revoked?: boolean;
  retired_profiles?: string[];
  token?: string;
  control_url?: string;
};
type Running = {
  process: ChildProcess;
  signature: string;
  stopped: Promise<void>;
  stopping: boolean;
  token: string;
  controlURL?: string;
};

export async function runAccountScheduler(signal: AbortSignal): Promise<void> {
  const configs = await loadConfigs();
  const primary = configs[0];
  const token = await readPrivateToken(primary.tokenFile);
  const root = resolve(
    process.env.WORKER_PROFILE_ROOT || join(dirname(primary.profileDir), 'managed'),
  );
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  if (
    profilesOverlap(root, repo) ||
    configs.some((config) => profilesOverlap(root, config.profileDir))
  )
    throw Error('账号存储根目录不得包含代码、配置或已导入会话');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await stat(root);
  if (
    (await realpath(root)) !== root ||
    metadata.mode & 0o077 ||
    metadata.uid !== process.getuid!()
  )
    throw Error('账号存储根目录必须为私有真实目录');
  const runner = fileURLToPath(new URL('./account-runner.js', import.meta.url));
  const browser = primary.executablePath || chromium.executablePath();
  const sandbox = process.env.ACCOUNT_SANDBOX_EXECUTABLE || '/usr/bin/bwrap';
  await access(sandbox, constants.X_OK);
  const retries = new Map<string, number>();
  const children = new Map<string, Running>();
  const purged = new Set<string>();
  function profileFor(item: Descriptor, reference = item.profile_ref || '') {
    if (reference.startsWith('configured/')) {
      const config = configs.find((config) => config.accountId === item.id);
      if (!config) throw Error('缺少已导入账号的会话配置');
      return config.profileDir;
    }
    return containedProfile(root, reference);
  }
  async function purge(item: Descriptor, reference: string) {
    const key = item.id + ':' + reference;
    if (purged.has(key)) return;
    await purgeAccountCredentials(profileFor(item, reference));
    purged.add(key);
  }
  const health = createServer((request, response) => {
    request.resume();
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end('{"error":"需要内部身份"}');
  });
  if (primary.loginControlAddr) {
    const address = loginControlAddress(primary.loginControlAddr);
    await new Promise<void>((resolve, reject) => {
      health.once('error', reject);
      health.listen(address.port, address.host, () => {
        health.off('error', reject);
        resolve();
      });
    });
  }
  async function stop(id: string) {
    const child = children.get(id);
    if (!child) return;
    child.stopping = true;
    let endpoint = child.controlURL;
    if (!endpoint) {
      try {
        const response = await fetch(primary.apiBaseURL + '/internal/worker/accounts', {
          headers: { Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        });
        if (response.ok)
          endpoint = ((await response.json()) as { items: Descriptor[] }).items.find(
            (item) => item.id === id,
          )?.control_url;
      } catch {}
    }
    if (endpoint && /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(endpoint)) {
      await fetch(endpoint + '/shutdown', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + child.token },
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    }
    const timer = setTimeout(() => child.process.kill('SIGKILL'), 10000);
    try {
      await child.stopped;
    } finally {
      clearTimeout(timer);
      children.delete(id);
    }
  }
  try {
    while (!signal.aborted) {
      const response = await fetch(primary.apiBaseURL + '/internal/worker/accounts', {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        redirect: 'error',
      });
      if (!response.ok) throw Error('无法读取账号执行范围');
      const body = (await response.json()) as { items: Descriptor[] };
      if (!Array.isArray(body.items) || body.items.length > 10000) throw Error('账号执行范围无效');
      const enabled = new Set<string>();
      const counts = new Map<string, number>();
      for (const item of body.items) {
        const count = counts.get(item.owner_user_id) || 0;
        if (item.enabled && item.wanted && enabled.size < 16 && count < 4) {
          enabled.add(item.id);
          counts.set(item.owner_user_id, count + 1);
        }
      }
      for (const item of body.items) {
        const child = children.get(item.id);
        if (child) child.controlURL = item.control_url;
      }
      for (const id of children.keys()) if (!enabled.has(id)) await stop(id);
      for (const item of body.items) {
        if ((retries.get(item.id) || 0) > Date.now()) continue;
        let pendingOwner: ProfileOwner | undefined;
        try {
          if (!item.enabled) {
            if (item.credentials_revoked && item.profile_ref) await purge(item, item.profile_ref);
            for (const reference of item.retired_profiles || []) await purge(item, reference);
            continue;
          }
          if (!enabled.has(item.id)) {
            for (const reference of item.retired_profiles || []) await purge(item, reference);
            continue;
          }
          if (!item.token) throw Error('账号执行凭据缺失');
          purged.delete(item.id);
          const { control_url, wanted, ...identity } = item;
          const signature = JSON.stringify(identity);
          if (children.get(item.id)?.signature === signature) continue;
          await stop(item.id);
          for (const reference of item.retired_profiles || []) await purge(item, reference);
          const profile = profileFor(item);
          await mkdir(profile, { recursive: true, mode: 0o700 });
          const info = await stat(profile);
          if (
            (await realpath(profile)) !== profile ||
            info.mode & 0o077 ||
            info.uid !== process.getuid!()
          )
            throw Error('账号会话目录无效');
          pendingOwner = await acquireProfile(profile);
          const credential = join(profile, '.executor-token');
          const secret = await open(
            credential,
            constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            const info = await secret.stat();
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              info.uid !== process.getuid!() ||
              info.mode & 0o077
            )
              throw Error('账号执行凭据文件无效');
            await secret.truncate(0);
            await secret.writeFile(item.token + '\n');
          } finally {
            await secret.close();
          }
          const descriptor = { platform: item.platform, accountId: item.id, userId: item.user_id };
          const child = spawn(sandbox, sandboxArguments(repo, profile, browser, runner), {
            env: {
              PATH: '/usr/bin:/bin',
              LANG: 'C.UTF-8',
              API_BASE_URL: primary.apiBaseURL,
              CSDN_USERNAME: item.username,
              CSDN_DISPLAY_NAME: item.username,
              CSDN_PROFILE_DIR: profile,
              WORKER_TOKEN_FILE: credential,
              PLAYWRIGHT_EXECUTABLE_PATH: browser,
              WORKER_HEADLESS: 'true',
              ACCOUNT_DESCRIPTOR: JSON.stringify(descriptor),
              ACCOUNT_OWNER_NONCE: pendingOwner.nonce,
              ACCOUNT_OWNER_PID: String(process.pid),
            },
            stdio: ['ignore', 'inherit', 'inherit'],
          });
          const parentOwner = pendingOwner;
          pendingOwner = undefined;
          const stopped = new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            child.once('error', () => resolve());
          }).then(async () => {
            try {
              await parentOwner.release();
            } catch {
              console.error('账号互斥锁释放失败，请核对运行状态。');
            }
          });
          const running: Running = {
            process: child,
            signature,
            stopped,
            stopping: false,
            token: item.token,
            controlURL: item.control_url,
          };
          children.set(item.id, running);
          void stopped.then(() => {
            if (children.get(item.id) === running) {
              children.delete(item.id);
              if (!running.stopping) retries.set(item.id, Date.now() + 30000);
            }
          });
        } catch {
          await pendingOwner?.release().catch(() => {});
          await stop(item.id);
          retries.set(item.id, Date.now() + 30000);
          console.error('账号执行环境暂不可用，等待重新检查。');
        }
      }
      await delay(3000, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await Promise.all([...children.keys()].map(stop));
    if (health.listening) {
      health.closeIdleConnections();
      await new Promise<void>((resolve) => health.close(() => resolve()));
    }
  }
}
