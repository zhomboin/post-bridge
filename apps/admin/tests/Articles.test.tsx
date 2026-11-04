import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const article = { id: '12345', title: '账号文章与只读正文', status: 'published', platform_status: 'enable', posted_at: '2026-11-03T04:00:00Z', type: 'original', views: 1240, likes: 12, comments: 3, favorites: 8, exposures: 2500, gained_fans: null, quality_score: null, is_top: false, fans_only: false, vip_only: false, editor_type: 1, cover_urls: [], blog_url: 'https://blog.csdn.net/example/article/details/12345', editor_url: 'https://editor.csdn.net/md/?articleId=12345' };
const snapshot = { username: 'example', profile: { nickname: '测试作者', avatar_url: '', level: 3, points: 200, original_articles: 1, followers: 35 }, counts: { total: 21, published: 20, draft: 1, rejected: 0, recycled: 0, unknown: 0 }, stats: { articles: 21, views: 1240, likes: 12, comments: 3, favorites: 8, exposures: 2500, followers: 35, yesterday_views: 22, yesterday_followers: null, yesterday_favorites: 1 }, trend: [{ date: '2026-11-03', views: 22, comments: 1, favorites: 1, followers: null, promotion_clicks: null, outlink_clicks: null }], synced_at: '2026-11-03T05:00:00Z' };
const readJob = { id: 'read-1', kind: 'read_article', article_id: '12345', title: article.title, status: 'queued', outcome: 'not_submitted', stage: 'queued', created_at: '', updated_at: '' };
let calls: { url: string; init?: RequestInit }[];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const listing = () => ({ items: [article], total: 21, page: 1, page_size: 20, snapshot, sync_job: null });
const detail = (body: unknown = null, read_job: unknown = null) => ({ article, body, fetched_at: body ? '2026-11-03T06:00:00Z' : null, read_job });
beforeEach(() => {
  calls = [];
  window.history.replaceState({}, '', '/articles');
  handler = url => {
    if (url === '/api/account') return response({ username: 'example', status: 'connected' });
    if (url === '/api/session') return response({ user: { username: '管理员' }, csrf_token: 'csrf' });
    if (url.startsWith('/api/account/articles?')) return response(listing());
    if (url === '/api/account/articles/12345') return response(detail());
    return response({ message: '不存在' }, 404);
  };
  vi.stubGlobal('fetch', vi.fn((input, init) => { const url = String(input); calls.push({ url, init }); return Promise.resolve(handler(url, init)); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('CSDN 账号文章', () => {
  it('恢复标题、状态与20条分页，详情返回保留筛选', async () => {
    window.history.replaceState({}, '', '/articles?q=账号&status=draft&page=2');
    render(<App />);
    await screen.findByRole('link', { name: article.title });
    expect((screen.getByLabelText('搜索文章') as HTMLInputElement).value).toBe('账号');
    const statusFilter = screen.getByRole('combobox', { name: '文章状态' }) as HTMLSelectElement;
    expect(statusFilter.value).toBe('draft');
    expect(statusFilter.getAttribute('aria-label')).toBe('文章状态');
    const url = calls.find(call => call.url.startsWith('/api/account/articles?'))!.url;
    expect(new URL(url, 'http://local').searchParams.get('page_size')).toBe('20');
    expect(new URL(url, 'http://local').searchParams.get('page')).toBe('2');
    fireEvent.click(screen.getByRole('link', { name: article.title }));
    await screen.findByRole('button', { name: '读取正文' });
    fireEvent.click(screen.getByRole('link', { name: '返回账号文章' }));
    await screen.findByLabelText('搜索文章');
    expect(decodeURI(window.location.search)).toBe('?q=账号&status=draft&page=2');
    fireEvent.change(screen.getByLabelText('搜索文章'), { target: { value: '新标题' } });
    fireEvent.change(screen.getByLabelText('文章状态'), { target: { value: 'unknown' } });
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    await waitFor(() => expect(window.location.search).toBe('?q=%E6%96%B0%E6%A0%87%E9%A2%98&status=unknown'));
  });

  it('展示账号统计与真实同步时间，失败保留快照并标记陈旧', async () => {
    const base = handler;
    let failed = false;
    handler = (url, init) => failed && url.startsWith('/api/account/articles?') ? response({ message: '连接中断' }, 503) : base(url, init);
    render(<App />);
    await screen.findByText('测试作者');
    expect(screen.getByText(/最近同步/).textContent).toContain('2026');
    expect(screen.queryByText('昨日 +22')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '数据统计' }));
    expect(screen.getByText('1,240')).toBeTruthy();
    expect(screen.getByText('昨日 +22')).toBeTruthy();
    failed = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新本地状态' }));
    await screen.findByText(/连接中断.*数据可能已过期/);
    expect(screen.getByText('1,240')).toBeTruthy();
    expect(calls.every(call => call.url.startsWith('/api/'))).toBe(true);
  });

  it('首次空快照仅提供主动同步，双击不重复提交且携带CSRF', async () => {
    const base = handler;
    let finish: (value: Response) => void = () => {};
    handler = (url, init) => url.startsWith('/api/account/articles?') ? response({ ...listing(), items: [], total: 0, snapshot: null }) : url.endsWith('/sync') ? new Promise(resolve => { finish = resolve; }) : base(url, init);
    render(<App />);
    const button = await screen.findByRole('button', { name: '同步文章' });
    expect(calls.some(call => call.url.endsWith('/sync'))).toBe(false);
    fireEvent.click(button); fireEvent.click(button);
    expect(calls.filter(call => call.url.endsWith('/sync'))).toHaveLength(1);
    expect(new Headers(calls.find(call => call.url.endsWith('/sync'))!.init?.headers).get('X-CSRF-Token')).toBe('csrf');
    await act(async () => finish(response({ ...readJob, kind: 'sync_articles' })));
    expect(screen.getByText('排队中')).toBeTruthy();
  });

  it('正文预览禁用脚本、外部图片与危险链接，外链校验固定账号', async () => {
    window.history.replaceState({}, '', '/articles/12345');
    const base = handler;
    handler = (url, init) => url === '/api/account/articles/12345' ? response({ ...detail({ id: '12345', title: article.title, markdown: '# 安全正文\n\n<script>window.injected=1</script>\n\n![私密图片](https://evil.test/pixel)\n\n[危险](javascript:alert%281%29) [安全](https://example.com/read) [相对](/api/logout)', html: '', description: '摘要', tags: ['Go'], categories: ['笔记'], type: 'original', visibility: 'public', platform_status: 'enable', reason: '' }), article: { ...article, blog_url: 'https://blog.csdn.net/other/article/details/12345', editor_url: 'https://evil.test/editor' } }) : base(url, init);
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: '安全正文' });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link', { name: '危险' })).toBeNull();
    expect(screen.queryByRole('link', { name: '相对' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'CSDN 原文' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'CSDN 编辑器' })).toBeNull();
    expect(screen.getByRole('link', { name: '安全' }).getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.click(screen.getByRole('button', { name: 'Markdown 源文' }));
    expect(screen.getByLabelText('Markdown 源文').textContent).toContain('<script>');
  });

  it('HTML正文仅显示纯文本；读取失败时保留已有正文与缓存时间', async () => {
    window.history.replaceState({}, '', '/articles/12345');
    const base = handler;
    handler = (url, init) => url === '/api/account/articles/12345' ? response(detail({ id: '12345', markdown: '', html: '<img src=x onerror=alert(1)><p>正文</p>', tags: [], categories: [] }, { ...readJob, status: 'failed', error_message: '正文读取失败' })) : base(url, init);
    const { container } = render(<App />);
    await screen.findByText('正文读取失败');
    expect(screen.getByLabelText('HTML 源文').textContent).toContain('<img');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/正文缓存于/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /编辑|删除|发布/ })).toBeNull();
  });

  it('仅展示固定CSDN详情和编辑器链接，回退地址拒绝外站', async () => {
    window.history.replaceState({}, '', '/articles/12345?back=https://evil.test');
    render(<App />);
    expect((await screen.findByRole('link', { name: 'CSDN 原文' })).getAttribute('href')).toBe(article.blog_url);
    expect(screen.getByRole('link', { name: 'CSDN 编辑器' }).getAttribute('href')).toBe(article.editor_url);
    expect(screen.getByRole('link', { name: '返回账号文章' }).getAttribute('href')).toBe('/account');
  });

  it.each(['sync_articles', 'read_article'])('任务列表正确标记%s读取类型与结果', async kind => {
    window.history.replaceState({}, '', '/jobs');
    const base = handler;
    handler = (url, init) => url.startsWith('/api/jobs?') ? response({ items: [{ ...readJob, kind, status: 'succeeded', outcome: 'not_submitted' }], total: 1, page: 1, page_size: 50 }) : base(url, init);
    render(<App />);
    await screen.findByText(kind === 'sync_articles' ? '文章同步完成' : '正文读取完成');
    expect(screen.queryByText('文字草稿')).toBeNull();
    expect(screen.queryByText('尚未保存到CSDN')).toBeNull();
  });

  it('同步失败显示上次快照，缺失统计保持未知而非零', async () => {
    const base = handler;
    handler = (url, init) => url.startsWith('/api/account/articles?') ? response({ ...listing(), snapshot: { ...snapshot, stats: { ...snapshot.stats, views: null, yesterday_views: null } }, sync_job: { ...readJob, kind: 'sync_articles', status: 'failed', error_message: '文章同步失败' } }) : base(url, init);
    render(<App />);
    await screen.findByText('同步未完成，显示上次快照。');
    expect(screen.getByRole('link', { name: article.title })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '数据统计' }));
    expect(screen.getByText('—', { selector: 'dd' })).toBeTruthy();
    expect(screen.queryByText('昨日 +22')).toBeNull();
  });

  it('离开详情取消本次请求，读取失败重试保留请求标识', async () => {
    window.history.replaceState({}, '', '/articles/12345');
    const base = handler;
    let attempts = 0;
    handler = (url, init) => url.endsWith('/read') ? (++attempts === 1 ? response({ message: '网络中断' }, 503) : new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); })) : base(url, init);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '读取正文' }));
    await screen.findByText('网络中断');
    fireEvent.click(screen.getByRole('button', { name: '读取正文' }));
    await screen.findByRole('button', { name: '正在读取…' });
    const reads = calls.filter(call => call.url.endsWith('/read'));
    expect(reads).toHaveLength(2);
    expect(reads[0].init?.body).toBe(reads[1].init?.body);
    fireEvent.click(screen.getByRole('link', { name: '返回账号文章' }));
    await screen.findByLabelText('搜索文章');
    expect(reads[1].init?.signal?.aborted).toBe(true);
  });

  it('读取任务详情显示只读方式且无草稿核对操作', async () => {
    window.history.replaceState({}, '', '/jobs/read-1');
    const base = handler;
    handler = (url, init) => url === '/api/jobs/read-1' ? response({ ...readJob, status: 'failed', retry_allowed: true }) : url.startsWith('/api/logs?') ? response({ items: [], total: 0 }) : base(url, init);
    render(<App />);
    await screen.findByText('正文读取失败');
    expect(screen.getByRole('button', { name: '重试读取' })).toBeTruthy();
    expect(screen.queryByText('保存草稿')).toBeNull();
    expect(screen.queryByText('已人工结束，草稿可能保留')).toBeNull();
    expect(screen.queryByRole('button', { name: '重新自动核对' })).toBeNull();
  });

  it('详情展示完整文章指标及封面链接但不加载封面', async () => {
    window.history.replaceState({}, '', '/articles/12345');
    const base = handler;
    handler = (url, init) => url === '/api/account/articles/12345' ? response({ ...detail(), article: { ...article, gained_fans: 4, quality_score: 86.5, cover_urls: ['https://img.example.com/cover.png', 'javascript:alert(1)'] } }) : base(url, init);
    const { container } = render(<App />);
    await screen.findByText('质量分');
    expect(screen.getByText('86.5')).toBeTruthy();
    expect(screen.getByText('涨粉')).toBeTruthy();
    expect(screen.getByRole('link', { name: '封面 1' }).getAttribute('href')).toBe('https://img.example.com/cover.png');
    expect(screen.queryByRole('link', { name: '封面 2' })).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('正文读取主动排队并阻止重复，状态错误不显示草稿保存结果', async () => {
    window.history.replaceState({}, '', '/articles/12345');
    const base = handler;
    let queued = false;
    handler = (url, init) => url.endsWith('/read') ? (queued = true, response(readJob)) : url === '/api/account/articles/12345' ? response(detail(null, queued ? readJob : null)) : base(url, init);
    render(<App />);
    const button = await screen.findByRole('button', { name: '读取正文' });
    expect(calls.some(call => call.url.endsWith('/read'))).toBe(false);
    fireEvent.click(button);
    await screen.findByRole('button', { name: '正在读取…' });
    expect(calls.filter(call => call.url.endsWith('/read'))).toHaveLength(1);
    expect(screen.queryByText(/保存到CSDN|草稿已保存/)).toBeNull();
  });
});


