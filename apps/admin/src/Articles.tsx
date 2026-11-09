import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, RefreshCw } from 'lucide-react';
import AccountTrend from './AccountTrend';
import { accountArticlesHref } from './accountRoutes';
import {
  Empty,
  Pagination,
  RefreshBar,
  ResourceError,
  RouteLink,
  Status,
  queryPage,
  time,
  useAction,
  useResource,
  useWorkspace,
  type Account,
  type Job,
  type PageData,
} from './runtime';

type ArticleStatus = 'published' | 'draft' | 'rejected' | 'recycled' | 'unknown';
export type Article = {
  id: string;
  title: string;
  status: ArticleStatus;
  platform_status: string;
  posted_at: string;
  type: string;
  views: number;
  likes: number;
  comments: number;
  favorites: number;
  exposures: number;
  gained_fans: number | null;
  quality_score: number | null;
  is_top: boolean;
  fans_only: boolean;
  vip_only: boolean;
  editor_type: number;
  cover_urls: string[];
  blog_url?: string;
  editor_url?: string;
};
type Metrics = Record<string, number | null>;
export type ArticleSnapshot = {
  username: string;
  profile: {
    nickname: string;
    avatar_url: string;
    level: number | null;
    points: number | null;
    original_articles: number | null;
    followers: number | null;
  };
  counts: Record<string, number>;
  stats: Metrics;
  trend: {
    date: string;
    views: number | null;
    comments: number | null;
    favorites: number | null;
    followers: number | null;
    promotion_clicks: number | null;
    outlink_clicks: number | null;
  }[];
  synced_at: string;
};
type ArticleBody = {
  id: string;
  title: string;
  markdown: string;
  html: string;
  description: string;
  tags: string[];
  categories: string[];
  type: string;
  visibility: string;
  platform_status: string;
  reason: string;
};
export type ArticlePage = PageData<Article> & {
  snapshot: ArticleSnapshot | null;
  sync_job: Job | null;
};
type ArticleDetailData = {
  article: Article;
  body: ArticleBody | null;
  fetched_at: string | null;
  read_job: Job | null;
};
const articleStatuses: Record<ArticleStatus, string> = {
  published: '已发布',
  draft: '草稿',
  rejected: '未通过',
  recycled: '回收站',
  unknown: '未知状态',
};
const types: Record<string, string> = {
  original: '原创',
  repost: '转载',
  translated: '翻译',
  unknown: '未知',
};
const metrics = [
  ['views', '阅读'],
  ['likes', '点赞'],
  ['comments', '评论'],
  ['favorites', '收藏'],
  ['exposures', '曝光'],
  ['followers', '粉丝'],
] as const;
const activeJob = (job?: Job | null) =>
  !!job && ['queued', 'running', 'waiting_user', 'reconciling'].includes(job.status);
const numberText = (value: number | null | undefined) =>
  value == null ? '—' : value.toLocaleString('zh-CN');
