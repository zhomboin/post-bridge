import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import IntegrationDocs from '../src/IntegrationDocs';

beforeEach(() => {
  window.history.replaceState({}, '', '/docs/integrations');
});

describe('接入文档阅读', () => {
  it('章节目录定位真实标题并关闭窄屏目录，重复标题有不同目标', () => {
    render(<IntegrationDocs markdown={'# 接入\n\n## 注册\n\n第一节\n\n## 注册\n\n第二节'} />);
    const toc = screen.getByRole('navigation', { name: '文档章节' });
    const links = within(toc).getAllByRole('link', { name: '注册' });
    expect(links[0].getAttribute('href')).not.toBe(links[1].getAttribute('href'));
    fireEvent.click(links[1]);
    expect(document.activeElement?.id).toBe((links[1] as HTMLAnchorElement).hash.slice(1));
    const details = document.querySelector('details')!;
    details.open = true;
    fireEvent.click(
      within(screen.getByRole('navigation', { name: '文档章节（窄屏）' })).getAllByRole('link')[0],
    );
    expect(details.open).toBe(false);
    expect(document.activeElement?.textContent).toBe('注册');
  });

  it('渲染现行文档表格，修正文档相对链接，下载契约和向量且源码安全外跳', () => {
    const { container } = render(<IntegrationDocs />);
    expect(screen.getAllByRole('table').length).toBeGreaterThan(5);
    expect(screen.getAllByRole('link', { name: 'OpenAPI 契约' })[0].getAttribute('download')).toBe(
      'cms.openapi.yaml',
    );
    expect(
      screen.getByRole('link', { name: '共享签名与内容指纹向量' }).getAttribute('download'),
    ).toBe('integration-contract.json');
    const source = screen.getByRole('link', { name: '签名实现' });
    expect(source.getAttribute('href')).toBe(
      'https://github.com/zhomboin/post-bridge/blob/main/apps/api/integration_signature.go',
    );
    expect(source.getAttribute('rel')).toBe('noopener noreferrer');
    expect(source.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('a[href^="../"]')).toBeNull();
    expect(
      screen
        .getAllByRole('region', { name: '接入参数表' })
        .every((region) => region.tabIndex === 0),
    ).toBe(true);
  });

  it('不执行原始 HTML，不加载图片，也不提供危险或未知相对链接', () => {
    const markdown =
      '# 安全阅读\n\n<script>alert(1)</script>\n\n![图片](https://example.invalid/private.png)\n\n[危险](javascript:alert%281%29)\n\n[文件](file:///private)\n\n[未知](../private.md)\n\n[外链](https://example.invalid/docs)';
    const { container } = render(<IntegrationDocs markdown={markdown} />);
    expect(container.querySelector('script,img,iframe')).toBeNull();
    expect(screen.queryByRole('link', { name: '危险' })).toBeNull();
    expect(screen.queryByRole('link', { name: '文件' })).toBeNull();
    expect(screen.queryByRole('link', { name: '未知' })).toBeNull();
    expect(screen.getByRole('link', { name: '外链' }).getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
  });
});

it('刷新带章节地址的文档时定位原章节', () => {
  window.history.replaceState({}, '', '/docs/integrations#section-7');
  render(<IntegrationDocs markdown={'# 接入\n\n## 注册\n\n内容\n\n## 签名'} />);
  expect(document.activeElement?.id).toBe('section-7');
});
