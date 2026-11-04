import { test, expect, login, csrf, worker } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import type { Stack } from './fixtures';

const title = '只读文章：长标题与代码、标签和平台状态的完整核对';
const entry = (id: string, status = 'published', platformStatus = '1') => ({ id, title: id === '101' ? title : '合成文章 ' + id, status, platform_status: platformStatus, posted_at: id === '101' ? '2026-11-04T10:30:00+08:00' : '2026-11-04T10:00:00+08:00', type: 'original', views: 312, likes: 8, comments: 3, favorites: 5, exposures: 820, gained_fans: 1, quality_score: 82.5, is_top: false, fans_only: false, vip_only: false, editor_type: 1, cover_urls: [] });
const snapshot = () => ({ username: 'synthetic-csdn-account', profile: { nickname: '演示创作者', avatar_url: '', level: 3, points: 685, original_articles: 20, followers: 91 }, counts: { total: 24, published: 20, draft: 1, rejected: 1, recycled: 1, unknown: 1 }, stats: { articles: 20, views: 24829, likes: 317, comments: 3, favorites: 309, exposures: 30870, followers: 91, yesterday_views: 26, yesterday_followers: -1, yesterday_favorites: 0 }, trend: [{ date: '2026-11-03', views: 26, comments: 0, favorites: 0, followers: -1, promotion_clicks: null, outlink_clicks: 0 }], items: [ ...Array.from({ length: 20 }, (_, n) => entry(String(101 + n))), entry('201', 'draft', '2'), entry('202', 'rejected', '6'), entry('203', 'recycled', '32'), entry('204', 'unknown', '999') ] });
async function finishRead(request: APIRequestContext, stack: Stack, id: string, payload: object, kind: string) {
  const claim = await (await worker(request, stack, '/internal/worker/claim', { worker_id: 'synthetic-reader' })).json();
  expect(claim.job.id).toBe(id); expect(claim.job.kind).toBe(kind); expect(claim.job.account_username).toBe('synthetic-csdn-account');
  const path = '/internal/worker/jobs/' + id; const lease = { lease_token: claim.lease_token };
  await worker(request, stack, path + '/progress', { ...lease, stage: 'checking_login' });
  await worker(request, stack, path + '/progress', { ...lease, stage: 'verifying' });
  await worker(request, stack, path + '/complete', { ...lease, status: 'succeeded', ...payload });
}

test('账号文章只读同步、分页、筛选、正文、安全外链和窄屏', async ({ page, stack, request }, info) => {
  await login(page, stack);
  await page.getByRole('link', { name: '账号文章', exact: true }).click();
  await expect(page.getByText('暂无文章快照', { exact: true })).toBeVisible();
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/account/articles/sync') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '同步文章', exact: true }).click();
  const sync = await (await accepted).json(); await finishRead(request, stack, sync.id, { articles: snapshot() }, 'sync_articles');
  await page.getByRole('button', { name: '刷新本地状态', exact: true }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('共 24 条记录', { exact: true })).toBeVisible();
  await expect(page.getByText('24,829', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page).toHaveURL(/page=2/); await expect(page.getByText('第 2 页 / 2 页', { exact: true })).toBeVisible();
  await page.getByLabel('文章状态', { exact: true }).selectOption('unknown'); await page.getByRole('button', { name: '筛选', exact: true }).click(); await expect(page.getByText('未知状态', { exact: true })).toBeVisible(); await expect(page.getByText('共 1 条记录', { exact: true })).toBeVisible();
  await page.getByLabel('文章状态', { exact: true }).selectOption('published'); await page.getByLabel('搜索文章', { exact: true }).fill('只读文章'); await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('account-articles-' + width + '.png'), fullPage: true });
  }
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'CSDN 原文', exact: true })).toHaveAttribute('href', 'https://blog.csdn.net/synthetic-csdn-account/article/details/101');
  await expect(page.getByRole('link', { name: 'CSDN 编辑器', exact: true })).toHaveAttribute('href', 'https://editor.csdn.net/md/?articleId=101');
  const bodyResponse = page.waitForResponse(response => response.url().endsWith('/api/account/articles/101/read') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '读取正文', exact: true }).click(); const read = await (await bodyResponse).json();
  await finishRead(request, stack, read.id, { article: { id: '101', title, markdown: '## 合成正文\n\n只读验证。\n\n<script>window.articleInjected = true</script>\n\n[危险链接](javascript:alert(1))\n\n[正常链接](https://example.com/)\n\n![图片](https://example.com/private.png)', html: '<script>window.articleInjected = true</script>', description: '合成内容摘要', tags: ['Go', '只读'], categories: ['测试专栏'], type: 'original', visibility: 'public', platform_status: '1', reason: '' } }, 'read_article');
  await page.getByRole('button', { name: '刷新本地状态', exact: true }).click(); await expect(page.getByRole('heading', { name: '合成正文', exact: true })).toBeVisible();
  await expect(page.locator('.article-preview img, .article-preview script, .article-preview iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { articleInjected?: boolean }).articleInjected)).toBeUndefined();
  await expect(page.getByRole('link', { name: '危险链接', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '正常链接', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('account-article-detail-' + width + '.png'), fullPage: true });
  }
  await page.getByRole('button', { name: 'Markdown 源文', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(page.locator('pre.article-source')).toContainText('## 合成正文');
  await page.getByRole('link', { name: '返回账号文章', exact: true }).click(); await expect(page).toHaveURL(/q=.*status=published/); await expect(page.getByLabel('搜索文章', { exact: true })).toHaveValue('只读文章');
  const token = await csrf(page.request); const failedSync = await page.request.post('/api/account/articles/sync', { headers: { Origin: stack.url, 'X-CSRF-Token': token }, data: { request_id: 'failing-sync' } }); expect(failedSync.status()).toBe(202); const failed = await failedSync.json();
  const claim = await (await worker(request, stack, '/internal/worker/claim', { worker_id: 'synthetic-reader' })).json(); expect(claim.job.id).toBe(failed.id); await worker(request, stack, '/internal/worker/jobs/' + failed.id + '/complete', { lease_token: claim.lease_token, status: 'failed', error_code: 'article_read_unavailable' });
  await page.getByRole('button', { name: '刷新本地状态', exact: true }).click(); await expect(page.getByText('平台文章读取暂不可用', { exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
});
