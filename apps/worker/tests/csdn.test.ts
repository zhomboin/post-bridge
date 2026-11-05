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
const sourceImage = 'https://public-album.example.test/albums/sample.png';
const transferredImages: string[] = [];
let savedPayloads: unknown[] = [];
let draftEntries: { articleId: string; title: string; markdown: string; status: number; username: string }[] = [];
let listRequests: number[] = [];
let fixtureProfile: string;
let context: BrowserContext;
const job = { id: 'test-job', kind: 'save_draft' as const, title: '本地草稿验证文章', markdown: '# 章节\n\n第一行\n第二行\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n', run_mode: 'execute' as const, external_started: false, remote_id: null, reconcile_candidate_id: null };
const imageMarkdown = (image: string) => '# 图文\n\n![照片](' + image + ')\n\n[普通链接](' + sourceImage + ')\n\n![重复图片](' + image + ')\n';
const imageJob = { ...job, image_urls: [sourceImage], markdown: imageMarkdown(sourceImage) };
const copyMarkdown = () => imageMarkdown(origin + '/csdn-copy.png');
const events: Progress[] = [];
const hooks = { progress: async (value: Progress) => { events.push(value); } };
const observations = () => events.flatMap(event => event.observation ? [event.observation] : []);

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
      const input=document.querySelector('input'); const body=document.querySelector('pre'); let committedTitle=${JSON.stringify(existing ? title : '【无标题】')};
      ${mode === 'deferred-title' ? `input.oninput=()=>{setTimeout(()=>{committedTitle=input.value},100)};` : ''}
      document.querySelector('div').onclick=()=>{input.style.display='block'};
      input.value=${JSON.stringify(existing ? title : '【无标题】')};body.textContent=${JSON.stringify(existing ? markdown : mode === 'oversized-before' ? 'x'.repeat(200001) : mode === 'nul-before' ? '\u0000' : '# 欢迎使用官方Markdown编辑器\n\n这是默认模板，不是已有文章。')};
      ${mode.startsWith('image-') ? `
        const updatePreview=()=>{document.querySelectorAll('img').forEach(image=>image.remove());for(const match of body.textContent.matchAll(/!\\[[^\\]]*\\]\\(([^)]+)\\)/g)){const image=document.createElement('img');image.src=match[1];document.body.append(image);}};
        body.addEventListener('input', async ()=>{updatePreview();
          if(!body.textContent.includes(${JSON.stringify(sourceImage)})) return;
          if(body.textContent.includes('/csdn-copy.png')) return;
          const transfer=(imgUrl)=>fetch('/v1/image/external/storage',{method:'POST',body:JSON.stringify({imgUrl,type:'blog'})}).then(r=>r.json());
          if(${mode === 'image-unauthorized'}) void transfer('https://unexpected.example.test/').catch(()=>{});
          await Promise.allSettled([transfer(${JSON.stringify(sourceImage)}),transfer(${JSON.stringify(sourceImage)})]);
        });
        document.querySelector('button').onclick=async()=>{
          const payload={title:input.value,markdowncontent:${mode === 'image-wrong-save' ? 'body.textContent + "多余字符"' : mode === 'image-leading-space' ? '" " + body.textContent' : 'body.textContent'},status:${mode === 'image-publish' ? 1 : 2},id:${mode === 'image-wrong-id' ? 999 : 123}};
          await Promise.allSettled([fetch('/save',{method:'POST',body:JSON.stringify(payload)}),fetch('/save',{method:'POST',body:JSON.stringify(payload)})]);};
      ` : `document.querySelector('button').onclick=async()=>{await fetch('/save',{method:'POST',body:JSON.stringify({title:${['deferred-title','unsynced-title'].includes(mode) ? 'committedTitle' : 'input.value'},markdown:body.textContent,status:${mode === 'text-publish' ? 1 : 2}})});history.replaceState({},'', '/md/?articleId=123')};`}
      ${existing ? `fetch('/blog-console-api/v3/editor/getArticle?articleId=${existing}',{method:'POST'}).then(r=>r.json()).then(r=>{input.value=r.data.title;body.textContent=r.data.markdowncontent;body.dispatchEvent(new Event('input'))})` : mode === 'late-id' ? '' : `history.replaceState({},'', '/md/?articleId=123');fetch('/acquired')`}
      </script>`);
    } else if (url.pathname === '/save') {
      let text = ''; for await (const chunk of req) text += chunk;
      const payload = JSON.parse(text); savedPayloads.push(payload); title = payload.title; markdown = mode === 'saved-mismatch' ? '平台实际保留的正文' : mode === 'oversized-after' ? 'x'.repeat(200001) : payload.markdowncontent ?? payload.markdown; writes++;
      res.end('{}');
    } else if (url.pathname === '/v1/image/external/storage') {
      let text = ''; for await (const chunk of req) text += chunk;
      const { imgUrl } = JSON.parse(text);
      transferredImages.push(imgUrl);
      if (mode === 'image-transfer-redirect') { res.writeHead(307, { location: '/save' }); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 200, data: { url: mode === 'image-unsafe-copy' ? 'https://unexpected.example.test/x.png' : origin + '/csdn-copy.png' } }));
    } else if (url.pathname === '/csdn-copy.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(mode === 'image-undecodable' ? 'invalid' : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVTsAAAAASUVORK5CYII=', 'base64'));
    } else if (url.pathname === '/acquired') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: { articleId: '123' } }));
    } else if (url.pathname.endsWith('/getArticle')) {
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'lost') { res.statusCode = 503; res.end('{}'); }
      else { const entry = draftEntries.find(value => value.articleId === url.searchParams.get('articleId')); res.end(JSON.stringify({ data: { article_id: entry?.articleId ?? '123', title: entry?.title ?? title, markdowncontent: entry?.markdown ?? markdown, ...(mode === 'missing-state' ? {} : { status: mode === 'not-draft' ? 1 : mode === 'oversized-status' ? 'x'.repeat(101) : entry?.status ?? 2 }) } })); }
    } else { res.statusCode = 404; res.end(''); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  fixtureProfile = await mkdtemp(join(tmpdir(), 'csdn-fixture-'));
  context = await chromium.launchPersistentContext(fixtureProfile, { headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
}, 30000);
afterAll(async () => { await context?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); if (fixtureProfile) await rm(fixtureProfile, { recursive: true, force: true }); });

function adapter() { return new CSDNAdapter(context, { username: 'expected-user', displayName: '测试昵称', timeoutMs: 1500 }, { origin, accountPath: '/account', editorPath: '/md/', managePath: '/manage' }); }
async function reset(next = 'normal') { mode = next; title = ''; markdown = ''; events.length = 0; editorVisits = 0; writes = 0; transferredImages.length = 0; savedPayloads = []; draftEntries = []; listRequests = []; }

describe('真实浏览器与本地模拟CSDN页面', () => {
  it('图文稿只转存允许的图片，冻结平台正文后只写一次草稿', async () => {
    await reset('image-unauthorized');
    const result = await adapter().run(imageJob, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(transferredImages).toEqual([sourceImage]);
    expect(savedPayloads).toHaveLength(1);
    expect(savedPayloads[0]).toMatchObject({ title: job.title, status: 2 });
    expect(markdown.trim()).toBe(copyMarkdown().trim());
    expect(events).toContainEqual(expect.objectContaining({ stage: 'saving', platform_markdown: copyMarkdown() }));
    expect(observations()).toContainEqual(expect.objectContaining({ phase: 'after', markdown, status: '2' }));
  });
  it.each(['image-unsafe-copy', 'image-undecodable', 'image-publish', 'image-wrong-save', 'image-leading-space', 'image-wrong-id', 'image-transfer-redirect'])('无法安全保存图文稿时待只读核对：%s', async state => {
    await reset(state);
    const result = await adapter().run(imageJob, hooks, new AbortController().signal);
    expect(result.status).toBe('reconciling');
    expect(transferredImages).toEqual([sourceImage]);
    expect(writes).toBe(0);
  });
  it('冻结正文检查点失败时图文稿不会写入', async () => {
    await reset('image-normal');
    const progress = async (value: Progress) => {
      if (value.platform_markdown !== undefined) throw new Error('checkpoint failed');
    };
    await expect(adapter().run(imageJob, { progress }, new AbortController().signal)).rejects.toThrow();
    expect(transferredImages).toEqual([sourceImage]);
    expect(writes).toBe(0);
  });
  it('图文图片列表与正文不一致时不打开编辑器', async () => {
    await reset('image-normal');
    const result = await adapter().run({ ...imageJob, image_urls: [] }, hooks, new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(editorVisits).toBe(0);
    expect(transferredImages).toEqual([]);
  });
  it('图文核对只使用已冻结的正文，不重新转存或保存', async () => {
    await reset('image-normal');
    title = imageJob.title;
    markdown = copyMarkdown();
    const reconcile = { ...imageJob, run_mode: 'reconcile' as const, external_started: true, remote_id: '123' };
    const missing = await adapter().run(reconcile, hooks, new AbortController().signal);
    expect(missing.status).toBe('reconciling');
    const result = await adapter().run({ ...reconcile, platform_markdown: copyMarkdown() }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(writes).toBe(0);
    expect(transferredImages).toEqual([]);
  });
  it('只读核对拒绝正文形状发生变化或无法解码的已冻结图文稿', async () => {
    await reset('image-normal');
    title = imageJob.title;
    markdown = ' ' + copyMarkdown();
    const reconcile = { ...imageJob, run_mode: 'reconcile' as const, external_started: true, remote_id: '123' };
    const changedShape = await adapter().run({ ...reconcile, platform_markdown: markdown }, hooks, new AbortController().signal);
    expect(changedShape.status).toBe('reconciling');

    await reset('image-undecodable');
    title = imageJob.title;
    markdown = copyMarkdown();
    const badPreview = await adapter().run({ ...reconcile, platform_markdown: markdown }, hooks, new AbortController().signal);
    expect(badPreview).toMatchObject({ status: 'reconciling', error_code: 'reconcile_unavailable' });
    expect(editorVisits).toBe(1);
    expect(observations()).toContainEqual(expect.objectContaining({ phase: 'after', markdown }));
    expect(writes).toBe(0);
    expect(transferredImages).toEqual([]);
  });
  it('只读核对通过草稿箱发现候选图文稿并确认图片', async () => {
    await reset('image-normal');
    title = imageJob.title;
    markdown = copyMarkdown();
    draftEntries = [{ articleId: '123', title, markdown, status: 2, username: 'expected-user' }];
    const reconcile = { ...imageJob, run_mode: 'reconcile' as const, external_started: true, platform_markdown: markdown };
    const result = await adapter().run(reconcile, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(writes).toBe(0);
    expect(transferredImages).toEqual([]);
  });
  it('验证账号、先持久化副作用边界，再填入多行Markdown并从服务器读回', async () => {
    await reset();
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe('succeeded');
    expect(result.remote_id).toBe('123');
    expect(markdown).toBe(job.markdown);
    expect(writes).toBe(1);
    expect(events.findIndex(e=>e.external_started === true)).toBeLessThan(events.findIndex(e=>e.remote_id === '123'));
    expect(events.some(e=>e.stage === 'draft_acquired')).toBe(true);
    expect(observations()).toEqual([
      { phase: 'before', title: '【无标题】', markdown: '# 欢迎使用官方Markdown编辑器\n\n这是默认模板，不是已有文章。', status: 'editor' },
      { phase: 'after', title: job.title, markdown: job.markdown, status: '2', remote_id: '123' },
    ]);
    expect(events.filter(value => value.observation?.phase === 'before').map(value => value.stage)).toEqual(['filling']);
    expect(events.filter(value => value.observation?.phase === 'after').map(value => value.stage)).toEqual(['verifying']);
    expect(events.every(value => !value.message?.includes(job.markdown) && !value.message?.includes('这是默认模板'))).toBe(true);
    await context.grantPermissions(['clipboard-read'], { origin });
    const checkPage = await context.newPage();
    await checkPage.goto(origin + '/account');
    expect(await checkPage.evaluate(() => navigator.clipboard.readText())).toBe('');
    await checkPage.close();
  });
  it('标题显示已更新但平台延迟同步保存状态时，等待同步后完整保存', async () => {
    await reset('deferred-title');
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(title).toBe(job.title); expect(markdown).toBe(job.markdown); expect(writes).toBe(1);
  });
  it('文字稿的手动保存也拒绝非草稿状态', async () => {
    await reset('text-publish');
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe('reconciling');
    expect(writes).toBe(0);
  });
  it('标题同步仍未完成时阻断错误保存请求，不把无标题发送给平台', async () => {
    await reset('unsynced-title');
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe('reconciling'); expect(writes).toBe(0);
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
    expect(observations().some(value => value.phase === 'after')).toBe(false);
  });
  it('核对只读，候选错误不绑定；修正后的相同快照才可成功', async () => {
    await reset(); title = '其他文章'; markdown = '其他正文';
    const reconcile = { ...job, run_mode: 'reconcile' as const, external_started: true, reconcile_candidate_id: '123' };
    const mismatch = await adapter().run(reconcile, hooks, new AbortController().signal);
    expect(mismatch.status).toBe('reconciling');
    expect(events.some(e=>e.remote_id)).toBe(false);
    expect(observations()).toEqual([{ phase: 'after', title: '其他文章', markdown: '其他正文', status: '2', remote_id: '123' }]);
    events.length = 0;
    title = job.title; markdown = job.markdown;
    const match = await adapter().run(reconcile, hooks, new AbortController().signal);
    expect(match.status).toBe('succeeded'); expect(match.remote_id).toBe('123'); expect(writes).toBe(0);
    expect(observations()).toEqual([{ phase: 'after', title: job.title, markdown: job.markdown, status: '2', remote_id: '123' }]);
  });
  it('保存核对失败仍记录平台实际值，不使用任务期望正文', async () => {
    await reset('saved-mismatch');
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'reconciling', error_code: 'draft_mismatch' });
    expect(observations().find(value => value.phase === 'after')).toEqual({ phase: 'after', title: job.title, markdown: '平台实际保留的正文', status: '2', remote_id: '123' });
    expect(writes).toBe(1);
  });
  it.each(['oversized-before', 'oversized-after'])('超长实际观察不截断或阻止安全保存：%s', async state => {
    await reset(state);
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(writes).toBe(1);
    expect(result.status).toBe(state === 'oversized-before' ? 'succeeded' : 'reconciling');
    expect(observations().map(value => value.phase)).toEqual(state === 'oversized-before' ? ['after'] : ['before']);
  });
  it('不合法编辑器实值不发送观察，仍完成安全草稿保存', async () => {
    await reset('nul-before');
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe('succeeded'); expect(writes).toBe(1);
    expect(observations().map(value => value.phase)).toEqual(['after']);
  });
  it('平台状态超出观察限额时不发送该快照，也不伪造为草稿状态', async () => {
    await reset('oversized-status');
    const result = await adapter().run(job, hooks, new AbortController().signal);
    expect(result.status).toBe('reconciling'); expect(writes).toBe(1);
    expect(observations().map(value => value.phase)).toEqual(['before']);
  });
  it.each(['not-draft', 'missing-state'])('相同内容缺少已观测草稿状态时，保存和核对均保持待核对：%s', async state => {
    await reset(state);
    const saved = await adapter().run(job, hooks, new AbortController().signal);
    expect(saved.status).toBe('reconciling');
    expect(observations().find(value => value.phase === 'after')?.status).toBe(state === 'missing-state' ? 'unknown' : '1');
    events.length = 0;
    const checked = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true, reconcile_candidate_id: '123' }, hooks, new AbortController().signal);
    expect(checked.status).toBe('reconciling');
    expect(observations()).toEqual([{ phase: 'after', title: job.title, markdown: job.markdown, status: state === 'missing-state' ? 'unknown' : '1', remote_id: '123' }]);
    expect(writes).toBe(1);
  });
  it('只读核对阻止编辑器脚本自动写稿，错误候选也不会新建或修改', async () => {
    await reset('auto-reconcile'); title = job.title; markdown = job.markdown;
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true, reconcile_candidate_id: '999' }, hooks, new AbortController().signal);
    expect(result.status).toBe('reconciling');
    expect(writes).toBe(0); expect(title).toBe(job.title); expect(markdown).toBe(job.markdown);
    expect(events.some(e=>e.remote_id)).toBe(false);
    expect(observations()).toEqual([]);
  });
  it('账号检查阻止页面脚本提交任何草稿写入', async () => {
    await reset('auto-account');
    const result = await adapter().run({ ...job, kind: 'check_account' }, hooks, new AbortController().signal);
    expect(result.status).toBe('succeeded'); expect(editorVisits).toBe(0); expect(writes).toBe(0);
    expect(observations()).toEqual([]);
  });
  it('无ID时完整分页查找并只读核对唯一匹配草稿', async () => {
    await reset();
    draftEntries = Array.from({ length: 21 }, (_, index) => ({ articleId: String(1000 + index), title: index === 20 ? job.title : '其他合成稿件', markdown: index === 20 ? job.markdown.replace(/\n/g, '\r\n') : '其他正文', status: 2, username: 'expected-user' }));
    const result = await adapter().run({ ...job, run_mode: 'reconcile', external_started: true }, hooks, new AbortController().signal);
    expect(result).toMatchObject({ status: 'succeeded', remote_id: '1020' });
    expect(listRequests).toEqual([1, 2]); expect(writes).toBe(0); expect(editorVisits).toBe(1);
    expect(observations()).toEqual([{ phase: 'after', title: job.title, markdown: job.markdown.replace(/\n/g, '\r\n'), status: '2', remote_id: '1020' }]);
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
    expect(observations()).toEqual(state === 'partial-match' ? [{ phase: 'after', title: job.title, markdown: '残留正文', status: '2', remote_id: '123' }] : []);
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
  it('填入前观察检查点取消时不会继续编辑或保存', async () => {
    await reset();
    const controller = new AbortController();
    const result = await adapter().run(job, { progress: async value => { events.push(value); if (value.observation) controller.abort(); } }, controller.signal);
    expect(result.status).toBe('reconciling');
    expect(writes).toBe(0);
    expect(observations().map(value => value.phase)).toEqual(['before']);
    expect(events.some(value => value.stage === 'saving')).toBe(false);
  });
  it('取消中止浏览器操作，不继续保存', async () => {
    await reset();
    const controller = new AbortController();
    const result = await adapter().run(job, { progress: async value => { events.push(value); if (value.external_started) controller.abort(); } }, controller.signal);
    expect(['cancelled', 'reconciling']).toContain(result.status);
    expect(writes).toBe(0);
  });
});