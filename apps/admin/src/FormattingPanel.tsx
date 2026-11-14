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
  const [capabilities, setCapabilities] = useState<{
    enabled: boolean;
    local_enabled?: boolean;
    platforms: string[];
    modes?: Record<string, string[]>;
  }>();
  const [jobID, setJobID] = useState<string>();
  const [sessionID, setSessionID] = useState<string>();
  const [platform, setPlatform] = useState(platforms[0] || 'csdn');
  const [template, setTemplate] = useState('technical');
  const [wechatAI, setWechatAI] = useState(false);
  const [consent, setConsent] = useState(false);
  const available = platforms.includes(platform) ? platform : platforms[0] || 'csdn';
  const wechat = available === 'wechat';
  const offersWechatAI = wechat && capabilities?.modes?.wechat?.includes('ai_assisted');
  const assisted = !!offersWechatAI && wechatAI;
  const mode = assisted ? 'ai_assisted' : 'fidelity';
  const sourceKey = JSON.stringify([source, available, wechat ? mode : null, assisted && consent]);
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
    void api<NonNullable<typeof capabilities>>('/api/formatting-capabilities', {
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
    setConsent(false);
  }, [source.snapshot?.title, source.snapshot?.body]);
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
    if (disabled || !authorized || (assisted && !consent)) return;
    started.current = true;
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
            allow_ai_processing: !wechat || assisted,
            ...(wechat && { mode }),
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
          ...(wechat && { mode }),
        }),
        signal,
      }),
    );
    if (job && activeSource.current === expected) {
      setJobID(job.id);
      resource.setJob(job);
    }
  }
  if (!(available === 'wechat' ? capabilities?.local_enabled : capabilities?.enabled)) return null;
  const running = resource.job && ['queued', 'running'].includes(resource.job.status);
  return (
    <section
      className="formatting-panel"
      aria-label={available === 'wechat' ? '公众号排版' : 'AI 格式化'}
    >
      <div className="surface-header">
        <h3>{available === 'wechat' ? '公众号排版' : 'AI 格式化'}</h3>
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
                    {value === 'csdn' ? 'CSDN' : value === 'wechat' ? '微信公众号' : '小红书'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {offersWechatAI && (
            <label>
              处理模式
              <select
                value={mode}
                disabled={!!running || action.pending}
                onChange={(event) => {
                  setWechatAI(event.target.value === 'ai_assisted');
                  setConsent(false);
                }}
              >
                <option value="fidelity">保真排版</option>
                <option value="ai_assisted">AI 辅助建议</option>
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
            disabled={
              disabled || !authorized || action.pending || !!running || (assisted && !consent)
            }
            onClick={() => void generate()}
          >
            {action.pending
              ? '正在创建…'
              : jobID
                ? '重新生成'
                : available === 'wechat'
                  ? '生成公众号本地稿'
                  : available === 'csdn'
                    ? '生成CSDN平台稿'
                    : '生成小红书图文'}
          </button>
        </div>
      </div>
      {assisted && (
        <label className="formatting-consent">
          <input
            type="checkbox"
            checked={consent}
            disabled={!!running || action.pending}
            onChange={(event) => setConsent(event.target.checked)}
          />
          允许 DeepSeek 处理本篇原稿
        </label>
      )}
      {!authorized && <div className="notice">来源尚未授权 AI 处理。</div>}
      {(action.error || resource.error) && (
        <div className="notice error" role="alert">
          {action.error || resource.error}
        </div>
      )}
      {resource.error && jobID && (
        <button type="button" onClick={resource.reload}>
          重试读取
        </button>
      )}
      {resource.job && (
        <FormattingResult
          job={resource.job}
          onChange={resource.setJob}
          onAdopt={onAdopt}
          sourcePreparation={!!source.preparation_id}
          originalMarkdown={source.snapshot?.body}
        />
      )}
    </section>
  );
}
