import type { ContentIdentity, ContentItem, ContentSnapshot } from './content-contract.js';

export interface ContentSourcePage {
  identity: ContentIdentity;
  items: ContentItem[];
  next_cursor: string | null;
  complete: boolean;
  total?: number;
}

// 平台负责取得下一页，公共采集器负责身份、容量、重复和完整性。
export async function collectContents(
  identity: ContentIdentity,
  readPage: (cursor: string | null, signal: AbortSignal) => Promise<ContentSourcePage>,
  signal: AbortSignal,
): Promise<ContentSnapshot> {
  const items: ContentItem[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let total: number | undefined;
  let bytes = 0;
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted();
    const result = await readPage(cursor, signal);
    signal.throwIfAborted();
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (
      result.identity.username !== identity.username ||
      result.identity.user_id !== identity.user_id
    )
      throw Error('account_mismatch');
    if (
      bytes > 6 * 1024 * 1024 ||
      !Array.isArray(result.items) ||
      typeof result.complete !== 'boolean'
    )
      throw Error('adapter_mismatch');
    if (result.total !== undefined) {
      if (
        !Number.isSafeInteger(result.total) ||
        result.total < 0 ||
        result.total > 2000 ||
        (total !== undefined && total !== result.total)
      )
        throw Error('adapter_mismatch');
      total = result.total;
    }
    for (const item of result.items) {
      if (!item.id || ids.has(item.id) || items.length >= 2000) throw Error('adapter_mismatch');
      ids.add(item.id);
      items.push(item);
    }
    if (result.complete) {
      if (result.next_cursor !== null || (total !== undefined && total !== items.length))
        throw Error('adapter_mismatch');
      return { identity, items, scope: 'all', complete: true, extensions: {} };
    }
    if (
      typeof result.next_cursor !== 'string' ||
      !result.next_cursor ||
      result.next_cursor.length > 4096 ||
      cursors.has(result.next_cursor) ||
      !result.items.length
    )
      throw Error('adapter_mismatch');
    cursor = result.next_cursor;
    cursors.add(cursor);
  }
  throw Error('adapter_mismatch');
}
