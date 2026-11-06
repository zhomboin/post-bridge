import { createHash } from 'node:crypto';
import type { BrowserContext, Page, Request, Route } from 'playwright';
import { contentImages } from './config.js';
import { copiedImageOrigin, copiedImageURL, forwardWithoutRedirect, imagePreviewPath, richMarkdown } from './csdn-images.js';
import { forwardPreviewImage } from './csdn-preview.js';
import { declarationValues, isPublishTagURL, preparePublishForm, publishTagKey, templateValues, visibilityValues } from './csdn-publish-form.js';
import type { Hooks, Job, JobResult, Progress, PublishOptions } from './types.js';

interface PublishContext {
  username: string;
  timeout: number;
  fixtureOrigin?: string;
  account(page: Page): Promise<'connected' | 'needs_login' | 'account_mismatch'>;
  editorURL(id: string): string;
  allowed(url: string): boolean;
}

interface Snapshot { title: string; markdown: string; html: string; status: unknown; readType: unknown }
class PublishCheckpointFailure extends Error {}
const apiOrigins = new Set(['https://bizapi.csdn.net', 'https://editor.csdn.net']);
const articleReadPath = '/blog-console-api/v3/editor/getArticle';
const qualityPath = '/blog/phoenix/console/v1/article/get-quality-score';
const checkImagesPath = '/blog/phoenix/console/v1/article/check-images';
const allowedFields = new Set([
  'id', 'title', 'markdowncontent', 'content', 'readType', 'level', 'tags', 'status', 'categories', 'type',
  'original_link', 'authorized_status', 'Description', 'resource_url', 'not_auto_saved', 'source', 'cover_images',
  'cover_type', 'is_new', 'vote_id', 'resource_id', 'pubStatus', 'creation_statement', 'template_id', 'sync_git_code',
  'creator_activity_id', 'plan_id', 'original_plan',
]);
const numericID = (value: unknown): string => typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : '';
const statusIs = (status: unknown, value: number) => status === value || status === String(value);
const htmlDigest = (html: string) => createHash('sha256').update(richMarkdown(html), 'utf8').digest('hex');
const absent = (value: unknown) => value === undefined || value === '' || value === 0 || value === '0' || value === false;

function validLabels(labels: unknown, min: number, max: number, length: number): labels is string[] {
  return Array.isArray(labels) && labels.length >= min && labels.length <= max && new Set(labels).size === labels.length &&
    labels.every(label => typeof label === 'string' && label.length > 0 && [...label].length <= length &&
      label.trim() === label && !/[,，\u0000-\u001f\u007f]/.test(label));
}

function validOptions(options: PublishOptions | undefined): options is PublishOptions {
  if (!options || !validLabels(options.tags, 1, 7, 64) || !validLabels(options.categories, 0, 3, 1000) ||
      typeof options.summary !== 'string' || options.summary.length > 256 || options.summary.includes('\0') ||
      !Object.hasOwn(visibilityValues, options.visibility) || !Object.hasOwn(declarationValues, options.creation_declaration) ||
      !Object.hasOwn(templateValues, options.template) || options.cover_image_url !== '') return false;
  if (options.article_type === 'original') return !options.original_url &&
    (options.rights_confirmed === undefined || options.rights_confirmed === false);
  if (options.article_type !== 'repost' && options.article_type !== 'translated') return false;
  if (options.rights_confirmed !== true || typeof options.original_url !== 'string' || !options.original_url ||
      (options.article_type === 'repost' && options.visibility === 'vip')) return false;
  try {
    const url = new URL(options.original_url);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') &&
      !/[\u0000-\u0020\u007f]/.test(options.original_url) && options.original_url.length <= 2048;
  } catch { return false; }
}

function payloadOf(request: Request): Record<string, unknown> | undefined {
  try {
    const value: unknown = request.postDataJSON();
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* 无法确认的请求保持拦截。 */ }
}

function sameContent(title: string, markdown: string, job: Job): boolean {
  return title === job.title && richMarkdown(markdown) === richMarkdown(job.markdown);
}

