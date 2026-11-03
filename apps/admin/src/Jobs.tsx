import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Plus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import Logs from './Logs';
import { Empty, Pagination, RefreshBar, ResourceError, RouteLink, Status, jobHref, queryPage, stageLabels, statusLabels, time, useAction, useResource, useWorkspace, type Job, type PageData } from './runtime';

function outcomeText(job: Job) {
  if (job.manual_resolved) return '已人工结束，草稿可能保留';
  if (job.kind === 'check_account') return job.status === 'succeeded' ? '登录状态已检查' : '账号检查任务';
  if (job.outcome === 'draft_saved') return '草稿已保存';
  if (job.outcome === 'unknown' || job.external_started) return '草稿结果待核对';
  return '尚未保存到CSDN';
}
export function Jobs() {
  const { route, navigate } = useWorkspace();
  const params = new URLSearchParams(route.split('?')[1]);
  const [q, setQ] = useState(params.get('q') || '');
  const [status, setStatus] = useState(params.get('status') || '');
  useEffect(() => { const values = new URLSearchParams(route.split('?')[1]); setQ(values.get('q') || ''); setStatus(values.get('status') || ''); }, [route]);
  const page = queryPage(params);
  const search = new URLSearchParams({ page: String(page), page_size: '50' });
  if (params.get('q')) search.set('q', params.get('q')!);
  if (params.get('status')) search.set('status', params.get('status')!);
  const resource = useResource<PageData<Job>>('/api/jobs?' + search);
  function submit(event: FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams();
    if (q.trim()) next.set('q', q.trim());
    if (status) next.set('status', status);
    navigate('/jobs' + (next.size ? '?' + next : ''));
  }
  return <div className="page">
    <div className="page-heading"><div><h1>草稿任务</h1><p>将确认后的文字稿保存到 CSDN，逐项核对执行结果。</p></div><RouteLink className="button primary" href="/jobs/new"><Plus size={16} aria-hidden="true" />新建草稿</RouteLink></div>
    <section className="surface">
      <form className="toolbar" onSubmit={submit}>
        <label className="search">搜索任务<input value={q} onChange={event => setQ(event.target.value)} placeholder="文章标题或任务ID" /></label>
        <label>执行状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(statusLabels).filter(([key]) => ['queued', 'running', 'waiting_user', 'reconciling', 'succeeded', 'failed', 'cancelled'].includes(key)).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
        <button type="submit">筛选</button>
      </form>
      <RefreshBar resource={resource} />
      <ResourceError error={resource.error} stale={!!resource.data} />
      {resource.data?.items.length ? <table className="data-table"><thead><tr><th className="title-cell">文章 / 任务</th><th>执行状态</th><th>草稿结果</th><th>最近更新</th></tr></thead><tbody>{resource.data.items.map(job => <tr key={job.id}>
        <td className="title-cell"><RouteLink className="title-link" href={jobHref(job.id, route)}>{job.title || 'CSDN 登录状态检查'}</RouteLink><div className="job-subline"><span>CSDN</span><span>{job.kind === 'check_account' ? '账号检查' : '文字草稿'}</span><span className="mono">{job.id}</span></div></td>
        <td><Status value={job.status} cancelling={job.cancel_requested && ['queued', 'running'].includes(job.status)} /><div className="table-title-note">{stageLabels[job.stage] || '步骤待确认'}</div></td>
        <td>{outcomeText(job)}</td><td><time dateTime={job.updated_at}>{time(job.updated_at)}</time></td>
      </tr>)}</tbody></table> : <Empty loading={resource.loading}><strong>{params.size ? '暂无符合条件的任务' : '还没有草稿任务'}</strong>{params.size ? '调整搜索或筛选条件后再试。' : '新建文字草稿后，可在这里查看保存进度。'}</Empty>}
      {resource.data && <Pagination total={resource.data.total} page={page} pageSize={50} onPage={value => { params.set('page', String(value)); navigate('/jobs?' + params); }} />}
    </section>
  </div>;
}

