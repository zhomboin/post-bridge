import type { Page, Route } from 'playwright';
import { contentImages, type ImageDestination } from './config.js';

export const copiedImageOrigin = 'https://i-blog.csdnimg.cn';

export function approvedImages(title: string, markdown: string, sources: string[]): ImageDestination[] | undefined {
  const images = contentImages(title, markdown);
  if (!images || !Array.isArray(sources) || images.length > 20 || sources.length > 10) return undefined;
  const unique = new Set(images.map(image => image.url));
  return unique.size === sources.length && sources.every(url => unique.delete(url)) ? images : undefined;
}

export function copiedImageURL(value: unknown, origin: string, preview = false): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\s()[\]\\<>"]|%(?:5c|0d|0a|09)/i.test(value) ||
      value.includes('#') || (!preview && value.includes('?'))) return undefined;
  try {
    const url = new URL(value);
    if (url.origin === origin && url.href === value && !url.username && !url.password && url.pathname !== '/' && !url.hash) return url;
  } catch { /* 返回值不是已知的 CSDN 图片链接。 */ }
  return undefined;
}

export function replaceDestinations(markdown: string, images: ImageDestination[], copies: ReadonlyMap<string, string>): string {
  let result = markdown;
  for (const image of images.slice().reverse()) {
    result = result.slice(0, image.start) + copies.get(image.url)! + result.slice(image.end);
  }
  return result;
}

export function richMarkdown(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

export function frozenCopies(title: string, original: string, frozen: string, sources: ImageDestination[], copyOrigin: string): Map<string, string> | undefined {
  const images = contentImages(title, frozen, copyOrigin);
  if (!images || images.length !== sources.length) return undefined;
  const approved = new Set(sources.map(image => image.url));
  const copies = new Map<string, string>();
  for (const [index, image] of images.entries()) {
    const source = sources[index].url;
    const previous = copies.get(source);
    if (!copiedImageURL(image.url, copyOrigin) || approved.has(image.url) || (previous && previous !== image.url)) return undefined;
    copies.set(source, image.url);
  }
  if (richMarkdown(replaceDestinations(original, sources, copies)) !== richMarkdown(frozen)) return undefined;
  return copies;
}

export function imagePreviewPath(value: string): string {
  const url = new URL(value);
  return url.origin + url.pathname;
}

export async function waitForImagePreviews(page: Page, urls: string[], timeout: number): Promise<void> {
  const paths = urls.map(imagePreviewPath);
  const preview = await page.waitForFunction(expected => {
    const pending = [...expected];
    const matches: HTMLImageElement[] = [];
    for (const image of document.images) {
      if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0 || !image.currentSrc) continue;
      const url = new URL(image.currentSrc);
      const index = pending.indexOf(url.origin + url.pathname);
      if (index === -1) continue;
      matches.push(image);
      pending.splice(index, 1);
    }
    return pending.length === 0 && matches;
  }, paths, { timeout });
  try {
    const decoded = await preview.evaluate(async matches => {
      if (!Array.isArray(matches)) return false;
      const results = await Promise.all(matches.map(async image => {
        const source = image.currentSrc;
        try { await image.decode(); } catch { return false; }
        return image.isConnected && image.currentSrc === source;
      }));
      return results.every(Boolean);
    });
    if (!decoded) throw new Error('平台图片无法解码');
  } finally { await preview.dispose(); }
}

// Playwright's normal continuation may follow a redirect without another route callback.
export async function forwardWithoutRedirect(route: Route, timeout: number, observe?: (body: string) => void): Promise<void> {
  try {
    const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout });
    try {
      if (response.status() >= 300 && response.status() < 400) throw new Error('平台端点重定向');
      if (observe) {
        const length = response.headers()['content-length'];
        if (response.status() !== 200 || (length && Number(length) > 8192)) throw new Error('图片转存响应无效');
        const body = await response.text();
        if (body.length > 8192) throw new Error('图片转存响应过长');
        observe(body);
      }
      // route.fetch is outside the browser fetch, so redirects must be handled above.
      await route.fulfill({ response });
    } finally { await response.dispose(); }
  } catch {
    await route.abort('blockedbyclient').catch(() => {});
  }
}
