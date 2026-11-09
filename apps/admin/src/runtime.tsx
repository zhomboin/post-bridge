import { contentOperations } from './content-operations';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
} from 'react';
import { RefreshCw } from 'lucide-react';

import type { CSDNPublishOptions } from './integration-types';

export type Session = {
  user: { id?: string; username: string; role?: string };
  csrf_token: string;
};
export type Job = {
  id: string;
  request_id: string;
  platform: string;
  account_id: string;
  kind: string;
  title: string;
  markdown?: string;
  status: string;
  outcome: string;
  stage: string;
  attempts: number;
  retry_count: number;
  max_retries: number;
  retry_allowed: boolean;
  external_started: boolean;
  integration_distribution_id?: string;
  article_id?: string;
  remote_id?: string;
  remote_url?: string;
  reconcile_candidate_id?: string;
  cancel_requested: boolean;
  manual_resolved?: boolean;
  error_code?: string;
  error_message?: string;
  reconcile_count?: number;
  auto_reconcile_started?: boolean;
  absence_checks?: number;
  available_at?: string;
  account_username?: string;
  publish_from_job_id?: string;
  publish_options?: CSDNPublishOptions;
  run_mode?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
};
export type LogEntry = {
  id: string;
  job_id?: string;
  attempt?: number;
  level: string;
  stage?: string;
  message: string;
  created_at: string;
};
export type PageData<T> = { items: T[]; total: number; page: number; page_size: number };
export type Account = {
  verified?: boolean;
  enabled?: boolean;
  id: string;
  platform: string;
  username?: string;
  display_name?: string;
  status: string;
  last_checked_at?: string;
  last_error?: string;
};
export type Settings = {
  draft_only: boolean;
  platform: string;
  limits?: Record<string, unknown>;
  poll_interval_ms?: number;
  worker_last_seen_at?: string;
};
export type Overview = {
  counts: Record<string, number>;
  worker_last_seen_at?: string;
  account?: Account;
};
export type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : '请求未完成，请检查连接后重试。';
}
export const WorkspaceContext = createContext<{
  api: Api;
  route: string;
  navigate: (path: string) => void;
}>({
  api: async () => {
    throw Error('尚未登录');
  },
  route: '/',
  navigate: () => {},
});
export const useWorkspace = () => useContext(WorkspaceContext);
export const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting_user: '等待处理',
  reconciling: '待核对',
  succeeded: '执行完成',
  failed: '执行失败',
  cancelled: '已取消',
  connected: '已连接',
  unchecked: '尚未检查',
  needs_login: '需要登录',
  blocked: '账号受限',
};
export const stageLabels: Record<string, string> = {
  queued: '等待执行',
  checking_login: '检查登录',
  opening_editor: '打开编辑器',
  syncing_articles: '读取文章列表',
  reading_article: '读取文章正文',
  draft_acquired: '已取得草稿',
  filling: '填写正文',
  saving: '保存草稿',
  verifying: '核对结果',
  finished: '处理结束',
};
export function stageLabel(stage: string, kind?: string) {
  if (kind === 'publish' && stage === 'saving') return '提交发布';
  if (kind === 'publish' && stage === 'verifying') return '核对发布结果';
  return stageLabels[stage];
}
export function isSourcePaused(
  job: Pick<Job, 'status' | 'error_code' | 'integration_distribution_id'> & { kind?: string },
) {
  return (
    (job.kind === 'publish' || !!job.integration_distribution_id) &&
    job.status === 'waiting_user' &&
    ['source_guard_failed', 'source_changed'].includes(job.error_code || '')
  );
}
export function Status({
  value,
  cancelling = false,
  label,
}: {
  value: string;
  cancelling?: boolean;
  label?: string;
}) {
  return (
    <span
      aria-live="polite"
      aria-atomic="true"
      className={'status ' + (statusLabels[value] ? value : 'unknown')}
    >
      {cancelling ? '取消中' : label || statusLabels[value] || '未知状态'}
    </span>
  );
}
export function time(value?: string) {
  if (!value) return '尚无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : date.toLocaleString('zh-CN', { hour12: false });
}
export function RouteLink({
  href = '/',
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useWorkspace();
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.button === 0
        ) {
          event.preventDefault();
          navigate(href);
        }
      }}
    />
  );
}
export function useResource<T>(path: string) {
  const { api } = useWorkspace();
  const [state, setState] = useState<{
    data?: T;
    error: string;
    updatedAt?: string;
    loading: boolean;
  }>({ error: '', loading: true });
  const [auto, setAuto] = useState(true);
  const [revision, setRevision] = useState(0);
  const currentPath = useRef(path);
  const requested = useRef({ path, revision });
  useEffect(() => {
    const requestChanged =
      requested.current.path !== path || requested.current.revision !== revision;
    requested.current = { path, revision };
    let alive = true;
    let active = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;
    const isHidden = () => document.visibilityState === 'hidden';
    if (currentPath.current !== path) {
      currentPath.current = path;
      setState({ loading: true, error: '' });
    }
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const load = async () => {
      if (!alive || active || isHidden()) return;
      active = true;
      controller = new AbortController();
      setState((previous) => ({ ...previous, loading: !previous.data }));
      try {
        const data = await api<T>(path, { signal: controller.signal });
        if (alive && !controller.signal.aborted) {
          failures = 0;
          setState({ data, error: '', loading: false, updatedAt: new Date().toISOString() });
        }
      } catch (error) {
        if (alive && !controller.signal.aborted) {
          failures++;
          setState((previous) => ({ ...previous, loading: false, error: errorText(error) }));
        }
      } finally {
        controller.abort();
        active = false;
        if (alive && auto && !isHidden())
          timer = setTimeout(load, Math.min(5000 * 2 ** failures, 30000));
      }
    };
    const visibility = () => {
      clear();
      if (document.visibilityState === 'hidden') controller?.abort();
      else if (auto) {
        if (!active) void load();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    if (auto || requestChanged) void load();
    return () => {
      alive = false;
      clear();
      controller?.abort();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [path, api, auto, revision]);
  return { ...state, auto, setAuto, refresh: () => setRevision((previous) => previous + 1) };
}
export type Resource<T> = ReturnType<typeof useResource<T>>;
export function RefreshBar({
  resource,
  name = '刷新',
}: {
  resource: Pick<Resource<unknown>, 'auto' | 'setAuto' | 'refresh' | 'updatedAt'>;
  name?: string;
}) {
  return (
    <div className="refresh-bar">
      <span>{resource.updatedAt ? '更新于 ' + time(resource.updatedAt) : '正在读取最新状态'}</span>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={resource.auto}
          onChange={(event) => resource.setAuto(event.target.checked)}
        />
        每 5 秒刷新
      </label>
      <button type="button" onClick={resource.refresh}>
        <RefreshCw size={13} aria-hidden="true" />
        {name}
      </button>
    </div>
  );
}
export function ResourceError({ error, stale = false }: { error: string; stale?: boolean }) {
  return error ? (
    <div className="notice error error-inline" role="status">
      {error}
      {stale ? '；数据可能已过期，请手动刷新。' : ' 请稍后重试。'}
    </div>
  ) : null;
}
export function Empty({
  loading = false,
  children,
}: {
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty" role="status">
      {loading ? '正在加载…' : children}
    </div>
  );
}
export function Pagination({
  total,
  page,
  pageSize,
  onPage,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <span>共 {total} 条记录</span>
      <div className="pagination-actions">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          上一页
        </button>
        <span>
          第 {page} 页 / {pages} 页
        </span>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  async function run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    conflictHint = '任务状态可能已改变，请刷新后再试。',
  ): Promise<T | undefined> {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    controller.current = new AbortController();
    try {
      const data = await operation(controller.current.signal);
      return mounted.current && !controller.current.signal.aborted ? data : undefined;
    } catch (error) {
      if (mounted.current && !controller.current.signal.aborted) {
        const conflict = error instanceof ApiError && error.status === 409;
        setError(errorText(error) + (conflict ? ' ' + conflictHint : ''));
      }
    } finally {
      controller.current?.abort();
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return { pending, error, setError, run };
}
export function jobOutcome(job: Job) {
  if (job.kind === 'publish') {
    if (job.outcome === 'published') return '已发布到 CSDN';
    if (job.manual_resolved)
      return job.outcome === 'submitted' ? '已人工结束，CSDN 已受理' : '已人工结束，发布结果未确认';
    if (job.outcome === 'submitted') return 'CSDN 已受理，等待发布结果';
    if (job.run_mode === 'reconcile' && ['queued', 'reconciling', 'running'].includes(job.status))
      return '后台正在核对发布结果';
    if (job.outcome === 'unknown') return '发布结果待核对';
    return (
      (
        { queued: '等待提交发布', running: '正在提交发布', cancelled: '发布任务已取消' } as Record<
          string,
          string
        >
      )[job.status] || '发布尚未提交'
    );
  }
  if (contentOperations[job.kind]) {
    const name = contentOperations[job.kind].result;
    return (
      name +
      ((
        {
          succeeded: '完成',
          failed: '失败',
          cancelled: '已取消',
          waiting_user: '等待登录',
          queued: '排队中',
          running: '中',
        } as Record<string, string>
      )[job.status] || '状态待确认')
    );
  }
  if (job.manual_resolved) return '已人工结束，草稿可能保留';
  if (job.kind === 'check_account')
    return (
      (
        {
          succeeded: '登录状态已检查',
          failed: '账号检查失败',
          waiting_user: '账号需要登录',
          cancelled: '账号检查已取消',
          running: '正在检查账号',
          queued: '等待检查账号',
        } as Record<string, string>
      )[job.status] || '账号结果待确认'
    );
  if (job.outcome === 'draft_saved') return '草稿已保存';
  if (job.run_mode === 'reconcile' && ['queued', 'reconciling', 'running'].includes(job.status))
    return '后台自动核对中';
  if (job.status === 'queued' && (job.absence_checks ?? 0) >= 2) return '确认未保存，等待自动重试';
  if (job.outcome === 'unknown' || job.external_started) return '草稿结果待核对';
  return '尚未保存到CSDN';
}
export function jobHref(id: string, back?: string) {
  return '/jobs/' + encodeURIComponent(id) + (back ? '?back=' + encodeURIComponent(back) : '');
}
export function queryPage(params: URLSearchParams) {
  const page = Number(params.get('page') || 1);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}
