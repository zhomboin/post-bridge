import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import document from '../../../docs/external-integration.md?raw';
import contractUrl from '../../../contracts/cms.openapi.yaml?url';
import vectorsUrl from '../../../tests/fixtures/integration-contract.json?url';
import { RouteLink } from './runtime';
import './IntegrationDocs.css';

const repository = 'https://github.com/zhomboin/post-bridge/blob/main/';
const downloads: Record<string, { href: string; name: string }> = {
  '../contracts/cms.openapi.yaml': { href: contractUrl, name: 'cms.openapi.yaml' },
  '../tests/fixtures/integration-contract.json': { href: vectorsUrl, name: 'integration-contract.json' },
};

export default function IntegrationDocs({ markdown = document }: { markdown?: string }) {
  const article = useRef<HTMLElement>(null);
  const mobileContents = useRef<HTMLDetailsElement>(null);
  const sections = markdown.split(/\r?\n/).flatMap((line, index) =>
    line.startsWith('## ') ? [{ title: line.slice(3), line: index + 1, id: 'section-' + (index + 1) }] : []);
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const heading = /^section-\d+$/.test(id) ? article.current?.querySelector<HTMLElement>('#' + id) : null;
    (heading || article.current?.querySelector('h1'))?.focus();
  }, []);

  function chapter(id: string) {
    if (mobileContents.current) mobileContents.current.open = false;
    const heading = article.current?.querySelector<HTMLElement>('#' + id);
    heading?.focus();
  }
  function contents(label: string) {
    return <nav aria-label={label}><ol>{sections.map(section => <li key={section.id}>
      <a href={'#' + section.id} onClick={() => chapter(section.id)}>{section.title}</a>
    </li>)}</ol></nav>;
  }
  return <div className="page integration-docs">
    <div className="docs-toolbar">
      <RouteLink className="back-link" href="/integrations">返回内容来源</RouteLink>
      <div className="docs-downloads">
        <a className="button" href={contractUrl} download="cms.openapi.yaml">OpenAPI</a>
        <a className="button" href={vectorsUrl} download="integration-contract.json">测试向量</a>
      </div>
    </div>
    <div className="docs-layout">
      <aside className="docs-contents">
        <div className="docs-desktop-contents"><h2>章节目录</h2>{contents('文档章节')}</div>
        <details className="docs-mobile-contents" ref={mobileContents}><summary>章节目录</summary>{contents('文档章节（窄屏）')}</details>
      </aside>
      <article ref={article} className="docs-article" aria-label="外部系统接入文档">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']} components={{
          h1: ({ children }) => <h1 tabIndex={-1}>{children}</h1>,
          h2: ({ children, node }) => <h2 id={'section-' + node?.position?.start.line} tabIndex={-1}>{children}</h2>,
          table: ({ children }) => <div className="docs-table" role="region" aria-label="接入参数表" tabIndex={0}><table>{children}</table></div>,
          a: ({ href = '', children }) => {
            const download = downloads[href];
            if (download) return <a href={download.href} download={download.name}>{children}</a>;
            if (/^\.\.\/apps\/api\/[a-z_]+\.go$/.test(href)) return <a href={repository + href.slice(3)} target="_blank" rel="noopener noreferrer">{children}</a>;
            if (href.startsWith('https://')) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
            if (href.startsWith('#')) return <a href={href}>{children}</a>;
            return <span>{children}</span>;
          },
        }}>{markdown}</ReactMarkdown>
      </article>
    </div>
  </div>;
}
