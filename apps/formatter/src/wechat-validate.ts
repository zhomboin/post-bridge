import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { analyzeWithProtectedHtml } from './markdown.js';
import type { WechatBlock } from './wechat.js';
import { safeWechatLink } from './wechat-html.js';
import { inspectWechatHtml } from './wechat-validate-html.js';

type SourceNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  identifier?: string;
  children?: SourceNode[];
};
type HtmlNode = DefaultTreeAdapterTypes.ChildNode;
type Review = { block_id: string; code: string; blocking: boolean };
const normalized = (value: string) => value.replace(/\s+/gu, '');
const identifier = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

// 独立提取原文和输出中的文字、代码及链接，不调用转换器重新生成结果。
export function validateWechat(markdown: string, blocks: WechatBlock[]): Review[] {
  const source = analyzeWithProtectedHtml(markdown);
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as SourceNode;
  if (!Array.isArray(blocks) || blocks.length !== source.length || blocks.length > 2000)
    throw Error('content_changed');
  const definitions = new Map<string, string>();
  for (const node of tree.children ?? [])
    if (node.type === 'definition' && node.identifier && node.url)
      definitions.set(identifier(node.identifier), node.url);
  const issues: Review[] = [];
  source.forEach((block, index) => {
    const output = blocks[index];
    if (!output || output.source_block_id !== block.id || typeof output.html !== 'string')
      throw Error('content_changed');
    const node = tree.children![index];
    const code: string[] = [];
    const links: string[] = [];
    const images: string[] = [];
    let containsHtml = false;
    const collect = (item: SourceNode) => {
      if (item.type === 'html') containsHtml = true;
      if (item.type === 'code' || item.type === 'inlineCode') code.push(item.value ?? '');
      if (item.type === 'image' || item.type === 'imageReference')
        images.push(`[图片：${item.alt ?? ''}]`);
      const url =
        item.type === 'link'
          ? item.url
          : item.type === 'linkReference'
            ? definitions.get(identifier(item.identifier ?? ''))
            : undefined;
      if (safeWechatLink(url)) links.push(url!);
      for (const child of item.children ?? []) collect(child);
    };
    collect(node);
    if (containsHtml && node.type !== 'html') {
      issues.push({ block_id: block.id, code: 'verification_incomplete', blocking: false });
      return;
    }
    if (node.type === 'definition') return;
    const htmlSource = node.type === 'html' ? inspectWechatHtml(block.markdown) : undefined;
    if (htmlSource && !htmlSource.complete) {
      issues.push({ block_id: block.id, code: 'verification_incomplete', blocking: false });
      return;
    }
    const displayedCode: string[] = [];
    const displayedLinks: string[] = [];
    const displayedImages: string[] = [];
    const extract = (item: HtmlNode): string => {
      if (item.nodeName === '#text' && 'value' in item) return item.value;
      if (!('tagName' in item)) return '';
      const attrs = new Map(item.attrs.map((attr) => [attr.name, attr.value]));
      if (attrs.has('data-wechat-image')) {
        displayedImages.push(item.childNodes.map(extract).join(''));
        return '';
      }
      const text = item.childNodes.map(extract).join('');
      if (item.tagName === 'code') displayedCode.push(text);
      if (item.tagName === 'a' && attrs.has('href')) displayedLinks.push(attrs.get('href')!);
      return text;
    };
    const text = parseFragment(output.html).childNodes.map(extract).join('');
    const expected = normalized(htmlSource?.text ?? block.text);
    const actual = normalized(text);
    const taskText = /(?:^|\n)\s*[-+*\d.)]+\s+\[[ xX]\]/.test(block.markdown)
      ? actual.replace(/[☑☐]/gu, '')
      : actual;
    if (
      expected !== taskText ||
      JSON.stringify(htmlSource?.codes ?? code) !== JSON.stringify(displayedCode) ||
      JSON.stringify(htmlSource?.links ?? links) !== JSON.stringify(displayedLinks) ||
      JSON.stringify(htmlSource?.images ?? images) !== JSON.stringify(displayedImages)
    )
      issues.push({ block_id: block.id, code: 'content_review', blocking: true });
  });
  return issues;
}
