import type { Page } from 'playwright';

type Identity = 'pending' | 'connected' | 'wrong';
interface Fixture {
  origin: string;
  accountPath: string;
}
export async function readLoginIdentity(
  page: Page,
  username: string,
  fixture?: Fixture,
): Promise<Identity> {
  if (
    fixture &&
    (process.env.NODE_ENV !== 'test' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture.origin))
  )
    throw new Error('登录模拟站点仅限测试回环地址');
  try {
    return await page.evaluate(
      ({ username, origin, accountPath }): Identity => {
        if (
          location.origin !== origin ||
          (accountPath !== undefined && location.pathname !== accountPath)
        )
          return 'pending';
        const names = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).flatMap(
          (node) => {
            try {
              const url = new URL(node.href);
              return url.protocol === 'https:' &&
                url.hostname === 'blog.csdn.net' &&
                /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
                ? [url.pathname.replace(/^\/|\/$/g, '')]
                : [];
            } catch {
              return [];
            }
          },
        );
        const login = Array.from(document.querySelectorAll<HTMLElement>('body,body *')).some(
          (node) => {
            if (node.textContent?.trim() !== '登录') return false;
            const rect = node.getBoundingClientRect(),
              style = getComputedStyle(node);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== 'hidden' &&
              style.visibility !== 'collapse'
            );
          },
        );
        if (!login && names.includes(username)) return 'connected';
        return !login && names.length > 0 ? 'wrong' : 'pending';
      },
      {
        username,
        origin: fixture?.origin ?? 'https://mp.csdn.net',
        accountPath: fixture?.accountPath,
      },
    );
  } catch (error) {
    if (
      !page.isClosed() &&
      error instanceof Error &&
      /Execution context was destroyed|Cannot find context with specified id|Frame was detached/.test(
        error.message,
      )
    )
      return 'pending';
    throw error;
  }
}