export function NewJob() {
  const { api, navigate } = useWorkspace();
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [preview, setPreview] = useState(false);
  const action = useAction();
  const request = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const size = Array.from(title.trim()).length;
    if (size < 5 || size > 100) { action.setError('文章标题需为 5—100 个字符。'); return; }
    if (!markdown.trim() || Array.from(markdown).length > 200000) { action.setError('Markdown 正文不能为空，且最多 200000 个字符。'); return; }
    const prose = markdown.replace(/(^|\n)([ \t]*)(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '');
    if (/!\s*\[|<\s*[!\/a-zA-Z]|\{\s*(?:import|export)\b|^\s*(?:import|export)\s/m.test(prose)) { action.setError('本轮仅支持文字 Markdown，请移除图片、HTML 和 MDX；代码围栏内的样例可以保留。'); return; }
    const fingerprint = JSON.stringify({ title: title.trim(), markdown });
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    const body = { request_id: request.current.id, kind: 'save_draft', platform: 'csdn', title: title.trim(), markdown };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 1048576) { action.setError('稿件过大，请精简到 1 MiB 以内。'); return; }
    const result = await action.run(signal => api<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(body), signal }));
    if (result) navigate(jobHref(result.id));
  }
  return <div className="page">
    <RouteLink className="back-link" href="/jobs"><ArrowLeft size={14} aria-hidden="true" />返回草稿任务</RouteLink>
    <div className="page-heading"><div><h1>新建 CSDN 草稿</h1><p>提交后由后台保存草稿，请在任务详情确认最终结果。</p></div></div>
    <div className="editor-layout"><section className="surface"><div className="surface-body">
      <form className="form-grid" onSubmit={submit} noValidate>
        <label>文章标题<input aria-label="文章标题" aria-describedby="title-help" value={title} onChange={event => setTitle(event.target.value)} disabled={action.pending} maxLength={100} placeholder="用清晰的标题说明文章主题" /><span id="title-help" className="form-hint">5—100 个字符，当前 {Array.from(title).length} 字</span></label>
        <div><div className="editor-tabs"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>编辑</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button></div>
          <label style={preview ? { display: 'none' } : undefined}>Markdown 正文<textarea className="markdown-editor" value={markdown} onChange={event => setMarkdown(event.target.value)} disabled={action.pending} placeholder="在这里粘贴已确认的 Markdown 文字稿…" /></label>
          {preview && <div className="markdown-preview" aria-label="Markdown 预览"><ReactMarkdown skipHtml disallowedElements={['img']} components={{ a: props => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{markdown || '正文预览将显示在这里。'}</ReactMarkdown></div>}
        </div>
        {action.error && <div className="notice error" role="alert">{action.error}</div>}
        <div className="form-footer"><span className="form-hint">仅保存草稿，文章不会公开发布。</span><button type="submit" className="primary" disabled={action.pending}>{action.pending ? '正在提交…' : '保存到CSDN草稿'}</button></div>
      </form>
    </div></section><aside className="editor-side"><h3>当前支持范围</h3><p>一个 CSDN 账号，文字 Markdown 草稿。</p><p>图片、HTML、MDX 暂不支持。预览不会执行 HTML 或加载图片。</p><p>提交期间请等待。连接中断后可重新点击保存，内容未变时会沿用请求标识，避免重复创建任务。</p></aside></div>
  </div>;
}

function draftURL(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'mp.csdn.net' || url.hostname === 'editor.csdn.net') ? url.href : undefined; } catch { return undefined; }
}
function JobActions({ job, onUpdate }: { job: Job; onUpdate: () => void }) {
  const { api } = useWorkspace();
  const action = useAction();
  const [candidate, setCandidate] = useState(job.reconcile_candidate_id || '');
  const [loggedIn, setLoggedIn] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const uncertain = job.status === 'reconciling' || (job.outcome === 'unknown' && !job.manual_resolved);
  async function perform(name: string, body: object = {}) {
    const result = await action.run(signal => api<Job>('/api/jobs/' + encodeURIComponent(job.id) + '/' + name, { method: 'POST', body: JSON.stringify(body), signal }), name === 'resolve' ? '请先刷新当前状态；任务仍在执行，或服务尚未确认最近 45 秒内的浏览器空闲状态。' : undefined);
    if (result) onUpdate();
  }
  function reconcile() {
    if (!job.remote_id && !/^\d{1,32}$/.test(candidate.trim())) { action.setError('请输入仅由数字组成的候选草稿ID。'); return; }
    if (candidate.trim() && !/^\d{1,32}$/.test(candidate.trim())) { action.setError('候选草稿ID仅接受数字。'); return; }
    void perform('reconcile', candidate.trim() && !job.remote_id ? { remote_id: candidate.trim() } : {});
  }
  return <section className="surface detail-actions-surface"><div className="surface-header"><h2>任务处理</h2></div><div className="surface-body action-panel">
    {job.cancel_requested && ['queued', 'running'].includes(job.status) && <div className="notice warning"><strong>取消中</strong><p>正在等待后台停止本任务。可能存在的草稿仍需核对，请勿重新创建。</p></div>}
    {job.status === 'waiting_user' && <><div className="notice warning">请在验证主机上，由管理员使用本地登录助手完成 CSDN 登录。完成后返回这里继续；本页不会提供公开远程浏览器入口。</div><label className="checkbox"><input type="checkbox" checked={loggedIn} onChange={event => setLoggedIn(event.target.checked)} />我已在验证主机完成登录</label><button className="primary" disabled={!loggedIn || action.pending} onClick={() => void perform('resume')}>登录完成，继续任务</button></>}
    {uncertain && <><div className="notice warning"><strong>先核对，避免重复草稿</strong><p>保存结果尚未确认。这里只读取已有草稿，核对标题和正文，不会新建或改写。</p></div>
      {!job.remote_id && <label>候选草稿ID（仅数字）<input aria-label="候选草稿ID（仅数字）" aria-describedby="candidate-help" maxLength={32} inputMode="numeric" value={candidate} disabled={action.pending} onChange={event => setCandidate(event.target.value)} placeholder="例如 123456789" /><span id="candidate-help" className="form-hint">在 CSDN 草稿地址中找到数字ID。它只是候选，匹配后才会关联。</span></label>}
      <button className="primary" disabled={action.pending} onClick={reconcile}>仅核对既有草稿</button>
      <details open><summary>无法匹配完整稿件</summary><p>可保留已有或可能存在的草稿并人工结束。本操作不会删除、改写草稿，也不会记为保存成功。</p>
        <label className="checkbox"><input type="checkbox" checked={stopped} onChange={event => setStopped(event.target.checked)} />我已确认本任务浏览器停止，并保留可能存在的草稿</label>
        <label>人工结束原因<textarea rows={3} maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="说明保留草稿和结束任务的原因" /></label>
        <button className="danger" disabled={!stopped || !note.trim() || action.pending} onClick={() => void perform('resolve', { confirmed_browser_stopped: true, note: note.trim() })}>保留草稿并结束任务</button>
      </details></>}
    {job.retry_allowed && !uncertain && <><p>后台已确认该失败可安全重试；重试将继续使用原任务内容。</p><button disabled={action.pending} onClick={() => void perform('retry')}>重试任务</button></>}
    {['queued', 'running'].includes(job.status) && !job.cancel_requested && <details><summary>取消此任务</summary><p>排队任务会停止执行；执行中的任务需等待后台确认。已可能保存的草稿会保留并进入核对。</p><label className="checkbox"><input type="checkbox" checked={cancelConfirmed} onChange={event => setCancelConfirmed(event.target.checked)} />我已了解取消范围</label><button className="danger" disabled={!cancelConfirmed || action.pending} onClick={() => void perform('cancel')}>确认取消任务</button></details>}
    {!uncertain && !job.retry_allowed && !['queued', 'running', 'waiting_user'].includes(job.status) && <p>{job.manual_resolved ? '任务已人工结束，保留草稿结果未知。该任务不会再次重试。' : '此任务已结束。请查看执行结果和关联日志。'}</p>}
    {action.pending && <p role="status">正在提交操作，请等待服务端确认…</p>}
    {action.error && <div className="notice error" role="alert">{action.error}</div>}
  </div></section>;
}

