import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { CSDNAdapter } from '../src/csdn.js';
import type { Progress } from '../src/types.js';

let server: Server;
let origin: string;
let title = '';
let markdown = '';
let mode = 'normal';
let editorVisits = 0;
let writes = 0;
let draftEntries: { articleId: string; title: string; markdown: string; status: number; username: string }[] = [];
let listRequests: number[] = [];
let fixtureProfile: string;
let context: BrowserContext;
const job = { id: 'test-job', kind: 'save_draft' as const, title: '本地草稿验证文章', markdown: '# 章节\n\n第一行\n第二行\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n', run_mode: 'execute' as const, external_started: false, remote_id: null, reconcile_candidate_id: null };
const events: Progress[] = [];
const hooks = { progress: async (value: Progress) => { events.push(value); } };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/account') {
      res.end(mode === 'login' ? '<button>登录</button>' : `<div class="nickname">测试昵称</div><a href="https://blog.csdn.net/${mode === 'wrong' ? 'wrong-user' : 'expected-user'}">个人主页</a>${mode === 'auto-account' ? `<script>fetch('/save',{method:'POST',body:JSON.stringify({title:'错误自动保存',markdown:'不能写入'})})</script>` : ''}`);
    } else if (url.pathname === '/manage') {
      res.end(`<button>草稿箱(${draftEntries.length})</button><button aria-label="下一页">下一页</button><script>
      ${mode === 'list-stale-response' ? `fetch('/blog/phoenix/console/v1/article/list?status=draft&pageSize=20&page=1&stale=1', { headers: { 'X-Native-Test': 'yes' } });` : ''}
      let page = 0;
      const load = () => fetch('/blog/phoenix/console/v1/article/list?status=draft&pageSize=20&page='+page, { headers: { 'X-Native-Test': 'yes' } });
      document.querySelector('button').onclick=()=>{page=1;load()};
      document.querySelector('[aria-label]').onclick=()=>{page++;load()};
      </script>`);
    } else if (url.pathname === '/blog/phoenix/console/v1/article/list') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get('pageSize'));
      listRequests.push(page);
      if (mode === 'list-request-failed') { res.destroy(); return; }
      if (mode === 'list-response-timeout') { res.setHeader('Content-Type', 'application/json'); res.flushHeaders(); await new Promise(resolve => setTimeout(resolve, 2000)); res.end('{}'); return; }
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'list-stale-response') {
        await new Promise(resolve => setTimeout(resolve, url.searchParams.has('stale') ? 500 : 1000));
        if (url.searchParams.has('stale')) { res.end(JSON.stringify({ code: 200, data: { list: [], total: 0, page, size } })); return; }
      }
      if (mode === 'list-error' || req.headers['x-native-test'] !== 'yes') { res.statusCode = 503; res.end('{}'); }
      else {
        const list = draftEntries.slice((page - 1) * size, page * size).map(({ markdown: _, ...entry }) => entry);
        if (mode === 'list-wrong-account' && list[0]) list[0].username = 'another-user';
        if (mode === 'list-missing-account' && list[0]) delete (list[0] as { username?: string }).username;
        if (mode === 'list-duplicate' && list[0]) list.push(list[0]);
        if (mode === 'list-not-draft' && list[0]) list[0].status = 1;
        res.end(JSON.stringify({ code: mode === 'list-error-code' ? 500 : 200, data: { list, total: mode === 'list-incomplete' ? draftEntries.length + 1 : draftEntries.length, page: mode === 'list-wrong-page' ? page + 1 : page, size: mode === 'list-wrong-size' ? 50 : size } }));
      }
    } else if (url.pathname === '/md/') {
      editorVisits++;
      const existing = url.searchParams.get('articleId');
      res.end(`<!doctype html><meta charset="utf-8">${mode === 'icon' ? '<style>button[data-save]::after{content:" "}</style>' : ''}<div class="article-bar__title-display">${existing ? title : '【无标题】'}</div><input class="article-bar__title" style="display:none"><pre contenteditable="true" class="editor__inner"></pre>${mode === 'changed' ? '' : '<button data-save>保存草稿</button>'}<button>保存并预览</button><button>发布</button><script>
      ${mode === 'auto-reconcile' ? `fetch('/save',{method:'POST',body:JSON.stringify({title:'错误自动保存',markdown:'不能写入'})}).catch(()=>{});` : ''}
      const input=document.querySelector('input'); const body=document.querySelector('pre');
      document.querySelector('div').onclick=()=>{input.style.display='block'};
      input.value=${JSON.stringify(existing ? title : '【无标题】')};body.textContent=${JSON.stringify(existing ? markdown : '# 欢迎使用官方Markdown编辑器\n\n这是默认模板，不是已有文章。')};
      document.querySelector('button').onclick=async()=>{await fetch('/save',{method:'POST',body:JSON.stringify({title:input.value,markdown:body.textContent})});history.replaceState({},'', '/md/?articleId=123')};
      ${existing ? `fetch('/blog-console-api/v3/editor/getArticle?articleId=${existing}',{method:'POST'}).then(r=>r.json()).then(r=>{input.value=r.data.title;body.textContent=r.data.markdowncontent})` : mode === 'late-id' ? '' : `setTimeout(()=>{history.replaceState({},'', '/md/?articleId=123');fetch('/acquired')}, 20)`}
      </script>`);
    } else if (url.pathname === '/save') {
      let text = ''; for await (const chunk of req) text += chunk;
      const payload = JSON.parse(text); title = payload.title; markdown = payload.markdown; writes++;
      res.end('{}');
    } else if (url.pathname === '/acquired') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: { articleId: '123' } }));
    } else if (url.pathname.endsWith('/getArticle')) {
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'lost') { res.statusCode = 503; res.end('{}'); }
      else { const entry = draftEntries.find(value => value.articleId === url.searchParams.get('articleId')); res.end(JSON.stringify({ data: { article_id: entry?.articleId ?? '123', title: entry?.title ?? title, markdowncontent: entry?.markdown ?? markdown, ...(mode === 'missing-state' ? {} : { status: mode === 'not-draft' ? 1 : entry?.status ?? 2 }) } })); }
    } else { res.statusCode = 404; res.end(''); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  fixtureProfile = await mkdtemp(join(tmpdir(), 'csdn-fixture-'));
  context = await chromium.launchPersistentContext(fixtureProfile, { headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
}, 30000);
afterAll(async () => { await context?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); if (fixtureProfile) await rm(fixtureProfile, { recursive: true, force: true }); });

