import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { CSDNReadAdapter } from '../src/csdn-read.js';
import { safeRequestURL } from '../src/config.js';
import type { Job, Progress } from '../src/types.js';

let server: Server;
let browser: Browser;
let context: BrowserContext;
let origin = '';
let mode = 'normal';
let writes = 0;
let reads = 0;
let visits: string[] = [];
let requests: string[] = [];
const events: Progress[] = [];
const article = (id: number, status = 1) => ({ articleId: String(id), username: 'expected-user', title: `合成文章${id}`, status, postTime: '2026-11-04 12:30:00', viewCount: 20, diggCount: 3, commentCount: 2, collectCount: 4, totalExposures: 40, fansCount: 1, qualityScore: 80.5, isTop: false, isNeedFans: false, isNeedVip: false, isVipArticle: false, type: 1, editorType: 0, coverImage: ['https://img-blog.csdnimg.cn/cover.png'] });
let all = Array.from({ length: 21 }, (_, i) => article(100 + i, i === 1 ? 6 : i === 2 ? 32 : i === 3 ? 77 : 1));
let drafts = [article(200, 2)];
const job: Job = { id: 'read-job', kind: 'sync_articles', title: '', markdown: '', account_username: 'expected-user', run_mode: 'execute', external_started: false, remote_id: null, reconcile_candidate_id: null };
const hooks = { progress: async (event: Progress) => { events.push(event); } };
const endpoint = '/blog/phoenix/console/v1/article/list';
const json = (value: unknown) => JSON.stringify(value);

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const send = (data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(json(data)); };
    if (url.pathname === '/account') {
      visits.push('account');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(mode === 'login' ? '<button>登录</button>' : `<a href="https://blog.csdn.net/${mode === 'wrong-account' ? 'wrong-user' : 'expected-user'}">个人主页</a><script>fetch('/blog-console-api/v1/user/info');${mode === 'premature-body' ? `fetch('/blog-console-api/v3/editor/getArticle?articleId=100').catch(()=>{});` : ''}${mode === 'no-metrics' ? '' : mode === 'late-summary' ? `setTimeout(()=>fetch('/blog/phoenix/console/v1/data/get-blog-statistics-data'),80);` : `fetch('/blog/phoenix/console/v1/data/get-blog-statistics-data');`}fetch('/save',{method:'POST'}).catch(()=>{});fetch('/save',{method:'PUT'}).catch(()=>{});fetch('/save',{method:'DELETE'}).catch(()=>{});new WebSocket('ws://127.0.0.1:${new URL(origin).port}/socket');</script>`);
    } else if (url.pathname === '/blog-console-api/v1/user/info') {
      send({ code: 200, data: { username: mode === 'profile-mismatch' ? 'wrong-user' : 'expected-user', nickname: '合成昵称', avatar: ['native-avatar', 'native-fields'].includes(mode) ? 'https://profile-avatar.csdnimg.cn/avatar.png' : mode === 'unsafe-avatar' ? 'https://profile-avatar.csdnimg.cn.evil.test/avatar.png' : 'https://img-home.csdnimg.cn/avatar.png', level: '4', point: '500' } });
    } else if (url.pathname === '/blog/phoenix/console/v1/data/get-blog-statistics-data') {
      send({ code: 200, data: { allViewCount: 120, yesterdayViewCount: 10, allFansCount: 30, yesterdayFansCount: -1, allFavoriteCount: 14, yesterdayFavoriteCount: -2, allOriginalArticleCount: 18, allScoreCount: 500 } });
    } else if (url.pathname === '/analysis') {
      visits.push('analysis');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<script>${mode === 'no-metrics' ? '' : `fetch('/blog/phoenix/console/v1/data/blog-statistics');fetch('/blog/phoenix/console/v1/data/all-article');`}fetch('/publish',{method:'POST'}).catch(()=>{});</script>`);
    } else if (url.pathname === '/blog/phoenix/console/v1/data/blog-statistics') {
      send({ code: 200, data: [{ name: '文章总数', enName: 'article', num: 18, tips: '', display: true }, { name: '阅读', enName: 'view', num: 120, tips: '', display: true }, { name: '点赞', enName: 'digg', num: 9, tips: '', display: true }, { name: '评论', enName: 'comment', num: 6, tips: '', display: true }] });
    } else if (url.pathname === '/blog/phoenix/console/v1/data/all-article') {
      send({ code: 200, data: { dateList: ['2026-11-03'], chartData: { view: [12], comment: [1], collect: [2], fans: [-1], promotionCardClickCnt: [0], articleOutlinkClickCnt: [1] }, list: [{ pdate: '2026-11-03', viewCount: 999, commentCount: 1, favoriteCount: 2, fanCount: 1, promotionCardClickCnt: 0, articleOutlinkClickCnt: 1 }], total: 1, page: 1, size: 20 } });
    } else if (url.pathname === '/manage') {
      visits.push('manage');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<button>全部(${all.length})</button><button>草稿箱(${drafts.length})</button><button aria-label="下一页">下一页</button><script>let status='all_v3',page=1;const load=()=>fetch('${endpoint}?status='+status+'&page='+page+'&pageSize=20',{headers:{'X-Native':'yes'}});document.querySelectorAll('button')[0].onclick=()=>{status='all_v3';page=1;load()};document.querySelectorAll('button')[1].onclick=()=>{status='draft';page=1;load()};document.querySelectorAll('button')[2].onclick=()=>{page++;load()};${mode === 'stale' ? `fetch('${endpoint}?status=all_v3&page=1&pageSize=20&stale=1',{headers:{'X-Native':'yes'}});` : ''}</script>`);
    } else if (url.pathname === endpoint) {
      const status = url.searchParams.get('status')!;
      const page = Number(url.searchParams.get('page'));
      requests.push(`${status}:${page}`);
      if (req.headers['x-native'] !== 'yes') { res.statusCode = 403; send({}); return; }
      if (url.searchParams.has('stale')) { await new Promise(resolve => setTimeout(resolve, 20)); send({ code: 200, data: { count: { all_v3: 0, draft: 0 }, list: [], page, size: 20, listStatus: status, total: 0 } }); return; }
      if (mode === 'stale') await new Promise(resolve => setTimeout(resolve, 60));
      const entries = status === 'draft' ? drafts : all;
      let list = entries.slice((page - 1) * 20, page * 20);
      if (mode === 'duplicate' && page === 2) list = [entries[0]];
      if (mode === 'early-empty' && page === 2) list = [];
      if (mode === 'item-wrong-account' && list[0]) list = [{ ...list[0], username: 'wrong-user' }, ...list.slice(1)];
      if (mode === 'large-list' && list[0]) list = [{ ...list[0], title: 'x'.repeat(6 * 1024 * 1024) }, ...list.slice(1)];
      const payloadList = mode === 'native-fields' ? list.map((item, index) => ({ ...item, type: '2', coverImage: index === 0 ? [] : ['https://i-blog.csdnimg.cn/cover.png'] })) : list;
      send({ code: 200, data: { count: { all_v3: all.length, draft: drafts.length }, list: payloadList, page: mode === 'wrong-page' ? page + 1 : page, size: 20, listStatus: status, total: mode === 'too-many' ? 2001 : mode === 'changing-total' && page === 2 ? entries.length + 1 : entries.length } });
    } else if (url.pathname === '/md/') {
      visits.push('editor');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const id = url.searchParams.get('articleId');
      const nativeGET = ['native-get', 'conflicting-query-id', 'duplicate-query-id'].includes(mode);
      const conflict = mode === 'conflicting-query-id' ? `fetch('/blog-console-api/v3/editor/getArticle?id=${id}&articleId=999&model_type=');` : mode === 'duplicate-query-id' ? `fetch('/blog-console-api/v3/editor/getArticle?id=${id}&id=999&model_type=');` : '';
      const bodyRequest = nativeGET ? `fetch('/blog-console-api/v3/editor/getArticle?id=${id}&model_type=');` : `fetch('/blog-console-api/v3/editor/getArticle?articleId=${id}',{method:'POST'});`;
      res.end(`<script>fetch('/save',{method:'POST'}).catch(()=>{});fetch('/blog-console-api/v3/editor/getArticle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({articleId:'999'})}).catch(()=>{});${mode === 'conflicting-body-id' ? `fetch('/blog-console-api/v3/editor/getArticle?articleId=${id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({articleId:'999'})}).catch(()=>{});` : ''}${conflict}${bodyRequest}</script>`);
    } else if (url.pathname === '/blog-console-api/v3/editor/getArticle') {
      reads++;
      send({ code: 200, data: { article_id: mode === 'body-mismatch' ? '999' : url.searchParams.get('articleId') ?? url.searchParams.get('id'), title: '正文标题', markdowncontent: mode === 'large-body' ? 'x'.repeat(2 * 1024 * 1024) : '# 合成正文\n\n![图](https://img-blog.csdnimg.cn/image.png)', content: '<p>合成正文</p>', description: '摘要', tags: '标签一,标签二', categories: '分类', type: 'original', read_type: 'public', status: 1, reason: '' } });
    } else if (['/save', '/publish', '/socket'].includes(url.pathname)) { writes++; send({}); }
    else { res.statusCode = 404; res.end(''); }
  });
  server.on('upgrade', (_request, socket) => { writes++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
}, 30000);
beforeEach(async () => { context = await browser.newContext({ serviceWorkers: 'block' }); mode = 'normal'; writes = 0; reads = 0; visits = []; requests = []; events.length = 0; all = Array.from({ length: 21 }, (_, i) => article(100 + i, i === 1 ? 6 : i === 2 ? 32 : i === 3 ? 77 : 1)); drafts = [article(200, 2)]; });
afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });
async function run(value = job, signal = new AbortController().signal) {
  try { return await new CSDNReadAdapter(context, { username: 'expected-user', timeoutMs: 600 }, { origin, accountPath: '/account', managePath: '/manage', analysisPath: '/analysis', editorPath: '/md/' }).run(value, hooks, signal); }
  finally { await context.close(); }
}

