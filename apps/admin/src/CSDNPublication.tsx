import { Fragment, useEffect, useState } from 'react';
import { IntegrationModal } from './Integrations';
import ManualJobResolution, { manualResolutionConflictHint } from './ManualJobResolution';
import { csdnPublishOptionGroups, hasCSDNOriginalURL } from './CSDNPublishSettings';
import { RouteLink, errorText, isSourcePaused, jobHref, useAction, useWorkspace, type Job } from './runtime';
import type { CSDNPublishOptions } from './integration-types';

type PublishReview = {
  title: string;
  options: CSDNPublishOptions;
  account_username: string;
  confirmation_token?: string;
  job?: Job;
};

export function canReviewPublication(job: Job) {
  return job.kind === 'save_draft' && job.platform === 'csdn' && job.status === 'succeeded' && job.outcome === 'draft_saved' &&
    job.external_started && !job.cancel_requested && !job.manual_resolved &&
    !!job.integration_distribution_id && /^\d{1,32}$/.test(job.remote_id || '');
}

export function publishedArticleURL(job: Job) {
  if (job.outcome !== 'published' || !job.remote_url || !job.remote_id) return undefined;
  try {
    const url = new URL(job.remote_url);
    const match = /^\/([A-Za-z0-9_-]+)\/article\/details\/(\d{1,32})$/.exec(url.pathname);
    if (url.origin === 'https://blog.csdn.net' && !url.username && !url.password && !url.search && !url.hash &&
      match?.[2] === job.remote_id && (!job.account_username || job.account_username === match[1])) return url.href;
  } catch {
    return undefined;
  }
}

function PublicationConfirmation({ draft, onClose }: { draft: Job; onClose: () => void }) {
  const { api, navigate } = useWorkspace();
  const action = useAction();
  const path = '/api/jobs/' + encodeURIComponent(draft.id) + '/publish';
  const [review, setReview] = useState<PublishReview>();
  const [readError, setReadError] = useState('');
  const [request, setRequest] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<PublishReview>(path, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      if (value?.job?.kind === 'publish' && value.job.id) { setReview(value); return; }
      if (!value?.title || !value.account_username || !value.confirmation_token || !value.options ||
        !csdnPublishOptionGroups.every(([key, , choices]) => choices.some(([code]) => code === value.options[key])) ||
        (value.options.article_type !== 'original' && (!hasCSDNOriginalURL(value.options.original_url) || !value.options.rights_confirmed))) {
        setReadError('无法读取已确认的发布设置。');
        return;
      }
      setReview(value);
    }).catch(error => { if (!controller.signal.aborted) setReadError(errorText(error)); });
    return () => controller.abort();
  }, [api, path, request]);
  const taskHref = (job: Job) => jobHref(job.id, jobHref(draft.id));
  function reload() {
    setReview(undefined);
    setReadError('');
    action.setError('');
    setRequest(current => current + 1);
  }
  async function submit() {
    if (!review?.confirmation_token || review.job || action.pending || action.error) return;
    const job = await action.run(signal => api<Job>(path, {
      method: 'POST', signal, body: JSON.stringify({ confirmation_token: review.confirmation_token }),
    }), '请重新读取发布状态。');
    if (job?.kind === 'publish' && job.id) navigate(taskHref(job));
    else if (job) action.setError('暂时无法确认发布任务，请重新读取发布状态。');
  }
  return <IntegrationModal title="确认发布到 CSDN" className="csdn-publication-modal" onClose={() => { if (!action.pending) onClose(); }}>
    {!review && !readError && <p role="status">正在读取发布设置…</p>}
    {review?.job ? <RouteLink className="button primary" href={taskHref(review.job)}>查看发布任务</RouteLink> : review && <>
      <dl className="readonly-list">
        <dt>文章标题</dt><dd>{review.title}</dd>
        <dt>目标账号</dt><dd>CSDN · <span>{review.account_username}</span></dd>
        {csdnPublishOptionGroups.map(([key, label, choices]) => <Fragment key={key}>
          <dt>{label}</dt><dd className={key === 'visibility' ? 'csdn-publication-visibility' : undefined}>{choices.find(([code]) => code === review.options[key])?.[1]}</dd>
        </Fragment>)}
        {review.options.article_type !== 'original' && <>
          <dt>原文链接</dt><dd>{review.options.original_url}</dd>
          <dt>原文授权</dt><dd>已确认</dd>
        </>}
        <dt>标签</dt><dd>{review.options.tags?.join('、') || '无'}</dd>
        <dt>专栏</dt><dd>{review.options.categories?.join('、') || '无'}</dd>
        <dt>摘要</dt><dd>{review.options.summary || '自动生成'}</dd>
        <dt>封面</dt><dd>{review.options.cover_image_url ? '使用来源封面' : '无'}</dd>
      </dl>
      {!action.error && <div className="form-footer section-gap">
        <button type="button" className="primary" disabled={action.pending} onClick={() => void submit()}>{action.pending ? '正在提交…' : '确认发布'}</button>
      </div>}
    </>}
    {(readError || action.error) && <>
      <div className="notice error section-gap" role="alert">{readError || action.error}</div>
      <button type="button" className="section-gap" onClick={reload}>重新读取发布状态</button>
    </>}
  </IntegrationModal>;
}