export function JobDetail({ id }: { id: string }) {
  const { route } = useWorkspace();
  const resource = useResource<Job>('/api/jobs/' + encodeURIComponent(id));
  const back = new URLSearchParams(route.split('?')[1]).get('back');
  const backHref = back && (/^\/jobs(?:\?|$)/.test(back) || /^\/logs(?:\?|$)/.test(back) || back === '/account') ? back : '/jobs';
  const job = resource.data;
  if (!job) return <div className="page"><RouteLink className="back-link" href={backHref}><ArrowLeft size={14} />返回任务列表</RouteLink><section className="surface"><ResourceError error={resource.error} /><Empty loading={resource.loading}>无法读取任务，请刷新或返回列表。</Empty><RefreshBar resource={resource} /></section></div>;
  const remote = draftURL(job.remote_url);
  return <div className="page">
    <RouteLink className="back-link" href={backHref}><ArrowLeft size={14} aria-hidden="true" />返回任务列表</RouteLink>
    <div className="page-heading"><div><h1 className="detail-title">{job.title || 'CSDN 登录状态检查'}</h1><p><span className="mono">{job.id}</span></p></div><Status value={job.status} cancelling={job.cancel_requested && ['queued', 'running'].includes(job.status)} /></div>
    <ResourceError error={resource.error} stale />
    <div className="detail-layout">
      <section className="surface detail-result"><div className="surface-header"><h2>执行结果</h2><span className="muted" style={{ fontSize: 12 }}>CSDN</span></div><RefreshBar resource={resource} /><div className="surface-body">
        <div className="result-line"><strong>{outcomeText(job)}</strong>{remote && <a href={remote} target="_blank" rel="noopener noreferrer">查看CSDN草稿 <ArrowUpRight size={13} aria-hidden="true" /></a>}<p>{job.kind === 'save_draft' ? '保存成功仅代表草稿已保存，文章不会公开发布。' : '此任务只检查账号状态，不修改平台内容。'}</p></div>
        <dl className="detail-facts"><div><dt>当前步骤</dt><dd>{stageLabels[job.stage] || '步骤待确认'}</dd></div><div><dt>执行次数</dt><dd>{job.attempts ?? 0} 次</dd></div><div><dt>安全重试</dt><dd>{job.retry_count ?? 0} / {job.max_retries ?? 3} 次</dd></div><div><dt>创建时间</dt><dd>{time(job.created_at)}</dd></div><div><dt>最近确认</dt><dd>{time(job.updated_at)}</dd></div><div><dt>执行方式</dt><dd>{job.run_mode === 'reconcile' ? '只读核对' : '保存草稿'}</dd></div>{job.remote_id && <div><dt>已关联草稿ID</dt><dd className="mono">{job.remote_id}</dd></div>}</dl>
        {job.error_message && <div className="notice error section-gap"><strong>最近错误</strong><p>{job.error_message}</p>{job.error_code && <p className="mono">{job.error_code}</p>}</div>}
      </div></section>
      <JobActions key={job.id} job={job} onUpdate={resource.refresh} />
      <div className="detail-history">
      {job.markdown !== undefined && <section className="surface section-gap"><div className="surface-header"><h2>已确认的原稿</h2><span className="muted" style={{ fontSize: 12 }}>提交后不可修改</span></div><div className="surface-body"><pre className="snapshot">{job.markdown}</pre></div></section>}
      <div className="section-gap"><Logs jobId={job.id} /></div>
    </div></div>
  </div>;
}
