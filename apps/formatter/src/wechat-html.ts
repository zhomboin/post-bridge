import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5';

type HtmlNode = DefaultTreeAdapterTypes.ChildNode;
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
export const escapeWechat = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function safeWechatLink(url: string | undefined): boolean {
  try {
    const parsed = new URL(url ?? '');
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function wechatHtmlImages(raw: string): { source: string; alt: string }[] {
  const result: { source: string; alt: string }[] = [];
  const visit = (node: HtmlNode) => {
    if (!('tagName' in node)) return;
    if (node.tagName === 'script' || node.tagName === 'style' || node.tagName === 'template')
      return;
    if (node.tagName === 'img') {
      const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));
      result.push({ source: attrs.get('src') ?? '', alt: attrs.get('alt') ?? '' });
    }
    for (const child of node.childNodes) visit(child);
  };
  for (const child of parseFragment(raw).childNodes) visit(child);
  return result;
}

export function convertWechatHtml(
  raw: string,
  report: (code: string) => void,
  imagePlaceholder?: (alt: string) => string,
): string {
  const sourceOf = (node: HtmlNode): string => {
    const location = node.sourceCodeLocation;
    return location ? raw.slice(location.startOffset, location.endOffset) : serializeOuter(node);
  };
  const render = (node: HtmlNode): string => {
    if (node.nodeName === '#text' && 'value' in node) return escapeWechat(node.value);
    if (node.nodeName === '#comment') {
      report('html_review');
      return `<code>${escapeWechat(sourceOf(node))}</code>`;
    }
    if (!('tagName' in node)) {
      report('html_review');
      return '';
    }
    const children = () => node.childNodes.map(render).join('');
    const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));
    if (node.tagName === 'script' || node.tagName === 'style' || node.tagName === 'template') {
      report('html_review');
      return `<code>${escapeWechat(sourceOf(node))}</code>`;
    }
    if (node.tagName === 'img') {
      report('image_unavailable');
      const alt = attrs.get('alt') ?? '';
      return imagePlaceholder ? imagePlaceholder(alt) : `<span>[图片：${escapeWechat(alt)}]</span>`;
    }
    if (node.tagName === 'a') {
      const href = attrs.get('href');
      if (node.attrs.some((attr) => attr.name !== 'href')) report('html_attributes_review');
      if (!safeWechatLink(href)) {
        report('unsupported_link');
        return children();
      }
      return `<a href="${escapeWechat(href!)}" rel="noopener noreferrer">${children()}</a>`;
    }
    const tag = node.tagName === 'b' ? 'strong' : node.tagName === 'i' ? 'em' : node.tagName;
    if (!tags.has(tag)) {
      report('html_review');
      return `<code>${escapeWechat(sourceOf(node))}</code>`;
    }
    const preserved = new Set<string>();
    let safeAttributes = '';
    const numericAttribute = (name: string, min: number, max: number) => {
      const value = attrs.get(name);
      if (
        value !== undefined &&
        /^\d+$/.test(value) &&
        Number(value) >= min &&
        Number(value) <= max
      ) {
        safeAttributes += ` ${name}="${Number(value)}"`;
        preserved.add(name);
      }
    };
    if (tag === 'ol') numericAttribute('start', 0, 1000000);
    if (tag === 'td' || tag === 'th') {
      numericAttribute('colspan', 1, 1000);
      numericAttribute('rowspan', 1, 1000);
    }
    if (node.attrs.some((attr) => !preserved.has(attr.name))) report('html_attributes_review');
    if (tag === 'br' || tag === 'hr') return `<${tag}>`;
    return `<${tag}${safeAttributes}>${children()}</${tag}>`;
  };
  return parseFragment(raw, { sourceCodeLocationInfo: true }).childNodes.map(render).join('');
}
