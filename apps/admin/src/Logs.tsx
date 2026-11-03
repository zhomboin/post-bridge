import { useEffect, useState, type FormEvent } from 'react';
import { Empty, Pagination, RefreshBar, ResourceError, RouteLink, jobHref, queryPage, stageLabels, time, useResource, useWorkspace, type LogEntry, type PageData } from './runtime';

const levelNames: Record<string, string> = { info: '信息', warning: '警告', error: '错误' };
export default function Logs({ jobId }: { jobId?: string }) {
  const { route, navigate } = useWorkspace();
  const params = new URLSearchParams(route.split('?')[1]);
  const [detailPage, setDetailPage] = useState(1);
  const [q, setQ] = useState(params.get('q') || '');
  const [level, setLevel] = useState(params.get('level') || '');
  const [job, setJob] = useState(params.get('job_id') || '');
  const [from, setFrom] = useState(params.get('from') || '');
  const [to, setTo] = useState(params.get('to') || '');
  const [validation, setValidation] = useState('');
  useEffect(() => {
    if (!jobId) {
      const values = new URLSearchParams(route.split('?')[1]);
      setQ(values.get('q') || ''); setLevel(values.get('level') || ''); setJob(values.get('job_id') || '');
      setFrom(values.get('from') || ''); setTo(values.get('to') || '');
    }
  }, [route, jobId]);
  const page = jobId ? detailPage : queryPage(params);
  const search = new URLSearchParams({ page: String(page), page_size: '50' });
  if (jobId) search.set('job_id', jobId);
  else for (const key of ['q', 'level', 'job_id', 'from', 'to']) {
    const value = params.get(key);
    if (value) {
      const date = (key === 'from' || key === 'to') ? new Date(value) : undefined;
      search.set(key, date && !Number.isNaN(date.getTime()) ? date.toISOString() : value);
    }
  }
  const resource = useResource<PageData<LogEntry>>('/api/logs?' + search);
  function submit(event: FormEvent) {
    event.preventDefault(); setValidation('');
    const start = from ? new Date(from) : undefined;
    const end = to ? new Date(to) : undefined;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) { setValidation('请输入有效的起止时间。'); return; }
    if (start && end && (end < start || end.getTime() - start.getTime() > 31 * 86400000)) { setValidation('查询结束时间须晚于开始时间，范围最多 31 天。'); return; }
    const next = new URLSearchParams();
    if (q.trim()) next.set('q', q.trim());
    if (level) next.set('level', level);
    if (job.trim()) next.set('job_id', job.trim());
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    navigate('/logs' + (next.size ? '?' + next : ''));
  }
  function changePage(value: number) {
    if (jobId) setDetailPage(value);
    else { params.set('page', String(value)); navigate('/logs?' + params); }
  }
  const content = <section className="surface">
    <div className="surface-header"><h2>{jobId ? '任务日志' : '运行记录'}</h2><span className="muted" style={{ fontSize: 12 }}>脱敏文本</span></div>
    {!jobId && <form className="toolbar log-filters" onSubmit={submit}>
      <label className="search">搜索日志<input value={q} onChange={event => setQ(event.target.value)} placeholder="关键词" /></label>
      <label>日志级别<select value={level} onChange={event => setLevel(event.target.value)}><option value="">全部级别</option>{Object.entries(levelNames).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
      <label>关联任务ID<input value={job} onChange={event => setJob(event.target.value)} placeholder="全部任务" /></label>
      <label>开始时间<input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>结束时间<input type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></label>
      <button type="submit">查询</button>
    </form>}
    {validation && <div className="notice error error-inline" role="alert">{validation}</div>}
    <RefreshBar resource={resource} name={jobId ? '刷新日志' : '刷新'} />
    <ResourceError error={resource.error} stale={!!resource.data} />
    {resource.data?.items.length ? <ul className="log-list">{resource.data.items.map(entry => <li className="log-item" key={entry.id}>
      <time className="log-time" dateTime={entry.created_at}>{time(entry.created_at)}</time>
      <span className={'log-level ' + (levelNames[entry.level] ? entry.level : '')}>{levelNames[entry.level] || '未知级别'}</span>
      <div className="log-message-wrap"><div className="log-message">{entry.message}</div><div className="log-meta">
        {entry.stage && <span>{stageLabels[entry.stage] || entry.stage}</span>}
        {entry.attempt !== undefined && <span>第 {entry.attempt} 次执行</span>}
        {entry.job_id && <RouteLink className="mono" href={jobHref(entry.job_id, route)}>{entry.job_id}</RouteLink>}
      </div></div>
    </li>)}</ul> : <Empty loading={resource.loading}><strong>暂无符合条件的日志</strong>默认查询最近 24 小时，可调整关键词和时间范围。</Empty>}
    {resource.data && <Pagination total={resource.data.total} page={page} pageSize={50} onPage={changePage} />}
  </section>;
  return jobId ? content : <div className="page"><div className="page-heading"><div><h1>运行日志</h1><p>查看任务步骤、异常原因与处理结果。默认最近 24 小时，单次最多 31 天。</p></div></div>{content}</div>;
}
