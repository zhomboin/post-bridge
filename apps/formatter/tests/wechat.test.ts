import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertWechat } from '../src/wechat.js';
import { validateWechat } from '../src/wechat-validate.js';

describe('公众号本地转换', () => {
  it('保持顺序、列表层级、链接、表格和代码原文', () => {
    const result = convertWechat(
      '# 标题\n\n1. 第一\n   - 子项\n\n[链接](https://example.test/a?x=1&y=2)\n\n| 列 | 值 |\n| --- | --- |\n| 甲 | 10 |\n\n```js\n  a < b && c\n```',
    );
    const html = result.blocks.map((block) => block.html).join('');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<ol><li>');
    expect(html).toContain('<ul><li>');
    expect(html).toContain('href="https://example.test/a?x=1&amp;y=2"');
    expect(html).toContain('<thead><tr><th>列</th><th>值</th></tr></thead>');
    expect(html).toContain('<td>甲</td><td>10</td>');
    expect(html).toContain('<pre><code data-language="js">  a &lt; b &amp;&amp; c</code></pre>');
    expect(result.issues).toEqual([]);
  });
  it('阻止危险链接和外部图片，定位公式与扩展问题', () => {
    const result = convertWechat(
      '[危险](javascript:alert(1))\n\n![替代](https://example.test/a.png)\n\n公式 $a+b$\n\n:::custom\n内容\n:::',
    );
    const html = result.blocks.map((block) => block.html).join('');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('图片：替代');
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'unsupported_link',
      'image_unavailable',
      'formula_review',
      'unsupported_extension',
    ]);
    expect(
      result.issues.every(
        (issue) =>
          issue.blocking && result.blocks.some((block) => block.source_block_id === issue.block_id),
      ),
    ).toBe(true);
  });
  it('保留引用链接并安全处理原始 HTML', () => {
    const result = convertWechat('[说明][ref]\n\n[ref]: https://example.test/path');
    expect(result.blocks[0].html).toContain('href="https://example.test/path"');
    const html = convertWechat('<script>alert(1)</script>');
    expect(html.blocks[0].html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.blocks[0].html).not.toContain('<script>');
    expect(html.issues[0].code).toBe('html_review');
  });
  it('转换安全 HTML 并保留不可转换的部分，同时继续处理其他段落', () => {
    const result = convertWechat(
      '<div><h2>标题</h2><p>正文 <strong>重点</strong></p><a href="https://example.test/">链接</a><img src="https://example.test/a.png" alt="示例"></div>\n\n普通 Markdown 段落。\n\n<div onclick="alert(1)">其他内容</div>',
    );
    const html = result.blocks.map((block) => block.html).join('');
    expect(html).toContain('<h2>标题</h2>');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('href="https://example.test/"');
    expect(html).toContain('图片：示例');
    expect(html).toContain('普通 Markdown 段落');
    expect(html).toContain('其他内容');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<img');
    expect(result.issues.map((issue) => issue.code)).toContain('image_unavailable');
    expect(result.issues.map((issue) => issue.code)).toContain('html_attributes_review');
  });
  it('保留不完整的行内 HTML 原文，不误改上下文', () => {
    const result = convertWechat('前文 <b>重点</b> 后文。\n\n后续段落。');
    expect(result.blocks[0].html).toContain('前文 &lt;b&gt;重点&lt;/b&gt; 后文。');
    expect(result.blocks[1].html).toContain('后续段落');
    expect(result.issues[0].code).toBe('html_review');
  });
  it('保留 HTML 有序列表起点和表格合并关系', () => {
    const result = convertWechat(
      '<div><ol start="3"><li>第三项</li></ol><table><tr><td colspan="2">合并</td></tr></table></div>',
    );
    expect(result.blocks[0].html).toContain('<ol start="3"><li>第三项</li></ol>');
    expect(result.blocks[0].html).toContain('<td colspan="2">合并</td>');
    expect(result.issues).toEqual([]);
  });
  it('按原稿顺序映射 Markdown、引用和 HTML 图片，不请求原图', () => {
    const result = convertWechat(
      '![甲](https://example.test/a.png)\n\n![乙][b]\n\n[b]: https://example.test/b.png\n\n<div><img src="https://example.test/c.png" alt="丙"></div>',
    );
    expect(result.images.map(({ source, alt }) => [source, alt])).toEqual([
      ['https://example.test/a.png', '甲'],
      ['https://example.test/b.png', '乙'],
      ['https://example.test/c.png', '丙'],
    ]);
    expect(new Set(result.images.map((image) => image.id)).size).toBe(3);
    for (const image of result.images) {
      const block = result.blocks.find((item) => item.source_block_id === image.source_block_id);
      expect(block?.html).toContain(`data-wechat-image="${image.id}"`);
    }
  });
  it('无法转换的 HTML 按原文保留，不改变属性或字符实体', () => {
    const result = convertWechat('<div><CUSTOM data-X="A">&amp; 示例</CUSTOM></div>');
    expect(result.blocks[0].html).toContain(
      '&lt;CUSTOM data-X=&quot;A&quot;&gt;&amp;amp; 示例&lt;/CUSTOM&gt;',
    );
    expect(result.issues.map((issue) => issue.code)).toContain('html_review');
  });
  it('为全部多类型合成样稿建立有序来源映射，并对图片和公式提示', () => {
    const samples = JSON.parse(
      readFileSync(
        new URL('../../../tests/fixtures/platform-formatting/samples.json', import.meta.url),
        'utf8',
      ),
    ) as { id: string; markdown: string }[];
    expect(samples).toHaveLength(13);
    for (const sample of samples) {
      const result = convertWechat(sample.markdown);
      expect(result.blocks.length, sample.id).toBeGreaterThan(0);
      expect(new Set(result.blocks.map((block) => block.source_block_id)).size, sample.id).toBe(
        result.blocks.length,
      );
      expect(validateWechat(sample.markdown, result.blocks), sample.id).not.toContainEqual(
        expect.objectContaining({ blocking: true }),
      );
      expect(
        result.issues.every((issue) => issue.blocking),
        sample.id,
      ).toBe(true);
      if (sample.id === 'images')
        expect(result.issues.some((issue) => issue.code === 'image_unavailable')).toBe(true);
      if (sample.id === 'structure')
        expect(result.issues.some((issue) => issue.code === 'formula_review')).toBe(true);
    }
  });
  it('在多类型样稿中保留关键条件、代码、表格与图片位置', () => {
    const samples = JSON.parse(
      readFileSync(
        new URL('../../../tests/fixtures/platform-formatting/samples.json', import.meta.url),
        'utf8',
      ),
    ) as { id: string; markdown: string }[];
    const htmlOf = (id: string) => {
      const sample = samples.find((entry) => entry.id === id);
      if (!sample) throw Error(`缺少合成样稿：${id}`);
      return convertWechat(sample.markdown)
        .blocks.map((block) => block.html)
        .join('');
    };
    const tutorial = htmlOf('tutorial');
    expect(tutorial).toContain('只有在获得授权时才继续');
    expect(tutorial).toContain('如有错误，停止处理');
    expect(tutorial.indexOf('检查输入')).toBeLessThan(tutorial.indexOf('核对结果'));
    const code = htmlOf('code');
    expect(code).toContain('    println(&quot;a  b&quot;)');
    expect(code).toContain('&lt;标签&gt; &amp; 引号');
    const comparison = htmlOf('comparison');
    expect(comparison).toContain('<td>甲</td><td>步骤少</td><td>单项</td>');
    expect(comparison).toContain('<td>乙</td><td>支持多项</td><td>额外核对</td>');
    const images = htmlOf('images');
    expect(images.indexOf('图片：蓝色方形')).toBeLessThan(images.indexOf('图片：橙色横图'));
    expect(images).not.toContain('<img');
  });
});
