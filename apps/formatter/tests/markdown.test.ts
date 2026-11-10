import { describe, expect, it } from 'vitest';
import { analyze, validateCSDN } from '../src/markdown.js';
describe('CSDN 内容保护', () => {
  it('整理标题和加粗时保留所有代码及链接', () => {
    const source =
      '# 标题\n\n正文包含 [文档](https://example.test/doc)。\n\n~~~go\nimport "fmt"\n\nfmt.Println("{}");\n~~~';
    const blocks = analyze(source);
    const changed = blocks.map((block) => ({ id: block.id, markdown: block.markdown }));
    changed[0].markdown = '## 标题';
    changed[1].markdown = '**正文**包含 [文档](https://example.test/doc)。';
    expect(validateCSDN(blocks, changed)).toContain('fmt.Println("{}");');
  });
  it('拒绝增删事实、修改代码和链接目标', () => {
    const blocks = analyze('正文事实。\n\n`command` [链接](https://example.test)');
    expect(() =>
      validateCSDN(
        blocks,
        blocks.map((b) => ({ id: b.id, markdown: b.markdown + '新增结论' })),
      ),
    ).toThrow();
    expect(() =>
      validateCSDN(blocks, [{ id: blocks[0].id, markdown: blocks[0].markdown }]),
    ).toThrow();
    expect(() =>
      validateCSDN(
        blocks,
        blocks.map((b) => ({
          id: b.id,
          markdown: b.markdown.replace('https://example.test', 'https://other.test'),
        })),
      ),
    ).toThrow();
  });
  it('保留英文单词边界，允许中文换行', () => {
    const blocks = analyze('foo bar 中文段落');
    expect(() =>
      validateCSDN(blocks, [{ id: blocks[0].id, markdown: 'foobar 中文段落' }]),
    ).toThrow();
    expect(validateCSDN(blocks, [{ id: blocks[0].id, markdown: 'foo bar 中文\n段落' }])).toContain(
      '段落',
    );
  });
  it('保留列表项和列表内段落的英文边界', () => {
    for (const source of ['- foo\n- bar', '- foo\n\n  bar']) {
      const blocks = analyze(source);
      expect(
        validateCSDN(
          blocks,
          blocks.map(({ id, markdown }) => ({ id, markdown })),
        ),
      ).toBe(source);
      expect(() => validateCSDN(blocks, [{ id: blocks[0].id, markdown: '- foobar' }])).toThrow(
        'content_changed',
      );
      expect(validateCSDN(blocks, [{ id: blocks[0].id, markdown: '- **foo**\n- bar' }])).toContain(
        '**foo**',
      );
    }
  });
  it('拒绝 HTML；完整保护表格、图片和公式', () => {
    expect(() => analyze('<script>bad()</script>')).toThrow();
    for (const body of [
      '![图](https://example.test/image.png)',
      '|甲|乙|\n|-|-|\n|1|2|',
      '$a=b$',
    ]) {
      expect(analyze(body)[0].protected).toBe(true);
    }
  });
});
