import type { BrowserContext, Page, Request, Response } from 'playwright';
import { safeRequestURL } from './config.js';
import { approvedImages, copiedImageOrigin, copiedImageURL, forwardWithoutRedirect, frozenCopies, imagePreviewPath, replaceDestinations, richMarkdown, waitForImagePreviews } from './csdn-images.js';
import { forwardPreviewImage } from './csdn-preview.js';
import { verifyImageSourceDNS } from './csdn-image-dns.js';
import { runCSDNPublish } from './csdn-publish.js';
import { nativeReadRequest } from './native-read.js';
import type { Hooks, Job, JobResult, Observation, Progress } from './types.js';

interface Identity { username: string; displayName?: string; timeoutMs?: number }
interface Snapshot { id?: string; title: string; markdown: string; status: unknown }
interface FixtureSite { origin: string; accountPath: string; editorPath: string; managePath?: string }
class CheckpointFailure extends Error {}
class AdapterFailure extends Error { constructor(readonly code: string) { super(code); } }
const numericID = (value: unknown): string | undefined => typeof value === 'string' || typeof value === 'number' ? /^\d{1,30}$/.test(String(value)) ? String(value) : undefined : undefined;
const withLF = (value: string): string => value.replace(/\r\n?/g, '\n');
const normalizedMarkdown = (value: string): string => withLF(value).trim();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class CSDNAdapter {
  private readonly site: FixtureSite;
  private readonly timeout: number;
  private readonly fixture: boolean;
  constructor(private readonly context: BrowserContext, private readonly identity: Identity, fixtureSite?: FixtureSite) {
    if (fixtureSite && (process.env.NODE_ENV !== 'test' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureSite.origin))) throw new Error('模拟站点仅限测试回环地址');
    this.fixture = !!fixtureSite;
    this.site = fixtureSite ?? { origin: 'https://editor.csdn.net', accountPath: 'https://mp.csdn.net/', editorPath: '/md/?not_checkout=1' };
    this.timeout = identity.timeoutMs ?? 20000;
  }
  private allowed(url: string): boolean { return safeRequestURL(url) || (this.fixture && new URL(url).origin === this.site.origin); }
  private readOnlyRequest(url: string, method: string): boolean {
    if (method === 'GET' || method === 'HEAD') return true;
    if (method !== 'POST') return false;
    const target = new URL(url);
    const confirmedOrigin = target.origin === 'https://bizapi.csdn.net' || target.origin === 'https://editor.csdn.net' || (this.fixture && target.origin === this.site.origin);
    return confirmedOrigin && target.pathname === '/blog-console-api/v3/editor/getArticle';
  }
  private editorURL(id?: string): string {
    const url = new URL(this.site.editorPath, this.site.origin);
    if (id) url.searchParams.set('articleId', id);
    return url.href;
  }
  private async account(page: Page, signal: AbortSignal): Promise<'connected' | 'needs_login' | 'account_mismatch'> {
    await page.goto(new URL(this.site.accountPath, this.site.origin).href, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + this.timeout;
    let login = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const matches = await page.locator('a[href]').evaluateAll((nodes, username) => nodes.some(node => {
        try { const url = new URL((node as HTMLAnchorElement).href); return url.protocol === 'https:' && url.hostname === 'blog.csdn.net' && url.pathname.replace(/\/+$/, '') === `/${username}`; } catch { return false; }
      }), this.identity.username);
      login = await page.getByText(/^登录$/).filter({ visible: true }).count() > 0;
      if (matches && !login) return 'connected';
      await sleep(100);
    }
    return login ? 'needs_login' : 'account_mismatch';
  }
  async run(job: Job, hooks: Hooks, signal: AbortSignal): Promise<JobResult> {
    if (job.kind === 'publish') return runCSDNPublish(this.context, job, hooks, signal, {
      username: this.identity.username, timeout: this.timeout, fixtureOrigin: this.fixture ? this.site.origin : undefined,
      account: page => this.account(page, signal), editorURL: id => this.editorURL(id), allowed: url => this.allowed(url),
    });
    if (job.kind === 'save_draft' && job.account_username && job.account_username !== this.identity.username) {
      return { status: job.external_started ? 'reconciling' : 'failed', error_code: 'account_mismatch', error_message: '平台账号与任务不一致', retryable: false };
    }
    const images = job.kind === 'check_account' ? [] : approvedImages(job.title, job.markdown, job.image_urls ?? []);
    if (!images) return { status: 'failed', error_code: 'adapter_mismatch', error_message: '任务内容不符合当前草稿范围', retryable: false };
    const rich = images.length > 0;
    const sources = new Set(images.map(image => image.url));
    const copyOrigin = this.fixture ? this.site.origin : copiedImageOrigin;
    const transfers = new Map<string, Promise<void>>();
    const copies = new Map<string, string>();
    const copyPaths = new Set<string>();
    let transferring = false;
    let saveArmed = false;
    let saveOperation: Promise<void> | undefined;
    let platformMarkdown = job.run_mode === 'reconcile' ? job.platform_markdown : undefined;
    let external = job.external_started;
    let writesAllowed = false;
    let savePayloadMismatch = false;
    let remoteID = numericID(job.remote_id);
    let pendingID: string | undefined;
    let queue = Promise.resolve();
    let checkpointFailure: unknown;
    let page: Page | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const snapshotState: { value?: Snapshot } = {};
    const readSnapshot = (): Snapshot | undefined => snapshotState.value;
    let lastStage = 'checking_login';
    let progressTail = Promise.resolve();
    const stageRanks: Record<string, number> = { checking_login: 1, opening_editor: 2, draft_acquired: 3, filling: 4, saving: 5, verifying: 6 };
    const progress = (value: Progress): Promise<void> => {
      const operation = progressTail.then(async () => {
        signal.throwIfAborted();
        const actual = value.remote_id && stageRanks[value.stage] < stageRanks[lastStage] ? { ...value, stage: lastStage } : value;
        try { await hooks.progress(actual); lastStage = actual.stage; }
        catch { throw new CheckpointFailure('任务检查点未确认'); }
      });
      progressTail = operation.catch(() => {});
      return operation;
    };
    const observation = (phase: Observation['phase'], snapshot: Snapshot): Observation | undefined => {
      // 超长实值保持未采集，不能截断成看似完整的内容，也不能中断草稿安全流程。
      if ([...snapshot.title].length > 100 || [...snapshot.markdown].length > 200000 || snapshot.title.includes('\0') || snapshot.markdown.includes('\0')) return undefined;
      const status = ['string', 'number', 'boolean'].includes(typeof snapshot.status) && String(snapshot.status).trim() ? String(snapshot.status) : 'unknown';
      if ([...status].length > 100 || status.includes('\0')) return undefined;
      return { phase, title: snapshot.title, markdown: snapshot.markdown, status, ...(snapshot.id ? { remote_id: snapshot.id } : {}) };
    };
    const reportAfter = async (snapshot: Snapshot) => {
      const value = observation('after', snapshot);
      if (value) await progress({ stage: 'verifying', observation: value });
    };
    const persistID = (value: unknown) => {
      const id = numericID(value);
      if (!id || job.run_mode === 'reconcile' || remoteID === id || pendingID === id) return;
      if (remoteID && remoteID !== id) { checkpointFailure = new AdapterFailure('adapter_mismatch'); void page?.close().catch(() => {}); return; }
      pendingID = id;
      queue = queue.then(async () => { await progress({ stage: 'draft_acquired', remote_id: id, message: '已取得平台草稿标识' }); remoteID = id; }).catch(error => { checkpointFailure = error; void page?.close().catch(() => {}); });
    };
    const captureURL = () => {
      if (!page || page.isClosed()) return;
      try { const url = new URL(page.url()); persistID(url.searchParams.get('articleId') ?? url.searchParams.get('articleID') ?? url.searchParams.get('article_id')); } catch { /* 页面尚未导航。 */ }
    };
    const observe = async (response: Response) => {
      try {
        const url = new URL(response.url());
        const editorResponse = /\/(?:mdeditor|editor)\/(?:getArticle|saveArticle|autoSave)/i.test(url.pathname) || (this.fixture && url.pathname === '/acquired');
        if (!editorResponse || !this.allowed(url.href) || response.status() !== 200) return;
        const length = response.headers()['content-length'];
        if (length && Number(length) > 1500000) return;
        const body = await response.json() as { data?: Record<string, unknown>; articleId?: unknown };
        const data = body.data;
        const id = numericID(data?.articleId ?? data?.article_id ?? data?.articleID ?? data?.id ?? body.articleId) ?? numericID(url.searchParams.get('articleId'));
        if (job.run_mode !== 'reconcile') persistID(id);
        if (/\/getArticle$/i.test(url.pathname) && typeof data?.title === 'string' && typeof data?.markdowncontent === 'string') snapshotState.value = { id, title: data.title, markdown: data.markdowncontent, status: data.status };
      } catch { /* 无法读取的响应不证明保存成功。 */ }
    };
    const abort = () => { void page?.close().catch(() => {}); };
    try {
      signal.throwIfAborted();
      await this.context.route('**/*', route => {
        const request = route.request();
        const target = new URL(request.url());
        const read = this.readOnlyRequest(request.url(), request.method());
        const imageTransfer = (
          this.fixture ? target.origin === this.site.origin && target.pathname === '/v1/image/external/storage' :
            ['https://bizapi.csdn.net', 'https://oms.csdn.net'].includes(target.origin) && target.pathname.endsWith('/v1/image/external/storage')
        );
        const block = () => route.abort('blockedbyclient');
        if (imageTransfer) {
          if (transferring && request.method() === 'OPTIONS') return forwardWithoutRedirect(route, this.timeout);
          if (request.method() !== 'POST' || !transferring || signal.aborted || request.frame() !== page?.mainFrame()) return block();
          let payload: { imgUrl?: unknown; type?: unknown } | undefined;
          try { payload = request.postDataJSON() as typeof payload; } catch { return block(); }
          const source = payload?.imgUrl;
          if (payload?.type !== 'blog' || typeof source !== 'string' || !sources.has(source) || transfers.has(source)) return block();
          const operation = forwardWithoutRedirect(route, this.timeout, text => {
            const body = JSON.parse(text) as { code?: unknown; data?: { url?: unknown } };
            const copy = copiedImageURL(body.data?.url, copyOrigin);
            if (body.code !== 200 || !copy || sources.has(copy.href)) throw new AdapterFailure('adapter_mismatch');
            copyPaths.add(imagePreviewPath(copy.href));
            copies.set(source, copy.href);
          });
          transfers.set(source, operation);
          return operation;
        }
        if (rich && sources.has(request.url())) return block();
        if (rich && request.resourceType() === 'image') {
          const copy = copiedImageURL(request.url(), copyOrigin, true);
          if (copy && copyPaths.has(imagePreviewPath(copy.href)) && request.method() === 'GET') return forwardPreviewImage(route, copy, this.timeout, signal);
        }
        if (rich && !this.fixture && target.origin === copyOrigin) return block();
        const draftSave = this.fixture ? target.origin === this.site.origin && target.pathname === '/save' :
          ['https://bizapi.csdn.net', 'https://editor.csdn.net'].includes(target.origin) && /^\/blog-console-api\/v3\/(?:mdeditor|editor)\/(?:saveArticle|autoSave)$/.test(target.pathname);
        if (rich && !read) {
          if (saveArmed && draftSave && request.method() === 'OPTIONS') return forwardWithoutRedirect(route, this.timeout);
          if (!saveArmed || signal.aborted || saveOperation || request.frame() !== page?.mainFrame() ||
              request.method() !== 'POST' || !draftSave || target.pathname.endsWith('/autoSave')) return block();
          let payload: { title?: unknown; markdowncontent?: unknown; status?: unknown; id?: unknown; articleId?: unknown; article_id?: unknown } | undefined;
          try { payload = request.postDataJSON() as typeof payload; } catch { return block(); }
          if (payload?.title !== job.title || typeof payload.markdowncontent !== 'string' || platformMarkdown === undefined ||
              richMarkdown(payload.markdowncontent) !== richMarkdown(platformMarkdown) || (payload.status !== 2 && payload.status !== '2')) return block();
          const ids = [payload.id, payload.articleId, payload.article_id, target.searchParams.get('articleId')].map(numericID);
          if (remoteID && ids.some(id => id && id !== '0' && id !== remoteID)) return block();
          saveOperation = forwardWithoutRedirect(route, this.timeout);
          return saveOperation;
        }
        if (writesAllowed && request.method() === 'POST' && draftSave) {
          const manual = !target.pathname.endsWith('/autoSave');
          let payload: { title?: unknown; status?: unknown } | undefined;
          try { payload = request.postDataJSON() as typeof payload; } catch { /* 无法确认有效载荷。 */ }
          const saving = lastStage === 'saving';
          if ((manual && payload?.status !== 2 && payload?.status !== '2') || (saving && payload?.title !== job.title)) {
            if (saving) savePayloadMismatch = true;
            return block();
          }
        }
        const allowed = this.allowed(request.url()) && (writesAllowed || read);
        return allowed ? route.continue() : route.abort('blockedbyclient');
      });
      await this.context.routeWebSocket('**/*', socket => socket.close());
      // 恢复的旧标签页不能继续发起自动保存。
      await Promise.all(this.context.pages().map(existing => existing.close()));
      page = await this.context.newPage();
      page.setDefaultTimeout(this.timeout); page.setDefaultNavigationTimeout(this.timeout);
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      page.on('response', response => { void observe(response); });
      signal.addEventListener('abort', abort, { once: true });
      await progress({ stage: 'checking_login', message: '正在核验平台账号' });
      const account = await this.account(page, signal);
      if (account !== 'connected') return { status: account === 'needs_login' ? 'waiting_user' : 'failed', error_code: account, error_message: account === 'needs_login' ? '平台账号需要人工登录' : '平台账号与配置不一致', retryable: false };
      if (job.kind === 'check_account') return { status: 'succeeded' };
      if (job.run_mode === 'reconcile') {
        const frozen = rich && platformMarkdown ? frozenCopies(job.title, job.markdown, platformMarkdown, images, copyOrigin) : undefined;
        if (rich && !frozen) return { status: 'reconciling', error_code: 'reconcile_unavailable', error_message: '图文草稿缺少已确认的平台正文' };
        const imageURLs = frozen ? images.map(image => frozen.get(image.url)!) : [];
        for (const imageURL of imageURLs) copyPaths.add(imagePreviewPath(imageURL));
        const id = remoteID ?? numericID(job.reconcile_candidate_id);
        await progress({ stage: 'verifying', message: id ? '正在只读核对已有草稿' : '正在自动查询并核对平台草稿' });
        if (id) {
          snapshotState.value = undefined;
          await page.goto(this.editorURL(id), { waitUntil: 'domcontentloaded' });
          const snapshot = await this.readSnapshot(readSnapshot, id, signal);
          if (!snapshot) return { status: 'reconciling', error_code: 'reconcile_unavailable', error_message: '平台草稿暂时无法读取' };
          await reportAfter(snapshot);
          if (!this.matches(snapshot, job.title, job.markdown, rich, platformMarkdown)) return { status: 'reconciling', error_code: 'draft_mismatch', error_message: '草稿内容或草稿状态未通过核对' };
          if (rich) await waitForImagePreviews(page, imageURLs, this.timeout);
          return { status: 'succeeded', remote_id: id };
        }
        const candidates = await this.draftCandidates(page, job.title, signal);
        if (!candidates.length) return { status: 'reconciling', error_code: 'draft_absent', error_message: '完整查询未找到同标题草稿，后台将再次确认' };
        const matches: Snapshot[] = [];
        let soleCandidate: Snapshot | undefined;
        let conflict = false;
        for (const candidate of candidates) {
          signal.throwIfAborted();
          snapshotState.value = undefined;
          await page.goto(this.editorURL(candidate), { waitUntil: 'domcontentloaded' });
          const snapshot = await this.readSnapshot(readSnapshot, candidate, signal);
          if (!snapshot) return { status: 'reconciling', error_code: 'reconcile_unavailable', error_message: '候选草稿暂时无法读取' };
          if (candidates.length === 1) soleCandidate = snapshot;
          if (this.matches(snapshot, job.title, job.markdown, rich, platformMarkdown)) {
            if (rich) await waitForImagePreviews(page, imageURLs, this.timeout);
            matches.push(snapshot);
          } else conflict = true;
        }
        if (soleCandidate) await reportAfter(soleCandidate);
        if (matches.length !== 1 || conflict) return { status: 'reconciling', error_code: 'draft_conflict', error_message: '存在重复或不完整的同标题草稿，不能自动重写' };
        if (!soleCandidate) await reportAfter(matches[0]);
        return { status: 'succeeded', remote_id: matches[0].id };
      }
      if (external || remoteID) return { status: 'reconciling', error_code: 'draft_mismatch', error_message: '任务已有外站操作，需要只读核对' };
      if (rich && !this.fixture) {
        try { await verifyImageSourceDNS([...sources], signal); }
        catch { signal.throwIfAborted(); throw new AdapterFailure('image_source_unavailable'); }
      }
      await progress({ stage: 'opening_editor', external_started: true, message: '即将打开平台草稿编辑器' });
      external = true;
      writesAllowed = true;
      signal.throwIfAborted();
      await page.goto(this.editorURL(), { waitUntil: 'domcontentloaded' });
      timer = setInterval(captureURL, 50);
      captureURL();
      const titleInput = page.locator('input.article-bar__title');
      const titleDisplay = page.locator('div.article-bar__title-display');
      const body = page.locator('pre[contenteditable="true"].editor__inner');
      await body.waitFor({ state: 'visible' });
      const initialTitle = await titleInput.count() === 1 ? (await titleInput.inputValue()).trim() : (await titleDisplay.textContent())?.trim();
      if (initialTitle && initialTitle !== '【无标题】') throw new AdapterFailure('adapter_mismatch');
      if (!await titleInput.isVisible()) await titleDisplay.click();
      await titleInput.waitFor({ state: 'visible' });
      const save = page.locator('button:text-is("保存草稿")').filter({ visible: true });
      await save.waitFor({ state: 'visible', timeout: this.timeout });
      if (await save.count() !== 1 || await body.count() !== 1 || await titleInput.count() !== 1) throw new AdapterFailure('adapter_mismatch');
      await queue; if (checkpointFailure) throw checkpointFailure;
      const before = observation('before', { title: await titleInput.inputValue(), markdown: await body.textContent() ?? '', status: 'editor' });
      await progress({ stage: 'filling', message: '正在填入任务快照', ...(before ? { observation: before } : {}) });
      signal.throwIfAborted();
      await titleInput.fill(job.title);
      await titleInput.press('Enter');
      // 官方标题监听器延迟 100 毫秒同步保存状态，输入框值不代表同步已完成。
      await page.waitForTimeout(150);
      signal.throwIfAborted();
      await this.context.grantPermissions(['clipboard-write'], { origin: new URL(page.url()).origin });
      const paste = async (text: string) => {
        await page!.evaluate(value => navigator.clipboard.writeText(value), text);
        try { await body.focus(); await page!.keyboard.press('Control+A'); await page!.keyboard.press('Control+V'); }
        finally { await page!.evaluate(() => navigator.clipboard.writeText('')).catch(() => {}); }
      };
      if (rich) {
        transferring = true;
        try {
          await paste(job.markdown);
          const deadline = Date.now() + this.timeout;
          while (copies.size !== sources.size && Date.now() < deadline) { signal.throwIfAborted(); await sleep(50); }
          if (copies.size !== sources.size) throw new AdapterFailure('image_transfer_unconfirmed');
          await Promise.all(transfers.values());
        } finally { transferring = false; }
        platformMarkdown = replaceDestinations(job.markdown, images, copies);
        if ([...platformMarkdown].length > 200000) throw new AdapterFailure('adapter_mismatch');
      }
      const expectedMarkdown = platformMarkdown ?? job.markdown;
      await paste(expectedMarkdown);
      const editorText = await body.textContent();
      // 编辑器 DOM 的空白可能随换行节点变化。实际保存请求必须与冻结正文一致。
      const visibleMarkdown = (text: string) => rich ? text.replace(/[\s\u200b]+/g, '') : text.trim();
      if (editorText === null || visibleMarkdown(editorText) !== visibleMarkdown(expectedMarkdown) ||
          await titleInput.inputValue() !== job.title) throw new AdapterFailure('adapter_mismatch');
      const imageURLs = images.map(image => copies.get(image.url)!);
      if (rich) await waitForImagePreviews(page, imageURLs, this.timeout);
      captureURL(); await queue; if (checkpointFailure) throw checkpointFailure;
      await progress({ stage: 'saving', message: '正在保存平台草稿', ...(rich ? { platform_markdown: platformMarkdown } : {}) });
      signal.throwIfAborted();
      saveArmed = true;
      await save.click();
      if (rich) {
        const deadline = Date.now() + this.timeout;
        while (!saveOperation && Date.now() < deadline) { signal.throwIfAborted(); await sleep(50); }
        if (!saveOperation) throw new AdapterFailure('adapter_mismatch');
        await saveOperation;
        saveArmed = false;
      }
      const idDeadline = Date.now() + this.timeout;
      while (!remoteID && Date.now() < idDeadline) { signal.throwIfAborted(); if (savePayloadMismatch) throw new AdapterFailure('adapter_mismatch'); captureURL(); await queue; if (checkpointFailure) throw checkpointFailure; await sleep(50); }
      if (savePayloadMismatch) throw new AdapterFailure('adapter_mismatch');
      if (!remoteID) throw new AdapterFailure('timeout');
      // 保存按钮可能异步提交；重新载入前等待浏览器完成对应保存请求。
      await page.waitForLoadState('networkidle', { timeout: Math.min(this.timeout, 5000) }).catch(() => {});
      signal.throwIfAborted();
      if (savePayloadMismatch) throw new AdapterFailure('adapter_mismatch');
      writesAllowed = false;
      await progress({ stage: 'verifying', message: '正在从平台重新读取草稿' });
      snapshotState.value = undefined;
      await page.reload({ waitUntil: 'domcontentloaded' });
      const matched = await this.waitSnapshot(readSnapshot, snapshot => this.matches(snapshot, job.title, job.markdown, rich, platformMarkdown), signal);
      const actual = readSnapshot();
      if (actual?.id === remoteID) await reportAfter(actual);
      if (!matched || (actual?.id && actual.id !== remoteID)) throw new AdapterFailure('draft_mismatch');
      if (rich) await waitForImagePreviews(page, imageURLs, this.timeout);
      await queue; if (checkpointFailure) throw checkpointFailure;
      return { status: 'succeeded', remote_id: remoteID };
    } catch (error) {
      if (error instanceof CheckpointFailure || checkpointFailure instanceof CheckpointFailure) throw new CheckpointFailure('任务检查点未确认');
      if (signal.aborted) return { status: external ? 'reconciling' : 'cancelled', ...(remoteID ? { remote_id: remoteID } : {}), error_code: 'cancelled', error_message: '浏览器操作已停止' };
      const code = error instanceof AdapterFailure ? error.code : job.run_mode === 'reconcile' ? 'reconcile_unavailable' : 'timeout';
      return { status: external ? 'reconciling' : 'failed', ...(remoteID ? { remote_id: remoteID } : {}), error_code: code, error_message: external ? '平台结果尚未确认，需要只读核对' : '平台页面未通过安全检查', retryable: !external && code === 'timeout' };
    } finally {
      if (timer) clearInterval(timer);
      signal.removeEventListener('abort', abort);
      await queue;
      // 浏览器上下文由执行器关闭；单次适配仅保留本任务页面。
      await page?.close().catch(() => {});
    }
  }
  private matches(snapshot: Snapshot, title: string, markdown: string, rich: boolean, platformMarkdown?: string): boolean {
    const expected = rich ? platformMarkdown : markdown;
    const normalize = rich ? richMarkdown : normalizedMarkdown;
    return expected !== undefined && (snapshot.status === 2 || snapshot.status === '2') &&
      snapshot.title === title && normalize(snapshot.markdown) === normalize(expected);
  }
  private async readSnapshot(snapshot: () => Snapshot | undefined, id: string, signal: AbortSignal): Promise<Snapshot | undefined> {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const value = snapshot();
      if (value?.id === id) return value;
      await sleep(50);
    }
    return undefined;
  }
  private async draftCandidates(page: Page, title: string, signal: AbortSignal): Promise<string[]> {
    const seen = new Set<string>();
    const candidates: string[] = [];
    let total: number | undefined;
    const size = 20;
    await page.goto(new URL(this.site.managePath ?? 'https://mp.csdn.net/mp_blog/manage/article', this.site.origin).href, { waitUntil: 'domcontentloaded' });
    // 限制扫描成本；超过上限保留未知结果，不能按不存在处理。
    for (let number = 1; number <= 100; number++) {
      signal.throwIfAborted();
      const expectedOrigin = this.fixture ? this.site.origin : 'https://bizapi.csdn.net';
      const target = number === 1 ? page.getByText(/^草稿箱/) : page.getByRole('button', { name: '下一页', exact: true });
      const request = await nativeReadRequest(page, target, request => {
        const url = new URL(request.url());
        return url.origin === expectedOrigin && url.pathname === '/blog/phoenix/console/v1/article/list' && url.searchParams.get('status') === 'draft' && (url.searchParams.get('page') ?? '1') === String(number) && request.method() === 'GET';
      }, this.timeout);
      // 由官方页面触发带会话校验的读取，不复制或自行生成私有签名。
      const text = await this.listResponseBody(request);
      if (text.length > 1500000) throw new AdapterFailure('reconcile_unavailable');
      const body: unknown = JSON.parse(text);
      const result = body as { code?: unknown; data?: { list?: unknown; total?: unknown; page?: unknown; size?: unknown } };
      const data = result?.data;
      if (result?.code !== 200 || !data || !Array.isArray(data.list) || !Number.isSafeInteger(data.total) || Number(data.total) < 0 || data.page !== number || data.size !== size || data.list.length > size || (total !== undefined && total !== data.total)) throw new AdapterFailure('reconcile_unavailable');
      total = Number(data.total);
      for (const value of data.list) {
        const item = value as { articleId?: unknown; title?: unknown; username?: unknown; status?: unknown } | null;
        const id = numericID(item?.articleId);
        if (!id || seen.has(id) || typeof item?.title !== 'string' || item.username !== this.identity.username || !(item.status === 2 || item.status === '2')) throw new AdapterFailure('reconcile_unavailable');
        seen.add(id);
        if (item.title === title) candidates.push(id);
      }
      if (seen.size > total || (seen.size < total && data.list.length !== size)) throw new AdapterFailure('reconcile_unavailable');
      if (seen.size === total) return candidates;
    }
    throw new AdapterFailure('reconcile_unavailable');
  }
  private async listResponseBody(request: Request): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await request.response();
          if (!response || response.status() !== 200) throw new AdapterFailure('reconcile_unavailable');
          return response.text();
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AdapterFailure('reconcile_unavailable')), this.timeout); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async waitSnapshot(snapshot: () => Snapshot | undefined, matches: (value: Snapshot) => boolean, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) { signal.throwIfAborted(); const value = snapshot(); if (value && matches(value)) return true; await sleep(50); }
    return false;
  }
}