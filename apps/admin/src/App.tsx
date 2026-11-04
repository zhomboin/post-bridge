import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BookOpenText, FileText, LayoutDashboard, ListFilter, Logs as LogsIcon } from 'lucide-react';
import { Dashboard } from './Dashboard';
import PlatformAccount from './PlatformAccount';
import Integrations from './Integrations';
import IntegrationDraft from './IntegrationDraft';
import { Jobs, JobDetail, NewJob } from './Jobs';
import Logs from './Logs';
import { ArticleDetail } from './Articles';
import { ProcessDetail } from './Processes';
import { ApiError, WorkspaceContext, RouteLink, errorText, type Api, type Session } from './runtime';

const IntegrationDocs = lazy(async () => {
  try { return await import('./IntegrationDocs'); }
  catch {
    return { default: function DocumentUnavailable() {
      return <div className="page"><div className="notice error" role="alert">接入文档加载失败，请刷新页面重试。</div><button className="section-gap" onClick={() => window.location.reload()}>刷新页面</button></div>;
    } };
  }
});

const locationRoute = () => {
  if (window.location.pathname === '/articles') window.history.replaceState({}, '', '/account' + window.location.search);
  return window.location.pathname + window.location.search;
};
const navigation = [
  { href: '/', label: '总览', icon: LayoutDashboard },
  { href: '/account', label: '平台账号', icon: BookOpenText },
  { href: '/jobs', label: '草稿任务', icon: ListFilter },
  { href: '/logs', label: '处理记录', icon: LogsIcon },
  { href: '/integrations', label: '内容来源', icon: BookOpenText },
];
function Login({ api, onLogin, notice }: { api: Api; onLogin: (session: Session) => void; notice: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    if (!username.trim() || !password) { setError('请输入管理员账号和密码。'); return; }
    busy.current = true; setPending(true); setError(''); controller.current = new AbortController();
    try {
      const result = await api<Session>('/api/login', { method: 'POST', body: JSON.stringify({ username: username.trim(), password }), signal: controller.current.signal });
      if (!controller.current.signal.aborted) { setPassword(''); onLogin(result); }
    } catch (error) {
      if (!controller.current.signal.aborted) { setError(errorText(error)); setPassword(''); }
    } finally {
      if (!controller.current.signal.aborted) setPending(false);
      controller.current.abort(); busy.current = false;
    }
  }
  return <main className="login-page"><section className="login-box"><div className="login-brand"><span className="brand-mark"><BookOpenText size={18} aria-hidden="true" /></span>Post Bridge</div><h1>登录发布工作台</h1>
    <form onSubmit={submit}><label>管理员账号<input autoComplete="username" value={username} disabled={pending} onChange={event => setUsername(event.target.value)} /></label><label>密码<input type="password" autoComplete="current-password" value={password} disabled={pending} onChange={event => setPassword(event.target.value)} /></label>{(error || notice) && <div className="notice error" role="alert">{error || notice}</div>}<button className="primary" type="submit" disabled={pending}>{pending ? '正在登录…' : '登录工作台'}</button></form>
  </section></main>;
}
export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [route, setRoute] = useState(locationRoute);
  const [notice, setNotice] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const logoutController = useRef<AbortController | undefined>(undefined);
  const csrf = session?.csrf_token;
  const api = useCallback<Api>(async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    if (init.method && init.method !== 'GET' && path !== '/api/login' && csrf) headers.set('X-CSRF-Token', csrf);
    const response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
    let body: unknown;
    try { body = response.status === 204 ? undefined : await response.json(); } catch { body = undefined; }
    if (!response.ok) {
      const error = body as { code?: string; message?: string } | undefined;
      if (response.status === 401 && path !== '/api/login') {
        setNotice('会话已过期，请重新登录。'); setSession(null);
      }
      throw new ApiError(response.status, error?.code || 'request_failed', error?.message || '请求未完成，请稍后重试。');
    }
    return body as never;
  }, [csrf]);
  useEffect(() => {
    const controller = new AbortController();
    void api<Session>('/api/session', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setSession(result);
    }).catch(error => {
      if (!controller.signal.aborted) { setSession(null); if (!(error instanceof ApiError && error.status === 401)) setNotice('无法读取会话：' + errorText(error)); }
    }).finally(() => controller.abort());
    return () => { controller.abort(); logoutController.current?.abort(); };
  }, []);
  useEffect(() => {
    const pop = () => setRoute(locationRoute());
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  const navigate = useCallback((path: string) => {
    if (!path.startsWith('/') || path.startsWith('//')) return;
    window.history.pushState({}, '', path); setRoute(locationRoute());
  }, []);
  const context = useMemo(() => ({ api, route, navigate }), [api, route, navigate]);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true); setNotice('');
    logoutController.current = new AbortController();
    try {
      await api('/api/logout', { method: 'POST', body: '{}', signal: logoutController.current.signal });
      setSession(null); setNotice('');
    } catch (error) { if (!logoutController.current.signal.aborted) setNotice('退出未完成：' + errorText(error)); }
    finally { logoutController.current.abort(); setLoggingOut(false); }
  }
  if (session === undefined) return <main className="loading-page" role="status">正在验证管理员会话…</main>;
  if (!session) return <Login api={api} notice={notice} onLogin={result => { setNotice(''); setSession(result); }} />;
  const pathname = route.split('?')[0];
  let content;
  if (loggingOut) content = <div className="loading-page" role="status">正在退出…</div>;
  else if (pathname === '/') content = <Dashboard />;
  else if (/^\/articles\/\d{1,32}$/.test(pathname)) content = <ArticleDetail key={pathname} id={pathname.slice('/articles/'.length)} />;
  else if (pathname === '/jobs') content = <Jobs />;
  else if (pathname === '/jobs/new') content = <NewJob />;
  else if (/^\/jobs\/[^/]+$/.test(pathname)) content = <JobDetail key={pathname} id={decodeURIComponent(pathname.slice('/jobs/'.length))} />;
  else if (pathname === '/logs') content = <Logs />;
  else if (/^\/logs\/[^/]+$/.test(pathname)) content = <ProcessDetail key={pathname} id={decodeURIComponent(pathname.slice('/logs/'.length))} />;
  else if (pathname === '/account') content = <PlatformAccount />;
  else if (pathname === '/docs/integrations') content = <Suspense fallback={<div className="loading-page" role="status">正在读取接入文档…</div>}><IntegrationDocs /></Suspense>;
  else if (pathname === '/integrations') content = <Integrations />;
  else if (/^\/integration-preparations\/[^/]+$/.test(pathname)) content = <IntegrationDraft key={pathname} id={decodeURIComponent(pathname.slice('/integration-preparations/'.length))} />;
  else content = <div className="page"><h1>页面不存在</h1><p className="section-gap"><RouteLink href="/jobs">返回草稿任务</RouteLink></p></div>;
  const pageName = pathname === '/docs/integrations' ? '接入文档' : navigation.find(item => item.href === (pathname.startsWith('/integration-preparations') ? '/integrations' : pathname.startsWith('/articles') ? '/account' : pathname.startsWith('/jobs') ? '/jobs' : pathname.startsWith('/logs') ? '/logs' : pathname))?.label || '工作台';
  return <WorkspaceContext.Provider value={context}><a className="skip-link" href="#main-content">跳到主要内容</a><div className="app-shell"><aside className="sidebar">
    <RouteLink className="brand" href="/"><span className="brand-mark"><BookOpenText size={18} aria-hidden="true" /></span>Post Bridge</RouteLink>
    <nav aria-label="主导航">{navigation.map(({ href, label, icon: Icon }) => <RouteLink className="nav-link" key={href} href={href} aria-current={href === (pathname.startsWith('/integration-preparations') ? '/integrations' : pathname.startsWith('/articles') ? '/account' : pathname.startsWith('/jobs') ? '/jobs' : pathname.startsWith('/logs') ? '/logs' : pathname) ? 'page' : undefined}><Icon size={17} aria-hidden="true" />{label}</RouteLink>)}</nav>

  </aside><div className="workspace"><header className="topbar"><span className="topbar-title">{pageName}</span><div className="topbar-session"><RouteLink className="topbar-docs-link" href="/docs/integrations" aria-label="接入文档" title="接入文档" aria-current={pathname === '/docs/integrations' ? 'page' : undefined}><FileText size={18} aria-hidden="true" /></RouteLink><span>{session.user.username}</span><button type="button" disabled={loggingOut} onClick={() => void logout()}>退出登录</button></div></header><main id="main-content" tabIndex={-1}>{notice && <div className="page" style={{ paddingBottom: 0 }}><div className="notice error" role="alert">{notice}</div></div>}{content}</main></div></div></WorkspaceContext.Provider>;
}
