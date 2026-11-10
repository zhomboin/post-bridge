import { createHash } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

type Node = {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
export type ContentBlock = import('./formatting-contract.js').FormattingBlock;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function textOf(node: Node): string {
  if (node.type === 'html') throw Error('unsupported_content');
  if (node.type === 'break') return ' ';
  if (node.type === 'image') return '';
  return node.value ?? (node.children ?? []).map(textOf).join('');
}
function locksOf(node: Node): string[] {
  const locks: string[] = [];
  if (node.type === 'inlineCode') locks.push('code:' + digest(node.value ?? ''));
  if (node.url !== undefined) locks.push('url:' + node.url);
  if (node.type === 'linkReference' || node.type === 'imageReference')
    locks.push('reference:' + node.identifier);
  for (const child of node.children ?? []) locks.push(...locksOf(child));
  return locks;
}
function protectedNode(node: Node): boolean {
  return (
    ![
      'paragraph',
      'heading',
      'list',
      'listItem',
      'text',
      'emphasis',
      'strong',
      'delete',
      'link',
      'linkReference',
      'inlineCode',
      'break',
    ].includes(node.type) || (node.children ?? []).some(protectedNode)
  );
}
export function analyze(markdown: string): ContentBlock[] {
  if (!markdown.trim() || markdown.length > 800000 || markdown.includes('\0'))
    throw Error('unsupported_content');
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Node;
  return (tree.children ?? []).map((node, index) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) throw Error('unsupported_content');
    const raw = markdown.slice(start, end);
    // 公式和未知扩展保留原文；HTML 不进入渲染器。
    textOf(node);
    return {
      id: 'b' + index + '-' + digest(raw).slice(0, 12),
      kind: node.type,
      markdown: raw,
      protected: protectedNode(node) || /\$|\\\(|\\\[/.test(raw),
      text: textOf(node),
      locks: locksOf(node),
    };
  });
}
function canonicalText(value: string) {
  return JSON.stringify(value.match(/[\p{Script=Latin}\p{N}_]+|[^\s]/gu) ?? []);
}
export function validateCSDN(
  original: ContentBlock[],
  proposed: { id: string; markdown: string }[],
): string {
  if (proposed.length !== original.length || proposed.length > 2000) throw Error('content_changed');
  return proposed
    .map((item, index) => {
      const before = original[index];
      if (item.id !== before.id || typeof item.markdown !== 'string' || !item.markdown.trim())
        throw Error('content_changed');
      if (before.protected) {
        if (item.markdown !== before.markdown) throw Error('protected_content_changed');
      } else {
        const after = analyze(item.markdown);
        if (
          after.some((block) => block.protected) ||
          canonicalText(after.map((block) => block.text).join('\n')) !==
            canonicalText(before.text) ||
          JSON.stringify(after.flatMap((block) => block.locks)) !== JSON.stringify(before.locks)
        )
          throw Error('content_changed');
      }
      return item.markdown;
    })
    .join('\n\n');
}
