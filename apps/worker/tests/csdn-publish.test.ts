import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chromium, type BrowserContext } from 'playwright';
import { CSDNAdapter } from '../src/csdn.js';
import type { Job, Progress } from '../src/types.js';

const job: Job = {
  id: 'publish-job', kind: 'publish', title: '本地发布模拟文章', markdown: '    leading space\n\n正文。',
  account_username: 'test-account', remote_id: '123', reconcile_candidate_id: null, external_started: false, run_mode: 'execute',
  publish_options: {
    tags: ['Go'], summary: '文章摘要', categories: [], article_type: 'original',
    creation_declaration: 'none', visibility: 'public', template: 'simple', cover_image_url: '',
  },
};
const expectedHTMLDigest = createHash('sha256').update('<p>内容</p>').digest('hex');
const reconciliation: Job = { ...job, run_mode: 'reconcile', external_started: true, published_html_sha256: expectedHTMLDigest };
let server: Server;
let context: BrowserContext;
let origin: string;
let mode = 'normal';
let draftStatus = 2;
let editorVisits = 0;
const writes: Record<string, unknown>[] = [];
const tagLookups: string[] = [];
let readType = 'public';
const checkpoints: Progress[] = [];
let timeline: string[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/account') {
      res.end('<a href="https://blog.csdn.net/test-account">个人主页</a>');
    } else if (url.pathname === '/md/') {
      editorVisits++;
      const options = '<input name="type" id="original" type="radio" checked><label for="original">原创</label>' +
        '<input name="type" id="repost" type="radio"><label for="repost">转载</label>' +
        '<input name="type" id="translated" type="radio"><label for="translated">翻译</label>' +
        '<input placeholder="请填写原文链接"><input id="chkAuthorized" type="checkbox"><label for="chkAuthorized">授权确认</label>' +
        '<input name="visibility" id="public" type="radio" value="public" checked><label for="public">全部可见</label>' +
        '<input name="visibility" id="needfans" type="radio" value="read_need_fans"><label for="needfans">粉丝可见</label>' +
        '<input name="template" id="article-template-simple-1" type="radio" value="4"><label for="article-template-simple-1">简洁模板</label>' +
        '<input name="template" id="article-template-mogrow-1" type="radio" value="3"><label for="article-template-mogrow-1">墨衍模板</label>' +
        '<div class="creation-statement-select"><input value="无声明" readonly></div>' +
        '<ul hidden class="declaration-options"><li class="el-select-dropdown__item"><span>部分内容由AI辅助生成</span></li></ul>' +
        '<div class="gitcode-box"><input type="checkbox" checked><label>同时备份到GitCode</label></div>' +
        '<div class="multi-platform-publish"><input id="multiPlatformPublishNo" type="radio"><label for="multiPlatformPublishNo">否</label></div>';
      res.end('<!doctype html><button class="btn-publish">发布文章</button>' +
        '<div class="modal__publish-article" hidden><div class="mark_selection"><div class="mark_selection_title_el_tag"></div>' +
        '<button>添加文章标签</button><div class="mark_selection_box" hidden>' +
        '<input placeholder="请输入文字搜索，Enter键入可添加自定义标签"><ul class="el-autocomplete-suggestion"></ul><button aria-label="关闭">关闭</button></div></div>' +
        '<div class="tag__box"><input type="hidden" name="categories" value=""><button class="tag__item-list">专栏</button><div class="tag__options-content" hidden>' +
        '<label class="tag__option-label"><input type="checkbox"><span>已有专栏</span></label><button aria-label="关闭">关闭</button></div></div>' +
        '<div class="txt-desc"><textarea></textarea></div>' +
        options + '<div class="publish-article-modal__footer"><button>发布文章</button></div></div>' +
        '<script>' +
        'const modal=document.querySelector(".modal__publish-article");' +
        'const mark=document.querySelector(".mark_selection_box");' +
        'const tags=[];let article;let statement=0;' +
        'const tagInput=mark.querySelector("input");const suggest=mark.querySelector("ul");' +
        'const addTag=value=>{tags.push(value);const chip=document.createElement("span");chip.className="mark_selection_box_el_tag";chip.textContent=value;document.querySelector(".mark_selection_title_el_tag").append(chip);tagInput.value="";suggest.replaceChildren();};' +
        'const lookup=key=>fetch("/blog/phoenix/console/v1/tag/search-recommend-tag",{method:"POST",body:JSON.stringify({key,page:0,page_size:1000,platform:"pc"})}).then(r=>r.json());' +
        'tagInput.oninput=()=>{' +
        (mode === 'existing-tag' ? 'void lookup("Unexpected").catch(()=>{});' : '') +
        'void lookup(tagInput.value).then(r=>{for(const value of r.data){const item=document.createElement("li");item.textContent=value;item.onclick=()=>addTag(value);suggest.append(item);}}).catch(()=>{});' +
        '};' +
        'const declaration=document.querySelector(".creation-statement-select input");const statements=document.querySelector(".declaration-options");declaration.onclick=()=>{statements.hidden=false};statements.querySelector("li").onclick=e=>{declaration.value=e.currentTarget.textContent;statement=1;statements.hidden=true};' +
        'const category=document.querySelector(".tag__options-content");document.querySelector(".tag__item-list").onmouseenter=()=>{category.hidden=false};category.querySelector("button").onclick=()=>{category.hidden=true};category.querySelector("input").onchange=e=>{document.querySelector("input[name=categories]").value=e.target.checked?"已有专栏":""};' +
        'const send=(extra={})=>fetch("/save",{method:"POST",body:JSON.stringify({id:"123",title:article.title,markdowncontent:article.markdowncontent,content:"<p>内容</p>",' +
        'status:0,pubStatus:"publish",is_new:1,source:"pc_mdeditor",not_auto_saved:"1",tags:tags.join(","),Description:document.querySelector("textarea").value,categories:document.querySelector("input[name=categories]").value,type:document.querySelector("input[name=type]:checked").id,' +
        'original_link:document.querySelector("input[placeholder=请填写原文链接]").value,authorized_status:document.querySelector("#chkAuthorized").checked,' +
        'readType:document.querySelector("input[name=visibility]:checked").value,template_id:Number(document.querySelector("input[name=template]:checked").value),creation_statement:statement,cover_images:[],cover_type:1,sync_git_code:document.querySelector("input[name=visibility]:checked").value==="public"?Number(document.querySelector(".gitcode-box input").checked):undefined,...extra})});' +
        'fetch("/blog-console-api/v3/editor/getArticle?id=123").then(r=>r.json()).then(r=>{article=r.data; ' +
        (mode === 'early' ? 'void send().catch(()=>{});' : '') + '});' +
        'document.querySelector(".btn-publish").onclick=()=>{modal.hidden=false};' +
        'document.querySelector(".mark_selection > button").onclick=()=>{mark.hidden=false};' +
        'mark.querySelector("button").onclick=()=>{mark.hidden=true};' +
        'tagInput.onkeydown=e=>{if(e.key==="Enter" && ' + String(mode !== 'existing-tag') + ')addTag(e.target.value);};' +
        'document.querySelector(".publish-article-modal__footer button").onclick=async()=>{const extra=' +
        JSON.stringify(mode === 'wrong-body' ? { markdowncontent: job.markdown.trimStart() } : mode === 'gitcode' ? { sync_git_code: 1 } : mode === 'scheduled' ? { scheduled_time: 50 } : mode === 'wrong-summary' ? { Description: '其他摘要' } :
          mode === 'wrong-html' ? { content: '<p>其他内容</p>' } : mode === 'wrong-source' ? { source: 'unexpected' } :
          mode === 'wrong-is-new' ? { is_new: 0 } : mode === 'wrong-autosave' ? { not_auto_saved: '0' } :
          mode === 'cross-platform' ? { multi_platform_ids: ['another'] } : {}) +
        ';await fetch("/blog/phoenix/console/v1/article/check-images",{method:"POST",body:JSON.stringify({content:extra.content||"<p>内容</p>"})}).catch(()=>{});' +
        'void send(extra).catch(()=>{});void send(extra).catch(()=>{});};' +
        '</script>');
    } else if (url.pathname.endsWith('/getArticle')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 200, data: {
        article_id: mode === 'wrong-id' ? '456' : '123', title: job.title, markdowncontent: job.markdown, content: mode === 'changed-html-readback' ? '<p>其他内容</p>' : '<p>内容</p>', status: draftStatus, read_type: mode === 'wrong-visibility' ? 'private' : readType,
      } }));
    } else if (url.pathname.endsWith('/check-images')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 200, data: mode === 'image-check-failed' ? ['unexpected'] : [] }));
    } else if (url.pathname.endsWith('/search-recommend-tag')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { key } = JSON.parse(body);
      tagLookups.push(key);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 200, data: mode === 'existing-tag' ? [key] : [] }));
    } else if (url.pathname === '/save') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      writes.push(payload);
      readType = payload.readType;
      timeline.push('write');
      draftStatus = mode === 'pending' ? 16 : 1;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"code":200,"data":{"id":"123"}}');
    } else { res.statusCode = 404; res.end(''); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  context = await browser.newContext({ serviceWorkers: 'block' });
}, 30000);

