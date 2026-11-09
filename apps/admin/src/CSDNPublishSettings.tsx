import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Empty, errorText, useAction, useWorkspace } from './runtime';
import type { CSDNPublishOptions, Preparation } from './integration-types';
import './CSDNPublishSettings.css';

const path = '/api/account/csdn-publish-preset';
const summaryLimit = 256;
const categoryLimit = 3;
export const csdnPublishOptionGroups = [
  [
    'article_type',
    '文章类型',
    [
      ['original', '原创'],
      ['repost', '转载'],
      ['translated', '翻译'],
    ],
  ],
  [
    'visibility',
    '可见范围',
    [
      ['public', '全部可见'],
      ['private', '仅我可见'],
      ['fans', '粉丝可见'],
      ['vip', 'VIP 可见'],
    ],
  ],
  [
    'creation_declaration',
    '创作声明',
    [
      ['none', '无'],
      ['ai_assisted', '部分内容由 AI 辅助生成'],
      ['online_recreation', '内容来源网络，进行整合/再创作'],
      ['personal_opinion', '个人观点，仅供参考'],
    ],
  ],
  [
    'template',
    '模板',
    [
      ['default', '默认'],
      ['simple', '简洁'],
      ['moyan', '墨衍'],
    ],
  ],
] as const;

type PublishPreset = {
  revision: number;
  options: CSDNPublishOptions;
  available_categories: string[];
};

export function useCSDNPublishPreset(enabled = true) {
  const { api } = useWorkspace();
  const [data, setData] = useState<PublishPreset>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setError('');
    void api<PublishPreset>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [api, enabled, revision]);
  return { data, setData, error, reload: () => setRevision((current) => current + 1) };
}

function cleanTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

