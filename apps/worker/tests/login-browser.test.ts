import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileAvailable } from '../src/profile.js';
import { loginRequestAllowed, loginNavigationAllowed, openLoginBrowser } from '../src/login-browser.js';
describe('独立登录网络策略', () => {
  it('只准认证POST与平台静态资源，草稿、上传、外站与导航均受限', () => {
    expect(loginRequestAllowed('https://passport.csdn.net/v1/login', 'POST')).toBe(true);
    expect(loginRequestAllowed('https://g.csdnimg.cn/login.js', 'GET')).toBe(true);
    expect(loginRequestAllowed('https://bizapi.csdn.net/blog-console-api/v3/editor/saveArticle', 'POST')).toBe(false);
    expect(loginRequestAllowed('https://bizapi.csdn.net/blog-console-api/v3/editor/autoSave', 'POST')).toBe(false);
    expect(loginRequestAllowed('https://mp.csdn.net/upload', 'POST')).toBe(false);
    expect(loginRequestAllowed('https://passport.csdn.net/v1/register', 'POST')).toBe(false);
    expect(loginRequestAllowed('https://passport.csdn.net/v1/account/changePassword', 'POST')).toBe(false);
    expect(loginRequestAllowed('https://evil.test/', 'GET')).toBe(false);
    expect(loginNavigationAllowed('https://passport.csdn.net/login')).toBe(true);
    expect(loginNavigationAllowed('https://mp.csdn.net/')).toBe(true);
    expect(loginNavigationAllowed('https://mp.csdn.net/mp_blog/manage/article')).toBe(false);
    expect(loginNavigationAllowed('https://editor.csdn.net/md/')).toBe(false);
    expect(loginNavigationAllowed('file:///etc/passwd')).toBe(false);
  });
});

it('无DISPLAY合成页面能传JPEG、输入、拖动并确认身份，草稿写请求被阻断', async () => {
  let authenticated = false; let draftWrites = 0; let dragged = 0; let entered = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/account') { response.end(authenticated ? '<a href="https://blog.csdn.net/expected-user">个人主页</a>' : '<button>登录</button>'); return; }
    if (request.url === '/login') { response.end(`<style>input{position:absolute;left:20px;top:20px;width:200px;height:40px}button{position:absolute;left:20px;top:80px;width:200px;height:40px}#slider{position:absolute;left:20px;top:150px;width:200px;height:50px;background:#ddd}</style><input><button>确认合成登录</button><div id="slider">拖动验证</div><script>
    fetch('/save',{method:'POST'}).catch(()=>{});let dragging=false,moves=0;document.querySelector('#slider').onmousedown=()=>{dragging=true};document.onmousemove=()=>{if(dragging)moves++};document.onmouseup=()=>{if(dragging){dragging=false;fetch('/authenticate',{method:'POST',body:JSON.stringify({kind:'drag',moves})})}};document.querySelector('button').onclick=async()=>{await fetch('/authenticate',{method:'POST',body:JSON.stringify({kind:'login',text:document.querySelector('input').value})});location.href='/account'};</script>`); return; }
    if (request.url === '/save') { draftWrites++; response.end(''); return; }
    if (request.url === '/authenticate') { let text = ''; for await (const chunk of request) text += chunk; const value = JSON.parse(text); if (value.kind === 'drag') dragged = value.moves; if (value.kind === 'login') { entered = value.text; authenticated = true; } response.end('{}'); return; }
    response.statusCode = 404; response.end('');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = await mkdtemp(join(tmpdir(), 'post-bridge-remote-browser-'));
  let browser: Awaited<ReturnType<typeof openLoginBrowser>> | undefined;
  try {
    browser = await openLoginBrowser({ profileDir: profile, username: 'expected-user', executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }, new AbortController().signal, { origin, loginPath: '/login', accountPath: '/account' });
    expect(await browser.connected()).toBe('pending'); const jpeg = await browser.frame(); expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    await browser.input({ type: 'click', x: 80, y: 35 }); await browser.input({ type: 'text', text: '合成验证码' });
    await browser.input({ type: 'drag', points: [{ x: 30, y: 170 }, { x: 65, y: 170 }, { x: 110, y: 170 }] });
    await browser.input({ type: 'click', x: 80, y: 95 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await browser.connected()).toBe('connected'); expect(entered).toBe('合成验证码'); expect(dragged).toBeGreaterThan(0); expect(draftWrites).toBe(0);
  } finally { await browser?.close(); expect(await profileAvailable(profile)).toBe(true); await new Promise<void>(resolve => server.close(() => resolve())); await rm(profile, { recursive: true, force: true }); }
}, 30000);