afterAll(async () => {
  const browser = context?.browser();
  await context?.close();
  await browser?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
});
beforeEach(() => { mode = 'normal'; draftStatus = 2; editorVisits = 0; writes.length = 0; tagLookups.length = 0; readType = 'public'; checkpoints.length = 0; timeline = []; });
const adapter = () => new CSDNAdapter(context, { username: 'test-account', timeoutMs: 900 }, { origin, accountPath: '/account', editorPath: '/md/' });
const hooks = { progress: async (checkpoint: Progress) => { checkpoints.push(checkpoint); if (checkpoint.external_started) timeline.push('checkpoint'); } };
const run = (input = job) => adapter().run(input, hooks, new AbortController().signal);

describe('CSDN 正式发布模拟站', () => {
  it('核对已有草稿，持久化写入边界，只提交一次，重新打开确认已发布', async () => {
    expect(await run()).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(editorVisits).toBe(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: '123', status: 0, pubStatus: 'publish', Description: '文章摘要', tags: 'Go', template_id: 4, sync_git_code: 0 });
    expect(timeline).toEqual(['checkpoint', 'write']);
    expect(checkpoints.filter(checkpoint => checkpoint.external_started)).toEqual([expect.objectContaining({ stage: 'saving', remote_id: '123', published_html_sha256: expectedHTMLDigest })]);
  });
  it.each(['wrong-body', 'gitcode', 'scheduled', 'wrong-summary', 'wrong-id', 'wrong-html', 'wrong-source', 'wrong-is-new',
    'wrong-autosave', 'cross-platform', 'image-check-failed'])('不匹配时不提交或持久化副作用：%s', async value => {
    mode = value;
    expect((await run()).status).toBe('failed');
    expect(writes).toEqual([]);
    expect(timeline).toEqual([]);
  });
  it.each(['repost', 'translated'] as const)('原文授权绑定到单篇文章：%s', async article_type => {
    const settings = { ...job.publish_options!, article_type, original_url: 'https://original.example/article' };
    const blocked = await run({ ...job, publish_options: settings });
    expect(blocked).toMatchObject({ status: 'failed', error_code: 'publish_options_mismatch' });
    const invalid = await run({ ...job, publish_options: { ...settings, rights_confirmed: 'false' as unknown as boolean } });
    expect(invalid).toMatchObject({ status: 'failed', error_code: 'publish_options_mismatch' });
    expect(editorVisits).toBe(0);
    expect(await run({ ...job, publish_options: { ...settings, rights_confirmed: true } })).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ type: article_type, original_link: settings.original_url, authorized_status: true });
  });
  it('绑定账号不匹配时不打开平台草稿', async () => {
    expect(await run({ ...job, account_username: 'another-account' })).toMatchObject({ status: 'failed', error_code: 'publish_draft_mismatch' });
    expect(editorVisits).toBe(0);
    expect(writes).toHaveLength(0);
  });
  it('回读可见范围不一致时保持待核对', async () => {
    mode = 'wrong-visibility';
    expect(await run()).toMatchObject({ status: 'reconciling', remote_id: '123', publish_accepted: true });
    expect(writes).toHaveLength(1);
  });
  it('只搜索已确认标签，选择已有匹配项', async () => {
    mode = 'existing-tag';
    expect(await run()).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(tagLookups).toEqual(['Go']);
    expect(writes[0].tags).toBe('Go');
  });
  it('按确认选项设置已有专栏、创作声明、模板和可见范围', async () => {
    const publish_options = { ...job.publish_options!, categories: ['已有专栏'], creation_declaration: 'ai_assisted' as const,
      visibility: 'fans' as const, template: 'moyan' as const };
    expect(await run({ ...job, publish_options })).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(writes[0]).toMatchObject({ categories: '已有专栏', creation_statement: 1, readType: 'read_need_fans', template_id: 3 });
  });
  it('副作用检查点失败时不会将原生请求转发到平台', async () => {
    await expect(adapter().run(job, { progress: async value => { if (value.external_started) throw new Error('lease lost'); } }, new AbortController().signal)).rejects.toThrow();
    expect(writes).toEqual([]);
  });
  it('只读核对已发布结果，不再次提交', async () => {
    mode = 'early';
    draftStatus = 1;
    expect(await run(reconciliation)).toMatchObject({ status: 'succeeded', remote_id: '123' });
    expect(editorVisits).toBe(1);
    expect(writes).toEqual([]);
    expect(timeline).toEqual([]);
  });
  it('只读恢复需要同一份原生 HTML 的冻结摘要', async () => {
    draftStatus = 1;
    expect(await run({ ...reconciliation, published_html_sha256: undefined })).toMatchObject({
      status: 'reconciling', error_code: 'publish_unconfirmed', remote_id: '123',
    });
    mode = 'changed-html-readback';
    const mismatch = await run(reconciliation);
    expect(mismatch).toMatchObject({ status: 'reconciling', error_code: 'publish_unconfirmed', remote_id: '123' });
    expect(mismatch.publish_accepted).toBeUndefined();
    expect(writes).toHaveLength(0);
  });
  it('审核状态在执行及恢复中保持待核对且不会重发', async () => {
    mode = 'pending';
    expect(await run()).toMatchObject({ status: 'reconciling', remote_id: '123', publish_accepted: true });
    expect(await run(reconciliation)).toMatchObject({ status: 'reconciling', remote_id: '123', publish_accepted: true });
    expect(writes).toHaveLength(1);
  });
});