export function PublishDraftAction({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="primary" onClick={() => setOpen(true)}>正式发布</button>
    {open && <PublicationConfirmation draft={job} onClose={() => setOpen(false)} />}
  </>;
}

export function PublishJobActions({ job, onUpdate }: { job: Job; onUpdate: () => void }) {
  const { api } = useWorkspace();
  const action = useAction();
  const [accepted, setAccepted] = useState(false);
  const [resolved, setResolved] = useState(false);
  useEffect(() => { setAccepted(false); }, [job]);
  const sourcePaused = isSourcePaused(job);
  const needsReconciliation = job.outcome === 'unknown' || job.outcome === 'submitted';
  const active = ['queued', 'reconciling', 'running'].includes(job.status);
  const canResolve = needsReconciliation && job.external_started && ['reconciling', 'waiting_user', 'failed'].includes(job.status);
  const canResume = job.status === 'waiting_user' && job.outcome === 'not_submitted' &&
    !job.external_started && !sourcePaused && job.run_mode !== 'reconcile';
  const canCancel = (job.status === 'queued' || job.status === 'waiting_user') &&
    job.outcome === 'not_submitted' && !job.external_started;
  if (job.manual_resolved || resolved || (!needsReconciliation && !canResume && !canCancel && !sourcePaused && !active)) return null;
  async function perform(name: 'reconcile' | 'resume' | 'cancel' | 'resolve', body: object = {}) {
    const result = await action.run(signal => api<Job>('/api/jobs/' + encodeURIComponent(job.id) + '/' + name, {
      method: 'POST', body: JSON.stringify(body), signal,
    }), name === 'resolve' ? manualResolutionConflictHint : undefined);
    if (result) {
      if (name === 'resolve') setResolved(true);
      else setAccepted(true);
      onUpdate();
    }
  }
  return <section className="surface detail-actions-surface">
    <div className="surface-header"><h2>任务处理</h2></div>
    <div className="surface-body action-panel">
      {needsReconciliation ? <>
        {job.status === 'waiting_user' && <RouteLink className="button" href="/account?tab=settings">登录 CSDN</RouteLink>}
        <button type="button" className="primary" disabled={action.pending || active || accepted} onClick={() => void perform('reconcile')}>
          {active || accepted ? '正在核对发布结果…' : '仅核对发布结果'}
        </button>
        {canResolve && <ManualJobResolution publication disabled={action.pending || accepted}
          onResolve={input => void perform('resolve', input)} />}
      </> : canResume ? <>
        <RouteLink className="button" href="/account?tab=settings">登录 CSDN</RouteLink>
        <button type="button" className="primary" disabled={action.pending || accepted} onClick={() => void perform('resume')}>登录完成，继续发布</button>
      </> : sourcePaused ? <p role="status">来源授权待处理</p> : <p role="status">发布任务处理中</p>}
      {canCancel && <button type="button" disabled={action.pending || accepted} onClick={() => void perform('cancel')}>取消发布任务</button>}
      {action.error && <div className="notice error" role="alert">{action.error}</div>}
    </div>
  </section>;
}