function ArticleState({ article }: { article: Article }) {
  const value = articleStatuses[article.status] ? article.status : 'unknown';
  return <span className={'status article-status ' + value}>{articleStatuses[value]}</span>;
}
function ReadJob({ job }: { job?: Job | null }) {
  return job ? (
    <div className="article-job" aria-label="读取任务状态">
      <Status value={job.status} />
      {job.status === 'waiting_user' && (
        <RouteLink href="/account?tab=settings">登录 CSDN</RouteLink>
      )}
      {job.error_message && (
        <span className="article-error" role="status">
          {job.error_message}
        </span>
      )}
    </div>
  ) : null;
}
export function AccountStats({ snapshot }: { snapshot: ArticleSnapshot }) {
  const { profile, stats } = snapshot;
  return (
    <section className="surface article-overview">
      <div className="surface-header">
        <h2>数据统计</h2>
        <div className="article-profile-facts">
          {profile.level != null && <span>等级 {profile.level}</span>}
          {profile.points != null && <span>积分 {numberText(profile.points)}</span>}
          {profile.original_articles != null && (
            <span>原创 {numberText(profile.original_articles)}</span>
          )}
        </div>
      </div>
      <dl className="article-metrics">
        {metrics.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{numberText(stats[key])}</dd>
            {stats['yesterday_' + key] != null && (
              <span>
                昨日 {stats['yesterday_' + key]! >= 0 ? '+' : ''}
                {numberText(stats['yesterday_' + key])}
              </span>
            )}
          </div>
        ))}
      </dl>
      <AccountTrend trend={snapshot.trend || []} />
    </section>
  );
}
export function Articles({ resource }: { resource: ReturnType<typeof useResource<ArticlePage>> }) {
  const { api, route, navigate } = useWorkspace();
  const params = new URLSearchParams(route.split('?')[1]);
  const [q, setQ] = useState(params.get('q') || '');
  const [status, setStatus] = useState(params.get('status') || '');
  useEffect(() => {
    const next = new URLSearchParams(route.split('?')[1]);
    setQ(next.get('q') || '');
    setStatus(next.get('status') || '');
  }, [route]);
  const page = queryPage(params);
  const action = useAction();
  const [submitted, setSubmitted] = useState<Job | null>(null);
  const requestId = useRef<string | undefined>(undefined);
  const remoteJob = resource.data?.sync_job;
  useEffect(() => {
    if (remoteJob && remoteJob.id === submitted?.id) setSubmitted(null);
  }, [remoteJob, submitted]);
  const job = submitted || remoteJob;
  async function sync() {
    if (activeJob(job)) return;
    requestId.current ??= crypto.randomUUID();
    const result = await action.run((signal) =>
      api<Job>('/api/account/articles/sync', {
        method: 'POST',
        body: JSON.stringify({ request_id: requestId.current }),
        signal,
      }),
    );
    if (result) {
      requestId.current = undefined;
      setSubmitted(result);
      resource.refresh();
    }
  }
  function filter(event: FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams();
    if (q.trim()) next.set('q', q.trim());
    if (status) next.set('status', status);
    navigate('/account' + (next.size ? '?' + next : ''));
  }
  return (
    <div className="articles-page">
      <div className="page-heading account-section-heading">
        <h2>文章</h2>
        <button
          className="primary"
          disabled={action.pending || activeJob(job)}
          onClick={() => void sync()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {action.pending || activeJob(job) ? '正在同步…' : '同步文章'}
        </button>
      </div>
      <ReadJob job={job} />
      {action.error && (
        <div role="alert" className="notice error article-action-error">
          {action.error}
        </div>
      )}
      {resource.data?.snapshot && job?.status === 'failed' && (
        <div className="notice warning article-action-error" role="status">
          同步未完成，显示上次快照。
        </div>
      )}
      <section className="surface">
        <form className="toolbar" onSubmit={filter}>
          <label className="search">
            搜索文章
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="文章标题"
            />
          </label>
          <label>
            文章状态
            <select
              aria-label="文章状态"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">
                全部状态
                {resource.data?.snapshot ? ' (' + resource.data.snapshot.counts.total + ')' : ''}
              </option>
              {Object.entries(articleStatuses).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                  {resource.data?.snapshot ? ' (' + resource.data.snapshot.counts[key] + ')' : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">筛选</button>
        </form>
        <RefreshBar resource={resource} name="刷新本地状态" />
        <ResourceError error={resource.error} stale={!!resource.data} />
        {resource.data?.items.length ? (
          <table className="data-table article-table">
            <thead>
              <tr>
                <th className="title-cell">文章</th>
                <th>状态</th>
                <th>阅读 / 互动</th>
                <th>发布时间</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.items.map((article) => (
                <tr key={article.id}>
                  <td className="title-cell">
                    <RouteLink
                      className="title-link"
                      href={
                        '/articles/' +
                        encodeURIComponent(article.id) +
                        '?back=' +
                        encodeURIComponent(accountArticlesHref(route))
                      }
                    >
                      {article.title || '无标题'}
                    </RouteLink>
                    <div className="job-subline">
                      <span>{types[article.type] || '未知'}</span>
                      {article.is_top && <span>置顶</span>}
                      {article.fans_only && <span>粉丝可见</span>}
                      {article.vip_only && <span>会员可见</span>}
                    </div>
                  </td>
                  <td>
                    <ArticleState article={article} />
                  </td>
                  <td>
                    <span>{numberText(article.views)} 阅读</span>
                    <div className="table-title-note">
                      {numberText(article.likes)} 赞　{numberText(article.comments)}
                      {' 评论　'}
                      {numberText(article.favorites)} 收藏
                    </div>
                  </td>
                  <td>
                    <time dateTime={article.posted_at || undefined}>
                      {article.posted_at ? time(article.posted_at) : '时间未知'}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty loading={resource.loading}>
            {resource.data?.snapshot
              ? '暂无符合条件的文章'
              : resource.error
                ? '暂时无法读取文章'
                : '暂无文章快照'}
          </Empty>
        )}
        {resource.data?.snapshot && (
          <Pagination
            total={resource.data.total}
            page={page}
            pageSize={20}
            onPage={(value) => {
              params.set('page', String(value));
              navigate('/account?' + params);
            }}
          />
        )}
      </section>
    </div>
  );
}
function csdnLink(
  value: string | undefined,
  article: Article,
  username: string | undefined,
  kind: 'blog' | 'editor',
) {
  if (!value || !/^\d{1,32}$/.test(article.id)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
      return undefined;
    if (kind === 'blog')
      return username &&
        /^[A-Za-z0-9_-]+$/.test(username) &&
        url.hostname === 'blog.csdn.net' &&
        url.pathname === '/' + username + '/article/details/' + article.id &&
        !url.search
        ? url.href
        : undefined;
    return url.hostname === 'editor.csdn.net' &&
      url.pathname === '/md/' &&
      url.searchParams.get('articleId') === article.id &&
      [...url.searchParams.keys()].length === 1
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function safeBodyLink(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function ArticleDetail({ id }: { id: string }) {
  const { api, route } = useWorkspace();
  const resource = useResource<ArticleDetailData>(
    '/api/account/articles/' + encodeURIComponent(id),
  );
  const account = useResource<Account>('/api/account');
  const action = useAction();
  const autoAttempted = useRef(false);
  const [submitted, setSubmitted] = useState<Job | null>(null);
  const requestId = useRef<string | undefined>(undefined);
  const remoteJob = resource.data?.read_job;
  useEffect(() => {
    if (remoteJob && remoteJob.id === submitted?.id) setSubmitted(null);
  }, [remoteJob, submitted]);
  const job = submitted || remoteJob;
  const rawBack = new URLSearchParams(route.split('?')[1]).get('back');
  const back = accountArticlesHref(rawBack);
  async function read() {
    if (activeJob(job)) return;
    autoAttempted.current = true;
    requestId.current ??= crypto.randomUUID();
    const result = await action.run((signal) =>
      api<Job>('/api/account/articles/' + encodeURIComponent(id) + '/read', {
        method: 'POST',
        body: JSON.stringify({ request_id: requestId.current }),
        signal,
      }),
    );
    if (result) {
      requestId.current = undefined;
      setSubmitted(result);
      resource.refresh();
    }
  }
  useEffect(() => {
    const data = resource.data;
    if (
      autoAttempted.current ||
      !data ||
      resource.error ||
      data.body ||
      activeJob(data.read_job) ||
      ['failed', 'cancelled'].includes(data.read_job?.status || '')
    )
      return;
    autoAttempted.current = true;
    void read();
  }, [resource.data, resource.error]);
  const data = resource.data;
  const article = data?.article;
  const body = data?.body;
  const blog = article && csdnLink(article.blog_url, article, account.data?.username, 'blog');
  const editor = article && csdnLink(article.editor_url, article, account.data?.username, 'editor');
  return (
    <div className="page article-detail">
      <RouteLink className="back-link" href={back}>
        <ArrowLeft size={14} aria-hidden="true" />
        返回账号文章
      </RouteLink>
      {article && (
        <>
          <div className="page-heading">
            <div>
              <h1 className="detail-title">{article.title || '无标题'}</h1>
              <div className="article-detail-meta">
                <ArticleState article={article} />
                <span>{types[article.type] || '未知'}</span>
                <span>{article.posted_at ? time(article.posted_at) : '时间未知'}</span>
              </div>
            </div>
            <div className="heading-actions">
              {blog && (
                <a className="button" href={blog} target="_blank" rel="noopener noreferrer">
                  CSDN 原文
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              )}
              {editor && (
                <a className="button" href={editor} target="_blank" rel="noopener noreferrer">
                  CSDN 编辑器
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              )}
              <button
                className="primary"
                disabled={action.pending || activeJob(job)}
                onClick={() => void read()}
              >
                {action.pending || activeJob(job) ? '正在读取…' : body ? '刷新正文' : '读取正文'}
              </button>
            </div>
          </div>
          <ReadJob job={job} />
        </>
      )}
      {action.error && (
        <div role="alert" className="notice error article-action-error">
          {action.error}
        </div>
      )}
      {article && (
        <section className="surface article-overview">
          <dl className="article-metrics article-detail-metrics">
            {[
              ...metrics.filter(([key]) => key !== 'followers'),
              ['gained_fans', '涨粉'],
              ['quality_score', '质量分'],
            ].map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  {numberText(
                    article[
                      key as
                        | 'views'
                        | 'likes'
                        | 'comments'
                        | 'favorites'
                        | 'exposures'
                        | 'gained_fans'
                        | 'quality_score'
                    ],
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {!!article.cover_urls?.some((url) => safeBodyLink(url)) && (
            <div className="article-covers">
              {article.cover_urls.map(
                (url, index) =>
                  safeBodyLink(url) && (
                    <a
                      key={index}
                      href={safeBodyLink(url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      封面 {index + 1}
                    </a>
                  ),
              )}
            </div>
          )}
        </section>
      )}
      <section className="surface">
        <RefreshBar resource={resource} name="刷新本地状态" />
        <ResourceError error={resource.error} stale={!!data} />
        {body ? (
          <div className="surface-body">
            <div className="article-body-header">
              <h2>文章正文</h2>
              {data?.fetched_at && (
                <span className="muted">正文缓存于 {time(data.fetched_at)}</span>
              )}
            </div>
            <dl className="article-body-facts">
              {body.description && (
                <>
                  <dt>摘要</dt>
                  <dd>{body.description}</dd>
                </>
              )}
              {!!body.tags?.length && (
                <>
                  <dt>标签</dt>
                  <dd>{body.tags.join('、')}</dd>
                </>
              )}
              {!!body.categories?.length && (
                <>
                  <dt>分类</dt>
                  <dd>{body.categories.join('、')}</dd>
                </>
              )}
              {body.type && (
                <>
                  <dt>类型</dt>
                  <dd>{types[body.type] || body.type}</dd>
                </>
              )}
              {body.visibility && (
                <>
                  <dt>可见范围</dt>
                  <dd>
                    {(
                      {
                        public: '公开',
                        private: '私密',
                        fans: '粉丝可见',
                        vip: '会员可见',
                      } as Record<string, string>
                    )[body.visibility] || body.visibility}
                  </dd>
                </>
              )}
              {body.reason && (
                <>
                  <dt>平台原因</dt>
                  <dd>{body.reason}</dd>
                </>
              )}
            </dl>
            {body.markdown ? (
              <pre className="article-source" tabIndex={0} aria-label="Markdown 源文">
                {body.markdown}
              </pre>
            ) : body.html ? (
              <pre className="article-source" tabIndex={0} aria-label="HTML 源文">
                {body.html}
              </pre>
            ) : (
              <Empty>正文为空</Empty>
            )}
          </div>
        ) : (
          <Empty loading={resource.loading}>
            {article ? '尚未读取正文' : resource.error ? '无法读取文章' : '正在加载文章…'}
          </Empty>
        )}
      </section>
    </div>
  );
}
