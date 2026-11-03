import { chromium, type BrowserContext, type Page } from 'playwright';
import { safeRequestURL, type Config } from './config.js';
import { focusNextLoginInput } from './login-focus.js';
import { loginHeight, loginWidth, type LoginBrowser, type LoginInput } from './remote-login.js';

export function loginNavigationAllowed(value: string): boolean {
  if (!safeRequestURL(value)) return false;
  const url = new URL(value);
  return url.hostname === 'passport.csdn.net' || (url.hostname === 'mp.csdn.net' && ['/', '/mp_blog/', '/mp_blog/creation'].includes(url.pathname));
}
const firstLoginPostPaths = new Set([
  '/v1/register/pc/wxapplets/createQrCode',
  '/v1/register/pc/wxapplets/checkScan',
  '/v1/register/pc/sendVerifyCode',
  '/v1/register/pc/login/doLogin',
  '/v1/api/get/mobileAreaCode',
  '/cdn_cgi_bs_bot/api',
]);
export function loginRequestAllowed(value: string, method: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  if (method === 'GET' && url.origin === 'https://res.wx.qq.com' && url.pathname === '/connect/zh_CN/htmledition/js/wxLogin.js') return true;
  if (!safeRequestURL(value)) return false;
  if (url.hostname === 'editor.csdn.net' || /(?:editor|autoSave|saveArticle|publish|upload|deleteArticle)/i.test(url.pathname)) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  return method === 'POST' && url.hostname === 'passport.csdn.net' && (url.pathname === '/v1/login' || url.pathname.startsWith('/v1/login/') || url.pathname === '/account/login' || firstLoginPostPaths.has(url.pathname));
}
interface Fixture { origin: string; loginPath: string; accountPath: string }
export async function openLoginBrowser(config: Pick<Config, 'profileDir' | 'username' | 'executablePath'>, signal: AbortSignal, fixture?: Fixture): Promise<LoginBrowser> {
  if (fixture && (process.env.NODE_ENV !== 'test' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture.origin))) throw new Error('登录模拟站点仅限测试回环地址');
  let context: BrowserContext | undefined;
  let closing: Promise<void> | undefined;
  const close = () => context ? closing ??= context.close() : Promise.resolve();
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    context = await chromium.launchPersistentContext(config.profileDir, { headless: true, executablePath: config.executablePath, serviceWorkers: 'block', acceptDownloads: false, viewport: { width: loginWidth, height: loginHeight }, timeout: 30000 });
    signal.throwIfAborted();
    const fixtureAllowed = (value: string) => !!fixture && new URL(value).origin === fixture.origin;
    await context.route('**/*', route => {
      const request = route.request(); const url = request.url();
      const allowed = fixtureAllowed(url) ? ['GET', 'HEAD'].includes(request.method()) || (request.method() === 'POST' && new URL(url).pathname === '/authenticate') : loginRequestAllowed(url, request.method());
      const mainNavigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
      const navigation = !mainNavigation || (fixtureAllowed(url) ? [fixture!.loginPath, fixture!.accountPath].includes(new URL(url).pathname) : loginNavigationAllowed(url));
      return allowed && navigation ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    await Promise.all(context.pages().map(page => page.close()));
    const page = await context.newPage(); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(20000);
    context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
    page.on('download', download => { void download.cancel().catch(() => {}); });
    page.on('filechooser', chooser => { void chooser.setFiles([]).catch(() => {}); });
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    const accountURL = fixture ? new URL(fixture.accountPath, fixture.origin).href : 'https://mp.csdn.net/';
    const loginURL = fixture ? new URL(fixture.loginPath, fixture.origin).href : 'https://passport.csdn.net/account/login?from=https%3A%2F%2Fmp.csdn.net%2F';
    await page.goto(accountURL, { waitUntil: 'domcontentloaded' });
    const identity = async (): Promise<'pending' | 'connected' | 'wrong'> => {
      if (fixture ? new URL(page.url()).pathname !== fixture.accountPath : new URL(page.url()).hostname !== 'mp.csdn.net') return 'pending';
      const names = await page.locator('a[href]').evaluateAll(nodes => nodes.flatMap(node => {
        try { const url = new URL((node as HTMLAnchorElement).href); return url.protocol === 'https:' && url.hostname === 'blog.csdn.net' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ? [url.pathname.replace(/^\/|\/$/g, '')] : []; } catch { return []; }
      }));
      const login = await page.getByText(/^登录$/).filter({ visible: true }).count() > 0;
      if (names.includes(config.username) && !login) return 'connected';
      if (!login && names.length) return 'wrong';
      return 'pending';
    };
    if (!fixture) {
      const deadline = Date.now() + 5000;
      while (new URL(page.url()).hostname === 'mp.csdn.net' && await identity() === 'pending' && !await page.getByText(/^登录$/).filter({ visible: true }).count() && Date.now() < deadline) { signal.throwIfAborted(); await page.waitForTimeout(100); }
    }
    if (await identity() === 'pending' && (fixture || new URL(page.url()).hostname === 'mp.csdn.net')) {
      const entry = page.getByText(/^登录$/).filter({ visible: true });
      if (!fixture && await entry.count() === 1) await entry.click();
      else await page.goto(loginURL, { waitUntil: 'domcontentloaded' });
    }
    const input = async (value: LoginInput) => {
      signal.throwIfAborted();
      switch (value.type) {
        case 'click': await page.mouse.click(value.x, value.y); break;
        case 'text': await page.keyboard.insertText(value.text); break;
        case 'key':
          if (value.key === 'Tab' || value.key === 'Shift+Tab') await focusNextLoginInput(page, value.key === 'Shift+Tab', fixture?.origin);
          else await page.keyboard.press(value.key);
          break;
        case 'scroll': await page.mouse.wheel(0, value.deltaY); break;
        case 'drag':
          await page.mouse.move(value.points[0].x, value.points[0].y);
          try { await page.mouse.down(); for (const point of value.points.slice(1)) { signal.throwIfAborted(); await page.mouse.move(point.x, point.y); await page.waitForTimeout(10); } }
          finally { await page.mouse.up().catch(() => {}); }
      }
    };
    return {
      frame: () => page.screenshot({ type: 'jpeg', quality: 75, animations: 'disabled', timeout: 5000 }),
      input,
      connected: identity,
      close: async () => { signal.removeEventListener('abort', abort); await close(); },
    };
  } catch { signal.removeEventListener('abort', abort); await close().catch(() => {}); throw new Error('登录浏览器启动失败'); }
}
