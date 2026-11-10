import { useEffect, useState } from 'react';
import { Empty, RouteLink, errorText, time, useResource, useWorkspace } from './runtime';
import type { FormattingJob, FormattingSession } from './formatting-contract';
import FormattingResult from './FormattingResult';
import { formattingLabels, useFormattingJob } from './formatting-resource';
import './Formatting.css';
export function FormattingList() {
  const [page, setPage] = useState(1);
  const { data, error, loading } = useResource<{ items: FormattingJob[] }>(
    '/api/formatting-jobs?page_size=20&page=' + page,
  );
  return (
    <div className="page">
      <div className="page-heading">
        <h1>格式化稿</h1>
        <RouteLink href="/formatting/new" className="button primary">
          新建格式化稿
        </RouteLink>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!data?.items.length ? (
        <Empty loading={loading}>暂无格式化稿</Empty>
      ) : (
        <div className="surface formatting-list">
          {data.items.map((job) => (
            <RouteLink key={job.id} href={'/formatting/' + job.id}>
              <span>
                <strong>{job.title}</strong>
                <br />
                {job.platform === 'csdn' ? 'CSDN' : '小红书'} ·{' '}
                {formattingLabels[job.status] || job.status}
              </span>
              <span>{time(job.created_at)}</span>
            </RouteLink>
          ))}
        </div>
      )}
      {(page > 1 || data?.items.length === 20) && (
        <div className="heading-actions section-gap">
          <button type="button" disabled={loading || page === 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button
            type="button"
            disabled={loading || !data || data.items.length < 20}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
export function FormattingDetail({ id }: { id: string }) {
  const { api } = useWorkspace();
  const resource = useFormattingJob(id);
  const [session, setSession] = useState<FormattingSession>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!resource.job) return;
    const controller = new AbortController();
    void api<FormattingSession>('/api/formatting-sessions/' + resource.job.session_id, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setSession(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [api, resource.job?.session_id]);
  return (
    <div className="page">
      <RouteLink href="/formatting" className="back-link">
        返回格式化稿
      </RouteLink>
      <div className="page-heading">
        <h1>{session?.snapshot.title || '格式化稿'}</h1>
      </div>
      {(error || resource.error) && (
        <div className="notice error" role="alert">
          {error || resource.error}
        </div>
      )}
      {!resource.job ? (
        <Empty loading={!resource.error}>暂时无法读取</Empty>
      ) : (
        <div className="formatting-columns">
          {session && (
            <section className="surface">
              <div className="surface-header">
                <h2>原稿</h2>
              </div>
              <div className="surface-body">
                <pre className="formatting-original">{session.snapshot.body}</pre>
              </div>
            </section>
          )}
          <section className="surface">
            <div className="surface-header">
              <h2>平台稿</h2>
            </div>
            <div className="surface-body">
              <FormattingResult
                job={resource.job}
                onChange={resource.setJob}
                sourcePreparation={!!session?.preparation_id}
              />
              {session?.preparation_id && (
                <RouteLink href={'/integration-preparations/' + session.preparation_id}>
                  查看来源平台稿
                </RouteLink>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