describe('平台账号工作台', () => {
  it('默认文章且只保留一个平台账号导航，共享身份与统计分离', async () => {
    window.history.replaceState({}, '', '/account');
    render(<App />);
    await screen.findByRole('link', { name: article.title });
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(within(navigation).getByRole('link', { name: '平台账号' }).getAttribute('href')).toBe('/account');
    expect(within(navigation).queryByRole('link', { name: '账号文章' })).toBeNull();
    expect(within(navigation).queryByRole('link', { name: 'CSDN 账号' })).toBeNull();
    expect(screen.getByRole('tab', { name: '文章' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('测试作者')).toBeTruthy();
    expect(screen.getByText('example')).toBeTruthy();
    expect(screen.getByText('已连接')).toBeTruthy();
    expect(screen.queryByText('昨日 +22')).toBeNull();
    expect(calls.some(call => call.url === '/api/account/login')).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: '数据统计' }));
    expect(screen.getByText('昨日 +22')).toBeTruthy();
    expect(screen.queryByRole('link', { name: article.title })).toBeNull();
    expect(screen.queryByLabelText('搜索文章')).toBeNull();
    expect(calls.filter(call => call.url.startsWith('/api/account/articles?'))).toHaveLength(1);
  });

  it('三页签保留筛选分页，键盘与浏览器历史恢复当前页签', async () => {
    window.history.replaceState({}, '', '/account?q=账号&status=draft&page=2');
    render(<App />);
    await screen.findByRole('link', { name: article.title });
    fireEvent.click(screen.getByRole('tab', { name: '数据统计' }));
    expect(window.location.search).toBe('?q=%E8%B4%A6%E5%8F%B7&status=draft&page=2&tab=stats');
    fireEvent.keyDown(screen.getByRole('tab', { name: '数据统计' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: '账号设置' }).getAttribute('aria-selected')).toBe('true');
    expect(new URLSearchParams(window.location.search).get('page')).toBe('2');
    fireEvent.keyDown(screen.getByRole('tab', { name: '账号设置' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: '文章' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByLabelText('搜索文章') as HTMLInputElement).value).toBe('账号');
    act(() => { window.history.replaceState({}, '', '/account?tab=stats&q=账号&status=draft&page=2'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.getByRole('tab', { name: '数据统计' }).getAttribute('aria-selected')).toBe('true');
    act(() => { window.history.replaceState({}, '', '/account?q=账号&status=draft&page=2'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.getByRole('tab', { name: '文章' }).getAttribute('aria-selected')).toBe('true');
  });

  it.each(['stats', 'settings'])('直接刷新 %s 页签由地址恢复', async tab => {
    window.history.replaceState({}, '', '/account?tab=' + tab + '&q=账号&status=draft&page=2');
    render(<App />);
    await screen.findByText('测试作者');
    expect(screen.getByRole('tab', { name: tab === 'stats' ? '数据统计' : '账号设置' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByLabelText('搜索文章')).toBeNull();
  });

  it('旧文章入口替换为平台账号地址并保留筛选', async () => {
    window.history.replaceState({}, '', '/articles?q=账号&status=draft&page=2');
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<App />);
    await screen.findByRole('link', { name: article.title });
    expect(window.location.pathname).toBe('/account');
    expect(new URLSearchParams(window.location.search).get('q')).toBe('账号');
    expect(replace).toHaveBeenCalled();
    replace.mockRestore();
  });

  it.each(['/account?tab=settings&q=账号&status=draft&page=2', '/articles?q=账号&status=draft&page=2'])('正文返回 %s 归一为账号文章筛选', async back => {
    window.history.replaceState({}, '', '/articles/12345?back=' + encodeURIComponent(back));
    render(<App />);
    await screen.findByRole('button', { name: '读取正文' });
    const link = screen.getByRole('link', { name: '返回账号文章' });
    expect(link.getAttribute('href')).toBe('/account?q=%E8%B4%A6%E5%8F%B7&status=draft&page=2');
    expect(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '平台账号' }).getAttribute('aria-current')).toBe('page');
  });

  it.each(['//evil.test', '/account/../jobs', '/account#evil', '/account?token=private', '/articles/123'])('正文拒绝异常返回地址 %s', async back => {
    window.history.replaceState({}, '', '/articles/12345?back=' + encodeURIComponent(back));
    render(<App />);
    expect((await screen.findByRole('link', { name: '返回账号文章' })).getAttribute('href')).toBe('/account');
  });
});
