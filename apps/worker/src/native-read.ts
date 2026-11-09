import type { Locator, Page, Request } from 'playwright';

let markerSequence = 0;
// 使用浏览器时钟区分原生点击前后的请求；响应再绑定到该请求实例。
export async function nativeReadRequest(
  page: Page,
  target: Locator,
  matches: (request: Request) => boolean,
  timeout: number,
): Promise<Request> {
  const marker = `__postBridgeReadClick${++markerSequence}`;
  await target.evaluate((element, key) => {
    (window as unknown as Record<string, unknown>)[key] = null;
    element.addEventListener(
      'click',
      () => {
        (window as unknown as Record<string, unknown>)[key] =
          performance.timeOrigin + performance.now();
      },
      { capture: true, once: true },
    );
  }, marker);
  try {
    const pending = page.waitForRequest(
      async (request) => {
        if (!matches(request)) return false;
        try {
          // Playwright 在响应头到达后才提供请求起始时间。
          if (!(await request.response())) return false;
          const clickedAt = await page.evaluate(
            (key) => (window as unknown as Record<string, unknown>)[key],
            marker,
          );
          return typeof clickedAt === 'number' && request.timing().startTime >= clickedAt;
        } catch {
          return false;
        }
      },
      { timeout },
    );
    const [request] = await Promise.all([pending, target.click()]);
    return request;
  } finally {
    await page
      .evaluate((key) => {
        delete (window as unknown as Record<string, unknown>)[key];
      }, marker)
      .catch(() => {});
  }
}
