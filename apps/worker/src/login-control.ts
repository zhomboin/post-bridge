import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { LoginError, type RemoteLoginManager } from './remote-login.js';

export function loginControlAddress(value: string): { host: '127.0.0.1'; port: number } {
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(value);
  if (!match || Number(match[1]) > 65535) throw new Error('登录控制服务必须使用IPv4回环地址');
  return { host: '127.0.0.1', port: Number(match[1]) };
}
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) {
      request.resume();
      throw new LoginError(413, '登录操作消息过大');
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new LoginError(400, '登录操作格式无效');
  }
}
export async function startLoginControl(
  address: string,
  token: string,
  manager: RemoteLoginManager,
  shutdown?: () => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const { host, port } = loginControlAddress(address);
  if (token.length < 32) throw new Error('登录控制密钥无效');
  let active = 0;
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 32;
  server.maxConnections = 16;
  const reply = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      reply(response, 401, { error: '内部鉴权失败' });
      request.resume();
      return;
    }
    if (active >= 8) {
      reply(response, 429, { error: '登录请求过于频繁' });
      request.resume();
      return;
    }
    active++;
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.search || url.hash) throw new LoginError(404, '登录接口不存在');
      if (url.pathname === '/shutdown' && request.method === 'POST' && shutdown) {
        request.resume();
        reply(response, 200, { ok: true });
        setImmediate(shutdown);
        return;
      }
      if (url.pathname === '/login' && request.method === 'GET') {
        reply(response, 200, manager.status());
        return;
      }
      if (url.pathname === '/login' && request.method === 'POST') {
        if (
          Number(request.headers['content-length'] ?? 0) > 0 ||
          request.headers['transfer-encoding']
        )
          throw new LoginError(400, '创建登录会话无需请求内容');
        reply(response, 202, manager.create());
        return;
      }
      const match = /^\/login\/([a-zA-Z0-9-]{1,64})(?:\/(frame|input))?$/.exec(url.pathname);
      if (!match) throw new LoginError(404, '登录接口不存在');
      const [, id, operation] = match;
      if (!operation && request.method === 'DELETE') {
        reply(response, 200, manager.cancel(id));
        return;
      }
      if (operation === 'frame' && request.method === 'GET') {
        const frame = await manager.frame(id);
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': frame.length });
        response.end(frame);
        return;
      }
      if (operation === 'input' && request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json')
          throw new LoginError(415, '登录操作必须使用JSON');
        const body = await jsonBody(request);
        await manager.input(id, body);
        reply(response, 200, manager.status());
        return;
      }
      throw new LoginError(404, '登录接口不存在');
    } catch (error) {
      request.resume();
      if (!response.headersSent)
        reply(response, error instanceof LoginError ? error.statusCode : 502, {
          error: error instanceof LoginError ? error.message : '登录控制暂不可用',
        });
      else response.end();
    } finally {
      active--;
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actual = server.address() as { port: number };
  return {
    url: `http://${host}:${actual.port}`,
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