function matchesSubmission(body: Record<string, unknown>, job: Job, id: string, options: PublishOptions, html: string): boolean {
  const authorized = options.article_type === 'original' ? body.authorized_status === false : body.authorized_status === true;
  const categories = body.categories === options.categories.join(',') || (!options.categories.length && body.categories === '0');
  return Object.keys(body).every(field => allowedFields.has(field)) && numericID(body.id) === id &&
    body.status === 0 && body.pubStatus === 'publish' && typeof body.title === 'string' &&
    typeof body.markdowncontent === 'string' && sameContent(body.title, body.markdowncontent, job) &&
    body.is_new === 1 && body.source === 'pc_mdeditor' && body.not_auto_saved === '1' &&
    typeof body.content === 'string' && richMarkdown(body.content) === richMarkdown(html) &&
    body.readType === visibilityValues[options.visibility] && body.type === options.article_type &&
    body.original_link === (options.original_url ?? '') && authorized &&
    body.tags === options.tags.join(',') && categories && body.Description === options.summary &&
    body.creation_statement === declarationValues[options.creation_declaration] && body.template_id === templateValues[options.template] &&
    Array.isArray(body.cover_images) && body.cover_images.length === 0 && (body.cover_type === 0 || body.cover_type === 1) &&
    (options.visibility === 'public' ? body.sync_git_code === 0 : body.sync_git_code === undefined) && absent(body.resource_url) && absent(body.resource_id) && absent(body.vote_id) &&
    absent(body.plan_id) && absent(body.original_plan) && absent(body.creator_activity_id) &&
    (body.level === undefined || body.level === 0);
}

