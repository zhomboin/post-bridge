import { afterAll, describe, expect, it } from 'vitest';
import { renderCards, closeRenderers } from '../src/render.js';
import { createHash } from 'node:crypto';
const input = {
  template: 'technical' as const,
  title: '技术笔记',
  subtitle: '合成验证',
  markdown: '原稿内容。',
  cards: [
    {
      title: '关键步骤',
      paragraphs: ['保留原稿中的适用条件与操作步骤。', '<script>这里只是待显示的文字</script>'],
      code_refs: [],
      source_block_ids: ['source'],
    },
  ],
};
afterAll(() => closeRenderers());
describe('小红书固定模板渲染', () => {
  it('生成固定比例 PNG，提供可核对的内容摘要', async () => {
    const images = await renderCards(input, new AbortController().signal);
    expect(images).toHaveLength(2);
    for (const image of images) {
      const bytes = Buffer.from(image.data, 'base64');
      expect(bytes.readUInt32BE(16)).toBe(1080);
      expect(bytes.readUInt32BE(20)).toBe(1440);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(image.sha256);
    }
  }, 30000);
  it('依据实际高度分页，不截断段落', async () => {
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => '步骤' + (i + 1) + '：' + '检查当前配置，保留前置条件。'.repeat(5),
    );
    const images = await renderCards(
      { ...input, cards: [{ ...input.cards[0], paragraphs }] },
      new AbortController().signal,
    );
    expect(images.length).toBeGreaterThan(2);
    expect(images.length).toBeLessThanOrEqual(9);
  }, 30000);
  it('拒绝过长代码块和已取消的任务', async () => {
    const markdown =
      '~~~txt\n' + Array.from({ length: 80 }, () => '保留完整代码').join('\n') + '\n~~~';
    const { analyze } = await import('../src/markdown.js');
    const id = analyze(markdown)[0].id;
    await expect(
      renderCards(
        { ...input, markdown, cards: [{ ...input.cards[0], paragraphs: [], code_refs: [id] }] },
        new AbortController().signal,
      ),
    ).rejects.toThrow('card_overflow');
    const controller = new AbortController();
    controller.abort();
    await expect(renderCards(input, controller.signal)).rejects.toThrow('render_cancelled');
  }, 30000);
});
