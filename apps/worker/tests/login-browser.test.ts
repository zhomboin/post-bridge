import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileAvailable } from '../src/profile.js';
import {
  loginRequestAllowed,
  loginNavigationAllowed,
  openLoginBrowser,
} from '../src/login-browser.js';
describe('独立登录网络策略', () => {
  it('只准认证POST与平台静态资源，草稿、上传、外站与导航均受限', () => {
    expect(loginRequestAllowed('https://passport.csdn.net/v1/login', 'POST')).toBe(true);
    expect(loginRequestAllowed('https://g.csdnimg.cn/login.js', 'GET')).toBe(true);
    expect(
      loginRequestAllowed('https://bizapi.csdn.net/blog-console-api/v3/editor/saveArticle', 'POST'),
    ).toBe(false);
    expect(
      loginRequestAllowed('https://bizapi.csdn.net/blog-console-api/v3/editor/autoSave', 'POST'),
    ).toBe(false);
    expect(loginRequestAllowed('https://mp.csdn.net/upload', 'POST')).toBe(false);
    expect(loginRequestAllowed('https://passport.csdn.net/v1/register', 'POST')).toBe(false);
    expect(loginRequestAllowed('https://passport.csdn.net/v1/account/changePassword', 'POST')).toBe(
      false,
    );
    expect(loginRequestAllowed('https://evil.test/', 'GET')).toBe(false);
    expect(loginNavigationAllowed('https://passport.csdn.net/login')).toBe(true);
    expect(loginNavigationAllowed('https://mp.csdn.net/')).toBe(true);
    expect(loginNavigationAllowed('https://mp.csdn.net/mp_blog/manage/article')).toBe(false);
    expect(loginNavigationAllowed('https://editor.csdn.net/md/')).toBe(false);
    expect(loginNavigationAllowed('file:///etc/passwd')).toBe(false);
  });
});

