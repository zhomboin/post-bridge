import { useRef } from 'react';
import RemoteLogin from './RemoteLogin';
import { AlertCircle, ArrowUpRight, CheckCircle2, Plus } from 'lucide-react';
import { Empty, RefreshBar, ResourceError, RouteLink, Status, jobHref, statusLabels, time, useAction, useResource, useWorkspace, type Account, type Job, type Overview } from './runtime';

export function Dashboard() {
  const resource = useResource<Overview>('/api/overview');
  const data = resource.data;
  const lastSeen = data?.worker_last_seen_at;
  const workerOnline = !!lastSeen && Date.now() - new Date(lastSeen).getTime() < 45000;
  return <div className="page">
    <div className="page-heading"><div><h1>发布工作台</h1></div><RouteLink className="button primary" href="/jobs/new"><Plus size={16} aria-hidden="true" />新建草稿</RouteLink></div>
    <ResourceError error={resource.error} stale={!!data} />
    {!data ? <section className="surface"><Empty loading={resource.loading}>无法读取总览，请稍后刷新。</Empty><RefreshBar resource={resource} /></section> : <>
      <div className="overview-counts">{['queued', 'running', 'failed', 'waiting_user', 'reconciling'].map(status => <RouteLink className="count-link" key={status} href={'/jobs?status=' + status}>{statusLabels[status]}<strong>{data.counts[status] || 0}</strong></RouteLink>)}</div>
      <section className="surface section-gap"><div className="surface-header"><h2>需要关注</h2></div><RefreshBar resource={resource} />
        <div className="overview-row"><div><h3>{workerOnline ? '执行器在线' : '执行器暂未连接'}</h3><p>最近报告：{time(lastSeen)}</p></div>{workerOnline ? <CheckCircle2 size={18} color="#176443" aria-label="在线" /> : <AlertCircle size={18} color="#855214" aria-label="需关注" />}</div>
        <div className="overview-row"><div><h3>CSDN 账号</h3><Status value={data.account?.status || 'unchecked'} /></div><RouteLink className="button" href="/account">查看账号</RouteLink></div>
        {(data.counts.waiting_user || 0) > 0 && <div className="overview-row"><div><h3>有任务等待登录</h3></div><RouteLink className="button" href="/jobs?status=waiting_user">去处理</RouteLink></div>}
        {(data.counts.reconciling || 0) > 0 && <div className="overview-row"><div><h3>有草稿结果待核对</h3></div><RouteLink className="button" href="/jobs?status=reconciling">去核对</RouteLink></div>}
      </section>
    </>}
  </div>;
}

export function AccountPage() {
  const { api, navigate } = useWorkspace();
  const account = useResource<Account>('/api/account');
  const action = useAction();
  const requestId = useRef<string | undefined>(undefined);
  async function check() {
    requestId.current ||= crypto.randomUUID();
    const result = await action.run(signal => api<Job>('/api/account/check', { method: 'POST', body: JSON.stringify({ request_id: requestId.current }), signal }));
    if (result) { requestId.current = undefined; navigate(jobHref(result.id, '/account')); }
  }
  return <div className="page"><div className="page-heading"><div><h1>CSDN 账号</h1></div><button className="primary" disabled={action.pending || !account.data} onClick={() => void check()}>{action.pending ? '正在创建检查任务…' : '检查登录状态'}</button></div>
    <section className="surface"><div className="surface-header"><h2>平台连接</h2></div><RefreshBar resource={account} /><ResourceError error={account.error} stale={!!account.data} />
      {!account.data ? <Empty loading={account.loading}>无法读取账号信息，请刷新。</Empty> : <div className="surface-body"><div className="account-summary"><div className="account-identity"><div className="account-icon" aria-hidden="true">C</div><div><h2>{account.data.display_name || account.data.username || 'CSDN 固定账号'}</h2><p>{account.data.username || '—'}</p></div></div><Status value={account.data.status} /></div>
        <dl className="readonly-list"><dt>平台</dt><dd>CSDN</dd><dt>最近检查</dt><dd>{time(account.data.last_checked_at)}</dd></dl>
        {account.data.last_error && <div className="notice error section-gap">{account.data.last_error}</div>}
        {action.error && <div className="notice error section-gap" role="alert">{action.error}</div>}
      </div>}
    </section>
    <RemoteLogin onVerified={account.refresh} />
  </div>;
}
