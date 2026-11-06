import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Empty, Pagination, RefreshBar, ResourceError, RouteLink, Status, jobHref, jobOutcome, queryPage, stageLabel, statusLabels, time, useResource, useWorkspace, type Job, type PageData } from './runtime';
import { operationName, platformName, processHref, type ProcessSummary } from './process-types';
import ProcessTimeline from './ProcessTimeline';
import ContentComparison from './ContentComparison';

export default function Processes() {
  const { route, navigate } = useWorkspace();
  const params = new URLSearchParams(route.split('?')[1]);
  const [q, setQ] = useState(params.get('q') || '');
  const [status, setStatus] = useState(params.get('status') || '');
  const [kind, setKind] = useState(params.get('kind') || '');
  const [platform, setPlatform] = useState(params.get('platform') || '');
  const [from, setFrom] = useState(params.get('from') || '');
  const [to, setTo] = useState(params.get('to') || '');
  const [validation, setValidation] = useState('');
  useEffect(() => { const values = new URLSearchParams(route.split('?')[1]); setQ(values.get('q') || ''); setStatus(values.get('status') || ''); setKind(values.get('kind') || ''); setPlatform(values.get('platform') || ''); setFrom(values.get('from') || ''); setTo(values.get('to') || ''); }, [route]);
  const page = queryPage(params);
  const search = new URLSearchParams({ page: String(page), page_size: '50' });
  for (const name of ['q', 'status', 'kind', 'platform', 'job_id', 'level', 'from', 'to']) {
    const value = params.get(name);
    if (value) { const date = ['from', 'to'].includes(name) ? new Date(value) : undefined; search.set(name, date && !Number.isNaN(date.getTime()) ? date.toISOString() : value); }
  }
  const resource = useResource<PageData<ProcessSummary>>('/api/processes?' + search);
  function submit(event: FormEvent) {
    event.preventDefault(); setValidation('');
    const start = from ? new Date(from) : undefined, end = to ? new Date(to) : undefined;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) { setValidation('请输入有效的起止时间。'); return; }
    if (start && end && (end < start || end.getTime() - start.getTime() > 31 * 86400000)) { setValidation('查询结束时间须晚于开始时间，范围最多 31 天。'); return; }
    const next = new URLSearchParams();
    for (const [name, value] of Object.entries({ q: q.trim(), status, kind, platform, from, to })) if (value) next.set(name, value);
    navigate('/logs' + (next.size ? '?' + next : ''));
  }
  return <div className="page"><div className="page-heading"><h1>处理记录</h1><RouteLink className="button" href="/logs?view=events">全部日志</RouteLink></div>
    <section className="surface"><form className="toolbar process-filters" onSubmit={submit}>
      <label className="search">搜索对象<input value={q} onChange={event => setQ(event.target.value)} placeholder="文章、对象或任务ID" /></label>
      <label>平台<select value={platform} onChange={event => setPlatform(event.target.value)}><option value="">全部平台</option><option value="csdn">CSDN</option></select></label>
      <label>操作<select aria-label="操作" value={kind} onChange={event => setKind(event.target.value)}><option value="">全部操作</option><option value="save_draft">保存草稿</option><option value="publish">正式发布</option><option value="check_account">检查账号</option><option value="sync_articles">同步文章</option><option value="read_article">读取正文</option></select></label>
      <label>处理状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{['queued','running','waiting_user','reconciling','succeeded','failed','cancelled'].map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}</select></label>
      <label>开始时间<input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label><label>结束时间<input type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></label>
      <button type="submit">查询</button>
    </form>
    {validation && <div className="notice error error-inline" role="alert">{validation}</div>}<RefreshBar resource={resource} /><ResourceError error={resource.error} stale={!!resource.data} />
    {resource.data?.items.length ? <table className="data-table process-table"><thead><tr><th className="title-cell">对象 / 本次处理</th><th>平台 / 账号</th><th>操作 / 进度</th><th>最终结果</th><th>最近更新</th></tr></thead><tbody>{resource.data.items.map(item => <tr key={item.id}>
      <td className="title-cell"><RouteLink className="title-link" href={processHref(item.id, route)}>{item.object_name || item.title || '平台账号'}</RouteLink><div className="job-subline"><span>{item.object_type === 'account' ? '账号' : '文章'}</span><span className="mono">{item.object_id}</span></div><div className="job-subline mono">任务 {item.id}</div></td>
      <td><strong>{platformName(item.platform)}</strong><div className="table-title-note">{item.account_name || item.account_id}</div></td>
      <td>{operationName(item.kind)}<div className="table-title-note">{stageLabel(item.stage, item.kind) || '步骤待确认'}</div><Status value={item.status} cancelling={item.cancel_requested && item.run_mode !== 'reconcile' && ['queued', 'running'].includes(item.status)} /></td>
      <td><strong className="process-result">{jobOutcome(item)}</strong><div className="job-subline"><span>{item.event_count} 条日志</span>{item.warning_count > 0 && <span>{item.warning_count} 条警告</span>}{item.error_count > 0 && <span>{item.error_count} 条错误</span>}</div></td>
      <td><time dateTime={item.updated_at}>{time(item.updated_at)}</time></td>
    </tr>)}</tbody></table> : <Empty loading={resource.loading}>暂无符合条件的处理记录</Empty>}
    {resource.data && <Pagination total={resource.data.total} page={page} pageSize={50} onPage={value => { params.set('page', String(value)); navigate('/logs?' + params); }} />}
    </section>
  </div>;
}
export function ProcessDetail({ id }: { id: string }) {
  const { route } = useWorkspace();
  const resource = useResource<Job>('/api/jobs/' + encodeURIComponent(id));
  const back = new URLSearchParams(route.split('?')[1]).get('back');
  const backHref = back && /^\/logs(?:\?|$)/.test(back) ? back : '/logs';
  const job = resource.data;
  return <div className="page"><RouteLink className="back-link" href={backHref}><ArrowLeft size={14} aria-hidden="true" />返回处理记录</RouteLink>
    <ResourceError error={resource.error} stale={!!job} />
    {!job ? <section className="surface"><Empty loading={resource.loading}>无法读取处理记录</Empty><RefreshBar resource={resource} /></section> : <>
      <div className="page-heading"><div><h1 className="detail-title">{job.title || 'CSDN ' + operationName(job.kind)}</h1><p className="mono">{job.id}</p></div><RouteLink className="button" href={jobHref(job.id, route)}>任务详情</RouteLink></div>
      <section className="surface"><div className="surface-header"><h2>处理结果</h2><Status value={job.status} cancelling={job.cancel_requested && job.run_mode !== 'reconcile' && ['queued', 'running'].includes(job.status)} /></div><RefreshBar resource={resource} /><div className="surface-body"><strong className="process-outcome">{jobOutcome(job)}</strong><dl className="detail-facts section-gap">
        <div><dt>平台</dt><dd>{platformName(job.platform)}</dd></div><div><dt>账号</dt><dd>{job.account_id}</dd></div><div><dt>操作</dt><dd>{operationName(job.kind)}</dd></div><div><dt>对象标识</dt><dd className="mono">{['check_account', 'sync_articles'].includes(job.kind) ? job.account_id : job.kind === 'read_article' ? job.article_id || '未记录' : job.remote_id || job.id}</dd></div><div><dt>开始时间</dt><dd>{time(job.started_at || job.created_at)}</dd></div><div><dt>结束时间</dt><dd>{job.finished_at ? time(job.finished_at) : '尚未结束'}</dd></div>
      </dl>{job.error_message && <div className="notice error section-gap" role="status">{job.error_message}</div>}</div></section>
      <ContentComparison kind={job.kind} jobId={job.id} active={['queued','running','reconciling','waiting_user'].includes(job.status)} />
      <ProcessTimeline jobId={job.id} job={job} />
    </>}
  </div>;
}
