import { Worker } from 'node:worker_threads';

type Input = { operation: 'convert' | 'validate'; markdown: string; blocks?: unknown };

export class WechatExecutor {
  private active = 0;
  constructor(
    private readonly timeoutMs = 30000,
    private readonly limit = 2,
  ) {}

  async run(input: Input, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw Error('render_cancelled');
    if (this.active >= this.limit) throw Error('renderer_busy');
    this.active++;
    let worker: Worker | undefined;
    try {
      worker = new Worker(new URL('../dist/wechat-worker.js', import.meta.url), {
        workerData: input,
      });
      const running = worker;
      return await new Promise((resolve, reject) => {
        let settled = false;
        const done = (error?: string, result?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (error) reject(Error(error));
          else resolve(result);
        };
        const abort = () => done('render_cancelled');
        const timer = setTimeout(() => done('renderer_unavailable'), this.timeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        running.once('message', (message: { error?: string; result?: unknown }) =>
          done(message.error, message.result),
        );
        running.once('error', () => done('renderer_unavailable'));
        running.once('exit', () => done('renderer_unavailable'));
      });
    } finally {
      try {
        if (worker) await worker.terminate();
      } finally {
        this.active--;
      }
    }
  }
}
