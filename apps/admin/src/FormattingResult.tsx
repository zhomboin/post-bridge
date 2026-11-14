import { lazy, Suspense, useState } from 'react';
import XiaohongshuFormatting from './XiaohongshuFormatting';
import ReactMarkdown from 'react-markdown';
import FormattingDifferences from './FormattingDifferences';
import { IntegrationModal } from './IntegrationDialog';
import { RouteLink, useAction, useWorkspace, type Job } from './runtime';
import { formattingLabels } from './formatting-resource';
import type { FormattingJob, FormattingOutput } from './formatting-contract';
import type { Preparation } from './integration-types';

const WechatFormatting = lazy(() => import('./WechatFormatting'));

export default function FormattingResult({
  job,
  onChange,
  onAdopt,
  sourcePreparation = false,
  originalMarkdown,
}: {
  job: FormattingJob;
  onChange: (job: FormattingJob) => void;
  onAdopt?: (output: FormattingOutput, preparation?: Preparation) => void;
  sourcePreparation?: boolean;
  originalMarkdown?: string;
}) {
  const { api, navigate } = useWorkspace();
  const action = useAction();
  const [confirm, setConfirm] = useState<'adopt' | 'save'>();
  async function perform() {
    if (!confirm) return;
    if (confirm === 'save') {
      const result = await action.run((signal) =>
        api<Job>('/api/formatting-jobs/' + job.id + '/csdn-draft', {
          method: 'POST',
          body: JSON.stringify({ revision: job.revision }),
          signal,
        }),
      );
      if (result) navigate('/jobs/' + result.id);
    } else {
      const result = await action.run((signal) =>
        api<{ job: FormattingJob; preparation?: Preparation }>(
          '/api/formatting-jobs/' + job.id + '/adopt',
          { method: 'POST', body: JSON.stringify({ revision: job.revision }), signal },
        ),
      );
      if (result) {
        onChange(result.job);
        if (result.job.result) onAdopt?.(result.job.result, result.preparation);
        setConfirm(undefined);
      }
    }
  }
  async function cancel() {
    const result = await action.run((signal) =>
      api<FormattingJob>('/api/formatting-jobs/' + job.id + '/cancel', { method: 'POST', signal }),
    );
    if (result) onChange(result);
  }
  return (
    <div className="formatting-result">
      <div className="formatting-status" role="status">
        {job.platform === 'wechat' && job.status === 'adopted'
          ? '已确认'
          : formattingLabels[job.status] || job.status}
        {job.status === 'running' ? ' · ' + (formattingLabels[job.stage] || job.stage) : ''}
      </div>
      {['queued', 'running'].includes(job.status) && (
        <button type="button" disabled={action.pending} onClick={() => void cancel()}>
          取消生成
        </button>
      )}
      {job.error_code && (
        <div className="notice error" role="alert">
          {formattingLabels[job.error_code] || '格式化处理未完成。'}
        </div>
      )}
      {job.result && job.platform === 'xiaohongshu' && (
        <XiaohongshuFormatting job={job} onChange={onChange} />
      )}
      {job.result?.wechat && job.platform === 'wechat' && (
        <Suspense fallback={<div role="status">正在加载…</div>}>
          <WechatFormatting job={job} onChange={onChange} originalMarkdown={originalMarkdown} />
        </Suspense>
      )}
      {job.result && job.platform === 'csdn' && (
        <>
          <h3>{job.result.title}</h3>
          {job.result.summary && <p className="formatting-summary">{job.result.summary}</p>}
          {!!job.result.tags.length && (
            <div className="formatting-tags">
              {job.result.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          )}
          <div className="markdown-preview" aria-label="AI 格式化结果">
            <ReactMarkdown
              skipHtml
              disallowedElements={['img']}
              components={{ a: ({ children }) => <span>{children}</span> }}
            >
              {job.result.markdown}
            </ReactMarkdown>
          </div>
          {originalMarkdown !== undefined && (
            <FormattingDifferences original={originalMarkdown} candidate={job.result.markdown} />
          )}
          {job.result.issues.map((issue, index) => (
            <div
              key={index}
              className={'notice ' + (issue.blocking ? 'error' : '')}
              role={issue.blocking ? 'alert' : undefined}
            >
              {issue.message}
            </div>
          ))}
          <div className="heading-actions section-gap">
            {job.status === 'succeeded' && (
              <button
                type="button"
                className="primary"
                disabled={action.pending}
                onClick={() => setConfirm('adopt')}
              >
                采用CSDN平台稿
              </button>
            )}
            {!sourcePreparation && job.status === 'adopted' && (
              <button
                type="button"
                className="primary"
                disabled={action.pending}
                onClick={() => setConfirm('save')}
              >
                保存到CSDN草稿
              </button>
            )}
            <RouteLink href={'/formatting/' + job.id}>查看格式化稿</RouteLink>
          </div>
        </>
      )}
      {action.error && (
        <div className="notice error" role="alert">
          {action.error}
        </div>
      )}
      {confirm && (
        <IntegrationModal
          title={confirm === 'save' ? '保存CSDN草稿' : '采用CSDN平台稿'}
          onClose={() => {
            if (!action.pending) setConfirm(undefined);
          }}
        >
          <p>
            {confirm === 'save'
              ? '确认将当前修订保存到所选 CSDN 账号的草稿箱？'
              : sourcePreparation
                ? '确认保存为新的平台稿修订？采用后需要重新确认平台稿。'
                : '确认采用当前格式化稿修订？'}
          </p>
          <button
            type="button"
            className="primary"
            disabled={action.pending}
            onClick={() => void perform()}
          >
            {action.pending ? '正在处理…' : '确认'}
          </button>
          {action.error && (
            <div className="notice error" role="alert">
              {action.error}
            </div>
          )}
        </IntegrationModal>
      )}
    </div>
  );
}
