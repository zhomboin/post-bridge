import { useEffect, useRef, useState } from 'react';
import { useAction, useWorkspace } from './runtime';
import FormattingResult from './FormattingResult';
import { useFormattingJob } from './formatting-resource';
import type {
  FormattingJob,
  FormattingOutput,
  FormattingSession,
  FormattingSnapshot,
} from './formatting-contract';
import type { Preparation } from './integration-types';
import './Formatting.css';
export type FormattingSource = {
  preparation_id?: string;
  base_revision?: number;
  account_id?: string;
  snapshot?: FormattingSnapshot;
};
export default function FormattingPanel({
  source,
  disabled = false,
  authorized = true,
  onAdopt,
  platforms = ['csdn'],
}: {
  source: FormattingSource;
  disabled?: boolean;
  authorized?: boolean;
  platforms?: string[];
  onAdopt?: (output: FormattingOutput, preparation?: Preparation) => void;
}) {
  const { api } = useWorkspace();
  const action = useAction();
  const [capabilities, setCapabilities] = useState<{ enabled: boolean; platforms: string[] }>();
  const [jobID, setJobID] = useState<string>();
  const [sessionID, setSessionID] = useState<string>();
  const [platform, setPlatform] = useState(platforms[0] || 'csdn');
  const [template, setTemplate] = useState('technical');
  const available = platforms.includes(platform) ? platform : platforms[0] || 'csdn';
  const sourceKey = JSON.stringify([source, available]);
  const activeSource = useRef(sourceKey);
  activeSource.current = sourceKey;
  const started = useRef(false);
  const request = useRef({
    source: sourceKey,
    session: crypto.randomUUID(),
    job: crypto.randomUUID(),
  });
  const resource = useFormattingJob(jobID);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ enabled: boolean; platforms: string[] }>('/api/formatting-capabilities', {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setCapabilities(result);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api]);
  useEffect(() => {
    setJobID(undefined);
    setSessionID(undefined);
    started.current = false;
    request.current = { source: sourceKey, session: crypto.randomUUID(), job: crypto.randomUUID() };
  }, [sourceKey]);
  useEffect(() => {
    if (!source.preparation_id) return;
    const controller = new AbortController();
    void api<{ items: FormattingJob[] }>(
      '/api/formatting-jobs?preparation_id=' +
        encodeURIComponent(source.preparation_id) +
        '&platform=' +
        available,
      { signal: controller.signal },
    )
      .then((result) => {
        if (
          !controller.signal.aborted &&
          activeSource.current === sourceKey &&
          !started.current &&
          result.items[0]
        )
          setJobID(result.items[0].id);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, source.preparation_id, sourceKey, available]);
  async function generate() {
    const expected = sourceKey;
    started.current = true;
    if (disabled || !authorized) return;
    if (resource.job && !['queued', 'running'].includes(resource.job.status))
      request.current.job = crypto.randomUUID();
    let id = sessionID;
    if (!id) {
      const session = await action.run((signal) =>
        api<FormattingSession>('/api/formatting-sessions', {
          method: 'POST',
          body: JSON.stringify({
            ...source,
            request_id: request.current.session,
            platforms: [available],
            allow_ai_processing: true,
          }),
          signal,
        }),
      );
      if (!session || activeSource.current !== expected) return;
      id = session.id;
      setSessionID(id);
    }
    const job = await action.run((signal) =>
      api<FormattingJob>('/api/formatting-sessions/' + id + '/jobs', {
        method: 'POST',
        body: JSON.stringify({
          request_id: request.current.job,
          platform: available,
          template: available === 'xiaohongshu' ? template : '',
        }),
        signal,
      }),
    );
    if (job && activeSource.current === expected) {
      setJobID(job.id);
      resource.setJob(job);
    }
  }
  if (!capabilities?.enabled) return null;
  const running = resource.job && ['queued', 'running'].includes(resource.job.status);
  return (
    <section className="formatting-panel" aria-label="AI 格式化">
      <div className="surface-header">
        <h3>AI 格式化</h3>
        <div className="heading-actions">
          {platforms.length > 1 && (
            <label>
              目标平台
              <select
                value={available}
                disabled={!!running || action.pending}
                onChange={(e) => setPlatform(e.target.value)}
              >
                {platforms.map((value) => (
                  <option key={value} value={value}>
                    {value === 'csdn' ? 'CSDN' : '小红书'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {available === 'xiaohongshu' && (
            <label>
              卡片样式
              <select
                value={template}
                disabled={!!running || action.pending}
                onChange={(e) => setTemplate(e.target.value)}
              >
                <option value="technical">技术笔记</option>
                <option value="checklist">操作清单</option>
              </select>
            </label>
          )}
          <button
            type="button"
            disabled={disabled || !authorized || action.pending || !!running}
            onClick={() => void generate()}
          >
            {action.pending
              ? '正在创建…'
              : jobID
                ? '重新生成'
                : available === 'csdn'
                  ? '生成CSDN平台稿'
                  : '生成小红书图文'}
          </button>
        </div>
      </div>
      {!authorized && <div className="notice">来源尚未授权 AI 处理。</div>}
      {(action.error || resource.error) && (
        <div className="notice error" role="alert">
          {action.error || resource.error}
        </div>
      )}
      {resource.job && (
        <FormattingResult
          job={resource.job}
          onChange={resource.setJob}
          onAdopt={onAdopt}
          sourcePreparation={!!source.preparation_id}
        />
      )}
    </section>
  );
}
