import type { BrowserContext, Page, Request, Response } from 'playwright';
import type { Hooks, Job, JobResult } from './types.js';
import { nativeReadRequest } from './native-read.js';
import { identityPayload, NotesCollector } from './xiaohongshu-model.js';
import { xiaohongshuRequestAllowed } from './xiaohongshu-network.js';
import { profilePayload, statsPayload } from './xiaohongshu-insights.js';
import { readNativeNote } from './xiaohongshu-detail.js';

const origin = 'https://creator.xiaohongshu.com';
const listPath = '/api/galaxy/v2/creator/note/user/posted';
export class XiaohongshuAdapter {
  constructor(
    private context: BrowserContext,
    private expected: { accountId: string; username: string; userId: string },
  ) {}
  private async payload(response: Response): Promise<unknown> {
    if ([401, 403].includes(response.status())) throw Error('needs_login');
    if (response.status() !== 200) throw Error('network_error');
    const body = await response.body();
    if (body.length > 6 * 1024 * 1024) throw Error('adapter_mismatch');
    return JSON.parse(body.toString());
  }
  private matchesListRequest(request: Request, pageNumber: number): boolean {
    const url = new URL(request.url());
    return (
      url.origin === origin &&
      url.pathname === listPath &&
      url.searchParams.get('tab') === '0' &&
      url.searchParams.get('page') === String(pageNumber) &&
      request.method() === 'GET'
    );
  }
  private listResponse(page: Page, pageNumber: number): Promise<Response> {
    return page.waitForResponse(
      (response) => this.matchesListRequest(response.request(), pageNumber),
      { timeout: 25000 },
    );
  }
  async run(job: Job, hooks: Hooks, signal: AbortSignal): Promise<JobResult> {
    if (
      !['check_account', 'sync_notes', 'read_note'].includes(job.kind) ||
      job.platform !== 'xiaohongshu' ||
      job.account_id !== this.expected.accountId ||
      job.account_username !== this.expected.username ||
      job.account_native_id !== this.expected.userId ||
      job.run_mode !== 'execute' ||
      job.external_started
    )
      return { status: 'failed', error_code: 'account_mismatch' };
    try {
      signal.throwIfAborted();
      await hooks.progress({ stage: 'checking_login' });
      await this.context.route('**/*', (route) =>
        xiaohongshuRequestAllowed(
          route.request().url(),
          route.request().method(),
          route.request().resourceType(),
          job.kind === 'read_note' ? job.article_id : undefined,
        )
          ? route.fallback()
          : route.abort('blockedbyclient'),
      );
      await this.context.routeWebSocket('**/*', (socket) => socket.close());
      const page = this.context.pages()[0] || (await this.context.newPage());
      let insights;
      if (job.kind === 'sync_notes') {
        const wait = (path: string) =>
          page.waitForResponse(
            (r) => r.url().split('?')[0] === origin + path && r.request().method() === 'GET',
            { timeout: 25000 },
          );
        const identityRead = wait('/api/galaxy/user/info');
        const profileRead = wait('/api/galaxy/creator/home/personal_info');
        const statsRead = wait('/api/galaxy/v2/creator/datacenter/account/base');
        for (const promise of [identityRead, profileRead, statsRead]) void promise.catch(() => {});
        await page.goto(origin + '/new/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const identity = identityPayload(await this.payload(await identityRead));
        if (
          identity.username !== this.expected.username ||
          identity.user_id !== this.expected.userId
        )
          throw Error('account_mismatch');
        insights = {
          profile: profilePayload(await this.payload(await profileRead), this.expected.username),
          ...statsPayload(await this.payload(await statsRead)),
        };
      }
      const accountResponse = page.waitForResponse(
        (response) => response.url().split('?')[0] === origin + '/api/galaxy/user/info',
        { timeout: 25000 },
      );
      const initialList = job.kind !== 'check_account' ? this.listResponse(page, 0) : undefined;
      // 所有等待在导航前注册，失败也立即接住拒绝，避免遗留未处理的 Promise。
      void accountResponse.catch(() => {});
      void initialList?.catch(() => {});
      await page.goto(origin + '/new/note-manager', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      const identity = identityPayload(await this.payload(await accountResponse));
      if (identity.username !== this.expected.username || identity.user_id !== this.expected.userId)
        throw Error('account_mismatch');
      if (job.kind === 'check_account') {
        signal.throwIfAborted();
        return { status: 'succeeded', account_identity: identity };
      }
      const collector = new NotesCollector();
      let pagePayload = await this.payload(await initialList!);
      let next = collector.add(0, pagePayload);
      let pageItems = collector.items.slice();
      for (;;) {
        if (job.kind === 'read_note') {
          const index = pageItems.findIndex((n) => n.id === job.article_id);
          if (index >= 0) {
            const target = pageItems[index];
            if (target.status !== 'published') throw Error('note_unavailable');
            const note = await readNativeNote(
              this.context,
              page,
              index,
              pageItems.length,
              target.id,
              target.title,
              this.expected.userId,
              signal,
            );
            await hooks.progress({ stage: 'verifying' });
            return { status: 'succeeded', account_identity: identity, note };
          }
        }
        if (collector.done) break;
        signal.throwIfAborted();
        // 只驱动平台原生分页，不构造签名或重放带凭据的接口请求。
        const button = page.getByRole('button', { name: /下一页|next/i });
        if ((await button.count()) !== 1 || !(await button.isEnabled()))
          throw Error('adapter_mismatch');
        const current = next;
        const request = await nativeReadRequest(
          page,
          button,
          (candidate) => this.matchesListRequest(candidate, current),
          25000,
        );
        const response = await request.response();
        if (!response) throw Error('network_error');
        const previous = collector.items.length;
        pagePayload = await this.payload(response);
        next = collector.add(current, pagePayload);
        pageItems = collector.items.slice(previous);
      }
      if (job.kind === 'read_note') throw Error('note_unavailable');
      signal.throwIfAborted();
      await hooks.progress({ stage: 'verifying' });
      return {
        status: 'succeeded',
        account_identity: identity,
        notes: { ...identity, ...insights, items: collector.items },
      };
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled', error_code: 'cancelled' };
      const code = error instanceof Error ? error.message : '';
      if (code === 'needs_login') return { status: 'waiting_user', error_code: code };
      return {
        status: 'failed',
        error_code: [
          'account_mismatch',
          'adapter_mismatch',
          'network_error',
          'note_unavailable',
        ].includes(code)
          ? code
          : 'adapter_mismatch',
        retryable: code === 'network_error',
      };
    }
  }
}
