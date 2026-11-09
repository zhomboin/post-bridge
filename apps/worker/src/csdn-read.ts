import type { BrowserContext, Page, Request } from 'playwright';
import { safeRequestURL } from './config.js';
import { readLoginIdentity } from './login-identity.js';
import { nativeReadRequest } from './native-read.js';
import type {
  Article,
  ArticleBody,
  ArticleSnapshot,
  ArticleStats,
  ArticleTrend,
  Hooks,
  Job,
  JobResult,
} from './types.js';

type ObjectValue = Record<string, unknown>;
interface Identity {
  username: string;
  timeoutMs?: number;
}
interface Site {
  origin: string;
  accountPath: string;
  managePath: string;
  analysisPath: string;
  editorPath: string;
}
class ReadFailure extends Error {}
class CheckpointFailure extends Error {}
const listPath = '/blog/phoenix/console/v1/article/list';
const bodyPath = '/blog-console-api/v3/editor/getArticle';
const profilePath = '/blog-console-api/v1/user/info';
const summaryPath = '/blog/phoenix/console/v1/data/get-blog-statistics-data';
const statsPath = '/blog/phoenix/console/v1/data/blog-statistics';
const trendPath = '/blog/phoenix/console/v1/data/all-article';
const maxItems = 2000;
const maxListBytes = 6 * 1024 * 1024;
const maxBodyBytes = 2 * 1024 * 1024;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReadFailure();
  return value as ObjectValue;
}
function text(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || value.length > max) throw new ReadFailure();
  return value;
}
function optionalText(value: unknown, max = 1000): string {
  return value === undefined || value === null ? '' : text(value, max);
}
function id(value: unknown): string {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'number' && !Number.isSafeInteger(value)) ||
    !/^\d{1,30}$/.test(String(value))
  )
    throw new ReadFailure();
  return String(value);
}
function integer(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)
    throw new ReadFailure();
  return number;
}
function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
}
function signedInteger(value: unknown): number | null {
  const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : null;
}
function nullableInteger(value: unknown): number | null {
  const number = nullableNumber(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}
function boolean(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0' || value === undefined || value === null)
    return false;
  throw new ReadFailure();
}
function status(value: unknown): string {
  return String(integer(value));
}
function kind(value: unknown): Article['type'] {
  if (value === 1 || value === '1' || value === 'original') return 'original';
  if (value === 2 || value === '2' || value === 'repost') return 'repost';
  if (value === 'translated') return 'translated';
  return 'unknown';
}
function safeImage(value: unknown): string {
  const valueURL = text(value, 2000);
  const url = new URL(valueURL);
  // 已核实的图片域名仅供返回元数据，不加入浏览器请求白名单。
  const metadataImage =
    url.protocol === 'https:' &&
    ['profile-avatar.csdnimg.cn', 'i-blog.csdnimg.cn'].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    (url.port === '' || url.port === '443');
  if (!safeRequestURL(valueURL) && !metadataImage) throw new ReadFailure();
  return valueURL;
}
function postedAt(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const raw = text(value, 50);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? raw.replace(' ', 'T') + '+08:00'
    : raw;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ||
    !Number.isFinite(Date.parse(normalized))
  )
    throw new ReadFailure();
  return normalized;
}
function parseArticle(value: unknown, username: string): Article {
  const entry = object(value);
  if (entry.username !== username) throw new ReadFailure();
  const native = status(entry.status);
  const states: Record<string, Article['status']> = {
    '1': 'published',
    '2': 'draft',
    '6': 'rejected',
    '32': 'recycled',
  };
  const cover =
    entry.coverImage === undefined || entry.coverImage === null || entry.coverImage === ''
      ? []
      : Array.isArray(entry.coverImage)
        ? entry.coverImage
        : [entry.coverImage];
  if (cover.length > 20) throw new ReadFailure();
  return {
    id: id(entry.articleId),
    title: text(entry.title, 500),
    status: states[native] ?? 'unknown',
    platform_status: native,
    posted_at: postedAt(entry.postTime),
    type: kind(entry.type),
    views: integer(entry.viewCount),
    likes: integer(entry.diggCount),
    comments: integer(entry.commentCount),
    favorites: integer(entry.collectCount),
    exposures: integer(entry.totalExposures),
    gained_fans: nullableInteger(entry.fansCount),
    quality_score: nullableNumber(entry.qualityScore),
    is_top: boolean(entry.isTop),
    fans_only: boolean(entry.isNeedFans),
    vip_only: boolean(entry.isNeedVip) || boolean(entry.isVipArticle),
    editor_type: integer(entry.editorType),
    cover_urls: cover.map(safeImage),
  };
}
function strings(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const entries =
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : value;
  if (!Array.isArray(entries) || entries.length > 100) throw new ReadFailure();
  return entries.map((entry) => text(entry, 200));
}
function parseBody(value: unknown, requested: string): ArticleBody {
  const entry = object(value);
  if (id(entry.article_id) !== requested) throw new ReadFailure();
  return {
    id: requested,
    title: text(entry.title, 500),
    markdown: optionalText(entry.markdowncontent, maxBodyBytes),
    html: optionalText(entry.content, maxBodyBytes),
    description: optionalText(entry.description, 20000),
    tags: strings(entry.tags),
    categories: strings(entry.categories),
    type: optionalText(entry.type, 100),
    visibility: optionalText(entry.read_type, 100),
    platform_status: status(entry.status),
    reason: optionalText(entry.reason, 10000),
  };
}
function data(value: unknown): unknown {
  const body = object(value);
  if (body.code !== 200) throw new ReadFailure();
  return body.data;
}

