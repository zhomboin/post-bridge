import { useState } from 'react';
import { Empty, Pagination, RefreshBar, ResourceError, Status, stageLabels, statusLabels, time, useResource, type Job } from './runtime';
import type { HistoryPage, ProcessEvent } from './process-types';

const levelNames: Record<string, string> = { info: '信息', warning: '警告', error: '错误' };
function eventName(event: ProcessEvent) {
  return event.status && event.status !== 'running' ? statusLabels[event.status] || event.status : stageLabels[event.stage] || '步骤未记录';
}
export function Workflow({ events, job, loading = false }: { events: ProcessEvent[]; job?: Job; loading?: boolean }) {
  const recorded = events.filter(event => event.status || event.stage);
  const groups = new Map<number, ProcessEvent[]>();
  for (const event of recorded) groups.set(event.attempt, [...(groups.get(event.attempt) || []), event]);
  return <section className="surface section-gap" aria-label="状态流转"><div className="surface-header"><h2>状态流转</h2>{job && <Status value={job.status} cancelling={job.cancel_requested && job.run_mode !== 'reconcile' && ['queued', 'running'].includes(job.status)} />}</div>
    <div className="surface-body workflow-groups">{events.some(event => !event.status) && <p className="muted" role="status">部分状态未采集</p>}{groups.size ? Array.from(groups, ([attempt, entries]) => <div key={attempt} className="workflow-attempt">
      <h3>{attempt ? '第 ' + attempt + ' 次执行' : '任务创建'}</h3>
      <ol className="workflow-graph">{entries.map((event, index) => <li key={event.id} className={'workflow-node ' + (event.status || '')} aria-current={event === recorded.at(-1) ? 'step' : undefined}>
        <span className="workflow-dot" aria-hidden="true">{index + 1}</span><div><strong>{eventName(event)}</strong>{event.run_mode === 'reconcile' && <span className="mode-label">只读核对</span>}{event.status && event.status !== 'running' && event.stage !== 'finished' && <span className="muted">{stageLabels[event.stage] || event.stage}</span>}<time dateTime={event.created_at}>{time(event.created_at)}</time></div>
      </li>)}</ol>
    </div>) : <Empty loading={loading}>状态未采集</Empty>}</div>
  </section>;
}
export default function ProcessTimeline({ jobId, job }: { jobId: string; job?: Job }) {
  const [page, setPage] = useState(1);
  const resource = useResource<HistoryPage>('/api/jobs/' + encodeURIComponent(jobId) + '/history?page=' + page + '&page_size=50');
  return <>
    <ResourceError error={resource.error} stale={!!resource.data} />
    <Workflow events={resource.data?.transitions || []} job={job} loading={resource.loading} />
    <section className="surface section-gap" aria-label="处理日志"><div className="surface-header"><h2>处理日志</h2></div><RefreshBar resource={resource} name="刷新日志" />
      {resource.data?.items.length ? <ol className="process-events">{resource.data.items.map(event => <li key={event.id} className={'process-event ' + event.level}>
        <div className="event-time"><time dateTime={event.created_at}>{time(event.created_at)}</time><span>{event.attempt ? '第 ' + event.attempt + ' 次执行' : '任务创建'}</span></div>
        <div className="event-content"><div className="event-heading"><strong>{stageLabels[event.stage] || '步骤未记录'}</strong><span className={'log-level ' + event.level}>{levelNames[event.level] || '未知级别'}</span>{event.status && <Status value={event.status} />}{event.run_mode === 'reconcile' && <span className="mode-label">只读核对</span>}</div>
          <div className="log-message">{event.message}</div>
        </div>
      </li>)}</ol> : <Empty loading={resource.loading}>暂无处理日志</Empty>}
      {resource.data && <Pagination total={resource.data.total} page={page} pageSize={50} onPage={setPage} />}
    </section>
  </>;
}
