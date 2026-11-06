import { useState } from 'react';

export const manualResolutionConflictHint = '请先刷新当前状态。任务仍在执行，或服务尚未确认最近 45 秒内的浏览器空闲状态。';

type Resolution = { confirmed_browser_stopped: true; note: string };

export default function ManualJobResolution({ publication = false, disabled, onResolve }: {
  publication?: boolean;
  disabled: boolean;
  onResolve: (input: Resolution) => void;
}) {
  const [stopped, setStopped] = useState(false);
  const [note, setNote] = useState('');
  const subject = publication ? 'CSDN 现有状态' : '可能存在的草稿';
  return <details>
    <summary>{publication ? '人工结束发布任务' : '无法匹配完整稿件'}</summary>
    <label className="checkbox">
      <input type="checkbox" checked={stopped} disabled={disabled} onChange={event => setStopped(event.target.checked)} />
      我已确认本任务浏览器停止，并保留{subject}
    </label>
    <label>人工结束原因
      <textarea rows={3} maxLength={500} value={note} disabled={disabled}
        onChange={event => setNote(event.target.value)}
        placeholder={publication ? '说明保留平台状态和结束任务的原因' : '说明保留草稿和结束任务的原因'} />
    </label>
    <button type="button" className="danger" disabled={!stopped || !note.trim() || disabled}
      onClick={() => onResolve({ confirmed_browser_stopped: true, note: note.trim() })}>
      {publication ? '保留平台状态并结束任务' : '保留草稿并结束任务'}
    </button>
  </details>;
}
