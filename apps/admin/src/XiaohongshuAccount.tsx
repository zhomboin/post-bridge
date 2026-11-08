import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Empty,
  Pagination,
  RefreshBar,
  ResourceError,
  RouteLink,
  Status,
  jobHref,
  queryPage,
  time,
  useAction,
  useResource,
  useWorkspace,
  type Account,
  type Job,
  type PageData,
} from './runtime';

type Note = {
  id: string;
  title: string;
  status: string;
  posted_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
};
export type NotePage = PageData<Note> & {
  snapshot: { synced_at: string } | null;
  sync_job: Job | null;
};
const labels: Record<string, string> = {
  published: '已发布',
  reviewing: '审核中',
  rejected: '未通过',
  unknown: '状态待确认',
};
const active = (job?: Job | null) =>
  !!job && ['queued', 'running', 'waiting_user'].includes(job.status);

export default function XiaohongshuAccount({ id, picker }: { id: string; picker: ReactNode }) {
  const { api, route, navigate } = useWorkspace();
  const params = new URLSearchParams(route.split('?')[1]);
  const settings = params.get('tab') === 'settings';
  const base = '/api/accounts/' + encodeURIComponent(id);
  const account = useResource<{ account: Account }>(base);
  const query = new URLSearchParams({
    page: String(queryPage(params)),
    page_size: '20',
    q: params.get('q') || '',
    status: params.get('status') || '',
  });
  const notes = useResource<NotePage>(base + '/notes?' + query);
  const action = useAction();
  const requestId = useRef<string | undefined>(undefined);
  const [submitted, setSubmitted] = useState<Job | null>(null);
  const [q, setQ] = useState(params.get('q') || '');
  const [status, setStatus] = useState(params.get('status') || '');
  useEffect(() => {
    setQ(params.get('q') || '');
    setStatus(params.get('status') || '');
  }, [route]);
  useEffect(() => {
    if (notes.data?.sync_job?.id === submitted?.id) setSubmitted(null);
  }, [notes.data?.sync_job, submitted]);
  const job = submitted || notes.data?.sync_job;
  const a = account.data?.account;
  function go(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    navigate('/account?' + next);
  }
  async function submit(check = false) {
    requestId.current ??= crypto.randomUUID();
    const result = await action.run((signal) =>
      api<Job>(base + (check ? '/check' : '/notes/sync'), {
        method: 'POST',
        body: JSON.stringify({ request_id: requestId.current }),
        signal,
      }),
    );
    if (result) {
      requestId.current = undefined;
      if (check) navigate(jobHref(result.id, route));
      else {
        setSubmitted(result);
        notes.refresh();
      }
    }
  }
  return (
    <div className="page platform-account-page">
      <div className="page-heading">
        <h1>平台账号</h1>
        {picker}
      </div>
      <section className="surface platform-account-header" aria-label="账号身份">
        <div className="account-summary">
          <div className="account-identity">
            <div>
              <span className="account-platform">小红书</span>
              <h2>{a?.display_name || '小红书账号'}</h2>
              <p>
                <span className="account-id-label">账号 ID</span>
                {a?.username || '—'}
              </p>
            </div>
          </div>
          <Status value={a?.status || 'unchecked'} />
        </div>
        <p className="article-sync-time">最近同步 {time(notes.data?.snapshot?.synced_at)}</p>
      </section>
      <ResourceError error={account.error} stale={!!a} />
      <nav className="account-tabs" aria-label="账号视图">
        <button aria-current={!settings ? 'page' : undefined} onClick={() => go({ tab: '' })}>
          笔记
        </button>
        <button
          aria-current={settings ? 'page' : undefined}
          onClick={() => go({ tab: 'settings' })}
        >
          账号设置
        </button>
      </nav>
      {settings ? (
        <section className="surface">
          <div className="surface-header">
            <h2>账号设置</h2>
            <button
              className="primary"
              disabled={action.pending || !a}
              onClick={() => void submit(true)}
            >
              检查登录状态
            </button>
          </div>
          <RefreshBar resource={account} />
          <div className="surface-body">
            <dl className="readonly-list">
              <dt>最近检查</dt>
              <dd>{time(a?.last_checked_at)}</dd>
            </dl>
            {a?.last_error && (
              <div role="status" className="notice error">
                {a.last_error}
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="surface">
          <div className="surface-header">
            <h2>笔记列表</h2>
            <button
              className="primary"
              disabled={action.pending || active(job) || !a}
              onClick={() => void submit()}
            >
              {action.pending || active(job) ? '同步处理中…' : '同步笔记'}
            </button>
          </div>
          <form
            className="toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              go({ q, status, page: '' });
            }}
          >
            <label>
              搜索笔记
              <input
                value={q}
                maxLength={200}
                placeholder="标题或笔记 ID"
                onChange={(event) => setQ(event.target.value)}
              />
            </label>
            <label>
              笔记状态
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">全部状态</option>
                {Object.entries(labels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">筛选</button>
          </form>
          <RefreshBar resource={notes} name="刷新本地状态" />
          <ResourceError error={notes.error} stale={!!notes.data} />
          {job && (
            <div className="article-job">
              <Status value={job.status} />
              <RouteLink href={jobHref(job.id, route)}>查看同步任务</RouteLink>
              {job.error_message && <span role="status">{job.error_message}</span>}
            </div>
          )}
          {job && ['failed', 'cancelled'].includes(job.status) && notes.data?.snapshot && (
            <div className="notice warning">同步未完成，显示上次快照。</div>
          )}
          {notes.data?.items.length ? (
            <div className="note-table-wrap" tabIndex={0} aria-label="笔记列表，可左右滚动">
              <table className="note-table">
                <thead>
                  <tr>
                    <th>笔记</th>
                    <th>状态</th>
                    <th>发布时间</th>
                    <th>阅读</th>
                    <th>点赞</th>
                    <th>评论</th>
                    <th>收藏</th>
                  </tr>
                </thead>
                <tbody>
                  {notes.data.items.map((note) => (
                    <tr key={note.id}>
                      <td className="title-cell">
                        <strong>{note.title}</strong>
                        <div className="mono">{note.id}</div>
                      </td>
                      <td>{labels[note.status] || labels.unknown}</td>
                      <td>{note.posted_at ? time(note.posted_at) : '—'}</td>
                      {(['views', 'likes', 'comments', 'favorites'] as const).map((key) => (
                        <td key={key}>
                          {note[key] == null ? '—' : note[key].toLocaleString('zh-CN')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty loading={notes.loading}>
              {notes.error
                ? '无法读取笔记列表'
                : notes.data?.snapshot
                  ? q || status
                    ? '没有符合条件的笔记'
                    : '账号暂无笔记'
                  : '尚未同步笔记'}
            </Empty>
          )}
          {notes.data && (
            <Pagination
              total={notes.data.total}
              page={notes.data.page}
              pageSize={notes.data.page_size}
              onPage={(page) => go({ page: String(page) })}
            />
          )}
        </section>
      )}
      {action.error && (
        <div className="notice error" role="alert">
          {action.error}
        </div>
      )}
    </div>
  );
}
