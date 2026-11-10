import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Empty, RouteLink, errorText, time, useAction, useWorkspace } from './runtime';
import { IntegrationModal, IntegrationState } from './IntegrationDialog';
import {
  CSDNPublishFields,
  cleanCSDNPublishOptions,
  csdnPublishOptionsError,
  draftOptionsFromPreset,
  useCSDNPublishPreset,
} from './CSDNPublishSettings';
import type { PlatformDraft, Preparation } from './integration-types';
import FormattingPanel from './FormattingPanel';

function Preview({
  body,
  label,
  allowedImages = [],
}: {
  body: string;
  label: string;
  allowedImages?: string[];
}) {
  return (
    <div className="markdown-preview integration-preview" aria-label={label}>
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ src, alt }) =>
            typeof src === 'string' && src.startsWith('https://') && allowedImages.includes(src) ? (
              <a href={src} target="_blank" rel="noreferrer noopener">
                {alt || '查看原图'}
              </a>
            ) : null,
        }}
      >
        {body || '暂无正文'}
      </ReactMarkdown>
    </div>
  );
}
export default function IntegrationDraft({ id }: { id: string }) {
  const { api, route } = useWorkspace();
  const [data, setData] = useState<Preparation>();
  const [drafts, setDrafts] = useState<PlatformDraft[]>([]);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState(false);
  const [confirm, setConfirm] = useState<'confirm' | 'revoke' | 'reload'>();
  const action = useAction();
  const backValue = new URLSearchParams(route.split('?')[1]).get('back') || '';
  const back = /^\/integrations(?:\?|$)/.test(backValue) ? backValue : '/integrations';
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<Preparation>('/api/integration-preparations/' + encodeURIComponent(id), {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setDrafts(result.drafts);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [api, id, refresh]);
  const dirty = !!data && JSON.stringify(drafts) !== JSON.stringify(data.drafts);
  const expired = !!data && Date.parse(data.expires_at) <= Date.now();
  const editable = !!data && !expired && ['prepared', 'confirmed'].includes(data.status);
  const preset = useCSDNPublishPreset(editable);
  function update(index: number, patch: Partial<PlatformDraft>) {
    setDrafts((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
    );
  }
  async function save() {
    if (!data || !editable || !dirty) return;
    if (drafts.some((draft) => !draft.title.trim() || !draft.markdown.trim())) {
      action.setError('平台标题和正文不能为空。');
      return;
    }
    const error = drafts
      .map((draft) => draft.publish_options && csdnPublishOptionsError(draft.publish_options))
      .find(Boolean);
    if (error) {
      action.setError(error);
      return;
    }
    const revisions = drafts.map(
      ({ id, platform, account_id, operation, title, markdown, publish_options }) => ({
        id,
        platform,
        account_id,
        operation,
        title,
        markdown,
        publish_options: publish_options && cleanCSDNPublishOptions(publish_options, true),
      }),
    );
    const result = await action.run(
      (signal) =>
        api<Preparation>('/api/integration-preparations/' + encodeURIComponent(id), {
          method: 'PUT',
          body: JSON.stringify({ revision: data.revision, drafts: revisions }),
          signal,
        }),
      '平台稿已改变，请核对后重新读取。',
    );
    if (result) {
      setData(result);
      setDrafts(result.drafts);
    }
  }
  async function perform() {
    if (confirm === 'reload') {
      setConfirm(undefined);
      setRefresh((value) => value + 1);
      return;
    }
    if (!data || !confirm || !editable || (confirm === 'confirm' && dirty)) return;
    const result = await action.run(
      (signal) =>
        api<Preparation>(
          '/api/integration-preparations/' + encodeURIComponent(id) + '/' + confirm,
          {
            method: 'POST',
            body: JSON.stringify(confirm === 'confirm' ? { revision: data.revision } : {}),
            signal,
          },
        ),
      '平台稿已改变，请核对后重新读取。',
    );
    if (result) {
      setData(result);
      setDrafts(result.drafts);
      setConfirm(undefined);
    }
  }
  return (
    <div className="page integration-draft-page">
      <RouteLink className="back-link" href={back}>
        返回内容来源
      </RouteLink>
      <div className="page-heading">
        <h1 className="detail-title">{data?.snapshot.title || '平台稿'}</h1>
        <button
          disabled={action.pending}
          onClick={() => (dirty ? setConfirm('reload') : setRefresh((value) => value + 1))}
        >
          重新读取
        </button>
      </div>
      {error && (
        <div className="notice error section-gap" role="alert">
          {error}
        </div>
      )}
      {!data ? (
        <section className="surface">
          <Empty loading={!error}>{error ? '暂时无法读取平台稿' : ''}</Empty>
        </section>
      ) : (
        <>
          <section className="surface integration-draft-facts">
            <dl className="detail-facts">
              <div>
                <dt>来源</dt>
                <dd>{data.source_id}</dd>
              </div>
              <div>
                <dt>原稿标识</dt>
                <dd>{data.article_id}</dd>
              </div>
              <div>
                <dt>来源版本</dt>
                <dd>{data.source_version}</dd>
              </div>
              <div>
                <dt>当前修订</dt>
                <dd>修订 {data.revision}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>
                  <IntegrationState
                    value={
                      expired && data.status !== 'submitted' && data.status !== 'revoked'
                        ? 'expired'
                        : data.status
                    }
                  />
                </dd>
              </div>
              <div>
                <dt>有效期</dt>
                <dd>{time(data.expires_at)}</dd>
              </div>
            </dl>
          </section>
          <div className="integration-draft-layout section-gap">
            <section className="surface">
              <div className="surface-header">
                <h2>来源原稿</h2>
              </div>
              <div className="surface-body">
                {data.snapshot.summary && (
                  <p className="integration-summary">{data.snapshot.summary}</p>
                )}
                <Preview
                  body={data.snapshot.body}
                  label="来源原稿预览"
                  allowedImages={data.preview_image_urls}
                />
              </div>
            </section>
            <section className="surface">
              <div className="surface-header">
                <h2>平台稿</h2>
                <div className="editor-tabs">
                  <button aria-pressed={!preview} onClick={() => setPreview(false)}>
                    编辑
                  </button>
                  <button aria-pressed={preview} onClick={() => setPreview(true)}>
                    预览
                  </button>
                </div>
              </div>
              <div className="surface-body">
                <div className="form-grid">
                  {drafts.map((draft, index) => (
                    <fieldset
                      className="integration-draft-fields"
                      key={draft.id}
                      disabled={action.pending || !editable}
                    >
                      <legend>
                        {draft.platform === 'csdn' ? 'CSDN' : draft.platform} · 保存草稿 ·{' '}
                        {draft.account_id}
                      </legend>
                      <label>
                        平台标题
                        <input
                          disabled={action.pending || !editable}
                          value={draft.title}
                          maxLength={100}
                          onChange={(event) => update(index, { title: event.target.value })}
                        />
                      </label>
                      {preview ? (
                        <Preview
                          body={draft.markdown}
                          label="平台稿预览"
                          allowedImages={data.preview_image_urls}
                        />
                      ) : (
                        <label>
                          平台 Markdown 正文
                          <textarea
                            disabled={action.pending || !editable}
                            className="markdown-editor"
                            maxLength={200000}
                            value={draft.markdown}
                            onChange={(event) => update(index, { markdown: event.target.value })}
                          />
                        </label>
                      )}
                      {draft.platform === 'csdn' && draft.publish_options && (
                        <section className="csdn-draft-settings">
                          <h3>发布设置</h3>
                          <CSDNPublishFields
                            draft
                            value={draft.publish_options}
                            readOnly={!editable}
                            coverCandidate={data.snapshot.cover_image_url}
                            availableCategories={preset.data?.available_categories}
                            categoryUnavailable={!!preset.error}
                            onChange={(publish_options) => update(index, { publish_options })}
                          />
                        </section>
                      )}
                      {draft.platform === 'csdn' &&
                        !draft.publish_options &&
                        editable &&
                        preset.data && (
                          <div>
                            <button
                              type="button"
                              onClick={() =>
                                update(index, {
                                  publish_options: draftOptionsFromPreset(
                                    preset.data!.options,
                                    data.snapshot,
                                  ),
                                })
                              }
                            >
                              载入发布预设
                            </button>
                          </div>
                        )}
                    </fieldset>
                  ))}
                </div>
                <FormattingPanel
                  source={{
                    preparation_id: data.id,
                    base_revision: data.revision,
                    account_id: data.targets?.[0]?.account_id || data.drafts[0]?.account_id,
                  }}
                  disabled={!editable || dirty || action.pending}
                  authorized={!!data.formatting?.allow_ai_processing}
                  platforms={data.formatting?.platforms || ['csdn']}
                  onAdopt={(_, preparation) => {
                    if (preparation) {
                      setData(preparation);
                      setDrafts(preparation.drafts);
                    }
                  }}
                />
                {action.error && (
                  <div className="notice error section-gap" role="alert">
                    {action.error}
                  </div>
                )}
                {editable && (
                  <div className="heading-actions section-gap">
                    <button
                      type="button"
                      disabled={action.pending || !dirty}
                      onClick={() => void save()}
                    >
                      {action.pending && !confirm ? '正在保存…' : '保存新修订'}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={action.pending || dirty || !drafts.length || data.confirmed}
                      onClick={() => setConfirm('confirm')}
                    >
                      确认平台稿
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={action.pending}
                      onClick={() => setConfirm('revoke')}
                    >
                      撤销平台稿
                    </button>
                  </div>
                )}
              </div>
            </section>
          </div>
          {confirm && (
            <IntegrationModal
              title={
                confirm === 'reload'
                  ? '重新读取'
                  : confirm === 'confirm'
                    ? '确认平台稿'
                    : '撤销平台稿'
              }
              onClose={() => {
                if (!action.pending) setConfirm(undefined);
              }}
            >
              <p>
                {confirm === 'reload'
                  ? '确认放弃未保存的修改并重新读取？'
                  : confirm === 'confirm'
                    ? '确认修订 ' + data.revision + ' 的平台稿？'
                    : '确认撤销当前平台稿？该稿件将不能继续提交。'}
              </p>
              <button
                className={confirm === 'confirm' ? 'primary' : 'danger'}
                disabled={action.pending}
                onClick={() => void perform()}
              >
                {action.pending
                  ? '正在处理…'
                  : confirm === 'reload'
                    ? '放弃修改并读取'
                    : confirm === 'confirm'
                      ? '确认当前修订'
                      : '确认撤销'}
              </button>
              {action.error && (
                <div role="alert" className="notice error section-gap">
                  {action.error}
                </div>
              )}
            </IntegrationModal>
          )}
        </>
      )}
    </div>
  );
}
