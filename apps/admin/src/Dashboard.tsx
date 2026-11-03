import { useRef } from 'react';
import RemoteLogin from './RemoteLogin';
import { AlertCircle, ArrowUpRight, CheckCircle2, Plus } from 'lucide-react';
import { Empty, RefreshBar, ResourceError, RouteLink, Status, jobHref, statusLabels, time, useAction, useResource, useWorkspace, type Account, type Job, type Overview, type Settings } from './runtime';

export function Dashboard() {
  const resource = useResource<Overview>('/api/overview');
  const data = resource.data;
  const lastSeen = data?.worker_last_seen_at;
  const workerOnline = !!lastSeen && Date.now() - new Date(lastSeen).getTime() < 45000;
  return <div className="page">
    <div className="page-heading"><div><h1>发布工作台</h1><p>关注需要处理的草稿，确认每一次保存。</p></div><RouteLink className="button primary" href="/jobs/new"><Plus size={16} aria-hidden="true" />新建草稿</RouteLink></div>
    <ResourceError error={resource.error} stale={!!data} />
    {!data ? <section className="surface"><Empty loading={resource.loading}>无法读取总览，请稍后刷新。</Empty><RefreshBar resource={resource} /></section> : <>
      <div className="overview-counts">{['queued', 'running', 'failed', 'waiting_user', 'reconciling'].map(status => <RouteLink className="count-link" key={status} href={'/jobs?status=' + status}>{statusLabels[status]}<strong>{data.counts[status] || 0}</strong></RouteLink>)}</div>
      <section className="surface section-gap"><div className="surface-header"><h2>需要关注</h2><span className="muted" style={{ fontSize: 12 }}>当前运行状态</span></div><RefreshBar resource={resource} />
        <div className="overview-row"><div><h3>{workerOnline ? '执行器在线' : '执行器暂未连接'}</h3><p>{workerOnline ? '后台可以按队列处理任务。' : '任务会保留在队列。请管理员确认后台服务已启动。'}最近报告：{time(lastSeen)}</p></div>{workerOnline ? <CheckCircle2 size={18} color="#176443" aria-label="在线" /> : <AlertCircle size={18} color="#855214" aria-label="需关注" />}</div>
        <div className="overview-row"><div><h3>CSDN 账号</h3><p>{data.account?.status === 'connected' ? '登录状态正常，可提交文字草稿。' : '提交草稿前，先检查账号并完成必要的登录。'}</p></div><RouteLink className="button" href="/account">查看账号</RouteLink></div>
        {(data.counts.waiting_user || 0) > 0 && <div className="overview-row"><div><h3>有任务等待登录</h3><p>在账号页完成远程登录，后台将自动恢复等待任务。</p></div><RouteLink className="button" href="/jobs?status=waiting_user">去处理</RouteLink></div>}
        {(data.counts.reconciling || 0) > 0 && <div className="overview-row"><div><h3>有草稿结果待核对</h3><p>先核对已有草稿，避免重复创建。</p></div><RouteLink className="button" href="/jobs?status=reconciling">去核对</RouteLink></div>}
      </section>
      <div className="notice section-gap">当前仅开放 CSDN 文字草稿保存。保存成功不代表文章已公开发布。</div>
    </>}
  </div>;
}

export function AccountPage() {
  const { api, navigate } = useWorkspace();
  const account = useResource<Account>('/api/account');
  const settings = useResource<Settings>('/api/settings');
  const action = useAction();
  const requestId = useRef<string | undefined>(undefined);
  async function check() {
    requestId.current ||= crypto.randomUUID();
    const result = await action.run(signal => api<Job>('/api/account/check', { method: 'POST', body: JSON.stringify({ request_id: requestId.current }), signal }));
    if (result) { requestId.current = undefined; navigate(jobHref(result.id, '/account')); }
  }
  return <div className="page"><div className="page-heading"><div><h1>CSDN 账号</h1><p>查看固定账号的连接状态与当前运行限制。</p></div><button className="primary" disabled={action.pending || !account.data} onClick={() => void check()}>{action.pending ? '正在创建检查任务…' : '检查登录状态'}</button></div>
    <section className="surface"><div className="surface-header"><h2>平台连接</h2><span className="muted" style={{ fontSize: 12 }}>单账号</span></div><RefreshBar resource={account} /><ResourceError error={account.error} stale={!!account.data} />
      {!account.data ? <Empty loading={account.loading}>无法读取账号信息，请刷新。</Empty> : <div className="surface-body"><div className="account-summary"><div className="account-identity"><div className="account-icon" aria-hidden="true">C</div><div><h2>{account.data.display_name || account.data.username || 'CSDN 固定账号'}</h2><p>{account.data.username || '账号由服务管理员配置'}</p></div></div><Status value={account.data.status} /></div>
        <dl className="readonly-list"><dt>平台</dt><dd>CSDN</dd><dt>最近检查</dt><dd>{time(account.data.last_checked_at)}</dd><dt>账号管理</dt><dd>当前只读，账号身份由服务管理员配置。</dd></dl>
        {account.data.last_error && <div className="notice error section-gap">{account.data.last_error}</div>}
        <div className={'notice section-gap ' + (account.data.status === 'connected' ? '' : 'warning')}><strong>需要登录时</strong><p>可在下方远程登录面板完成验证，无需连接服务器桌面；成功后后台自动恢复等待任务。仍可使用验证主机的本地登录助手。</p></div>
        {action.error && <div className="notice error section-gap" role="alert">{action.error}</div>}
      </div>}
    </section>
    <RemoteLogin onVerified={account.refresh} />
    <section className="surface section-gap"><div className="surface-header"><h2>运行限制</h2><span className="muted" style={{ fontSize: 12 }}>只读</span></div><ResourceError error={settings.error} stale={!!settings.data} />
      {!settings.data ? <Empty loading={settings.loading}>无法读取运行限制。</Empty> : <div className="surface-body"><dl className="readonly-list"><dt>保存方式</dt><dd>仅保存 CSDN 草稿，不公开发布</dd><dt>内容范围</dt><dd>文字 Markdown，不支持图片、HTML 和 MDX</dd><dt>账号并发</dt><dd>同一账号同时只处理一个任务</dd><dt>页面刷新</dt><dd>默认每 5 秒，可暂停；页面隐藏后停止</dd><dt>执行器报告</dt><dd>{time(settings.data.worker_last_seen_at)}</dd></dl><p className="form-hint section-gap">运行参数由服务配置管理，当前页面不提供修改。</p></div>}
    </section>
  </div>;
}
