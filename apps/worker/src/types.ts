export interface Job {
  id: string;
  kind: 'save_draft' | 'check_account';
  title: string;
  markdown: string;
  run_mode: 'execute' | 'reconcile';
  external_started: boolean;
  remote_id: string | null;
  reconcile_candidate_id: string | null;
}
export interface Claim { job: Job; lease_token: string; lease_seconds: number; lease_expires_at: string }
export interface Progress { stage: string; external_started?: boolean; remote_id?: string; message?: string }
export interface JobResult {
  status: 'succeeded' | 'failed' | 'waiting_user' | 'reconciling' | 'cancelled';
  remote_id?: string;
  error_code?: string;
  error_message?: string;
  retryable?: boolean;
}
export interface Hooks { progress(value: Progress): Promise<void> }
export interface Session { run(job: Job, hooks: Hooks, signal: AbortSignal): Promise<JobResult>; close(): Promise<void> }
export interface JobAPI {
  heartbeat(id: string, token: string): Promise<{cancel_requested: boolean}>;
  progress(id: string, token: string, value: Progress): Promise<void>;
  complete(id: string, token: string, value: JobResult): Promise<void>;
}