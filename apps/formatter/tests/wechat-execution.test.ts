import { describe, expect, it } from 'vitest';
import { WechatExecutor } from '../src/wechat-execution.js';

describe('公众号计算线程', () => {
  it('超时后终止计算并允许后续请求', async () => {
    const timeout = new WechatExecutor(1);
    await expect(
      timeout.run({ operation: 'convert', markdown: '合成正文。' }, new AbortController().signal),
    ).rejects.toThrow('renderer_unavailable');
    const normal = new WechatExecutor(5000);
    const result = await normal.run(
      { operation: 'convert', markdown: '合成正文。' },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ blocks: [{ html: '<p>合成正文。</p>' }] });
  });
  it('并发达到上限时拒绝新请求，取消后释放线程', async () => {
    const executor = new WechatExecutor(5000, 1);
    const controller = new AbortController();
    const pending = executor.run(
      { operation: 'convert', markdown: '合成正文。' },
      controller.signal,
    );
    await expect(
      executor.run({ operation: 'convert', markdown: '第二篇。' }, new AbortController().signal),
    ).rejects.toThrow('renderer_busy');
    controller.abort();
    await expect(pending).rejects.toThrow('render_cancelled');
    const result = await executor.run(
      { operation: 'convert', markdown: '恢复。' },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ blocks: [{ html: '<p>恢复。</p>' }] });
  });
});
