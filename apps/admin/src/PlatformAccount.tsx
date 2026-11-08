import XiaohongshuAccount from './XiaohongshuAccount';
import { useRef, type ReactNode, type KeyboardEvent } from 'react';
import { AccountStats, Articles, type ArticlePage } from './Articles';
import RemoteLogin from './RemoteLogin';
import AccountAvatar from './AccountAvatar';
import CSDNPublishSettings from './CSDNPublishSettings';
import { Empty, RefreshBar, ResourceError, Status, jobHref, queryPage, time, useAction, useResource, useWorkspace, type Account, type Job } from './runtime';

const tabs = [{ value: '', label: '文章' }, { value: 'stats', label: '数据统计' }, { value: 'settings', label: '账号设置' }] as const;
type AccountResource = ReturnType<typeof useResource<Account>>;

function AccountSettings({ account }: { account: AccountResource }) {
  const { api, route, navigate } = useWorkspace();
  const action = useAction();
  const requestId = useRef<string | undefined>(undefined);
  async function check() {
    requestId.current ??= crypto.randomUUID();
    const result = await action.run(signal => api<Job>('/api/account/check', { method: 'POST', body: JSON.stringify({ request_id: requestId.current }), signal }));
    if (result) { requestId.current = undefined; navigate(jobHref(result.id, route)); }
  }
  return <><section className="surface"><div className="surface-header"><h2>账号设置</h2><button className="primary" disabled={action.pending || !account.data} onClick={() => void check()}>{action.pending ? '正在创建检查任务…' : '检查登录状态'}</button></div><RefreshBar resource={account} />
    {!account.data ? <Empty loading={account.loading}>无法读取账号信息，请刷新。</Empty> : <div className="surface-body"><dl className="readonly-list"><dt>最近检查</dt><dd>{time(account.data.last_checked_at)}</dd></dl>{account.data.last_error && <div className="notice error section-gap">{account.data.last_error}</div>}</div>}
    {action.error && <div className="notice error error-inline" role="alert">{action.error}</div>}
  </section><RemoteLogin onVerified={account.refresh} /><CSDNPublishSettings /></>;
}

function CSDNAccount({ picker }: { picker: ReactNode }) {
  const { route, navigate } = useWorkspace();
  const params = new URLSearchParams(route.split('?')[1]);
  const tab = tabs.some(item => item.value === params.get('tab')) ? params.get('tab') || '' : '';
  const account = useResource<Account>('/api/account');
  const search = new URLSearchParams({ page: String(queryPage(params)), page_size: '20' });
  if (params.get('q')) search.set('q', params.get('q')!);
  if (params.get('status')) search.set('status', params.get('status')!);
  const articles = useResource<ArticlePage>('/api/account/articles?' + search);
  const snapshot = articles.data?.snapshot;
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  function select(value: string) {
    if (value) params.set('tab', value); else params.delete('tab');
    navigate('/account' + (params.size ? '?' + params : ''));
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else return;
    event.preventDefault();
    select(tabs[next].value);
    tabButtons.current[next]?.focus();
  }
  return <div className="page platform-account-page"><div className="page-heading"><h1>平台账号</h1>{picker}</div>
    <section className="surface platform-account-header" aria-label="账号身份"><div className="account-summary"><div className="account-identity"><AccountAvatar url={snapshot?.profile.avatar_url} /><div><span className="account-platform">CSDN</span><h2>{snapshot?.profile.nickname || account.data?.display_name || account.data?.username || 'CSDN 固定账号'}</h2><p><span className="account-id-label">账号 ID</span>{snapshot?.username || account.data?.username || account.data?.id || '—'}</p></div></div><Status value={account.data?.status || 'unchecked'} /></div><p className="article-sync-time">最近同步 {time(snapshot?.synced_at)}</p></section>
    <ResourceError error={account.error} stale={!!account.data} />
    <div className="account-tabs" role="tablist" aria-label="平台账号">{tabs.map((item, index) => <button key={item.value} ref={element => { tabButtons.current[index] = element; }} id={'account-tab-' + (item.value || 'articles')} type="button" role="tab" aria-selected={tab === item.value} aria-controls={'account-panel-' + (item.value || 'articles')} tabIndex={tab === item.value ? 0 : -1} onClick={() => select(item.value)} onKeyDown={event => keyDown(event, index)}>{item.label}</button>)}</div>
    <div role="tabpanel" id={'account-panel-' + (tab || 'articles')} aria-labelledby={'account-tab-' + (tab || 'articles')} tabIndex={0}>
      {tab === '' && <Articles resource={articles} />}
      {tab === 'stats' && <><section className="surface account-stats-refresh"><RefreshBar resource={articles} name="刷新本地状态" /><ResourceError error={articles.error} stale={!!articles.data} /></section>{snapshot ? <>{articles.data?.sync_job?.status === 'failed' && <div className="notice warning article-action-error" role="status">同步未完成，显示上次快照。</div>}<AccountStats snapshot={snapshot} /></> : <section className="surface"><Empty loading={articles.loading}>{articles.error ? '暂时无法读取统计' : '暂无统计快照'}</Empty></section>}</>}
      {tab === 'settings' && <AccountSettings account={account} />}
    </div>
  </div>;
}

export default function PlatformAccount() {
  const { route, navigate } = useWorkspace();
  const accounts = useResource<{ items: { account: Account; capabilities: Record<string, boolean> }[] }>('/api/accounts');
  const id = new URLSearchParams(route.split('?')[1]).get('account') || 'csdn-main';
  const selected = accounts.data?.items.find(item => item.account.id === id)?.account;
  const picker = <label className="account-picker">平台账号<select aria-label="选择平台账号" value={id} onChange={event => navigate('/account?account=' + encodeURIComponent(event.target.value))}>{(accounts.data?.items || [{ account: { id: 'csdn-main', platform: 'csdn', display_name: 'CSDN', username: '' } }]).map(({ account }) => <option key={account.id} value={account.id}>{account.platform === 'xiaohongshu' ? '小红书' : 'CSDN'} · {account.display_name || account.username || account.id}</option>)}</select></label>;
  if (id !== 'csdn-main' && !selected) return <div className="page"><div className="page-heading"><h1>平台账号</h1>{picker}</div><ResourceError error={accounts.error} /><Empty loading={accounts.loading}>未找到平台账号</Empty></div>;
  return <><ResourceError error={accounts.error} stale={!!accounts.data} />{selected?.platform === 'xiaohongshu' ? <XiaohongshuAccount key={id} id={id} picker={picker} /> : <CSDNAccount key={id} picker={picker} />}</>;
}
