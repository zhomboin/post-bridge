import { AlertCircle, CheckCircle2, Plus } from 'lucide-react';
import { Empty, RefreshBar, ResourceError, RouteLink, Status, statusLabels, time, useResource, type Overview } from './runtime';

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
        <div className="overview-row"><div><h3>CSDN 账号</h3><Status value={data.account?.status || 'unchecked'} /></div><RouteLink className="button" href="/account?tab=settings">查看账号</RouteLink></div>
        {(data.counts.waiting_user || 0) > 0 && <div className="overview-row"><div><h3>有任务等待处理</h3></div><RouteLink className="button" href="/jobs?status=waiting_user">去处理</RouteLink></div>}
        {(data.counts.reconciling || 0) > 0 && <div className="overview-row"><div><h3>有任务结果待核对</h3></div><RouteLink className="button" href="/jobs?status=reconciling">去核对</RouteLink></div>}
      </section>
    </>}
  </div>;
}