describe('CSDN账号文章只读读取', () => {
  it('通过原生按钮完整读取全部和草稿分页，保留未知状态并换算中国时区', async () => {
    const result = await run();
    expect(result.status).toBe('succeeded');
    expect(requests).toEqual(['all_v3:1', 'all_v3:2', 'draft:1']);
    expect(result.articles?.counts).toEqual({ total: 22, published: 18, rejected: 1, recycled: 1, unknown: 1, draft: 1 });
    expect(result.articles?.items[0]).toMatchObject({ id: '100', posted_at: '2026-11-04T12:30:00+08:00', type: 'original', views: 20, likes: 3, comments: 2, favorites: 4, exposures: 40, quality_score: 80.5 });
    expect(result.articles?.items.find(item => item.id === '103')).toMatchObject({ status: 'unknown', platform_status: '77' });
    expect(events.map(event => event.stage)).toEqual(['checking_login', 'verifying']);
    expect(events.every(event => !event.external_started && !event.remote_id)).toBe(true);
    expect(result.remote_id).toBeUndefined(); expect(writes).toBe(0); expect(visits).not.toContain('editor');
  });
  it('读取账号汇总与趋势，缺失统计保持null', async () => {
    const result = await run();
    expect(result.articles?.profile).toEqual({ nickname: '合成昵称', avatar_url: 'https://img-home.csdnimg.cn/avatar.png', level: 4, points: 500, original_articles: 18, followers: 30 });
    expect(result.articles?.stats).toMatchObject({ articles: 18, views: 120, likes: 9, comments: 6, favorites: 14, exposures: null, followers: 30, yesterday_views: 10, yesterday_followers: -1, yesterday_favorites: -2 });
    expect(result.articles?.trend).toEqual([{ date: '2026-11-03', views: 12, comments: 1, favorites: 2, followers: -1, promotion_clicks: 0, outlink_clicks: 1 }]);
  });
  it('等待首页晚发的原生账号汇总请求，文章总数采用平台统计', async () => {
    mode = 'late-summary'; const result = await run(); expect(result.status).toBe('succeeded');
    expect(result.articles?.profile).toMatchObject({ original_articles: 18, followers: 30 });
    expect(result.articles?.stats).toMatchObject({ articles: 18, followers: 30, yesterday_views: 10, yesterday_followers: -1, yesterday_favorites: -2 });
    expect(result.articles?.counts.total).toBe(22);
  });
  it('接受已确认头像域名元数据但不扩展浏览器请求白名单', async () => {
    mode = 'native-avatar'; const result = await run(); expect(result.status).toBe('succeeded');
    expect(result.articles?.profile.avatar_url).toBe('https://profile-avatar.csdnimg.cn/avatar.png');
    expect(safeRequestURL('https://profile-avatar.csdnimg.cn/avatar.png')).toBe(false);
  });
  it('支持已确认封面域名与转载类型，空封面不补猜测值', async () => {
    mode = 'native-fields'; const result = await run(); expect(result.status).toBe('succeeded');
    expect(result.articles?.items[0]).toMatchObject({ type: 'repost', cover_urls: [] });
    expect(result.articles?.items[1]).toMatchObject({ type: 'repost', cover_urls: ['https://i-blog.csdnimg.cn/cover.png'] });
    expect(safeRequestURL('https://i-blog.csdnimg.cn/cover.png')).toBe(false);
  });
  it('拒绝相似头像域名', async () => {
    mode = 'unsafe-avatar'; const result = await run(); expect(result.status).toBe('failed'); expect(result.articles).toBeUndefined();
  });
  it('汇总和趋势未获取时不把未知统计写成零', async () => {
    mode = 'no-metrics'; const result = await run();
    expect(result.articles?.stats).toEqual({ articles: null, views: null, likes: null, comments: null, favorites: null, exposures: null, followers: null, yesterday_views: null, yesterday_followers: null, yesterday_favorites: null });
    expect(result.articles?.trend).toEqual([]);
  });
  it('确认全量为空时交付零条快照', async () => {
    all = []; drafts = []; const result = await run(); expect(result.status).toBe('succeeded'); expect(result.articles?.counts.total).toBe(0);
  });
  it.each(['native-get', 'conflicting-query-id', 'duplicate-query-id'])('支持官方GET正文格式并拒绝冲突查询ID：%s', async value => {
    mode = value; const result = await run({ ...job, kind: 'read_article', article_id: '100' });
    expect(result.status).toBe('succeeded'); expect(result.article?.id).toBe('100'); expect(reads).toBe(1); expect(writes).toBe(0);
  });
  it('正文请求查询参数与载荷ID冲突时阻止额外读取', async () => {
    mode = 'conflicting-body-id'; const result = await run({ ...job, kind: 'read_article', article_id: '100' }); expect(result.status).toBe('succeeded'); expect(reads).toBe(1);
  });
  it('账号核验前阻止提前读取正文', async () => {
    mode = 'premature-body'; const result = await run({ ...job, kind: 'read_article', article_id: '100' }); expect(result.status).toBe('succeeded'); expect(reads).toBe(1);
  });
  it('同一ID在两个完整列表相同则合并', async () => {
    all = [article(200, 2)]; drafts = [article(200, 2)];
    const result = await run(); expect(result.articles?.counts.total).toBe(1);
  });
  it('跨列表同一ID内容不一致则失败', async () => {
    all = [article(200, 1)]; drafts = [article(200, 2)];
    expect((await run()).status).toBe('failed');
  });
  it('只接受点击触发的请求实例，忽略页面自动请求的迟到响应', async () => {
    mode = 'stale'; const result = await run(); expect(result.articles?.counts.total).toBe(22);
  });
  it.each(['duplicate', 'early-empty', 'wrong-page', 'changing-total', 'too-many', 'item-wrong-account', 'large-list'])('完整列表校验失败不交付部分数据：%s', async value => {
    mode = value; const result = await run(); expect(result.status).toBe('failed'); expect(result.articles).toBeUndefined(); expect(writes).toBe(0);
  });
  it.each(['wrong-account', 'profile-mismatch', 'login'])('账号不匹配或需登录时不读取列表和正文：%s', async value => {
    mode = value; const result = await run(); expect(result.status).toBe(value === 'login' ? 'waiting_user' : 'failed'); expect(requests).toEqual([]); expect(visits).not.toContain('editor');
  });
  it('任务账号与执行器配置不一致时不访问平台', async () => {
    expect((await run({ ...job, account_username: 'wrong-user' })).status).toBe('failed'); expect(visits).toEqual([]);
  });
  it('只读获取指定文章正文，阻止自动保存及其他ID的正文请求', async () => {
    const result = await run({ ...job, kind: 'read_article', article_id: '100' });
    expect(result.status).toBe('succeeded'); expect(result.article).toEqual({ id: '100', title: '正文标题', markdown: '# 合成正文\n\n![图](https://img-blog.csdnimg.cn/image.png)', html: '<p>合成正文</p>', description: '摘要', tags: ['标签一', '标签二'], categories: ['分类'], type: 'original', visibility: 'public', platform_status: '1', reason: '' });
    expect(result.articles).toBeUndefined(); expect(reads).toBe(1); expect(writes).toBe(0);
  });
  it.each(['body-mismatch', 'large-body'])('正文ID或大小不合规时拒绝：%s', async value => {
    mode = value; const result = await run({ ...job, kind: 'read_article', article_id: '100' }); expect(result.status).toBe('failed'); expect(result.article).toBeUndefined();
  });
  it('读取前关闭恢复页面，取消不返回读取数据', async () => {
    const restored = await context.newPage();
    const controller = new AbortController(); controller.abort();
    const result = await run(job, controller.signal); expect(result.status).toBe('cancelled'); expect(result.articles).toBeUndefined(); expect(restored.isClosed()).toBe(true);
  });
});
