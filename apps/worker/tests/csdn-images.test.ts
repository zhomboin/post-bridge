import { describe, expect, it, vi } from 'vitest';
import { approvedImages } from '../src/csdn-images.js';
import { verifyImageSourceDNS } from '../src/csdn-image-dns.js';

const source = 'https://public-album.example.test/photos/image.png';
const verify = (resolver: Parameters<typeof verifyImageSourceDNS>[2]) => verifyImageSourceDNS([source], new AbortController().signal, resolver);
const noData = () => Promise.reject(Object.assign(new Error(), { code: 'ENODATA' }));

describe('已批准的相册图源 DNS 检查', () => {
  it('同时检查 A 和 AAAA，只解析一次相同的域名', async () => {
    const resolver = { resolve4: vi.fn(async () => ['1.1.1.1']), resolve6: vi.fn(async () => ['2606:4700:4700::1111']), cancel: vi.fn() };
    await expect(verifyImageSourceDNS([source, source + '2'], new AbortController().signal, resolver)).resolves.toBeUndefined();
    expect(resolver.resolve4).toHaveBeenCalledExactlyOnceWith('public-album.example.test');
    expect(resolver.resolve6).toHaveBeenCalledExactlyOnceWith('public-album.example.test');
  });
  it('允许仅一个地址族提供公网地址', async () => {
    const resolver = { resolve4: async () => ['1.1.1.1'], resolve6: noData, cancel: vi.fn() };
    await expect(verify(resolver)).resolves.toBeUndefined();
  });
  it.each(['0.0.0.0', '10.1.2.3', '100.64.0.2', '127.0.0.1', '169.254.1.1', '192.0.2.1', '224.0.0.1', '240.0.0.1', '::1', '::ffff:192.168.1.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:ac10::1'])('拒绝夹带非公网地址的解析结果 %s', async address => {
    const resolver = { resolve4: async () => address.includes(':') ? ['1.1.1.1'] : ['1.1.1.1', address], resolve6: async () => address.includes(':') ? [address] : [], cancel: vi.fn() };
    await expect(verify(resolver)).rejects.toThrow();
  });
  it('无地址或某一地址族 DNS 查询超时时停止', async () => {
    await expect(verify({ resolve4: noData, resolve6: noData, cancel: vi.fn() })).rejects.toThrow();
    await expect(verify({ resolve4: async () => ['1.1.1.1'], resolve6: async () => { throw new Error('timeout'); }, cancel: vi.fn() })).rejects.toThrow();
  });
});

describe('受控 Markdown 图片位置', () => {
  const image = '![照片](' + source + ')';
  const title = '公开相册图片文章';
  it('在独立图片和普通链接指向同一图源时只识别图片', () => {
    const markdown = '[普通链接](' + source + ')\n\n' + image;
    expect(approvedImages(title, markdown, [source])).toEqual([{ url: source, start: markdown.lastIndexOf(source), end: markdown.lastIndexOf(source) + source.length }]);
  });
  it.each([
    '[链接](https://outside.example/a/' + image + ')',
    '[链接](https://outside.example/a(b)/' + image + ')',
    '[' + image + '](https://outside.example/)',
    String.fromCharCode(96) + image + String.fromCharCode(96),
  ])('拒绝隐藏在其它 Markdown 构造中的图片 %s', markdown => {
    expect(approvedImages(title, markdown, [source])).toBeUndefined();
  });
});
