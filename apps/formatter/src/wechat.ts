import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { analyzeWithProtectedHtml } from './markdown.js';
import {
  convertWechatHtml,
  escapeWechat as escape,
  safeWechatLink,
  wechatHtmlImages,
} from './wechat-html.js';

type Node = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  identifier?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  lang?: string | null;
  meta?: string | null;
  children?: Node[];
};
type Issue = { block_id: string; code: string; blocking: boolean };
export type WechatBlock = { source_block_id: string; html: string };
export type WechatImage = { id: string; source_block_id: string; source: string; alt: string };
export type WechatConversion = { blocks: WechatBlock[]; issues: Issue[]; images: WechatImage[] };

const identifier = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// 未批准的图片只显示占位符，不产生外部资源请求。
export function convertWechat(markdown: string): WechatConversion {
  const source = analyzeWithProtectedHtml(markdown);
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Node;
  const definitions = new Map<string, string>();
  for (const node of tree.children ?? []) {
    if (node.type === 'definition' && node.identifier && node.url)
      definitions.set(identifier(node.identifier), node.url);
  }
  const issues: Issue[] = [];
  const result: WechatBlock[] = [];
  const images: WechatImage[] = [];
  for (const [index, node] of (tree.children ?? []).entries()) {
    const block = source[index];
    let imageIndex = 0;
    const collectImages = (item: Node) => {
      const append = (image: { source: string; alt: string }) => {
        images.push({ id: `${block.id}:${imageIndex++}`, source_block_id: block.id, ...image });
      };
      if (item.type === 'image') append({ source: item.url ?? '', alt: item.alt ?? '' });
      if (item.type === 'imageReference')
        append({
          source: definitions.get(identifier(item.identifier ?? '')) ?? '',
          alt: item.alt ?? '',
        });
      if (item.type === 'html')
        for (const image of wechatHtmlImages(item.value ?? '')) append(image);
      for (const child of item.children ?? []) collectImages(child);
    };
    collectImages(node);
    let renderedImageIndex = 0;
    const imagePlaceholder = (alt: string) =>
      `<span data-wechat-image="${block.id}:${renderedImageIndex++}">[图片：${escape(alt)}]</span>`;
    const blockIssues = new Set<string>();
    const report = (code: string) => {
      if (blockIssues.has(code)) return;
      blockIssues.add(code);
      issues.push({ block_id: block.id, code, blocking: true });
    };
    const link = (url: string | undefined, body: string) => {
      if (safeWechatLink(url)) {
        return `<a href="${escape(url!)}" rel="noopener noreferrer">${body}</a>`;
      }
      report('unsupported_link');
      return body;
    };
    const render = (item: Node, header = false): string => {
      const children = () => (item.children ?? []).map((child) => render(child, header)).join('');
      switch (item.type) {
        case 'definition':
          return '';
        case 'html':
          return convertWechatHtml(item.value ?? '', report, imagePlaceholder);
        case 'text':
          if (/\$|\\\(|\\\[/.test(item.value ?? '')) report('formula_review');
          return escape(item.value ?? '');
        case 'paragraph':
          return `<p>${children()}</p>`;
        case 'heading':
          return `<h${item.depth}>${children()}</h${item.depth}>`;
        case 'emphasis':
          return `<em>${children()}</em>`;
        case 'strong':
          return `<strong>${children()}</strong>`;
        case 'delete':
          return `<del>${children()}</del>`;
        case 'inlineCode':
          return `<code>${escape(item.value ?? '')}</code>`;
        case 'code':
          if (item.meta) report('code_metadata_review');
          return `<pre><code${item.lang ? ` data-language="${escape(item.lang)}"` : ''}>${escape(item.value ?? '')}</code></pre>`;
        case 'break':
          return '<br>';
        case 'thematicBreak':
          return '<hr>';
        case 'blockquote':
          return `<blockquote>${children()}</blockquote>`;
        case 'list': {
          const tag = item.ordered ? 'ol' : 'ul';
          const start =
            item.ordered && item.start != null && item.start !== 1 ? ` start="${item.start}"` : '';
          return `<${tag}${start}>${children()}</${tag}>`;
        }
        case 'listItem':
          return `<li>${item.checked == null ? '' : item.checked ? '☑ ' : '☐ '}${children()}</li>`;
        case 'link':
          return link(item.url, children());
        case 'linkReference':
          return link(definitions.get(identifier(item.identifier ?? '')), children());
        case 'image':
        case 'imageReference':
          report('image_unavailable');
          return imagePlaceholder(item.alt ?? '');
        case 'table': {
          const [first, ...rows] = item.children ?? [];
          return `<table>${first ? `<thead>${render(first, true)}</thead>` : ''}<tbody>${rows.map((row) => render(row)).join('')}</tbody></table>`;
        }
        case 'tableRow':
          return `<tr>${children()}</tr>`;
        case 'tableCell':
          return header ? `<th>${children()}</th>` : `<td>${children()}</td>`;
        default:
          report('unsupported_content');
          return item.children?.length ? children() : escape(item.value ?? block.markdown);
      }
    };
    if (/^\s*:::[^\n]*/m.test(block.markdown)) report('unsupported_extension');
    const containsInlineHtml = (item: Node): boolean =>
      item.type === 'html' || (item.children ?? []).some(containsInlineHtml);
    let html: string;
    if (node.type !== 'html' && containsInlineHtml(node)) {
      report('html_review');
      html = `<pre><code>${escape(block.markdown)}</code></pre>`;
    } else {
      html = render(node);
    }
    result.push({ source_block_id: block.id, html });
  }
  return { blocks: result, issues, images };
}
