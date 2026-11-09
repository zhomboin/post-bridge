import { describe, expect, it } from 'vitest';
import { readPreviewImage } from '../src/csdn-preview.js';

function png(width: number, height: number): Buffer {
  const body = Buffer.from('89504e470d0a1a0a0000000d4948445200000000000000000806000000', 'hex');
  body.writeUInt32BE(width, 16);
  body.writeUInt32BE(height, 20);
  return body;
}

const image = (body: Buffer, type = 'image/png') =>
  new Response(new Uint8Array(body), { headers: { 'content-type': type } });

describe('CSDN 预览图片读取限制', () => {
  it('允许声明类型与像素头均正确的 PNG/JPEG/WebP', async () => {
    const jpeg = Buffer.from('ffd8ffc000070800020003', 'hex');
    const webp = Buffer.from('524946461600000057454250565038580a00000000000000010000020000', 'hex');
    await expect(readPreviewImage(image(png(2, 3)))).resolves.toMatchObject({
      contentType: 'image/png',
    });
    await expect(readPreviewImage(image(jpeg, 'image/jpeg'))).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });
    await expect(readPreviewImage(image(webp, 'image/webp'))).resolves.toMatchObject({
      contentType: 'image/webp',
    });
  });
  it('拒绝超过像素上限、零尺寸、错误签名和非栅格类型', async () => {
    await expect(readPreviewImage(image(png(10001, 10000)))).rejects.toThrow();
    await expect(readPreviewImage(image(png(0, 2)))).rejects.toThrow();
    await expect(readPreviewImage(image(png(1, 1), 'image/jpeg'))).rejects.toThrow();
    await expect(readPreviewImage(image(png(1, 1), 'image/svg+xml'))).rejects.toThrow();
  });
  it('长度未知时仍截断超限的响应流', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(8)),
      cancel: () => {
        cancelled = true;
      },
    });
    await expect(
      readPreviewImage(new Response(stream, { headers: { 'content-type': 'image/png' } }), 10),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
