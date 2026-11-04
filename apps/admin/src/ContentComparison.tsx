import { useEffect, useState } from 'react';
import { Empty, ResourceError, RefreshBar, statusLabels, time, useResource } from './runtime';
import type { ContentChanges, ProcessSnapshot } from './process-types';

function Difference({ value, other, side, multiline = false }: { value?: string; other?: string; side: 'before' | 'after'; multiline?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (value === undefined) return <span className="muted">未采集</span>;
  const characters = Array.from(value), comparison = other === undefined ? undefined : Array.from(other);
  const visibleLength = expanded ? characters.length : Math.min(characters.length, 4000);
  const text = characters.slice(0, visibleLength).join('');
  let start = 0, end = 0;
  if (comparison && value !== other) {
    while (start < Math.min(characters.length, comparison.length) && characters[start] === comparison[start]) start++;
    while (end < Math.min(characters.length, comparison.length) - start && characters[characters.length - 1 - end] === comparison[comparison.length - 1 - end]) end++;
  }
  const changed = other !== undefined && value !== other;
  const changeStart = Math.min(start, visibleLength), changeEnd = Math.min(characters.length - end, visibleLength);
  return <div className={multiline ? 'diff-text multiline' : 'diff-text'}><div>{!value ? '（空）' : changed ? <>{characters.slice(0, changeStart).join('')}{changeEnd > changeStart && <mark className={side}>{characters.slice(changeStart, changeEnd).join('')}</mark>}{characters.slice(changeEnd, visibleLength).join('')}</> : text}</div>
    {characters.length > 4000 && <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起正文' : '展开全文'}</button>}
  </div>;
}
function stateName(value?: string) {
  if (value === undefined) return undefined;
  return ({ editor: '编辑器', '2': '草稿', unknown: '未知' } as Record<string, string>)[value] || statusLabels[value] || value;
}
function ComparisonData({ jobId, active, kind }: { jobId: string; active: boolean; kind: string }) {
  const [attempt, setAttempt] = useState('');
  const resource = useResource<ContentChanges>('/api/jobs/' + encodeURIComponent(jobId) + '/changes' + (attempt ? '?attempt=' + attempt : ''));
  useEffect(() => { if (resource.data && !active) resource.setAuto(false); }, [active, resource.data, resource.setAuto]);
  const before = resource.data?.snapshots.find(snapshot => snapshot.phase === 'before');
  const after = resource.data?.snapshots.find(snapshot => snapshot.phase === 'after');
  const account = kind === 'check_account';
  const fields: { name: string; key: keyof ProcessSnapshot; multiline?: boolean }[] = account ? [{ name: '账号', key: 'username' }, { name: '显示名称', key: 'display_name' }, { name: '连接状态', key: 'status' }] : [{ name: '标题', key: 'title' }, { name: '正文', key: 'markdown', multiline: true }, { name: '平台状态', key: 'status' }];
  function field(snapshot: ProcessSnapshot | undefined, key: keyof ProcessSnapshot): string | undefined {
    const value = snapshot?.[key];
    if (typeof value !== 'string') return undefined;
    return key === 'status' ? stateName(value) : value;
  }
  return <><div className="comparison-toolbar"><label>执行轮次<select value={attempt} onChange={event => setAttempt(event.target.value)}><option value="">本次处理整体</option>{resource.data?.attempts.map(value => <option key={value} value={value}>第 {value} 次执行</option>)}</select></label></div>
    <ResourceError error={resource.error} stale={!!resource.data} /><RefreshBar resource={resource} name="刷新变更" />
    {!resource.data ? <Empty loading={resource.loading}>无法读取内容变更</Empty> : <>
      {!resource.data.content_retained && <div className="notice warning error-inline" role="status">无可用内容快照</div>}
      <table className="change-table"><thead><tr><th>字段</th><th>处理前{before && <small>第 {before.attempt} 次 · {time(before.captured_at)}</small>}</th><th>处理后{after && <small>第 {after.attempt} 次 · {time(after.captured_at)}</small>}</th></tr></thead>
        <tbody>{fields.map(({ name, key, multiline }) => <tr key={key}><th scope="row">{name}</th><td data-side="处理前"><Difference key={'before-' + attempt + '-' + before?.id} value={field(before, key)} other={field(after, key)} side="before" multiline={multiline} /></td><td data-side="处理后"><Difference key={'after-' + attempt + '-' + after?.id} value={field(after, key)} other={field(before, key)} side="after" multiline={multiline} /></td></tr>)}</tbody>
      </table>
    </>}
  </>;
}
export default function ContentComparison({ jobId, active = false, kind = 'save_draft' }: { jobId: string; active?: boolean; kind?: string }) {
  const [open, setOpen] = useState(false);
  if (kind === 'sync_articles' || kind === 'read_article') return null;
  return <section className="surface section-gap" aria-label="内容变更"><div className="surface-header"><h2>内容变更</h2><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起内容变更' : '查看内容变更'}</button></div>
    {open && <ComparisonData jobId={jobId} active={active} kind={kind} />}
  </section>;
}