export async function runCSDNPublish(context: BrowserContext, job: Job, hooks: Hooks, signal: AbortSignal, site: PublishContext): Promise<JobResult> {
  const id = numericID(job.remote_id);
  const readonly = job.run_mode === 'reconcile' || job.external_started;
  const options = job.publish_options;
  const readOnlyFailure = (code: string, message: string): JobResult => ({
    status: readonly ? 'reconciling' : 'failed', ...(id ? { remote_id: id } : {}), error_code: code, error_message: message, retryable: false,
  });
  if (job.account_username !== site.username || !/^[1-9]\d{0,29}$/.test(id) ||
      [...job.title].length < 5 || [...job.title].length > 100 || !job.markdown.trim() || [...job.markdown].length > 200000 ||
      job.title.includes('\0') || job.markdown.includes('\0')) return readOnlyFailure('publish_draft_mismatch', '待发布草稿或账号未通过核对');
  if (!readonly && !validOptions(options)) return readOnlyFailure('publish_options_mismatch', '发布设置未通过平台检查');

  const editor = new URL(site.editorURL(id));
  const nativeAPI = (url: URL) => apiOrigins.has(url.origin) || url.origin === site.fixtureOrigin;
  const isRead = (url: URL) => nativeAPI(url) && url.pathname === articleReadPath;
  const isSnapshotRequest = (request: Request): boolean => {
    const url = new URL(request.url());
    if (!isRead(url)) return false;
    if (request.method() === 'GET') return url.searchParams.getAll('id').length === 1 &&
      url.searchParams.get('id') === id && !url.searchParams.get('model_type');
    if (request.method() === 'POST' && site.fixtureOrigin) return numericID(payloadOf(request)?.id) === id;
    return false;
  };
  const isSubmit = (url: URL) => site.fixtureOrigin ? url.origin === site.fixtureOrigin && url.pathname === '/save' :
    apiOrigins.has(url.origin) && /^\/blog-console-api\/v3\/(?:editor|mdeditor)\/saveArticle$/.test(url.pathname);
  const copyOrigin = site.fixtureOrigin ?? copiedImageOrigin;
  const copyPaths = new Set((contentImages(job.title, job.markdown, site.fixtureOrigin) ?? [])
    .filter(image => copiedImageURL(image.url, copyOrigin)).map(image => imagePreviewPath(image.url)));
  let page: Page | undefined;
  let filling = false;
  let armed = false;
  let external = job.external_started;
  let accepted = false;
  let imagesChecked = false;
  let draftHTML = '';
  let expectedHTML = readonly && /^[a-f0-9]{64}$/.test(job.published_html_sha256 ?? '') ? job.published_html_sha256 : undefined;
  let submission: Promise<void> | undefined;
  let checkpointFailure: unknown;
  const checkpoint = async (value: Progress) => {
    signal.throwIfAborted();
    try { await hooks.progress(value); } catch { throw new PublishCheckpointFailure('任务检查点未确认'); }
  };
  const closePage = () => { void page?.close().catch(() => {}); };

  const gate = (route: Route): Promise<void> => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const block = () => route.abort('blockedbyclient');
    if (isSubmit(url)) {
      if (readonly || !armed || signal.aborted || request.frame() !== page?.mainFrame() || url.search) return block();
      if (method === 'OPTIONS') return forwardWithoutRedirect(route, site.timeout);
      if (method !== 'POST' || submission || !options || !imagesChecked || !expectedHTML) return block();
      const body = payloadOf(request);
      if (!body || !matchesSubmission(body, job, id, options, draftHTML)) return block();
      // 保留当前请求，直到服务端确认本次不可逆提交边界。
      submission = (async () => {
        try {
          await checkpoint({
            stage: 'saving', external_started: true, remote_id: id, published_html_sha256: expectedHTML,
            message: '正在提交平台发布请求',
          });
          external = true;
          signal.throwIfAborted();
          await forwardWithoutRedirect(route, site.timeout, text => {
            const response = JSON.parse(text) as { code?: unknown; data?: { id?: unknown } };
            accepted = response.code === 200 && numericID(response.data?.id) === id;
          });
        } catch (error) {
          checkpointFailure = error;
          await block().catch(() => {});
        }
      })();
      return submission;
    }
    if (isRead(url)) {
      if (request.frame() !== page?.mainFrame() || (method !== 'OPTIONS' && !isSnapshotRequest(request))) return block();
      return forwardWithoutRedirect(route, site.timeout);
    }
    if (method === 'POST' || method === 'OPTIONS') {
      if (request.frame() !== page?.mainFrame()) return block();
      if (filling && isPublishTagURL(url, site.fixtureOrigin)) {
        if (method === 'OPTIONS') return forwardWithoutRedirect(route, site.timeout);
        const tag = publishTagKey(request, site.fixtureOrigin);
        if (tag && options?.tags.includes(tag)) return forwardWithoutRedirect(route, site.timeout);
      }
      if (armed && nativeAPI(url) && url.pathname === checkImagesPath && !url.search) {
        if (method === 'OPTIONS') return forwardWithoutRedirect(route, site.timeout);
        const body = payloadOf(request);
        if (body && Object.keys(body).length === 1 && typeof body.content === 'string' &&
            richMarkdown(body.content) === richMarkdown(draftHTML)) {
          return forwardWithoutRedirect(route, site.timeout, text => {
            const response = JSON.parse(text) as { code?: unknown; data?: unknown };
            imagesChecked = response.code === 200 && Array.isArray(response.data) && response.data.length === 0;
          });
        }
      }
      if (filling && url.origin === 'https://bizapi.csdn.net' && url.pathname === qualityPath && !url.search) {
        if (method === 'OPTIONS') return forwardWithoutRedirect(route, site.timeout);
        const body = payloadOf(request);
        if (body && numericID(body.articleId) === id && body.title === job.title && typeof body.content === 'string' &&
            richMarkdown(body.content) === richMarkdown(draftHTML) && Object.keys(body).every(key => ['articleId', 'title', 'content'].includes(key))) return forwardWithoutRedirect(route, site.timeout);
      }
      return block();
    }
    if (method !== 'GET' && method !== 'HEAD') return block();
    const copy = copiedImageURL(url.href, copyOrigin, true);
    if (copy && request.resourceType() === 'image' && copyPaths.has(imagePreviewPath(copy.href)) && method === 'GET') {
      return forwardPreviewImage(route, copy, site.timeout, signal);
    }
    if (!site.fixtureOrigin && url.origin === copyOrigin) return block();
    return site.allowed(url.href) ? route.continue() : block();
  };

  const openSnapshot = async (currentPage: Page): Promise<Snapshot | undefined> => {
    const [response] = await Promise.all([
      currentPage.waitForResponse(candidate => isSnapshotRequest(candidate.request()), { timeout: site.timeout }),
      currentPage.goto(editor.href, { waitUntil: 'domcontentloaded' }),
    ]);
    const location = new URL(currentPage.url());
    if (location.origin !== editor.origin || location.pathname !== editor.pathname || response.status() !== 200) return undefined;
    const length = Number(response.headers()['content-length']);
    if (length > 1500000) return undefined;
    const text = await response.text();
    if (text.length > 1500000) return undefined;
    const result = JSON.parse(text) as { code?: unknown; data?: Record<string, unknown> };
    const data = result.data;
    if (result.code !== 200 || !data || numericID(data.article_id ?? data.articleId ?? data.id) !== id ||
        typeof data.title !== 'string' || typeof data.markdowncontent !== 'string' || typeof data.content !== 'string' ||
        !data.content.trim() || data.content.includes('\0')) return undefined;
    return { title: data.title, markdown: data.markdowncontent, html: data.content, status: data.status, readType: data.read_type };
  };
  const outcome = (snapshot?: Snapshot): JobResult => {
    const matches = !!snapshot && expectedHTML !== undefined && sameContent(snapshot.title, snapshot.markdown, job) &&
      htmlDigest(snapshot.html) === expectedHTML;
    const expectedVisibility = options && visibilityValues[options.visibility];
    if (matches && statusIs(snapshot.status, 1) && expectedVisibility && snapshot.readType === expectedVisibility) {
      return { status: 'succeeded', remote_id: id };
    }
    const submitted = accepted || (matches && statusIs(snapshot.status, 16));
    return {
      status: 'reconciling', remote_id: id, ...(submitted ? { publish_accepted: true } : {}),
      error_code: submitted ? 'publish_pending' : 'publish_unconfirmed',
      error_message: submitted ? '平台已受理，等待发布结果' : '平台发布结果尚未确认',
    };
  };

  try {
    signal.throwIfAborted();
    await context.route('**/*', gate);
    await context.routeWebSocket('**/*', socket => socket.close());
    await Promise.all(context.pages().map(existing => existing.close()));
    page = await context.newPage();
    page.setDefaultTimeout(site.timeout);
    page.setDefaultNavigationTimeout(site.timeout);
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    signal.addEventListener('abort', closePage, { once: true });
    await checkpoint({ stage: 'checking_login', message: '正在核验平台账号' });
    const account = await site.account(page);
    if (account !== 'connected') return {
      ...readOnlyFailure(account, account === 'needs_login' ? '平台账号需要人工登录' : '平台账号与任务不一致'),
      ...(account === 'needs_login' && !readonly ? { status: 'waiting_user' as const } : {}),
    };
    await checkpoint({ stage: readonly ? 'verifying' : 'opening_editor', message: '正在读取已有平台稿件' });
    const before = await openSnapshot(page);
    if (readonly) return outcome(before);
    if (!before || !statusIs(before.status, 2) || !sameContent(before.title, before.markdown, job)) {
      return readOnlyFailure('publish_draft_mismatch', '已有平台草稿内容或状态未通过核对');
    }
    draftHTML = before.html;
    expectedHTML = htmlDigest(draftHTML);
    await checkpoint({ stage: 'filling', message: '正在核对平台发布设置' });
    filling = true;
    const submit = await preparePublishForm(page, options!, site.timeout, site.fixtureOrigin);
    filling = false;
    signal.throwIfAborted();
    armed = true;
    await submit.click();
    const deadline = Date.now() + site.timeout;
    while (!submission && Date.now() < deadline) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!submission) return readOnlyFailure('publish_options_mismatch', '平台未生成与确认设置相符的发布请求');
    await submission;
    armed = false;
    if (checkpointFailure) throw checkpointFailure;
    await checkpoint({ stage: 'verifying', message: '正在重新读取平台发布状态' });
    return outcome(await openSnapshot(page));
  } catch (error) {
    filling = false;
    armed = false;
    await submission;
    if (error instanceof PublishCheckpointFailure || checkpointFailure instanceof PublishCheckpointFailure) throw new PublishCheckpointFailure('任务检查点未确认');
    if (external || readonly) return outcome();
    if (signal.aborted) return { status: 'cancelled', remote_id: id, error_code: 'cancelled', error_message: '浏览器操作已停止' };
    return readOnlyFailure('publish_unavailable', '无法安全完成平台发布设置');
  } finally {
    signal.removeEventListener('abort', closePage);
    await page?.close().catch(() => {});
    await context.unroute('**/*', gate).catch(() => {});
  }
}
