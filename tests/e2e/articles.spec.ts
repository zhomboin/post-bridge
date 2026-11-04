import { test, expect, login, csrf, worker } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import type { Stack } from './fixtures';

const title = '只读文章：长标题与代码、标签和平台状态的完整核对';
const entry = (id: string, status = 'published', platformStatus = '1') => ({ id, title: id === '101' ? title : '合成文章 ' + id, status, platform_status: platformStatus, posted_at: id === '101' ? '2026-11-04T10:30:00+08:00' : '2026-11-04T10:00:00+08:00', type: 'original', views: 312, likes: 8, comments: 3, favorites: 5, exposures: 820, gained_fans: 1, quality_score: 82.5, is_top: false, fans_only: false, vip_only: false, editor_type: 1, cover_urls: [] });
const snapshot = () => ({ username: 'synthetic-csdn-account', profile: { nickname: '演示创作者', avatar_url: 'https://profile-avatar.csdnimg.cn/synthetic-account.png', level: 3, points: 685, original_articles: 20, followers: 91 }, counts: { total: 24, published: 20, draft: 1, rejected: 1, recycled: 1, unknown: 1 }, stats: { articles: 20, views: 24829, likes: 317, comments: 3, favorites: 309, exposures: 30870, followers: 91, yesterday_views: 26, yesterday_followers: -1, yesterday_favorites: 0 }, trend: Array.from({ length: 7 }, (_, n) => ({ date: ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'][n], views: [38, 21, 54, 42, 68, 35, 26][n], comments: n === 2 ? 2 : 0, favorites: [1, 0, 3, null, 2, 1, 0][n], followers: [1, 0, 2, -1, 1, 0, -1][n], promotion_clicks: null, outlink_clicks: 0 })), items: [ ...Array.from({ length: 20 }, (_, n) => entry(String(101 + n))), entry('201', 'draft', '2'), entry('202', 'rejected', '6'), entry('203', 'recycled', '32'), entry('204', 'unknown', '999') ] });
async function syntheticAvatar(page: Page) {
  await page.route('https://profile-avatar.csdnimg.cn/synthetic-account.png', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#e7eefc"/><circle cx="32" cy="23" r="11" fill="#2557c8"/><path d="M12 58c0-23 40-23 40 0" fill="#2557c8"/></svg>' }));
}
async function finishRead(request: APIRequestContext, stack: Stack, id: string, payload: object, kind: string) {
  const claim = await (await worker(request, stack, '/internal/worker/claim', { worker_id: 'synthetic-reader' })).json();
  expect(claim.job.id).toBe(id); expect(claim.job.kind).toBe(kind); expect(claim.job.account_username).toBe('synthetic-csdn-account');
  const path = '/internal/worker/jobs/' + id; const lease = { lease_token: claim.lease_token };
  await worker(request, stack, path + '/progress', { ...lease, stage: 'checking_login' });
  await worker(request, stack, path + '/progress', { ...lease, stage: 'verifying' });
  await worker(request, stack, path + '/complete', { ...lease, status: 'succeeded', ...payload });
}

test('账号文章只读同步、分页、筛选、正文、安全外链和窄屏', async ({ page, stack, request }, info) => {
  await syntheticAvatar(page);
  await login(page, stack);
  await page.getByRole('link', { name: '平台账号', exact: true }).click();
  await expect(page.getByText('暂无文章快照', { exact: true })).toBeVisible();
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/account/articles/sync') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '同步文章', exact: true }).click();
  const sync = await (await accepted).json(); await finishRead(request, stack, sync.id, { articles: snapshot() }, 'sync_articles');
  await page.getByRole('button', { name: '刷新本地状态', exact: true }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('共 24 条记录', { exact: true })).toBeVisible();
  const avatar = page.getByRole('img', { name: '账号头像', exact: true });
  await expect(avatar).toBeVisible();
  await expect.poll(() => avatar.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText('24,829', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '数据统计', exact: true }).click();
  await expect(page.getByText('24,829', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '文章', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page).toHaveURL(/page=2/); await expect(page.getByText('第 2 页 / 2 页', { exact: true })).toBeVisible();
  await page.getByLabel('文章状态', { exact: true }).selectOption('unknown'); await page.getByRole('button', { name: '筛选', exact: true }).click(); await expect(page.getByText('未知状态', { exact: true })).toBeVisible(); await expect(page.getByText('共 1 条记录', { exact: true })).toBeVisible();
  await page.getByLabel('文章状态', { exact: true }).selectOption('published'); await page.getByLabel('搜索文章', { exact: true }).fill('只读文章'); await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '账号身份' }).getByText('已连接', { exact: true })).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('account-articles-' + width + '.png'), fullPage: true });
  }
  const bodyResponse = page.waitForResponse(response => response.url().endsWith('/api/account/articles/101/read') && response.request().method() === 'POST');
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'CSDN 原文', exact: true })).toHaveAttribute('href', 'https://blog.csdn.net/synthetic-csdn-account/article/details/101');
  await expect(page.getByRole('link', { name: 'CSDN 编辑器', exact: true })).toHaveAttribute('href', 'https://editor.csdn.net/md/?articleId=101');
  const read = await (await bodyResponse).json();
  await expect(page.getByRole('button', { name: '正在读取…', exact: true })).toBeDisabled();
  await finishRead(request, stack, read.id, { article: { id: '101', title, markdown: '## 合成正文\n\n只读验证。\n\n<script>window.articleInjected = true</script>\n\n[危险链接](javascript:alert(1))\n\n[正常链接](https://example.com/)\n\n![图片](https://example.com/private.png)', html: '<script>window.articleInjected = true</script>', description: '合成内容摘要', tags: ['Go', '只读'], categories: ['测试专栏'], type: 'original', visibility: 'public', platform_status: '1', reason: '' } }, 'read_article');
  await page.getByRole('button', { name: '刷新本地状态', exact: true }).click(); await expect(page.getByLabel('Markdown 源文', { exact: true })).toContainText('## 合成正文');
  await expect(page.locator('.article-source img, .article-source script, .article-source iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { articleInjected?: boolean }).articleInjected)).toBeUndefined();
  await expect(page.getByRole('link', { name: '危险链接', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '正常链接', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Markdown 源文', { exact: true })).toContainText('<script>window.articleInjected = true</script>');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('account-article-detail-' + width + '.png'), fullPage: true });
  }
  await expect(page.getByRole('button', { name: '正文预览', exact: true })).toHaveCount(0);
  await page.getByLabel('Markdown 源文', { exact: true }).focus(); await expect(page.getByLabel('Markdown 源文', { exact: true })).toBeFocused();
  await page.getByRole('link', { name: '返回账号文章', exact: true }).click(); await expect(page).toHaveURL(/\/account\?q=.*status=published/); await expect(page.getByLabel('搜索文章', { exact: true })).toHaveValue('只读文章');
  const token = await csrf(page.request); const failedSync = await page.request.post('/api/account/articles/sync', { headers: { Origin: stack.url, 'X-CSRF-Token': token }, data: { request_id: 'failing-sync' } }); expect(failedSync.status()).toBe(202); const failed = await failedSync.json();
  const claim = await (await worker(request, stack, '/internal/worker/claim', { worker_id: 'synthetic-reader' })).json(); expect(claim.job.id).toBe(failed.id); await worker(request, stack, '/internal/worker/jobs/' + failed.id + '/complete', { lease_token: claim.lease_token, status: 'failed', error_code: 'article_read_unavailable' });
  await page.getByRole('button', { name: '刷新本地状态', exact: true }).click(); await expect(page.getByText('平台文章读取暂不可用', { exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
});


test('平台账号页签与正文保持文章筛选、分页和浏览器历史', async ({ page, stack, request }, info) => {
  await syntheticAvatar(page);
  await login(page, stack);
  const token = await csrf(page.request);
  const accepted = await page.request.post('/api/account/articles/sync', { headers: { Origin: stack.url, 'X-CSRF-Token': token }, data: { request_id: 'account-tabs-seed' } });
  expect(accepted.status()).toBe(202); await finishRead(request, stack, (await accepted.json()).id, { articles: snapshot() }, 'sync_articles');
  await page.getByRole('link', { name: '平台账号', exact: true }).click();
  await expect(page.getByRole('tab', { name: '文章', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '账号文章', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: 'CSDN 账号', exact: true })).toHaveCount(0);
  await page.getByLabel('搜索文章', { exact: true }).fill('合成'); await page.getByRole('button', { name: '筛选', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page).toHaveURL(/page=2/);
  const listAddress = page.url(); const listID = new URL(listAddress).searchParams;
  await page.getByRole('tab', { name: '数据统计', exact: true }).click();
  await expect(page.getByRole('tab', { name: '数据统计', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('24,829', { exact: true })).toBeVisible(); await expect(page.getByLabel('搜索文章')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '近期趋势数据' })).toBeVisible();
  for (const metric of ['阅读', '评论', '收藏', '粉丝', '推广点击', '外链点击']) await expect(page.getByRole('img', { name: metric + '趋势', exact: true })).toBeVisible();
  await expect(page.locator('.article-trend summary')).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('platform-account-stats-' + width + '.png'), fullPage: true });
  }
  await page.getByRole('tab', { name: '账号设置', exact: true }).click(); await expect(page.getByRole('button', { name: '检查登录状态', exact: true })).toBeVisible(); await expect(page.getByLabel('搜索文章')).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('platform-account-settings-' + width + '.png'), fullPage: true });
  }
  await page.reload(); await expect(page.getByRole('tab', { name: '账号设置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '文章', exact: true }).click(); await expect(page.getByLabel('搜索文章', { exact: true })).toHaveValue('合成'); await expect(page.getByText('第 2 页 / 2 页', { exact: true })).toBeVisible();
  const automaticRead = page.waitForResponse(response => /\/api\/account\/articles\/\d+\/read$/.test(response.url()) && response.request().method() === 'POST');
  const first = page.locator('.article-table tbody .title-link').first(); const selectedTitle = await first.innerText(); await first.click(); await expect(page.getByRole('heading', { name: selectedTitle, exact: true })).toBeVisible();
  expect((await automaticRead).status()).toBe(202);
  await page.getByRole('link', { name: '返回账号文章', exact: true }).click(); expect(new URL(page.url()).searchParams.get('q')).toBe(listID.get('q')); expect(new URL(page.url()).searchParams.get('page')).toBe('2');
  await page.getByRole('tab', { name: '文章', exact: true }).focus(); await page.keyboard.press('ArrowRight'); await expect(page.getByRole('tab', { name: '数据统计', exact: true })).toBeFocused(); await expect(page.getByRole('tab', { name: '数据统计', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(page.getByRole('tab', { name: '文章', exact: true })).toHaveAttribute('aria-selected', 'true'); await expect(page.getByText('第 2 页 / 2 页', { exact: true })).toBeVisible();
  await page.goForward(); await expect(page.getByRole('tab', { name: '数据统计', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goto('/articles?q=%E5%90%88%E6%88%90&page=2'); await expect(page).toHaveURL(/\/account\?q=.*page=2/); await expect(page.getByText('第 2 页 / 2 页', { exact: true })).toBeVisible();
});
