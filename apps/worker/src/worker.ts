import type { Claim, JobAPI, JobResult, Session } from './types.js';
import { WorkerAPI } from './api.js';
import { acquireProfile, profileAvailable } from './profile.js';

export async function executeClaim(api: JobAPI, claim: Claim, open: () => Promise<Session>, outerSignal: AbortSignal, heartbeatMs = 15000): Promise<void> {
  const controller = new AbortController();
  let session: Session | undefined;
  let closing: Promise<void> | undefined;
  let leaseLost = false;
  let external = claim.job.external_started;
  let remoteID = claim.job.remote_id ?? undefined;
  let heartbeatInFlight = false;
  let heartbeatPromise: Promise<void> = Promise.resolve();
  const close = () => closing ??= (async () => { await session?.close().catch(() => {}); })();
  const abort = () => { controller.abort(); if (session) void close(); };
  outerSignal.addEventListener('abort', abort, { once: true });
  if (outerSignal.aborted) abort();
  const timer = setInterval(() => {
    if (heartbeatInFlight || controller.signal.aborted) return;
    heartbeatInFlight = true;
    heartbeatPromise = (async () => {
      try { const response = await api.heartbeat(claim.job.id, claim.lease_token); if (response.cancel_requested) abort(); }
      catch { leaseLost = true; abort(); }
      finally { heartbeatInFlight = false; }
    })();
  }, heartbeatMs);
  const deadline = setTimeout(abort, 180000);
  let result: JobResult;
  try {
    controller.signal.throwIfAborted();
    session = await open();
    if (controller.signal.aborted) { await close(); controller.signal.throwIfAborted(); }
    result = await session.run(claim.job, { progress: async value => {
      controller.signal.throwIfAborted();
      try { await api.progress(claim.job.id, claim.lease_token, value); }
      catch { leaseLost = true; abort(); throw new Error('任务检查点未确认'); }
      if (value.external_started) external = true;
      if (value.remote_id) remoteID = value.remote_id;
    } }, controller.signal);
  } catch {
    result = { status: external ? 'reconciling' : controller.signal.aborted ? 'cancelled' : 'failed', error_code: controller.signal.aborted ? 'cancelled' : 'browser_busy', error_message: external ? '平台结果尚未确认，需要只读核对' : '浏览器操作未完成', retryable: !external && !controller.signal.aborted };
  } finally {
    clearInterval(timer); clearTimeout(deadline);
    outerSignal.removeEventListener('abort', abort);
    await heartbeatPromise;
    // 新实例产生之后才建立清理Promise，避免启动期间停止导致漏关。
    if (session) await close();
  }
  if (leaseLost) return;
  try {
    const finalHeartbeat = await api.heartbeat(claim.job.id, claim.lease_token);
    if (finalHeartbeat.cancel_requested) controller.abort();
  } catch { return; }
  if (controller.signal.aborted) result = { status: external ? 'reconciling' : 'cancelled', error_code: 'cancelled', error_message: '浏览器操作已停止', retryable: false };
  if (external && ['failed', 'cancelled'].includes(result.status)) result = { ...result, status: 'reconciling', retryable: false };
  if (remoteID && claim.job.run_mode !== 'reconcile') result.remote_id = remoteID;
  await api.complete(claim.job.id, claim.lease_token, result);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true });
  });
}
export interface WorkerMaintenance { pending(): boolean; run(signal: AbortSignal): Promise<void>; close(): Promise<void> }
export async function runWorker(api: WorkerAPI, profileDir: string, open: () => Promise<Session>, signal: AbortSignal, pollIntervalMs = 1500, maintenance?: WorkerMaintenance): Promise<void> {
  const owner = await acquireProfile(profileDir);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let idle = true;
  let heartbeatRunning = false;
  let heartbeatPromise: Promise<void> = Promise.resolve();
  let fatal = false;
  const sendHeartbeat = async () => {
    const available = idle && await profileAvailable(profileDir, owner);
    await api.workerHeartbeat(idle, idle && available);
  };
  const timer = setInterval(() => {
    if (heartbeatRunning || controller.signal.aborted) return;
    heartbeatRunning = true;
    heartbeatPromise = sendHeartbeat().catch(() => { fatal = true; abort(); }).finally(() => { heartbeatRunning = false; });
  }, 15000);
  try {
    await sendHeartbeat();
    while (!controller.signal.aborted) {
      if (!await profileAvailable(profileDir, owner)) throw new Error('浏览器配置尚未释放，执行器已停止');
      if (maintenance?.pending()) {
        idle = false; await sendHeartbeat();
        try { await maintenance.run(controller.signal); }
        finally { idle = true; await sendHeartbeat(); }
        continue;
      }
      const claim = await api.claim();
      if (!claim) { await delay(pollIntervalMs, controller.signal); continue; }
      idle = false;
      await sendHeartbeat();
      try { await executeClaim(api, claim, open, controller.signal); }
      finally { idle = true; await sendHeartbeat(); }
    }
    if (fatal) throw new Error('执行器心跳失败，已停止浏览器');
  } finally {
    clearInterval(timer); signal.removeEventListener('abort', abort);
    await heartbeatPromise;
    try { await maintenance?.close(); } finally { await owner.release(); }
  }
}