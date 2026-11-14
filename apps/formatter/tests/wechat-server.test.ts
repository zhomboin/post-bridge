import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createFormatterServer } from '../src/server.js';

const server = createFormatterServer({ token: 'test-token' });
let base: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('公众号转换服务', () => {
  it('要求认证并返回有来源映射的转换结果', async () => {
    const unauthorized = await fetch(`${base}/convert-wechat`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${base}/convert-wechat`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify({ markdown: '# 标题\n\n正文。' }),
    });
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output.blocks).toHaveLength(2);
    expect(output.blocks[0].source_block_id).toMatch(/^b0-/);
    expect(output.blocks[0].html).toBe('<h1>标题</h1>');
    expect(output.issues).toEqual([]);
  });
  it('安全保留 HTML 原文并拒绝超过上限的输入', async () => {
    const safe = await fetch(`${base}/convert-wechat`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify({ markdown: '<script>alert(1)</script>\n\n其余文章。' }),
    });
    expect(safe.status).toBe(200);
    const output = await safe.json();
    expect(output.blocks[0].html).toContain('&lt;script&gt;');
    expect(output.blocks[1].html).toContain('其余文章');
    for (const markdown of ['', 'a'.repeat(100001)]) {
      const response = await fetch(`${base}/convert-wechat`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
        body: JSON.stringify({ markdown }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ code: 'unsupported_content' });
    }
  });
  it('独立校验入口要求认证并标记内容差异', async () => {
    const markdown = '原始正文。';
    const converted = await fetch(`${base}/convert-wechat`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify({ markdown }),
    });
    const { blocks } = await converted.json();
    const payload = JSON.stringify({ markdown, blocks: [{ ...blocks[0], html: '<p>正文。</p>' }] });
    expect((await fetch(`${base}/validate-wechat`, { method: 'POST', body: payload })).status).toBe(
      401,
    );
    const checked = await fetch(`${base}/validate-wechat`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: payload,
    });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({
      issues: [{ block_id: blocks[0].source_block_id, code: 'content_review', blocking: true }],
    });
    const invalid = await fetch(`${base}/validate-wechat`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: JSON.stringify({ markdown, blocks: [] }),
    });
    expect(invalid.status).toBe(422);
  });
  it('转换与校验超时返回受控错误并保持服务可用', async () => {
    const limited = createFormatterServer({ token: 'test-token', wechatTimeoutMs: 1 });
    await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    try {
      for (const path of ['/convert-wechat', '/validate-wechat']) {
        const response = await fetch(url + path, {
          method: 'POST',
          headers: { Authorization: 'Bearer test-token' },
          body: JSON.stringify({ markdown: '合成正文。', blocks: [] }),
        });
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ code: 'renderer_unavailable' });
      }
      expect(
        (await fetch(url + '/healthz', { headers: { Authorization: 'Bearer test-token' } })).status,
      ).toBe(200);
    } finally {
      limited.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        limited.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('小红书分析保留 HTML 为受保护内容，CSDN 继续使用既有保护规则', async () => {
    const analyze = async (platform: string) =>
      fetch(`${base}/analyze`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
        body: JSON.stringify({ markdown: '<div>原始内容</div>\n\n后续段落。', platform }),
      });
    const xhs = await analyze('xiaohongshu');
    expect(xhs.status).toBe(200);
    const result = await xhs.json();
    expect(result.blocks[0].protected).toBe(true);
    expect(result.blocks[0].markdown).toContain('原始内容');
    expect(result.blocks[1].text).toBe('后续段落。');
    expect((await analyze('csdn')).status).toBe(422);
    expect((await analyze('unknown')).status).toBe(422);
  });
});
