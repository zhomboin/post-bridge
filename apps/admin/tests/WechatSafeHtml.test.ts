import { describe, expect, it } from 'vitest';
import { safeWechatPreview } from '../src/wechat-safe-html';

describe('公众号预览与复制安全', () => {
  it('保留可读内容，移除可执行属性、外部图片和危险链接', () => {
    const result = safeWechatPreview(
      [
        {
          source_block_id: 'b0',
          html: '<script>alert(1)</script><img src="https://example.test/pixel.png" onerror="alert(1)"><a href="javascript:alert(1)">链接</a><p onclick="alert(1)" style="background:url(https://example.test/x)">正文</p>',
        },
      ],
      [],
    );
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.html).toContain('<span>[图片不可用]</span>');
    expect(result.html).toContain('<p>正文</p>');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('onerror');
    expect(result.html).not.toContain('onclick');
    expect(result.html).not.toContain('javascript:');
    expect(result.html).not.toContain('https://example.test');
    expect(result.text).toContain('正文');
  });
  it('仅允许本稿已关联的 PNG 和 JPEG 数据，保持原有内容顺序', () => {
    const image = { image_id: 'b0:0', data: 'YWJj', media_type: 'image/png', sha256: 'digest' };
    const result = safeWechatPreview(
      [
        {
          source_block_id: 'b0',
          html: '<h2>标题</h2><img src="data:image/png;base64,YWJj" alt="图片"><img src="data:image/png;base64,ZGVm" alt="未知"><p>末尾</p>',
        },
      ],
      [image],
    );
    expect(result.html).toContain('<img src="data:image/png;base64,YWJj" alt="图片">');
    expect(result.html).not.toContain('ZGVm');
    expect(result.html.indexOf('标题')).toBeLessThan(result.html.indexOf('末尾'));
    expect(result.text).toContain('标题');
    expect(result.text).toContain('末尾');
  });
  it('保留常见表格、代码和安全链接并隔离导航目标', () => {
    const result = safeWechatPreview(
      [
        {
          source_block_id: 'b0',
          html: '<a href="https://example.test/a?x=1&amp;y=2">文档</a><table><tbody><tr><td colspan="2">甲</td></tr></tbody></table><pre><code data-language="go">  x &lt; 1</code></pre>',
        },
      ],
      [],
    );
    expect(result.html).toContain('href="https://example.test/a?x=1&amp;y=2" target="_blank"');
    expect(result.html).toContain('<td colspan="2">甲</td>');
    expect(result.html).toContain('<code data-language="go">  x &lt; 1</code>');
  });
});
