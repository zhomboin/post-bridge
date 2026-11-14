import { useEffect, useRef, useState } from 'react';
import { IntegrationModal } from './IntegrationDialog';
import { useAction, useWorkspace } from './runtime';
import type { FormattingJob, FormattingOutput } from './formatting-contract';
export default function XiaohongshuFormatting({
  job,
  onChange,
}: {
  job: FormattingJob;
  onChange: (job: FormattingJob) => void;
}) {
  const { api } = useWorkspace();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [output, setOutput] = useState<FormattingOutput>();
  const [template, setTemplate] = useState(job.template);
  const request = useRef({ fingerprint: '', id: crypto.randomUUID() });
  useEffect(() => {
    setOutput(job.result ? structuredClone(job.result) : undefined);
    setTemplate(job.template);
    setEditing(false);
  }, [job.id, job.revision, job.status]);
  const editable =
    !!job.result &&
    (['succeeded', 'needs_review', 'adopted'].includes(job.status) ||
      (job.status === 'failed' && job.operation === 'render'));
  function patch(value: Partial<FormattingOutput>) {
    setOutput((current) => (current ? { ...current, ...value } : current));
  }
  function card(index: number, value: Partial<FormattingOutput['cards'][number]>) {
    patch({ cards: output!.cards.map((item, i) => (i === index ? { ...item, ...value } : item)) });
  }
  async function save() {
    if (!output) return;
    const body = {
      revision: job.revision,
      template,
      output: { ...output, binding: undefined, assets: [], issues: [] },
    };
    const fingerprint = JSON.stringify(body);
    if (request.current.fingerprint !== fingerprint)
      request.current = { fingerprint, id: crypto.randomUUID() };
    const result = await action.run((signal) =>
      api<FormattingJob>('/api/formatting-jobs/' + job.id, {
        method: 'PUT',
        body: JSON.stringify({ ...body, request_id: request.current.id }),
        signal,
      }),
    );
    if (result) {
      onChange(result);
      setEditing(false);
    }
  }
  async function confirmDraft() {
    const result = await action.run((signal) =>
      api<FormattingJob>('/api/formatting-jobs/' + job.id + '/confirm', {
        method: 'POST',
        body: JSON.stringify({ revision: job.revision }),
        signal,
      }),
    );
    if (result) {
      onChange(result);
      setConfirm(false);
    }
  }
  if (!job.result || !output) return null;
  return (
    <div className="xiaohongshu-formatting">
      <div className="editor-tabs">
        <button type="button" aria-pressed={!editing} onClick={() => setEditing(false)}>
          预览
        </button>
        <button
          type="button"
          aria-pressed={editing}
          disabled={!editable || action.pending}
          onClick={() => setEditing(true)}
        >
          编辑图文
        </button>
      </div>
      {editing ? (
        <div className="form-grid section-gap">
          <label>
            笔记标题
            <input
              value={output.title}
              maxLength={20}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </label>
          <label>
            笔记正文
            <textarea
              className="markdown-editor formatting-note-editor"
              value={output.body}
              onChange={(e) => patch({ body: e.target.value })}
            />
          </label>
          <label>
            话题
            <input
              value={output.topics.join('，')}
              onChange={(e) =>
                patch({
                  topics: e.target.value
                    .split(/[,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label>
            封面标题
            <input
              value={output.cover_title}
              maxLength={30}
              onChange={(e) => patch({ cover_title: e.target.value })}
            />
          </label>
          <label>
            封面副标题
            <input
              value={output.cover_subtitle}
              maxLength={80}
              onChange={(e) => patch({ cover_subtitle: e.target.value })}
            />
          </label>
          <label>
            卡片样式
            <select value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="technical">技术笔记</option>
              <option value="checklist">操作清单</option>
            </select>
          </label>
          {output.cards.map((item, index) => (
            <fieldset className="formatting-card-editor" key={index}>
              <legend>卡片 {index + 1}</legend>
              <label>
                小标题
                <input
                  value={item.title}
                  maxLength={40}
                  onChange={(e) => card(index, { title: e.target.value })}
                />
              </label>
              <label>
                正文段落
                <textarea
                  value={item.paragraphs.join('\n\n')}
                  onChange={(e) =>
                    card(index, {
                      paragraphs: e.target.value.split(/\n\n+/).filter((p) => p.trim()),
                    })
                  }
                />
              </label>
              {Array.from(
                new Set((job.result?.cards ?? []).flatMap((original) => original.code_refs)),
              )
                .filter((id) => item.source_block_ids.includes(id))
                .map((id) => (
                  <label className="checkbox" key={id}>
                    <input
                      type="checkbox"
                      checked={item.code_refs.includes(id)}
                      onChange={(event) =>
                        card(index, {
                          code_refs: event.target.checked
                            ? [...item.code_refs, id]
                            : item.code_refs.filter((value) => value !== id),
                        })
                      }
                    />
                    保留完整代码块 {id}
                  </label>
                ))}
              <div className="heading-actions">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    const cards = [...output.cards];
                    [cards[index - 1], cards[index]] = [cards[index], cards[index - 1]];
                    patch({ cards });
                  }}
                >
                  上移
                </button>
                <button
                  type="button"
                  disabled={index === output.cards.length - 1}
                  onClick={() => {
                    const cards = [...output.cards];
                    [cards[index + 1], cards[index]] = [cards[index], cards[index + 1]];
                    patch({ cards });
                  }}
                >
                  下移
                </button>
                <button
                  type="button"
                  disabled={output.cards.length >= 8 || item.paragraphs.length < 2}
                  onClick={() => {
                    const middle = Math.ceil(item.paragraphs.length / 2);
                    const cards = [...output.cards];
                    cards.splice(
                      index,
                      1,
                      { ...item, paragraphs: item.paragraphs.slice(0, middle) },
                      {
                        ...item,
                        title: item.title + '（续）',
                        paragraphs: item.paragraphs.slice(middle),
                        code_refs: [],
                      },
                    );
                    patch({ cards });
                  }}
                >
                  拆分卡片
                </button>
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            className="primary"
            disabled={action.pending}
            onClick={() => void save()}
          >
            {action.pending ? '正在保存…' : '保存并重新排版'}
          </button>
        </div>
      ) : (
        <>
          <h3>{job.result.title}</h3>
          <p className="formatting-note-body">{job.result.body}</p>
          <div className="formatting-tags">
            {job.result.topics.map((topic) => (
              <span key={topic}>#{topic}</span>
            ))}
          </div>
          <div className="formatting-card-grid">
            {job.result.assets.map((asset, index) => (
              <figure key={asset.id}>
                <a href={asset.url} target="_blank" rel="noreferrer">
                  <img
                    src={asset.url}
                    alt={index === 0 ? '封面' : '正文卡片 ' + index}
                    loading="lazy"
                  />
                </a>
                <figcaption>
                  <a href={asset.url + '?download=1'} download>
                    {index === 0 ? '下载封面' : '下载卡片 ' + index}
                  </a>
                </figcaption>
              </figure>
            ))}
          </div>
          {job.result.omissions.length > 0 && (
            <details>
              <summary>删减与来源核对</summary>
              <ul>
                {job.result.omissions.map((value, index) => (
                  <li key={index}>{value}</li>
                ))}
              </ul>
            </details>
          )}
          {job.result.issues.map((issue, index) => (
            <div
              key={index}
              className={issue.blocking ? 'notice error' : 'notice'}
              role={issue.blocking ? 'alert' : undefined}
            >
              {issue.message}
            </div>
          ))}
          {!job.confirmed && job.status === 'succeeded' && (
            <button type="button" className="primary section-gap" onClick={() => setConfirm(true)}>
              确认图文素材
            </button>
          )}
          {job.confirmed && <p role="status">图文素材已确认</p>}
        </>
      )}
      {action.error && (
        <div className="notice error" role="alert">
          {action.error}
        </div>
      )}
      {confirm && (
        <IntegrationModal
          title="确认图文素材"
          onClose={() => {
            if (!action.pending) setConfirm(false);
          }}
        >
          <p>确认当前正文、话题和图片顺序？</p>
          <button
            type="button"
            className="primary"
            disabled={action.pending}
            onClick={() => void confirmDraft()}
          >
            {action.pending ? '正在确认…' : '确认当前修订'}
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
