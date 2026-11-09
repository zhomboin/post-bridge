import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WorkerAPI } from '../src/api.js';
let server: Server;
let url = '';
const received: { path: string; token: string | undefined; body: Record<string, unknown> }[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ path: req.url!, token: req.headers.authorization, body: JSON.parse(raw) });
    if (req.url?.endsWith('/claim')) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ cancel_requested: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it('内部接口使用独立Bearer、固定路径和领取令牌，不携带管理员Cookie', async () => {
  const api = new WorkerAPI(url, 'worker-only-secret', 'worker-1');
  expect(await api.claim()).toBeNull();
  await api.workerHeartbeat(true, true);
  await api.heartbeat('job-1', 'lease-1');
  await api.progress('job-1', 'lease-1', { stage: 'draft_acquired', remote_id: '123' });
  await api.complete('job-1', 'lease-1', { status: 'succeeded', remote_id: '123' });
  expect(received).toHaveLength(5);
  expect(received.every((r) => r.token === 'Bearer worker-only-secret')).toBe(true);
  expect(received[0].body).toEqual({ worker_id: 'worker-1' });
  expect(received[1].body).toEqual({
    worker_id: 'worker-1',
    browser_idle: true,
    profile_available: true,
  });
  expect(received[3].body).toEqual({
    lease_token: 'lease-1',
    stage: 'draft_acquired',
    remote_id: '123',
  });
});
