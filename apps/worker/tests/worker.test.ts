import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerAPI } from '../src/api.js';
import { executeClaim, runWorker } from '../src/worker.js';
import type { Claim, JobResult } from '../src/types.js';

const claim: Claim = { job: { id: 'job', kind: 'save_draft', title: '一篇验证草稿文章', markdown: '正文', run_mode: 'execute', external_started: false, remote_id: null, reconcile_candidate_id: null }, lease_token: 'lease', lease_seconds: 60, lease_expires_at: new Date(Date.now()+60000).toISOString() };
function api(heartbeat: () => Promise<{cancel_requested:boolean}>) {
  const completed: JobResult[] = [];
  return { completed, heartbeat, progress: async () => {}, complete: async (_id:string, _token:string, result:JobResult) => { completed.push(result); } };
}

describe('领取的停止与清理', () => {
  it('租约心跳失败立即关闭浏览器，不再写入完成状态', async () => {
    let closed = false;
    const fake = api(async () => { throw new Error('lost lease'); });
    await executeClaim(fake, claim, async () => ({
      close: async () => { closed = true; },
      run: async (_job, _hooks, signal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { status: 'cancelled' }; }
    }), new AbortController().signal, 10);
    expect(closed).toBe(true); expect(fake.completed).toHaveLength(0);
  });
  it('取消已开始任务时先关闭浏览器，再上报待核对，不谎报撤回', async () => {
    let closed = false;
    let completionAfterClose = false;
    const fake = api(async () => ({ cancel_requested: true }));
    const complete = fake.complete;
    fake.complete = async (...args) => { completionAfterClose = closed; await complete(...args); };
    await executeClaim(fake, claim, async () => ({
      close: async () => { closed = true; },
      run: async (_job, hooks, signal) => {
        await hooks.progress({ stage: 'opening_editor', external_started: true });
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { status: 'cancelled' };
      }
    }), new AbortController().signal, 10);
    expect(completionAfterClose).toBe(true);
    expect(fake.completed[0]?.status).toBe('reconciling');
  });
  it('保存读回完成到关闭浏览器之间的取消请求仍阻止成功上报', async () => {
    let closed = false;
    const fake = api(async () => ({ cancel_requested: true }));
    await executeClaim(fake, claim, async () => ({
      close: async () => { closed = true; },
      run: async (_job, hooks) => { await hooks.progress({ stage: 'opening_editor', external_started: true }); return { status: 'succeeded', remote_id: '123' }; }
    }), new AbortController().signal, 15000);
    expect(closed).toBe(true);
    expect(fake.completed[0]?.status).toBe('reconciling');
  });
  it('停止信号清理浏览器并保留可安全取消的未开始任务', async () => {
    let closed = false;
    const controller = new AbortController();
    const fake = api(async () => ({ cancel_requested: false }));
    await executeClaim(fake, claim, async () => ({
      close: async () => { closed = true; },
      run: async (_job, _hooks, signal) => { controller.abort(); if (!signal.aborted) throw new Error('abort not forwarded'); return { status: 'cancelled' }; }
    }), controller.signal, 10);
    expect(closed).toBe(true); expect(fake.completed[0]?.status).toBe('cancelled');
  });
});
describe('空闲维护调度', () => {
  it('登录维护优先于领取任务，期间报告忙碌并在退出时关闭', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'post-bridge-maintenance-'));
    const stop = new AbortController(); const states: boolean[] = []; let claims = 0; let closed = false;
    const fake = { workerHeartbeat: async (idle: boolean) => { states.push(idle); }, claim: async () => { claims++; stop.abort(); return null; } } as unknown as WorkerAPI;
    try {
      await runWorker(fake, dir, async () => { throw new Error('不应开启任务浏览器'); }, stop.signal, 1, { pending: () => true, run: async () => { expect(states.at(-1)).toBe(false); stop.abort(); }, close: async () => { closed = true; } });
      expect(claims).toBe(0); expect(closed).toBe(true); expect(states).toContain(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
