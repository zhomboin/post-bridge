import type { Route } from 'playwright';

const maxBytes = 50 * 1024 * 1024;
const maxPixels = 100_000_000;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

type Size = [width: number, height: number];

function pngSize(body: Buffer): Size | undefined {
  if (body.length >= 24 && body.subarray(0, 8).equals(pngSignature) &&
      body.readUInt32BE(8) === 13 && body.toString('ascii', 12, 16) === 'IHDR') {
    return [body.readUInt32BE(16), body.readUInt32BE(20)];
  }
}

function jpegSize(body: Buffer): Size | undefined {
  if (body[0] !== 0xff || body[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < body.length && body[offset++] === 0xff) {
    while (body[offset] === 0xff) offset++;
    const marker = body[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > body.length) return undefined;
    const length = body.readUInt16BE(offset);
    if (length < 2 || offset + length > body.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 7) return undefined;
      return [body.readUInt16BE(offset + 5), body.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
}

function webpSize(body: Buffer): Size | undefined {
  if (body.length < 25 || body.toString('ascii', 0, 4) !== 'RIFF' || body.toString('ascii', 8, 12) !== 'WEBP') return undefined;
  const chunk = body.toString('ascii', 12, 16);
  const length = body.readUInt32LE(16);
  if (length + 20 > body.length) return undefined;
  if (chunk === 'VP8X' && length >= 10) return [body.readUIntLE(24, 3) + 1, body.readUIntLE(27, 3) + 1];
  if (chunk === 'VP8L' && length >= 5 && body[20] === 0x2f) {
    const packed = body.readUInt32LE(21);
    return [(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1];
  }
  if (chunk === 'VP8 ' && length >= 10 && body[23] === 0x9d && body[24] === 0x01 && body[25] === 0x2a) {
    return [body.readUInt16LE(26) & 0x3fff, body.readUInt16LE(28) & 0x3fff];
  }
}

const formats = new Map<string, (body: Buffer) => Size | undefined>([
  ['image/png', pngSize], ['image/jpeg', jpegSize], ['image/webp', webpSize],
]);

export async function readPreviewImage(response: Response, limit = maxBytes): Promise<{ contentType: string; body: Buffer }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('平台图片没有响应正文');
  try {
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    const format = formats.get(contentType);
    const advertisedLength = Number(response.headers.get('content-length'));
    if (response.status !== 200 || !format || !Number.isSafeInteger(advertisedLength) || advertisedLength < 0 || advertisedLength > limit) {
      throw new Error('平台图片响应不符合限制');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('平台图片超过下载限制');
      chunks.push(value);
    }
    const body = Buffer.concat(chunks, size);
    const dimensions = format(body);
    if (!dimensions || dimensions[0] === 0 || dimensions[1] === 0 || dimensions[0] * dimensions[1] > maxPixels) {
      throw new Error('平台图片像素不符合限制');
    }
    return { contentType, body };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function forwardPreviewImage(route: Route, copy: URL, timeout: number, signal: AbortSignal): Promise<void> {
  try {
    const response = await fetch(copy, {
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: { Accept: 'image/png,image/jpeg,image/webp', Referer: 'https://editor.csdn.net/' },
    });
    const { contentType, body } = await readPreviewImage(response);
    await route.fulfill({ status: 200, contentType, body, headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch {
    await route.abort('blockedbyclient').catch(() => {});
  }
}
