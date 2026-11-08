import type { BrowserContext, Page, Response } from 'playwright';
import type { Hooks, Job, JobResult } from './types.js';
import { identityPayload, NotesCollector } from './xiaohongshu-model.js';
import { xiaohongshuRequestAllowed } from './xiaohongshu-network.js';

const origin = 'https://creator.xiaohongshu.com';
const listPath = '/api/galaxy/v2/creator/note/user/posted';
export class XiaohongshuAdapter {
  constructor(private context: BrowserContext, private expected: { accountId: string; username: string; userId: string }) {}
  private async payload(response: Response): Promise<unknown> {
    if ([401, 403].includes(response.status())) throw Error('needs_login');
    if (response.status() !== 200) throw Error('network_error');
    const body = await response.body();
    if (body.length > 6 * 1024 * 1024) throw Error('adapter_mismatch');
    return JSON.parse(body.toString());
  }
  private listResponse(page: Page, pageNumber: number): Promise<Response> {
    return page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === origin && url.pathname === listPath && url.searchParams.get('tab') === '0' && url.searchParams.get('page') === String(pageNumber) && response.request().method() === 'GET';
    }, { timeout: 25000 });
  }
  async run(job: Job, hooks: Hooks, signal: AbortSignal): Promise<JobResult> {
    if (!['check_account', 'sync_notes'].includes(job.kind) || job.platform !== 'xiaohongshu' || job.account_id !== this.expected.accountId || job.account_username !== this.expected.username || job.account_native_id !== this.expected.userId || job.run_mode !== 'execute' || job.external_started) return { status: 'failed', error_code: 'account_mismatch' };
    try {
      signal.throwIfAborted();
      await hooks.progress({ stage: 'checking_login' });
      await this.context.route('**/*', route => xiaohongshuRequestAllowed(route.request().url(), route.request().method(), route.request().resourceType()) ? route.fallback() : route.abort('blockedbyclient'));
      await this.context.routeWebSocket('**/*', socket => socket.close());
      const page = this.context.pages()[0] || await this.context.newPage();
      const accountResponse = page.waitForResponse(response => response.url().split('?')[0] === origin + '/api/galaxy/user/info', { timeout: 25000 });
      const initialList = job.kind === 'sync_notes' ? this.listResponse(page, 0) : undefined;
      // 所有等待在导航前注册，失败也立即接住拒绝，避免遗留未处理的 Promise。
      void accountResponse.catch(() => {}); void initialList?.catch(() => {});
      await page.goto(origin + '/new/note-manager', { waitUntil: 'domcontentloaded', timeout: 30000 });
      const identity = identityPayload(await this.payload(await accountResponse));
      if (identity.username !== this.expected.username || identity.user_id !== this.expected.userId) throw Error('account_mismatch');
      if (job.kind === 'check_account') { signal.throwIfAborted(); return { status: 'succeeded', account_identity: identity }; }
      const collector = new NotesCollector();
      let next = collector.add(0, await this.payload(await initialList!));
      while (!collector.done) {
        signal.throwIfAborted();
        // 只驱动平台原生分页，不构造签名或重放带凭据的接口请求。
        const pending = this.listResponse(page, next); void pending.catch(() => {});
        const button = page.getByRole('button', { name: /下一页|next/i });
        if (await button.count() !== 1 || !await button.isEnabled()) throw Error('adapter_mismatch');
        await button.click();
        const current = next; next = collector.add(current, await this.payload(await pending));
      }
      signal.throwIfAborted();
      await hooks.progress({ stage: 'verifying' });
      return { status: 'succeeded', account_identity: identity, notes: { ...identity, items: collector.items } };
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled', error_code: 'cancelled' };
      const code = error instanceof Error ? error.message : '';
      if (code === 'needs_login') return { status: 'waiting_user', error_code: code };
      return { status: 'failed', error_code: ['account_mismatch', 'adapter_mismatch', 'network_error'].includes(code) ? code : 'adapter_mismatch', retryable: code === 'network_error' };
    }
  }
}