function adapter() { return new CSDNAdapter(context, { username: 'expected-user', displayName: '测试昵称', timeoutMs: 1500 }, { origin, accountPath: '/account', editorPath: '/md/', managePath: '/manage' }); }
async function reset(next = 'normal') { mode = next; title = ''; markdown = ''; events.length = 0; editorVisits = 0; writes = 0; draftEntries = []; listRequests = []; }

describe('真实浏览器与本地模拟CSDN页面', () => {
  it('验证账号、先持久化副作用边界，再填入多行Markdown并从服务器读回', async () => {
    await reset();
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe('succeeded');
    expect(result.remote_id).toBe('123');
    expect(markdown).toBe(job.markdown);
    expect(writes).toBe(1);
    expect(events.findIndex(e=>e.external_started === true)).toBeLessThan(events.findIndex(e=>e.remote_id === '123'));
    expect(events.some(e=>e.stage === 'draft_acquired')).toBe(true);
    await context.grantPermissions(['clipboard-read'], { origin });
    const checkPage = await context.newPage();
    await checkPage.goto(origin + '/account');
    expect(await checkPage.evaluate(() => navigator.clipboard.readText())).toBe('');
    await checkPage.close();
  });
  it('保存按钮CSS伪元素图标改变可访问名称时，仍只点击精确文本保存草稿', async () => {
    await reset('icon');
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe('succeeded'); expect(writes).toBe(1);
  });
  it('草稿ID在保存后才出现时，checkpoint仍按服务端stage单调推进', async () => {
    await reset('late-id');
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe('succeeded');
    const ranks: Record<string, number> = { checking_login:1, opening_editor:2, draft_acquired:3, filling:4, saving:5, verifying:6 };
    expect(events.every((event,index) => index === 0 || ranks[event.stage] >= ranks[events[index-1].stage])).toBe(true);
  });
  it.each(['wrong', 'login'])('身份不符或缺少登录时不打开新稿：%s', async state => {
    await reset(state);
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe(state === 'login' ? 'waiting_user' : 'failed');
    expect(editorVisits).toBe(0); expect(writes).toBe(0);
  });
  it('checkpoint失败时没有访问新建页面', async () => {
    await reset();
    await expect(adapter().run(job, { progress: async value => { if (value.external_started) throw new Error('checkpoint'); } }, new AbortController().signal)).rejects.toThrow();
    expect(editorVisits).toBe(0);
  });
  it.each(['changed', 'lost'])('页面变动或服务端读取失败时保持待核对且不二次新建：%s', async state => {
    await reset(state);
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe('reconciling');
    expect(editorVisits).toBeLessThanOrEqual(2);
    expect(writes).toBeLessThanOrEqual(1);
  });
  it('核对只读，候选错误不绑定；修正后的相同快照才可成功', async () => {
    await reset(); title = '其他文章'; markdown = '其他正文';
    const reconcile = { ...job, run_mode: 'reconcile' as const, external_started: true, reconcile_candidate_id: '123' };
    const mismatch = await adapter().run(reconcile, hooks, new AbortController().signal);
    expect(mismatch.status).toBe('reconciling');
    expect(events.some(e=>e.remote_id)).toBe(false);
    title = job.title; markdown = job.markdown;
    const match = await adapter().run(reconcile, hooks, new AbortController().signal);
    expect(match.status).toBe('succeeded'); expect(match.remote_id).toBe('123'); expect(writes).toBe(0);
  });
  it.each(['not-draft', 'missing-state'])('相同内容缺少已观测草稿状态时，保存和核对均保持待核对：%s', async state => {
    await reset(state);
    const saved = await adapter().run(job, hooks, new AbortController().signal);
    expect(saved.status).toBe('reconciling');
    const checked = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true, reconcile_candidate_id: '123' }, hooks, new AbortController().signal);
    expect(checked.status).toBe('reconciling');
    expect(writes).toBe(1);
  });
  it('只读核对阻止编辑器脚本自动写稿，错误候选也不会新建或修改', async () => {
    await reset('auto-reconcile'); title = job.title; markdown = job.markdown;
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true, reconcile_candidate_id: '999' }, hooks, new AbortController().signal);
    expect(result.status).toBe('reconciling');
    expect(writes).toBe(0); expect(title).toBe(job.title); expect(markdown).toBe(job.markdown);
    expect(events.some(e=>e.remote_id)).toBe(false);
  });
  it('账号检查阻止页面脚本提交任何草稿写入', async () => {
    await reset('auto-account');
    const result = await adapter().run({ ...job, kind: 'check_account' }, hooks, new AbortController().signal);
    expect(result.status).toBe('succeeded'); expect(editorVisits).toBe(0); expect(writes).toBe(0);
  });
  it('无ID时完整分页查找并只读核对唯一匹配草稿', async () => {
    await reset();
    draftEntries = Array.from({ length: 21 }, (_, index) => ({ articleId: String(1000 + index), title: index === 20 ? job.title : '其他合成稿件', markdown: index === 20 ? job.markdown.replace(/\n/g, '\r\n') : '其他正文', status: 2, username: 'expected-user' }));
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'succeeded', remote_id: '1020' });
    expect(listRequests).toEqual([1, 2]); expect(writes).toBe(0); expect(editorVisits).toBe(1);
  });
  it('只核对本次点击发起的列表请求，不接受导航时滞后的空响应', async () => {
    await reset('list-stale-response');
    draftEntries = [{ articleId: '123', title: job.title, markdown: job.markdown, status: 2, username: 'expected-user' }];
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(listRequests).toEqual([1, 1]); expect(writes).toBe(0);
  });
  it('完整空列表才报告未找到，不要求人工输入ID', async () => {
    await reset();
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'reconciling', error_code: 'draft_absent' });
    expect(listRequests).toEqual([1]); expect(writes).toBe(0); expect(editorVisits).toBe(0);
  });
  it.each(['list-error', 'list-incomplete', 'list-duplicate', 'list-wrong-account', 'list-missing-account', 'list-not-draft', 'list-error-code', 'list-wrong-page', 'list-wrong-size', 'list-request-failed', 'list-response-timeout'])('列表故障或不完整时不能报告不存在：%s', async state => {
    await reset(state);
    draftEntries = [{ articleId: '123', title: '其他合成稿件', markdown: '', status: 2, username: 'expected-user' }];
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'reconciling', error_code: 'reconcile_unavailable' });
    expect(writes).toBe(0);
  });
  it.each(['duplicate-match', 'partial-match'])('重复完整稿或同标题残稿均报告冲突：%s', async state => {
    await reset(state);
    draftEntries = [{ articleId: '123', title: job.title, markdown: state === 'partial-match' ? '残留正文' : job.markdown, status: 2, username: 'expected-user' }];
    if (state === 'duplicate-match') draftEntries.push({ ...draftEntries[0], articleId: '456' });
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'reconciling', error_code: 'draft_conflict' });
    expect(writes).toBe(0);
  });
  it('候选正文读取失败时不能报告未找到或内容冲突', async () => {
    await reset('lost');
    draftEntries = [{ articleId: '123', title: job.title, markdown: job.markdown, status: 2, username: 'expected-user' }];
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'reconciling', error_code: 'reconcile_unavailable' });
    expect(writes).toBe(0);
  });
  it('已有绑定ID核对不回退查询列表或替换关联', async () => {
    await reset('list-error'); title = job.title; markdown = job.markdown;
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true, remote_id: '123' }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(listRequests).toEqual([]); expect(writes).toBe(0);
  });
  it('核对前关闭浏览器恢复的旧标签页', async () => {
    await reset();
    const restored = await context.newPage(); await restored.goto(origin + '/account');
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'reconciling', error_code: 'draft_absent' });
    expect(restored.isClosed()).toBe(true); expect(writes).toBe(0);
  });
  it('取消中止浏览器操作，不继续保存', async () => {
    await reset();
    const controller = new AbortController();
    const result = await adapter().run(job, { progress: async value => { events.push(value); if (value.external_started) controller.abort(); } }, controller.signal);
    expect(['cancelled', 'reconciling']).toContain(result.status);
    expect(writes).toBe(0);
  });
});