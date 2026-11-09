import type { BrowserContext, Page } from 'playwright';
import type { NoteBody } from './types.js';
import { xhsImageURL, xhsObject, xhsText } from './xiaohongshu-insights.js';

export function noteBodyPayload(value: unknown, id: string, userID: string): NoteBody {
  const note = xhsObject(value);
  if (note.noteId !== id || xhsObject(note.user).userId !== userID) throw Error('account_mismatch');
  if (typeof note.desc !== 'string') throw Error('adapter_mismatch');
  const images = note.imageList;
  const tags = note.tagList ?? [];
  if (!Array.isArray(images) || images.length > 50 || !Array.isArray(tags) || tags.length > 100)
    throw Error('adapter_mismatch');
  return {
    id,
    user_id: userID,
    title: xhsText(note.title, 2000),
    text: xhsText(note.desc, 200000),
    images: images.map((raw) => xhsImageURL(xhsObject(raw).urlDefault)).filter(Boolean),
    tags: tags.map((raw) => xhsText(xhsObject(raw).name, 200)).filter(Boolean),
  };
}

// 只点击官方卡片的封面查看入口，不进入编辑器，也不拼接带签名的读取请求。
export async function readNativeNote(
  context: BrowserContext,
  page: Page,
  index: number,
  count: number,
  id: string,
  title: string,
  userID: string,
  signal: AbortSignal,
): Promise<NoteBody> {
  const cards = page.locator('.note-card').filter({ has: page.locator('.note-card__cover') });
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('.note-card')].filter((card) =>
        card.querySelector('.note-card__cover'),
      ).length === expected,
    count,
    { timeout: 10000 },
  );
  if ((await cards.count()) !== count) throw Error('adapter_mismatch');
  const card = cards.nth(index);
  if ((await card.locator('.note-card__title').innerText()).trim() !== title)
    throw Error('adapter_mismatch');
  const popup = context.waitForEvent('page', { timeout: 15000 });
  void popup.catch(() => {});
  await card.locator('.note-card__cover').click({ timeout: 15000 });
  const detail = await popup;
  try {
    await detail.waitForURL(
      (url) => url.origin === 'https://www.xiaohongshu.com' && url.pathname === '/explore/' + id,
      { timeout: 20000 },
    );
    await detail.waitForLoadState('domcontentloaded');
    signal.throwIfAborted();
    // 页面初始数据与原生详情页一致；未知结构停止，不以列表摘要冒充正文。
    const raw = await detail.evaluate((noteID) => {
      const state = (
        window as unknown as {
          __INITIAL_STATE__?: { note?: { noteDetailMap?: Record<string, { note?: unknown }> } };
        }
      ).__INITIAL_STATE__;
      return state?.note?.noteDetailMap?.[noteID]?.note;
    }, id);
    return noteBodyPayload(raw, id, userID);
  } finally {
    await detail.close();
  }
}
