import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { analyzeWithProtectedHtml } from './markdown.js';
import { cardDocument, cardAtoms, escapeHTML, type CardTemplate } from './card-template.js';
import type { FormattingCard } from './formatting-contract.js';
type Input = {
  template: CardTemplate;
  title: string;
  subtitle: string;
  cards: FormattingCard[];
  markdown: string;
};
type Image = { data: string; sha256: string; width: number; height: number };
const browsers = new Set<Browser>();
let stopping = false;
let tail = Promise.resolve();
let waiting = 0;
export async function closeRenderers() {
  stopping = true;
  await Promise.allSettled([...browsers].map((browser) => browser.close()));
}
function font(file: string) {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw Error('renderer_unavailable');
  return readFileSync(file);
}
async function screenshot(page: Page): Promise<Image> {
  const fits = await page.evaluate(() => {
    const content = document.querySelector('.content')! as HTMLElement;
    const last = content.lastElementChild?.getBoundingClientRect();
    const box = content.getBoundingClientRect();
    return (
      (!last || last.bottom <= box.bottom + 1) &&
      Array.from(content.querySelectorAll('*')).every(
        (child) => child.getBoundingClientRect().bottom <= box.bottom + 1,
      )
    );
  });
  if (!fits) throw Error('card_overflow');
  const bytes = await page.screenshot({
    type: 'png',
    clip: { x: 0, y: 0, width: 1080, height: 1440 },
  });
  return {
    data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: 1080,
    height: 1440,
  };
}
function sentences(value: string): string[] {
  const parts = value.match(/[^。！？；\n]+[。！？；\n]*|[。！？；\n]+/gu) ?? [value];
  return parts.length > 1 ? parts : [value];
}
async function render(input: Input, signal: AbortSignal): Promise<Image[]> {
  if (stopping || signal.aborted) throw Error('render_cancelled');
  if (
    !['technical', 'checklist'].includes(input.template) ||
    typeof input.title !== 'string' ||
    input.title.length > 80 ||
    typeof input.subtitle !== 'string' ||
    input.subtitle.length > 160 ||
    !Array.isArray(input.cards) ||
    input.cards.length < 1 ||
    input.cards.length > 8
  )
    throw Error('unsupported_content');
  const codeBlocks = new Map(
    analyzeWithProtectedHtml(input.markdown)
      .filter((block) => block.kind === 'code')
      .map((block) => {
        const tree = fromMarkdown(block.markdown);
        const code = tree.children[0];
        return [block.id, code.type === 'code' ? code.value : ''];
      }),
  );
  const chinese = font(
    process.env.FORMATTER_FONT_FILE ?? '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  );
  const codeFont = font(
    process.env.FORMATTER_CODE_FONT_FILE ?? '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  );
  const browser = await chromium.launch({ headless: true });
  browsers.add(browser);
  const abort = () => {
    void browser.close().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (stopping || signal.aborted) throw Error('render_cancelled');
    const context = await browser.newContext({
      viewport: { width: 1080, height: 1440 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      if (route.request().url() === 'https://formatter.invalid/chinese')
        await route.fulfill({ status: 200, contentType: 'font/ttf', body: chinese });
      else if (route.request().url() === 'https://formatter.invalid/code')
        await route.fulfill({ status: 200, contentType: 'font/ttf', body: codeFont });
      else await route.abort();
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.setContent(cardDocument(input.template));
    await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load('36px PBChinese'),
        document.fonts.load('28px PBCode'),
      ]);
      await document.fonts.ready;
      if (!document.fonts.check('36px PBChinese') || !document.fonts.check('28px PBCode'))
        throw Error('font_unavailable');
    });
    const pages: string[] = [];
    for (const card of input.cards) {
      if (
        typeof card.title !== 'string' ||
        card.title.length > 100 ||
        !Array.isArray(card.paragraphs) ||
        card.paragraphs.length > 30 ||
        card.paragraphs.some((p) => typeof p !== 'string' || p.length > 4000) ||
        !Array.isArray(card.code_refs) ||
        card.code_refs.length > 3
      )
        throw Error('unsupported_content');
      const code = card.code_refs.map((ref) => {
        const value = codeBlocks.get(ref);
        if (value === undefined) throw Error('unsupported_content');
        return value;
      });
      const heading = '<h1>' + escapeHTML(card.title) + '</h1>';
      let current: string[] = [];
      const fits = async (atoms: string[]) =>
        page.evaluate(
          (html) => {
            const content = document.querySelector('.content')! as HTMLElement;
            content.innerHTML = html;
            const last = content.lastElementChild?.getBoundingClientRect();
            return !last || last.bottom <= content.getBoundingClientRect().bottom + 1;
          },
          heading + atoms.join(''),
        );
      const flush = () => {
        if (current.length) {
          pages.push(heading + current.join(''));
          current = [];
        }
        if (pages.length > 8) throw Error('too_many_cards');
      };
      const append = async (
        atom: { html: string; text?: string },
        canSplit = true,
      ): Promise<void> => {
        if (await fits([...current, atom.html])) {
          current.push(atom.html);
          return;
        }
        flush();
        if (await fits([atom.html])) {
          current.push(atom.html);
          return;
        }
        if (canSplit && atom.text !== undefined) {
          const text = atom.text;
          const parts = sentences(text);
          if (parts.length > 1) {
            for (const part of parts)
              await append({ html: '<p>' + escapeHTML(part) + '</p>', text: part }, false);
            return;
          }
        }
        throw Error('card_overflow');
      };
      for (const atom of cardAtoms({ ...card, code })) await append(atom);
      flush();
    }
    if (!pages.length) throw Error('unsupported_content');
    const images: Image[] = [];
    await page.locator('.content').evaluate(
      (element, html) => {
        element.innerHTML = html;
      },
      '<div class="cover"><h1>' +
        escapeHTML(input.title) +
        '</h1><p>' +
        escapeHTML(input.subtitle) +
        '</p></div>',
    );
    images.push(await screenshot(page));
    for (let index = 0; index < pages.length; index++) {
      if (signal.aborted) throw Error('render_cancelled');
      await page.locator('.content').evaluate((element, html) => {
        element.innerHTML = html;
      }, pages[index]);
      await page.locator('.footer').evaluate(
        (element, text) => {
          element.textContent = text;
        },
        String(index + 1) + ' / ' + pages.length,
      );
      images.push(await screenshot(page));
    }
    if (images.reduce((sum, image) => sum + image.data.length, 0) > 16 * 1024 * 1024)
      throw Error('too_many_cards');
    return images;
  } finally {
    signal.removeEventListener('abort', abort);
    browsers.delete(browser);
    await browser.close();
  }
}
export async function renderCards(input: Input, signal: AbortSignal): Promise<Image[]> {
  if (waiting >= 4) throw Error('renderer_busy');
  waiting++;
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    return await render(input, signal);
  } finally {
    waiting--;
    release();
  }
}
