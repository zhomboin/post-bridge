import type { Claim, JobAPI, JobResult, Progress } from './types.js';

export class APIError extends Error {
  constructor(public readonly status: number) { super(status === 409 ? '任务领取已失效' : '内部服务暂不可用'); }
}
export class WorkerAPI implements JobAPI {
  constructor(private readonly baseURL: string, private readonly token: string, readonly workerId: string) {}
  private async request(path: string, body: unknown): Promise<unknown> {
    try {
      const response = await fetch(`${this.baseURL}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, body: JSON.stringify(body) });
      if (!response.ok) throw new APIError(response.status);
      if (response.status === 204) return null;
      const text = await response.text();
      if (!text) return {};
      if (text.length > 1200000) throw new APIError(502);
      return JSON.parse(text);
    } catch (error) { if (error instanceof APIError) throw error; throw new APIError(0); }
  }
  async claim(): Promise<Claim | null> {
    const value = await this.request('/internal/worker/claim', { worker_id: this.workerId }) as Claim | null;
    if (value && (!value.job?.id || !value.lease_token || value.lease_seconds < 30)) throw new APIError(502);
    return value;
  }
  async workerHeartbeat(browserIdle: boolean, profileAvailable: boolean): Promise<void> {
    await this.request('/internal/worker/heartbeat', { worker_id: this.workerId, browser_idle: browserIdle, profile_available: profileAvailable });
  }
  async heartbeat(id: string, token: string): Promise<{cancel_requested: boolean}> {
    const value = await this.request(`/internal/worker/jobs/${encodeURIComponent(id)}/heartbeat`, { lease_token: token }) as {cancel_requested: boolean};
    if (typeof value.cancel_requested !== 'boolean') throw new APIError(502);
    return value;
  }
  async progress(id: string, token: string, value: Progress): Promise<void> { await this.request(`/internal/worker/jobs/${encodeURIComponent(id)}/progress`, { lease_token: token, ...value }); }
  async complete(id: string, token: string, value: JobResult): Promise<void> { await this.request(`/internal/worker/jobs/${encodeURIComponent(id)}/complete`, { lease_token: token, ...value }); }
}