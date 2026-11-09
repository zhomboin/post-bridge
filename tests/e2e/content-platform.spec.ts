import { test, expect, login } from './fixtures';
import type { ContentPlatform } from '../../apps/admin/src/content-contract';

test('合成平台使用通用内容工作台、不透明标识及安全正文', async ({ page, stack }, info) => {
  const definition: ContentPlatform = {
    id: 'synthetic',
    label: '合成平台',
    id_pattern: '^post:.+$',
    username_pattern: '^author-.+$',
    user_id_pattern: '^native-.+$',
    sync_job: 'sync_contents',
    read_job: 'read_content',
    sync_result: 'contents',
    read_result: 'content',
    identity_result: 'content_identity',
    body_ttl_seconds: 0,
    invalidate_body_on_sync: false,
    read_statuses: ['published'],
    capabilities: {
      list: { enabled: true, formats: [], kinds: ['document'] },
      body: { enabled: true, formats: ['text'], kinds: ['document'] },
    },
  };
  const item = {
    id: 'post:alpha/one',
    title: '合成平台的独立文档',
    status: 'published',
    platform_status: 'LIVE',
    posted_at: '2026-11-09T00:00:00Z',
    kind: 'document',
    cover_urls: [],
    metrics: {},
    extensions: {},
  };
  const base = '/api/accounts/synthetic-account/contents';
  let read = false;
  await login(page, stack);
  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            account: {
              id: 'synthetic-account',
              platform: 'synthetic',
              username: 'author-test',
              display_name: '合成平台账号',
              status: 'connected',
            },
            capabilities: {},
          },
        ],
      },
    }),
  );
  await page.route('**/api/content-platforms', (route) =>
    route.fulfill({ json: { items: [definition] } }),
  );
  await page.route('**/api/accounts/synthetic-account/contents**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON().request_id).toBeTruthy();
      read = path.endsWith('/read');
      await route.fulfill({
        json: {
          id: 'synthetic-task',
          kind: read ? 'read_content' : 'sync_contents',
          status: 'queued',
        },
      });
    } else if (path === base) {
      await route.fulfill({
        json: {
          items: [item],
          total: 1,
          page: 1,
          page_size: 20,
          snapshot: { synced_at: '2026-11-09T00:00:00Z', complete: true, extensions: {} },
          sync_job: null,
        },
      });
    } else {
      await route.fulfill({
        json: {
          platform: 'synthetic',
          item,
          body: read
            ? {
                id: item.id,
                format: 'text',
                text: '<script>这里只展示正文文本</script>',
                html: '',
                images: [],
                tags: [],
                extensions: {},
              }
            : null,
          fetched_at: read ? '2026-11-09T00:00:00Z' : null,
          read_job: null,
        },
      });
    }
  });
  await page.goto(stack.url + '/account?account=synthetic-account&q=合成&page=2');
  await expect(page.getByRole('link', { name: item.title })).toBeVisible();
  await page.screenshot({ path: info.outputPath('content-platform-1440.png'), fullPage: true });
  await page.getByRole('link', { name: item.title }).click();
  await expect(page.getByRole('heading', { name: item.title })).toBeVisible();
  await page.getByRole('button', { name: '读取正文', exact: true }).click();
  await expect(
    page.getByText('<script>这里只展示正文文本</script>', { exact: true }),
  ).toBeVisible();
  expect(await page.locator('script').filter({ hasText: '这里只展示正文文本' }).count()).toBe(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('content-platform-' + width + '.png'),
      fullPage: true,
    });
  }
  await page.getByRole('link', { name: '返回账号内容' }).click();
  await expect(page).toHaveURL(/account=synthetic-account.*q=/);
  await page.getByLabel('搜索内容').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '筛选', exact: true })).toBeFocused();
});
