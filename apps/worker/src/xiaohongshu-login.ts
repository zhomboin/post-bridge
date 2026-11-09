import { chromium } from 'playwright';
import type { Config } from './config.js';
import type { LoginBrowser, LoginInput } from './remote-login.js';
import { identityPayload } from './xiaohongshu-model.js';

export function xiaohongshuLoginRequestAllowed(value: string, method: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const platform = ['xiaohongshu.com', 'xhscdn.com', 'xiaohongshu.net'].some(
      (host) => url.hostname === host || url.hostname.endsWith('.' + host),
    );
    if (!platform || /(?:publish|upload|delete|autoSave|saveDraft)/i.test(url.pathname))
      return false;
    if (method === 'GET' || method === 'HEAD') return true;
    return (
      method === 'POST' &&
      url.hostname.endsWith('.xiaohongshu.com') &&
      /\/(?:login|qrcode|captcha|verify|sms)(?:\/|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export async function openXiaohongshuLoginBrowser(
  config: Config,
  token: string,
  signal: AbortSignal,
): Promise<LoginBrowser> {
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: true,
    executablePath: config.executablePath,
    serviceWorkers: 'block',
    acceptDownloads: false,
    viewport: { width: 1280, height: 800 },
    timeout: 30000,
  });
  const close = () => context.close();
  const abort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await context.route('**/*', (route) =>
      xiaohongshuLoginRequestAllowed(route.request().url(), route.request().method())
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await Promise.all(context.pages().map((page) => page.close()));
    const page = await context.newPage();
    let identity: 'pending' | 'connected' | 'wrong' = 'pending';
    let nativeID = '';
    const responses = new Set<Promise<void>>();
    page.on('response', (response) => {
      if (response.url().split('?')[0] !== 'https://creator.xiaohongshu.com/api/galaxy/user/info')
        return;
      const task = (async () => {
        if (response.status() !== 200) return;
        const data = identityPayload(await response.json());
        if (
          data.username !== config.username ||
          (config.userId && config.userId !== data.user_id)
        ) {
          identity = 'wrong';
          return;
        }
        nativeID = data.user_id;
        identity = 'connected';
      })().catch(() => {});
      responses.add(task);
      void task.finally(() => responses.delete(task));
    });
    context.on('page', (popup) => {
      if (popup !== page) void popup.close().catch(() => {});
    });
    page.on('download', (download) => {
      void download.cancel().catch(() => {});
    });
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    await page.goto('https://creator.xiaohongshu.com/new/note-manager', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    const input = async (value: LoginInput) => {
      signal.throwIfAborted();
      switch (value.type) {
        case 'click':
          await page.mouse.click(value.x, value.y);
          break;
        case 'text':
          await page.keyboard.insertText(value.text);
          break;
        case 'key':
          await page.keyboard.press(value.key);
          break;
        case 'scroll':
          await page.mouse.wheel(0, value.deltaY);
          break;
        case 'fill': {
          const input = page
            .getByPlaceholder(value.field === 'phone' ? /手机号|手机号码/ : /验证码/)
            .filter({ visible: true });
          if ((await input.count()) !== 1) throw Error('未找到唯一登录输入框');
          await input.fill(value.text);
          break;
        }
        case 'drag':
          await page.mouse.move(value.points[0].x, value.points[0].y);
          try {
            await page.mouse.down();
            for (const point of value.points.slice(1)) await page.mouse.move(point.x, point.y);
          } finally {
            await page.mouse.up().catch(() => {});
          }
      }
    };
    return {
      frame: () =>
        page.screenshot({ type: 'jpeg', quality: 75, animations: 'disabled', timeout: 5000 }),
      input,
      connected: async () => identity,
      commit: async () => {
        const result = await fetch(config.apiBaseURL + '/internal/worker/identity', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: nativeID }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          redirect: 'error',
        });
        if (!result.ok) throw Error('登录身份确认失败');
        await result.body?.cancel();
      },
      close: async () => {
        signal.removeEventListener('abort', abort);
        await close();
        await Promise.allSettled(responses);
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', abort);
    await close().catch(() => {});
    throw error;
  }
}