it('无DISPLAY合成页面能传JPEG、输入、拖动并确认身份，草稿写请求被阻断', async () => {
  let authenticated = false;
  let draftWrites = 0;
  let dragged = 0;
  let entered = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/account') {
      response.end(
        authenticated
          ? '<a href="https://blog.csdn.net/expected-user">个人主页</a>'
          : '<button>登录</button>',
      );
      return;
    }
    if (request.url === '/login') {
      response.end(`<style>input{position:absolute;left:20px;top:20px;width:200px;height:40px}button{position:absolute;left:20px;top:80px;width:200px;height:40px}#slider{position:absolute;left:20px;top:150px;width:200px;height:50px;background:#ddd}</style><input><button>确认合成登录</button><div id="slider">拖动验证</div><script>
    fetch('/save',{method:'POST'}).catch(()=>{});let dragging=false,moves=0;document.querySelector('#slider').onmousedown=()=>{dragging=true};document.onmousemove=()=>{if(dragging)moves++};document.onmouseup=()=>{if(dragging){dragging=false;fetch('/authenticate',{method:'POST',body:JSON.stringify({kind:'drag',moves})})}};document.querySelector('button').onclick=async()=>{await fetch('/authenticate',{method:'POST',body:JSON.stringify({kind:'login',text:document.querySelector('input').value})});location.href='/account'};</script>`);
      return;
    }
    if (request.url === '/save') {
      draftWrites++;
      response.end('');
      return;
    }
    if (request.url === '/authenticate') {
      let text = '';
      for await (const chunk of request) text += chunk;
      const value = JSON.parse(text);
      if (value.kind === 'drag') dragged = value.moves;
      if (value.kind === 'login') {
        entered = value.text;
        authenticated = true;
      }
      response.end('{}');
      return;
    }
    response.statusCode = 404;
    response.end('');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = await mkdtemp(join(tmpdir(), 'post-bridge-remote-browser-'));
  let browser: Awaited<ReturnType<typeof openLoginBrowser>> | undefined;
  try {
    browser = await openLoginBrowser(
      {
        profileDir: profile,
        username: 'expected-user',
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      },
      new AbortController().signal,
      { origin, loginPath: '/login', accountPath: '/account' },
    );
    expect(await browser.connected()).toBe('pending');
    const jpeg = await browser.frame();
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    await browser.input({ type: 'click', x: 80, y: 35 });
    await browser.input({ type: 'text', text: '合成验证码' });
    await browser.input({
      type: 'drag',
      points: [
        { x: 30, y: 170 },
        { x: 65, y: 170 },
        { x: 110, y: 170 },
      ],
    });
    await browser.input({ type: 'click', x: 80, y: 95 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await browser.connected()).toBe('connected');
    expect(entered).toBe('合成验证码');
    expect(dragged).toBeGreaterThan(0);
    expect(draftWrites).toBe(0);
  } finally {
    await browser?.close();
    expect(await profileAvailable(profile)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}, 30000);

describe('认证内容加载与有限恢复', () => {
  async function site(mode: 'empty-once' | 'empty-always' | 'disconnect-once' | 'hidden-frame') {
    let requests = 0;
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.url === '/account') {
        res.end('<button>登录</button>');
        return;
      }
      if (req.url === '/wrapper') {
        res.end('<iframe src="/login?input"></iframe>');
        return;
      }
      if (req.url === '/login?input') {
        res.end('<input type="tel" placeholder="手机号">');
        return;
      }
      if (req.url === '/login') {
        requests++;
        if (mode === 'hidden-frame') {
          res.end('<iframe hidden src="/wrapper"></iframe>');
          return;
        }
        if (mode === 'disconnect-once' && requests === 1) {
          req.socket.destroy();
          return;
        }
        if (mode === 'empty-always' || (mode === 'empty-once' && requests === 1)) {
          res.statusCode = 503;
          res.end('<main></main>');
          return;
        }
        res.end('<input type="tel" placeholder="手机号">');
        return;
      }
      res.statusCode = 404;
      res.end('');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const profile = await mkdtemp(join(tmpdir(), 'post-bridge-login-ready-'));
    return {
      profile,
      origin,
      requests: () => requests,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(profile, { recursive: true, force: true });
      },
    };
  }
  it.each(['empty-once', 'disconnect-once'] as const)(
    '首次页面加载失败会有限恢复，只交付可用表单：%s',
    async (mode) => {
      const fixture = await site(mode);
      let browser: Awaited<ReturnType<typeof openLoginBrowser>> | undefined;
      try {
        browser = await openLoginBrowser(
          { profileDir: fixture.profile, username: 'expected-user' },
          new AbortController().signal,
          { origin: fixture.origin, loginPath: '/login', accountPath: '/account' },
        );
        await browser.input({ type: 'fill', field: 'phone', text: '12345678901' });
        expect(fixture.requests()).toBeGreaterThan(1);
        expect(fixture.requests()).toBeLessThanOrEqual(3);
      } finally {
        await browser?.close();
        expect(await profileAvailable(fixture.profile)).toBe(true);
        await fixture.close();
      }
    },
    25000,
  );
  it.each(['empty-always', 'hidden-frame'] as const)(
    '空白认证页面三次仍未加载则明确失败并释放目录，不暴露外站错误：%s',
    async (mode) => {
      const fixture = await site(mode);
      let browser: Awaited<ReturnType<typeof openLoginBrowser>> | undefined;
      try {
        await expect(
          openLoginBrowser(
            { profileDir: fixture.profile, username: 'expected-user' },
            new AbortController().signal,
            { origin: fixture.origin, loginPath: '/login', accountPath: '/account' },
          ).then((value) => {
            browser = value;
            return value;
          }),
        ).rejects.toThrow('CSDN 登录页面未能加载，请稍后重新开始');
        expect(fixture.requests()).toBe(3);
        expect(await profileAvailable(fixture.profile)).toBe(true);
      } finally {
        await browser?.close();
        await fixture.close();
      }
    },
    25000,
  );
  it('加载期间取消立即关闭，不继续重新请求认证页', async () => {
    const fixture = await site('empty-always');
    const controller = new AbortController();
    let browser: Awaited<ReturnType<typeof openLoginBrowser>> | undefined;
    const pending = openLoginBrowser(
      { profileDir: fixture.profile, username: 'expected-user' },
      controller.signal,
      { origin: fixture.origin, loginPath: '/login', accountPath: '/account' },
    ).then((value) => {
      browser = value;
      return value;
    });
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      await expect(pending).rejects.toThrow();
      expect(fixture.requests()).toBeLessThanOrEqual(1);
      expect(await profileAvailable(fixture.profile)).toBe(true);
    } finally {
      clearTimeout(timer);
      await browser?.close();
      await fixture.close();
    }
  }, 10000);
});