export function hasCSDNOriginalURL(value?: string) {
  if (!value) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function cleanCSDNPublishOptions(value: CSDNPublishOptions, draft = false) {
  const { original_url, rights_confirmed, ...base } = value;
  const options = { ...base, summary: base.summary.trim(), tags: cleanTags(base.tags) };
  if (!draft || options.article_type === 'original') return options;
  return {
    ...options,
    original_url: original_url?.trim() || undefined,
    rights_confirmed: rights_confirmed || undefined,
  };
}

export function csdnPublishOptionsError(value: CSDNPublishOptions) {
  if (value.summary.trim().length > summaryLimit) return '摘要最多 256 个字符。';
  const tags = cleanTags(value.tags);
  if (tags.length > 7) return '最多填写 7 个标签。';
  if (tags.some((tag) => /[,，\u0000-\u001f\u007f]/.test(tag)))
    return '标签不能包含逗号或控制字符。';
  if (tags.some((tag) => Array.from(tag).length > 64)) return '每个标签最多 64 个字符。';
  return '';
}

export function draftOptionsFromPreset(
  preset: CSDNPublishOptions,
  snapshot: Preparation['snapshot'],
) {
  let summary = '';
  for (const letter of snapshot.summary.trim()) {
    if (summary.length + letter.length > summaryLimit) break;
    summary += letter;
  }
  const tags = cleanTags(snapshot.tags);
  const validTags = tags.length && tags.every((tag) => !/[,，\u0000-\u001f\u007f]/.test(tag));
  return {
    ...cleanCSDNPublishOptions(preset),
    summary,
    tags: validTags ? tags.slice(0, 7) : preset.tags,
    cover_image_url: '',
  };
}

export function CSDNPublishFields({
  value,
  onChange,
  availableCategories,
  categoryUnavailable,
  readOnly,
  draft,
  coverCandidate,
}: {
  value: CSDNPublishOptions;
  onChange: (value: CSDNPublishOptions) => void;
  availableCategories?: string[];
  categoryUnavailable?: boolean;
  readOnly?: boolean;
  draft?: boolean;
  coverCandidate?: string;
}) {
  const summaryId = useId();
  const categories = availableCategories?.filter((name) => !value.categories.includes(name));
  const summaryLength = value.summary.trim().length;
  const categoryLimitReached = value.categories.length >= categoryLimit;
  function update(patch: Partial<CSDNPublishOptions>) {
    onChange({ ...value, ...patch });
  }
  return (
    <div className="csdn-publish-fields">
      <label className="csdn-publish-wide">
        标签（每行一个）
        <textarea
          rows={2}
          value={value.tags.join('\n')}
          onChange={(event) => update({ tags: event.target.value.split('\n') })}
        />
      </label>
      {draft && (
        <div className="csdn-publish-wide csdn-summary-field">
          <div className="csdn-summary-label">
            <label htmlFor={summaryId}>摘要</label>
            <small id={summaryId + '-count'}>
              {summaryLength} / {summaryLimit}
            </small>
          </div>
          <textarea
            id={summaryId}
            rows={3}
            value={value.summary}
            aria-describedby={summaryId + '-count'}
            aria-invalid={summaryLength > summaryLimit}
            onChange={(event) => update({ summary: event.target.value })}
          />
        </div>
      )}
      {csdnPublishOptionGroups.map(([name, label, choices]) => (
        <label key={name}>
          {label}
          <select
            value={value[name]}
            onChange={(event) => {
              const next = event.target.value;
              if (name === 'article_type') {
                update({
                  article_type: next,
                  original_url: next === 'original' ? undefined : value.original_url,
                  rights_confirmed: undefined,
                });
              } else update({ [name]: next });
            }}
          >
            {choices.map(([code, text]) => (
              <option key={code} value={code}>
                {text}
              </option>
            ))}
          </select>
        </label>
      ))}
      {draft && value.article_type !== 'original' && (
        <>
          <label className="csdn-publish-wide">
            原文链接
            <input
              type="url"
              autoComplete="off"
              placeholder="https://"
              value={value.original_url || ''}
              onChange={(event) =>
                update({ original_url: event.target.value, rights_confirmed: undefined })
              }
            />
          </label>
          <label className="checkbox csdn-publish-wide">
            <input
              type="checkbox"
              checked={!!value.rights_confirmed}
              disabled={!hasCSDNOriginalURL(value.original_url)}
              onChange={(event) => update({ rights_confirmed: event.target.checked })}
            />
            我已确认有权转载或翻译此文
          </label>
        </>
      )}
      <div className="csdn-publish-wide">
        {!readOnly ? (
          <label>
            添加专栏
            <select
              value=""
              disabled={!categories?.length || categoryLimitReached}
              onChange={(event) => {
                if (event.target.value)
                  update({ categories: [...value.categories, event.target.value] });
              }}
            >
              <option value="">
                {categoryLimitReached
                  ? '最多选择 3 个专栏'
                  : categoryUnavailable
                    ? '暂时无法读取专栏'
                    : !categories
                      ? '正在读取专栏…'
                      : categories.length
                        ? '选择专栏'
                        : '暂无可选专栏'}
              </option>
              {categories?.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="csdn-category-label">专栏</span>
        )}
        {value.categories.length > 0 && (
          <ul className="csdn-category-list">
            {value.categories.map((name) => (
              <li key={name}>
                {name}
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={'移除专栏 ' + name}
                    onClick={() =>
                      update({
                        categories: value.categories.filter((category) => category !== name),
                      })
                    }
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {readOnly && value.categories.length === 0 && <p className="muted">未选择</p>}
      </div>
      {draft && (coverCandidate || value.cover_image_url) && (
        <label className="checkbox csdn-publish-wide">
          <input
            type="checkbox"
            checked={!!value.cover_image_url}
            onChange={(event) =>
              update({ cover_image_url: event.target.checked ? coverCandidate || '' : '' })
            }
          />
          使用来源封面
        </label>
      )}
    </div>
  );
}

export default function CSDNPublishSettings() {
  const { api } = useWorkspace();
  const preset = useCSDNPublishPreset();
  const [edited, setEdited] = useState<CSDNPublishOptions>();
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const current = preset.data;
  const value = edited ?? current?.options;
  const dirty = !!current && JSON.stringify(value) !== JSON.stringify(current.options);
  async function save() {
    if (!current || !value || !dirty) return;
    const error = csdnPublishOptionsError(value);
    if (error) {
      action.setError(error);
      return;
    }
    const result = await action.run(
      (signal) =>
        api<PublishPreset>(path, {
          method: 'PUT',
          body: JSON.stringify({
            revision: current.revision,
            options: cleanCSDNPublishOptions(value),
          }),
          signal,
        }),
      '请重新读取预设。',
    );
    if (result) {
      preset.setData(result);
      setEdited(undefined);
      setSaved(true);
    }
  }
  function reload() {
    setEdited(undefined);
    setSaved(false);
    action.setError('');
    preset.reload();
  }
  return (
    <section className="surface section-gap" aria-labelledby="csdn-preset-heading">
      <div className="surface-header">
        <h2 id="csdn-preset-heading">发布预设</h2>
        {(preset.error || action.error) && (
          <button type="button" disabled={action.pending} onClick={reload}>
            重新读取预设
          </button>
        )}
      </div>
      {value ? (
        <form
          className="surface-body form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="csdn-publish-set" disabled={action.pending}>
            <CSDNPublishFields
              value={value}
              onChange={(next) => {
                setEdited(next);
                setSaved(false);
              }}
              availableCategories={current?.available_categories}
            />
          </fieldset>
          {action.error && (
            <div className="notice error" role="alert">
              {action.error}
            </div>
          )}
          <div className="form-footer">
            {saved && <span role="status">已保存发布预设</span>}
            <button type="submit" className="primary" disabled={!dirty || action.pending}>
              {action.pending ? '正在保存…' : '保存发布预设'}
            </button>
          </div>
        </form>
      ) : (
        <Empty loading={!preset.error}>{preset.error}</Empty>
      )}
    </section>
  );
}
