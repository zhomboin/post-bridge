import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5';
import type { WechatAttachment, WechatBlock } from './formatting-contract';

type Node = DefaultTreeAdapterTypes.ChildNode;
const allowed = new Set([
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
]);
const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function safeWechatPreview(blocks: WechatBlock[], attachments: WechatAttachment[]) {
  const allowedImages = new Set(
    attachments
      .filter(
        (item) =>
          ['image/png', 'image/jpeg'].includes(item.media_type) &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(item.data),
      )
      .map((item) => `data:${item.media_type};base64,${item.data}`),
  );
  const text: string[] = [];
  const html = blocks
    .map((block) => {
      const source = block.html;
      const raw = (node: Node) => {
        const position = node.sourceCodeLocation;
        return position
          ? source.slice(position.startOffset, position.endOffset)
          : serializeOuter(node);
      };
      const render = (node: Node): string => {
        if (node.nodeName === '#text' && 'value' in node) {
          text.push(node.value);
          return escape(node.value);
        }
        if (!('tagName' in node)) return '';
        const children = () => node.childNodes.map(render).join('');
        const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));
        const tag = node.tagName;
        if (tag === 'img') {
          const source = attrs.get('src') ?? '';
          const alt = attrs.get('alt') ?? '';
          if (!allowedImages.has(source)) {
            text.push('[图片不可用]');
            return '<span>[图片不可用]</span>';
          }
          text.push(alt);
          return `<img src="${escape(source)}" alt="${escape(alt)}">`;
        }
        if (tag === 'a') {
          const href = attrs.get('href') ?? '';
          let valid = false;
          try {
            const url = new URL(href);
            valid = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
          } catch {}
          const body = children();
          return valid
            ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${body}</a>`
            : body;
        }
        if (!allowed.has(tag)) {
          const value = raw(node);
          text.push(value);
          return `<code>${escape(value)}</code>`;
        }
        let safeAttrs = '';
        const numeric = (name: string, min: number, max: number) => {
          const value = attrs.get(name);
          if (value && /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max)
            safeAttrs += ` ${name}="${Number(value)}"`;
        };
        if (tag === 'ol') numeric('start', 0, 1000000);
        if (tag === 'td' || tag === 'th') {
          numeric('colspan', 1, 1000);
          numeric('rowspan', 1, 1000);
        }
        if (tag === 'code' && attrs.has('data-language'))
          safeAttrs += ` data-language="${escape(attrs.get('data-language')!)}"`;
        if (tag === 'br' || tag === 'hr') {
          text.push('\n');
          return `<${tag}>`;
        }
        const body = children();
        if (
          ['p', 'div', 'section', 'li', 'tr', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(
            tag,
          )
        )
          text.push('\n');
        return `<${tag}${safeAttrs}>${body}</${tag}>`;
      };
      return parseFragment(source, { sourceCodeLocationInfo: true })
        .childNodes.map(render)
        .join('');
    })
    .join('\n');
  return { html, text: text.join('').trim() };
}
