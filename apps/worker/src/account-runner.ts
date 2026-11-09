import { runtimePlatforms } from './content-platforms.js';
import { candidateLogin } from './account-credentials.js';
import { setTimeout as delay } from 'node:timers/promises';
import { readPrivateToken, type Config } from './config.js';
import { loadConfig } from './config.js';
import { openXiaohongshuLoginBrowser } from './xiaohongshu-login.js';
import { WorkerAPI } from './api.js';
import { runWorker } from './worker.js';
import { RemoteLoginManager } from './remote-login.js';
import { startLoginControl } from './login-control.js';
import { openLoginBrowser } from './login-browser.js';

const stop = new AbortController();
const shutdown = () => stop.abort();
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
async function accountWorker(config: Config) {
  let login: RemoteLoginManager | undefined;
  let control: Awaited<ReturnType<typeof startLoginControl>> | undefined;
  try {
    const token = await readPrivateToken(config.tokenFile);
    const api = new WorkerAPI(config.apiBaseURL, token, config.workerId, {
      id: config.accountId!,
      platform: config.platform!,
    });
    {
      login = new RemoteLoginManager((signal) =>
        candidateLogin(
          config.profileDir,
          (profile) =>
            config.platform === 'xiaohongshu'
              ? openXiaohongshuLoginBrowser({ ...config, profileDir: profile }, token, signal)
              : openLoginBrowser({ ...config, profileDir: profile }, signal).then((browser) => ({
                  ...browser,
                  commit: async () => {
                    const response = await fetch(config.apiBaseURL + '/internal/worker/identity', {
                      method: 'POST',
                      headers: {
                        Authorization: 'Bearer ' + token,
                        'Content-Type': 'application/json',
                      },
                      body: '{}',
                      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
                      redirect: 'error',
                    });
                    if (!response.ok) throw Error('平台账号归属核对失败');
                    await response.body?.cancel();
                  },
                })),
          signal,
        ),
      );
      control = await startLoginControl('127.0.0.1:0', token, login, shutdown);
    }
    await registerControl(config.apiBaseURL, token, control!.url, stop.signal);
    const registration = setInterval(() => {
      void registerControl(config.apiBaseURL, token, control!.url, stop.signal).catch(() =>
        stop.abort(),
      );
    }, 15000);
    try {
      await runWorker(
        api,
        config.profileDir,
        () => runtimePlatforms.open(config),
        stop.signal,
        config.pollIntervalMs,
        {
          pending: () => login!.pending(),
          run: async (signal) => {
            const headers = { Authorization: 'Bearer ' + token };
            const grant = await fetch(config.apiBaseURL + '/internal/worker/login-lease', {
              method: 'POST',
              headers,
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
              redirect: 'error',
            });
            if (grant.status === 429) {
              await grant.body?.cancel();
              await delay(1500, undefined, { signal });
              return;
            }
            if (!grant.ok) throw Error('登录执行名额申请失败');
            await grant.body?.cancel();
            try {
              await login!.run(signal);
            } finally {
              await fetch(config.apiBaseURL + '/internal/worker/login-lease', {
                method: 'DELETE',
                headers,
                signal: AbortSignal.timeout(10000),
                redirect: 'error',
              })
                .then((response) => response.body?.cancel())
                .catch(() => {});
            }
          },
          close: () => login!.close(),
        },
        process.env.ACCOUNT_OWNER_NONCE
          ? {
              path: config.profileDir,
              nonce: process.env.ACCOUNT_OWNER_NONCE,
              pid: Number(process.env.ACCOUNT_OWNER_PID),
              release: async () => {},
            }
          : undefined,
      );
    } finally {
      clearInterval(registration);
    }
  } finally {
    await login?.close();
    if (control) {
      const token = await readPrivateToken(config.tokenFile);
      await fetch(config.apiBaseURL + '/internal/worker/control', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: control.url }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    }
    await control?.close();
  }
}
try {
  const descriptor = JSON.parse(process.env.ACCOUNT_DESCRIPTOR || 'null');
  if (!descriptor) throw Error('缺少账号执行配置');
  const config = { ...loadConfig(process.env), ...descriptor };
  await accountWorker(config);
} catch {
  stop.abort();
  if (!stop.signal.aborted) {
    console.error('账号执行器已停止');
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}

async function registerControl(base: string, token: string, url: string, signal: AbortSignal) {
  const response = await fetch(base + '/internal/worker/control', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    redirect: 'error',
  });
  if (!response.ok) throw Error('账号登录控制注册失败');
  await response.body?.cancel();
}
