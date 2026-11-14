import { useLayoutEffect, useRef, useState } from 'react';
import { useAction, useWorkspace } from './runtime';
import type { FormattingJob } from './formatting-contract';
import { safeWechatPreview } from './wechat-safe-html';
import FormattingDifferences from './FormattingDifferences';
import WechatSuggestionsView from './WechatSuggestionsView';

export default function WechatFormatting({
  job,
  onChange,
  originalMarkdown,
}: {
  job: FormattingJob;
  onChange: (job: FormattingJob) => void;
  originalMarkdown?: string;
}) {
  const { api } = useWorkspace();
  const action = useAction();
  const [copyError, setCopyError] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnToEdit = useRef(false);
  const [uploads, setUploads] = useState<Record<string, string>>({});
  const [reading, setReading] = useState(0);
  const editRequest = useRef(crypto.randomUUID());
  const result = job.result?.wechat;
  const fallbackMarkdown = result?.candidate_markdown == null ? (originalMarkdown ?? '') : '';
  useLayoutEffect(() => {
    setMarkdown(result?.candidate_markdown ?? fallbackMarkdown);
    setUploads(
      Object.fromEntries((result?.attachments ?? []).map((item) => [item.image_id, item.data])),
    );
    setEditing(false);
    editRequest.current = crypto.randomUUID();
  }, [job.id, job.revision, fallbackMarkdown]);
  useLayoutEffect(() => {
    if (editing) editor.current?.focus();
    else if (returnToEdit.current) {
      returnToEdit.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  if (!result) return null;
  const running = ['queued', 'running'].includes(job.status);
  const { html, text } = safeWechatPreview(result.blocks, result.attachments ?? []);
  const document = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><base target="_blank"><style>body{font:16px/1.7 sans-serif;overflow-wrap:anywhere;margin:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:4px}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  async function copy() {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      setCopyError('');
    } catch {
      setCopyError('复制失败，请检查浏览器剪贴板权限。');
    }
  }
  async function confirm() {
    const next = await action.run((signal) =>
      api<FormattingJob>('/api/formatting-jobs/' + job.id + '/confirm', {
        method: 'POST',
        body: JSON.stringify({ revision: job.revision }),
        signal,
      }),
    );
    if (next) onChange(next);
  }
  async function save() {
    const next = await action.run((signal) =>
      api<FormattingJob>('/api/formatting-jobs/' + job.id + '/wechat', {
        method: 'PUT',
        body: JSON.stringify({
          revision: job.revision,
          request_id: editRequest.current,
          markdown,
          attachments: Object.entries(uploads).map(([image_id, data]) => ({ image_id, data })),
        }),
        signal,
      }),
    );
    if (next) onChange(next);
  }
  async function chooseImage(id: string, file?: File) {
    if (!file) return;
    const existingSize = Object.entries(uploads).reduce(
      (sum, [key, value]) =>
        key === id
          ? sum
          : sum +
            Math.floor((value.length * 3) / 4) -
            (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0),
      0,
    );
    if (file.size + existingSize > 4 * 1024 * 1024) {
      setCopyError('图片总大小不能超过 4 MB。');
      return;
    }
    setReading((count) => count + 1);
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result.slice(reader.result.indexOf(',') + 1))
          : reject(new Error());
      reader.onerror = () => reject(new Error());
      reader.readAsDataURL(file);
    })
      .catch(() => '')
      .finally(() => setReading((count) => count - 1));
    if (!data) {
      setCopyError('读取图片失败，请重新选择。');
      return;
    }
    setCopyError('');
    editRequest.current = crypto.randomUUID();
    setUploads((current) => ({ ...current, [id]: data }));
  }
  return (
    <>
      <h3>{job.result?.title}</h3>
      {editing ? (
        <label>
          候选稿 Markdown
          <textarea
            ref={editor}
            className="markdown-editor"
            value={markdown}
            disabled={action.pending}
            onChange={(event) => {
              editRequest.current = crypto.randomUUID();
              setMarkdown(event.target.value);
            }}
          />
        </label>
      ) : (
        <iframe
          title="公众号本地稿预览"
          sandbox=""
          srcDoc={document}
          className="formatting-wechat-preview"
        />
      )}
      {!running &&
        !editing &&
        originalMarkdown !== undefined &&
        result.candidate_markdown != null && (
          <FormattingDifferences
            original={originalMarkdown}
            candidate={result.candidate_markdown}
          />
        )}
      {!running && result.suggestions && <WechatSuggestionsView suggestions={result.suggestions} />}
      {result.issues.map((issue, index) => (
        <div
          key={index}
          className={'notice ' + (issue.blocking ? 'error' : '')}
          role={issue.blocking ? 'alert' : undefined}
        >
          {issue.message}（原文第{' '}
          {result.blocks.findIndex((block) => block.source_block_id === issue.field) + 1} 段）
        </div>
      ))}
      {!!result.images?.length && (
        <div className="section-gap">
          <strong>图片素材</strong>
          {result.images.map((image, index) => (
            <div key={image.id}>
              <p>
                第 {index + 1} 张：{image.alt || '未填写替代文字'}（原文第{' '}
                {result.blocks.findIndex(
                  (block) => block.source_block_id === image.source_block_id,
                ) + 1}{' '}
                段）
              </p>
              {editing && image.source && (
                <p style={{ overflowWrap: 'anywhere' }}>{image.source}</p>
              )}
              {editing && (
                <>
                  <label>
                    选择第 {index + 1} 张图片
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      disabled={action.pending || reading > 0}
                      onChange={(event) => void chooseImage(image.id, event.target.files?.[0])}
                    />
                  </label>
                  {uploads[image.id] && (
                    <button
                      type="button"
                      disabled={action.pending || reading > 0}
                      onClick={() => {
                        editRequest.current = crypto.randomUUID();
                        setUploads((current) => {
                          const next = { ...current };
                          delete next[image.id];
                          return next;
                        });
                      }}
                    >
                      移除第 {index + 1} 张素材
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="heading-actions section-gap">
        {editing ? (
          <>
            <button
              type="button"
              disabled={action.pending || reading > 0 || !markdown.trim()}
              onClick={() => void save()}
            >
              保存并重新排版
            </button>
            <button
              type="button"
              disabled={action.pending || reading > 0}
              onClick={() => {
                setMarkdown(result.candidate_markdown ?? originalMarkdown ?? '');
                setUploads(
                  Object.fromEntries(
                    (result.attachments ?? []).map((item) => [item.image_id, item.data]),
                  ),
                );
                action.setError('');
                setCopyError('');
                returnToEdit.current = true;
                setEditing(false);
              }}
            >
              取消编辑
            </button>
          </>
        ) : (
          <button
            ref={editButton}
            type="button"
            disabled={running || (!result.candidate_markdown && !originalMarkdown)}
            onClick={() => {
              action.setError('');
              setCopyError('');
              setEditing(true);
            }}
          >
            编辑候选稿
          </button>
        )}
        <button type="button" disabled={running || editing} onClick={() => void copy()}>
          复制排版内容
        </button>
        {!editing && job.status === 'succeeded' && (
          <button
            type="button"
            className="primary"
            disabled={action.pending}
            onClick={() => void confirm()}
          >
            确认本地稿
          </button>
        )}
      </div>
      {(copyError || action.error) && (
        <div className="notice error" role="alert">
          {copyError || action.error}
        </div>
      )}
    </>
  );
}
