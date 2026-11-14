import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { safeWechatLink } from './wechat-html.js';

type Node = DefaultTreeAdapterTypes.ChildNode;
const tags = new Set([
  'p',
  'div',
  'span',
  'section',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'b',
  'i',
  'del',
  'blockquote',
  'ul',
  'ol',
  'li',
  'pre',
  'code',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'br',
  'hr',
  'a',
  'img',
]);

// 使用原始 HTML 单独提取可校对内容，无法判定的标签保留人工提示。
export function inspectWechatHtml(raw: string) {
  const codes: string[] = [];
  const links: string[] = [];
  const images: string[] = [];
  let complete = true;
  const read = (node: Node): string => {
    if (node.nodeName === '#text' && 'value' in node) return node.value;
    if (!('tagName' in node)) {
      complete = false;
      return '';
    }
    if (!tags.has(node.tagName)) {
      complete = false;
      return '';
    }
    const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));
    if (node.tagName === 'img') {
      images.push(`[图片：${attrs.get('alt') ?? ''}]`);
      return '';
    }
    const text = node.childNodes.map(read).join('');
    if (node.tagName === 'code') codes.push(text);
    if (node.tagName === 'a' && safeWechatLink(attrs.get('href'))) links.push(attrs.get('href')!);
    return text;
  };
  const text = parseFragment(raw).childNodes.map(read).join('');
  return { text, codes, links, images, complete };
}