export class CSDNReadAdapter {
  private readonly site: Site;
  private readonly fixture: boolean;
  private readonly timeout: number;
  constructor(
    private readonly context: BrowserContext,
    private readonly identity: Identity,
    fixture?: Site,
  ) {
    if (
      fixture &&
      (process.env.NODE_ENV !== 'test' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture.origin))
    )
      throw new Error('模拟站点仅限测试回环地址');
    this.fixture = !!fixture;
    this.site = fixture ?? {
      origin: 'https://mp.csdn.net',
      accountPath: '/',
      managePath: '/mp_blog/manage/article',
      analysisPath: '/mp_blog/analysis/article',
      editorPath: 'https://editor.csdn.net/md/?not_checkout=1',
    };
    this.timeout = identity.timeoutMs ?? 20000;
  }
  private trusted(url: URL): boolean {
    return this.fixture
      ? url.origin === this.site.origin
      : url.origin === 'https://bizapi.csdn.net';
  }
  private allowed(url: URL): boolean {
    return safeRequestURL(url.href) || (this.fixture && url.origin === this.site.origin);
  }
  private requestID(request: Request): string | undefined {
    try {
      const url = new URL(request.url());
      const candidates: unknown[] = [
        ...url.searchParams.getAll('articleId'),
        ...url.searchParams.getAll('article_id'),
        ...url.searchParams.getAll('id'),
      ];
      if (request.postData()) {
        const body = object(request.postDataJSON());
        for (const key of ['articleId', 'article_id'])
          if (body[key] !== undefined) candidates.push(body[key]);
      }
      const ids = candidates.map(id);
      return ids.length && ids.every((value) => value === ids[0]) ? ids[0] : undefined;
    } catch {
      return undefined;
    }
  }
  private async response(
    request: Request,
    limit: number,
  ): Promise<{ value: unknown; bytes: number }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await request.response();
          if (!response || response.status() !== 200) throw new ReadFailure();
          const length = response.headers()['content-length'];
          if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new ReadFailure();
          const body = await response.body();
          if (body.length > limit) throw new ReadFailure();
          return { value: JSON.parse(body.toString('utf8')) as unknown, bytes: body.length };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ReadFailure()), this.timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async account(
    page: Page,
    signal: AbortSignal,
  ): Promise<'connected' | 'needs_login' | 'account_mismatch'> {
    await page.goto(new URL(this.site.accountPath, this.site.origin).href, {
      waitUntil: 'domcontentloaded',
    });
    const deadline = Date.now() + this.timeout;
    do {
      signal.throwIfAborted();
      const current = await readLoginIdentity(
        page,
        this.identity.username,
        this.fixture ? { origin: this.site.origin, accountPath: this.site.accountPath } : undefined,
      );
      if (current === 'connected') return 'connected';
      if (current === 'wrong') return 'account_mismatch';
      if (
        await page
          .getByText(/^登录$/)
          .filter({ visible: true })
          .count()
      )
        return 'needs_login';
      await page.waitForTimeout(50);
    } while (Date.now() < deadline);
    return 'needs_login';
  }
  async run(job: Job, hooks: Hooks, signal: AbortSignal): Promise<JobResult> {
    let page: Page | undefined;
    let verified = false;
    const metrics = new Map<string, Promise<unknown>>();
    const abort = () => {
      void page?.close().catch(() => {});
    };
    const settleMetrics = async () => {
      const deadline = Date.now() + this.timeout;
      for (;;) {
        const pending = [...metrics.entries()];
        await Promise.all(pending.map(([, response]) => response));
        signal.throwIfAborted();
        if (
          Date.now() >= deadline ||
          (pending.length === metrics.size &&
            pending.every(([path, response]) => metrics.get(path) === response))
        )
          return;
      }
    };
    const progress = async (stage: string) => {
      signal.throwIfAborted();
      try {
        await hooks.progress({ stage });
      } catch {
        throw new CheckpointFailure();
      }
    };
    try {
      await this.context.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const contentRead =
          url.pathname === bodyPath &&
          (this.trusted(url) || url.origin === 'https://editor.csdn.net');
        if (
          contentRead &&
          (!verified || job.kind !== 'read_article' || this.requestID(request) !== job.article_id)
        )
          return route.abort('blockedbyclient');
        if (this.trusted(url) && url.pathname === listPath && !verified)
          return route.abort('blockedbyclient');
        const readPost =
          request.method() === 'POST' &&
          (this.trusted(url) || url.origin === 'https://editor.csdn.net') &&
          url.pathname === bodyPath &&
          job.kind === 'read_article' &&
          this.requestID(request) === job.article_id;
        return this.allowed(url) &&
          (request.method() === 'GET' || request.method() === 'HEAD' || readPost)
          ? route.continue()
          : route.abort('blockedbyclient');
      });
      await this.context.routeWebSocket('**/*', (socket) => socket.close());
      await Promise.all(this.context.pages().map((existing) => existing.close()));
      signal.throwIfAborted();
      if (
        !['sync_articles', 'read_article'].includes(job.kind) ||
        job.account_username !== this.identity.username ||
        job.external_started ||
        job.remote_id ||
        job.run_mode !== 'execute'
      )
        return {
          status: 'failed',
          error_code: 'account_mismatch',
          error_message: '读取任务与当前账号配置不一致',
          retryable: false,
        };
      if (job.kind === 'read_article') id(job.article_id);
      page = await this.context.newPage();
      page.setDefaultTimeout(this.timeout);
      page.setDefaultNavigationTimeout(this.timeout);
      page.on('dialog', (dialog) => {
        void dialog.dismiss().catch(() => {});
      });
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (
          this.trusted(url) &&
          request.method() === 'GET' &&
          [profilePath, summaryPath, statsPath, trendPath].includes(url.pathname)
        )
          metrics.set(
            url.pathname,
            this.response(request, 256 * 1024)
              .then((result) => data(result.value))
              .catch(() => undefined),
          );
      });
      signal.addEventListener('abort', abort, { once: true });
      await progress('checking_login');
      const identity = await this.account(page, signal);
      if (identity !== 'connected')
        return {
          status: identity === 'needs_login' ? 'waiting_user' : 'failed',
          error_code: identity,
          error_message:
            identity === 'needs_login' ? '平台账号需要人工登录' : '平台账号与配置不一致',
          retryable: false,
        };
      // 首页汇总可能在账号链接出现后才发起，先等有限的原生页面加载。
      await page.waitForLoadState('networkidle', { timeout: this.timeout }).catch(() => {});
      await settleMetrics();
      const profile = await metrics.get(profilePath);
      if (profile !== undefined && object(profile).username !== this.identity.username)
        return {
          status: 'failed',
          error_code: 'account_mismatch',
          error_message: '平台账号与配置不一致',
          retryable: false,
        };
      verified = true;
      await progress('verifying');
      if (job.kind === 'read_article') {
        const requested = id(job.article_id);
        const responsePromise = page.waitForRequest((request) => {
          const url = new URL(request.url());
          return (
            (this.trusted(url) || url.origin === 'https://editor.csdn.net') &&
            url.pathname === bodyPath &&
            this.requestID(request) === requested
          );
        });
        const url = new URL(this.site.editorPath, this.site.origin);
        url.searchParams.set('articleId', requested);
        const [request] = await Promise.all([
          responsePromise,
          page.goto(url.href, { waitUntil: 'domcontentloaded' }),
        ]);
        const body = parseBody(data((await this.response(request, maxBodyBytes)).value), requested);
        signal.throwIfAborted();
        return { status: 'succeeded', article: body };
      }
      const items = await this.articles(page, signal);
      await page.goto(new URL(this.site.analysisPath, this.site.origin).href, {
        waitUntil: 'domcontentloaded',
      });
      // 页面原生请求携带平台自己的会话与校验，不复制 Cookie 或生成签名。
      await page.waitForLoadState('networkidle', { timeout: this.timeout }).catch(() => {});
      await settleMetrics();
      const captured = new Map<string, unknown>();
      for (const [path, pending] of metrics) captured.set(path, await pending);
      const snapshot = this.snapshot(items, captured);
      signal.throwIfAborted();
      return { status: 'succeeded', articles: snapshot };
    } catch (error) {
      if (error instanceof CheckpointFailure) throw new Error('任务检查点未确认');
      if (signal.aborted)
        return {
          status: 'cancelled',
          error_code: 'cancelled',
          error_message: '浏览器读取已停止',
          retryable: false,
        };
      return {
        status: 'failed',
        error_code: 'article_read_unavailable',
        error_message: '平台读取未通过完整性与安全检查',
        retryable: false,
      };
    } finally {
      signal.removeEventListener('abort', abort);
      await page?.close().catch(() => {});
    }
  }
  private async articles(page: Page, signal: AbortSignal): Promise<Article[]> {
    const merged = new Map<string, Article>();
    let bytes = 0;
    let expectedCounts: string | undefined;
    await page.goto(new URL(this.site.managePath, this.site.origin).href, {
      waitUntil: 'domcontentloaded',
    });
    for (const category of ['all_v3', 'draft']) {
      const seen = new Set<string>();
      let total: number | undefined;
      for (let number = 1; number <= 100; number++) {
        signal.throwIfAborted();
        const target =
          number === 1
            ? page.getByText(category === 'draft' ? /^草稿箱(?:\s|\(|（|$)/ : /^全部(?:\s|\(|（|$)/)
            : page.getByRole('button', { name: '下一页', exact: true });
        const request = await nativeReadRequest(
          page,
          target,
          (request) => {
            const url = new URL(request.url());
            return (
              this.trusted(url) &&
              request.method() === 'GET' &&
              url.pathname === listPath &&
              url.searchParams.get('status') === category &&
              (url.searchParams.get('page') ?? '1') === String(number)
            );
          },
          this.timeout,
        );
        const response = await this.response(request, maxListBytes - bytes);
        bytes += response.bytes;
        const value = object(data(response.value));
        const counts = object(value.count);
        const count = JSON.stringify([integer(counts.all_v3), integer(counts.draft)]);
        if (expectedCounts !== undefined && expectedCounts !== count) throw new ReadFailure();
        expectedCounts = count;
        const currentTotal = integer(value.total);
        if (
          currentTotal > maxItems ||
          currentTotal !== integer(counts[category]) ||
          (total !== undefined && total !== currentTotal) ||
          value.page !== number ||
          value.size !== 20 ||
          (value.listStatus !== undefined && value.listStatus !== category) ||
          !Array.isArray(value.list) ||
          value.list.length > 20
        )
          throw new ReadFailure();
        total = currentTotal;
        for (const raw of value.list) {
          const entry = parseArticle(raw, this.identity.username);
          if (category === 'draft' && entry.status !== 'draft') throw new ReadFailure();
          if (seen.has(entry.id)) throw new ReadFailure();
          seen.add(entry.id);
          const previous = merged.get(entry.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
            throw new ReadFailure();
          merged.set(entry.id, entry);
        }
        if (
          seen.size > total ||
          merged.size > maxItems ||
          (seen.size < total && value.list.length !== 20)
        )
          throw new ReadFailure();
        if (seen.size === total) break;
        if (number === 100) throw new ReadFailure();
      }
    }
    return [...merged.values()];
  }
  private snapshot(items: Article[], metrics: Map<string, unknown>): ArticleSnapshot {
    const profile = metrics.get(profilePath) === undefined ? {} : object(metrics.get(profilePath));
    if (profile.username !== undefined && profile.username !== this.identity.username)
      throw new ReadFailure();
    const summary = metrics.get(summaryPath) === undefined ? {} : object(metrics.get(summaryPath));
    const nativeStats = metrics.get(statsPath);
    const entries = Array.isArray(nativeStats) ? nativeStats.map(object) : [];
    const stat = (...names: string[]) =>
      nullableInteger(entries.find((entry) => names.includes(String(entry.enName)))?.num);
    const counts: ArticleSnapshot['counts'] = {
      total: items.length,
      published: 0,
      draft: 0,
      rejected: 0,
      recycled: 0,
      unknown: 0,
    };
    for (const entry of items) counts[entry.status]++;
    const stats: ArticleStats = {
      articles: stat('article'),
      views: nullableInteger(summary.allViewCount) ?? stat('view', 'viewCount'),
      likes: stat('digg', 'diggCount', 'like'),
      comments: stat('comment', 'commentCount'),
      favorites: nullableInteger(summary.allFavoriteCount) ?? stat('collect', 'favorite'),
      exposures: stat('exposure', 'exposures'),
      followers: nullableInteger(summary.allFansCount),
      yesterday_views: nullableInteger(summary.yesterdayViewCount),
      yesterday_followers: signedInteger(summary.yesterdayFansCount),
      yesterday_favorites: signedInteger(summary.yesterdayFavoriteCount),
    };
    const nativeTrend = metrics.get(trendPath) === undefined ? {} : object(metrics.get(trendPath));
    const chart = nativeTrend.chartData === undefined ? {} : object(nativeTrend.chartData);
    const dates = nativeTrend.dateList;
    let rows: unknown = nativeTrend.list ?? [];
    if (dates !== undefined) {
      if (!Array.isArray(dates) || dates.length > 366) throw new ReadFailure();
      const series = (key: string, index: number): unknown => {
        const values = chart[key];
        if (values === undefined || values === null) return undefined;
        if (!Array.isArray(values) || values.length !== dates.length) throw new ReadFailure();
        return values[index];
      };
      rows = dates.map((date, index) => ({
        pdate: date,
        viewCount: series('view', index),
        commentCount: series('comment', index),
        favoriteCount: series('collect', index),
        fanCount: series('fans', index),
        promotionCardClickCnt: series('promotionCardClickCnt', index),
        articleOutlinkClickCnt: series('articleOutlinkClickCnt', index),
      }));
    }
    if (!Array.isArray(rows) || rows.length > 366) throw new ReadFailure();
    const seenDates = new Set<string>();
    const trend: ArticleTrend[] = rows.map((raw) => {
      const row = object(raw);
      const date = text(row.pdate, 10);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        seenDates.has(date)
      )
        throw new ReadFailure();
      seenDates.add(date);
      return {
        date,
        views: nullableInteger(row.viewCount),
        comments: nullableInteger(row.commentCount),
        favorites: nullableInteger(row.favoriteCount),
        followers: signedInteger(row.fanCount),
        promotion_clicks: nullableInteger(row.promotionCardClickCnt),
        outlink_clicks: nullableInteger(row.articleOutlinkClickCnt),
      };
    });
    return {
      username: this.identity.username,
      profile: {
        nickname: optionalText(profile.nickname, 500),
        avatar_url: profile.avatar ? safeImage(profile.avatar) : '',
        level: nullableInteger(profile.level),
        points: nullableInteger(profile.point),
        original_articles: nullableInteger(summary.allOriginalArticleCount),
        followers: nullableInteger(summary.allFansCount),
      },
      counts,
      stats,
      trend,
      items,
    };
  }
}
