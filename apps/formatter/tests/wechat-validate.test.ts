import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertWechat } from '../src/wechat.js';
import { validateWechat } from '../src/wechat-validate.js';

describe('公众号内容独立校验', () => {
  it('检查不同类型的合成样稿，保留来源块顺序', () => {
    const samples = JSON.parse(
      readFileSync(
        new URL('../../../tests/fixtures/platform-formatting/samples.json', import.meta.url),
        'utf8',
      ),
    ) as { id: string; markdown: string }[];
    for (const sample of samples) {
      const output = convertWechat(sample.markdown);
      expect(
        validateWechat(sample.markdown, output.blocks).filter((issue) => issue.blocking),
        sample.id,
      ).toEqual([]);
    }
  });
  it('无法核对的 HTML 保留结果并提示人工查看', () => {
    const markdown = '<custom>内容</custom>';
    const output = convertWechat(markdown);
    expect(validateWechat(markdown, output.blocks)).toEqual([
      {
        block_id: output.blocks[0].source_block_id,
        code: 'verification_incomplete',
        blocking: false,
      },
    ]);
  });
  it('独立核对 HTML 正文、代码、链接和图片占位', () => {
    const markdown =
      '<div><p>关键条件</p><pre><code>const x = 1;</code></pre><a href="https://example.test/a">资料</a><img src="https://example.test/a.png" alt="图甲"></div>';
    const blocks = convertWechat(markdown).blocks;
    expect(validateWechat(markdown, blocks)).toEqual([]);
    for (const [before, after] of [
      ['关键条件', '条件'],
      ['const x = 1;', 'const x = 2;'],
      ['https://example.test/a"', 'https://example.test/b"'],
      ['图片：图甲', '图片：图乙'],
    ]) {
      const tampered = [{ ...blocks[0], html: blocks[0].html.replace(before, after) }];
      expect(validateWechat(markdown, tampered)[0]?.code, before).toBe('content_review');
    }
  });
  it('标出丢失文字、修改代码或链接的块', () => {
    const markdown =
      '关键条件不能遗漏。\n\n```js\nconst x = 1;\n```\n\n[资料](https://example.test/a)';
    const output = convertWechat(markdown);
    output.blocks[0].html = '<p>关键条件。</p>';
    output.blocks[1].html = '<pre><code>const x = 2;</code></pre>';
    output.blocks[2].html = '<p><a href="https://example.test/b">资料</a></p>';
    expect(validateWechat(markdown, output.blocks)).toEqual(
      output.blocks.map((block) => ({
        block_id: block.source_block_id,
        code: 'content_review',
        blocking: true,
      })),
    );
  });
  it('拒绝缺失、调换和伪造来源块', () => {
    const markdown = '第一段。\n\n第二段。';
    const blocks = convertWechat(markdown).blocks;
    expect(() => validateWechat(markdown, blocks.slice(1))).toThrow('content_changed');
    expect(() => validateWechat(markdown, [...blocks].reverse())).toThrow('content_changed');
    expect(() =>
      validateWechat(markdown, [{ ...blocks[0], source_block_id: 'fake' }, blocks[1]]),
    ).toThrow('content_changed');
  });
  it('检测图片占位丢失或替代文字变化', () => {
    const markdown = '![甲](https://example.test/a.png) 和 ![乙](https://example.test/b.png)';
    const blocks = convertWechat(markdown).blocks;
    blocks[0].html = blocks[0].html.replace('图片：甲', '图片：其他');
    expect(validateWechat(markdown, blocks)[0].code).toBe('content_review');
  });
});
