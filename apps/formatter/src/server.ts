import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { analyze, analyzeWithProtectedHtml, validateCSDN, type ContentBlock } from './markdown.js';
import { renderCards } from './render.js';
import { WechatExecutor } from './wechat-execution.js';

export type FormatterOptions = { token: string; wechatTimeoutMs?: number };
function authorized(request: IncomingMessage, token: string) {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function createFormatterServer(options: FormatterOptions) {
  const wechat = new WechatExecutor(options.wechatTimeoutMs);
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    if (!authorized(request, options.token)) return send(401, { code: 'unauthorized' });
    if (request.method === 'GET' && request.url === '/healthz') return send(200, { status: 'ok' });
    if (
      request.method !== 'POST' ||
      !['/analyze', '/validate-csdn', '/render', '/convert-wechat', '/validate-wechat'].includes(
        request.url ?? '',
      )
    )
      return send(404, { code: 'not_found' });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        const limit = request.url === '/validate-wechat' ? 8 : 4;
        if (size > limit * 1024 * 1024) return send(413, { code: 'request_too_large' });
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.url === '/validate-wechat' || request.url === '/convert-wechat') {
        if (
          typeof body?.markdown !== 'string' ||
          [...body.markdown].length > 100000 ||
          (request.url === '/validate-wechat' && !Array.isArray(body.blocks))
        )
          throw Error('unsupported_content');
        const controller = new AbortController();
        const onClose = () => {
          if (!response.writableFinished) controller.abort();
        };
        response.once('close', onClose);
        let result: unknown;
        try {
          result = await wechat.run(
            {
              operation: request.url === '/convert-wechat' ? 'convert' : 'validate',
              markdown: body.markdown,
              blocks: body.blocks,
            },
            controller.signal,
          );
        } finally {
          response.off('close', onClose);
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
          throw Error('unsupported_content');
        return send(200, result);
      }
      if (request.url === '/render') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        response.once('close', () => {
          if (!response.writableFinished) controller.abort();
        });
        try {
          return send(200, { images: await renderCards(body, controller.signal) });
        } finally {
          clearTimeout(timeout);
        }
      }
      if (request.url === '/analyze') {
        if (typeof body.markdown !== 'string') throw Error('unsupported_content');
        if (
          body.platform !== undefined &&
          !['csdn', 'xiaohongshu', 'wechat'].includes(body.platform)
        )
          throw Error('unsupported_content');
        return send(200, {
          blocks:
            body.platform === 'xiaohongshu' || body.platform === 'wechat'
              ? analyzeWithProtectedHtml(body.markdown)
              : analyze(body.markdown),
        });
      }
      if (!Array.isArray(body.original) || !Array.isArray(body.blocks))
        throw Error('unsupported_content');
      // 重新分析原文，客户端不能把保护块降级成可编辑内容。
      const original = analyze(String(body.markdown ?? ''));
      if (JSON.stringify(original) !== JSON.stringify(body.original as ContentBlock[]))
        throw Error('content_changed');
      return send(200, { markdown: validateCSDN(original, body.blocks) });
    } catch (error) {
      const code =
        error instanceof Error &&
        [
          'unsupported_content',
          'content_changed',
          'protected_content_changed',
          'card_overflow',
          'too_many_cards',
          'renderer_busy',
          'renderer_unavailable',
          'render_cancelled',
        ].includes(error.message)
          ? error.message
          : 'invalid_request';
      return send(422, { code });
    }
  });
}
