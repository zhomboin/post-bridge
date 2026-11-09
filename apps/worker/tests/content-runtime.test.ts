import { describe, expect, it, vi } from 'vitest';
import { collectContents, type ContentSourcePage } from '../src/content-sync.js';
import { platformRegistry } from '../src/content-runtime.js';
import { executeClaim } from '../src/worker.js';
import type { ContentItem, ContentPlatform } from '../src/content-contract.js';
import type { Claim, JobAPI, JobResult } from '../src/types.js';

const identity = { username: 'author-test', user_id: 'native-test' };
const definition: ContentPlatform = {
  id: 'synthetic',
  label: '合成平台',
  id_pattern: '^post:.+$',
  username_pattern: '^author-.+$',
  user_id_pattern: '^native-.+$',
  sync_job: 'sync_contents',
  read_job: 'read_content',
  sync_result: 'contents',
  read_result: 'content',
  identity_result: 'content_identity',
  body_ttl_seconds: 0,
  invalidate_body_on_sync: false,
  read_statuses: [],
  capabilities: { list: { enabled: true, formats: [], kinds: ['document'] } },
};
function item(id: string): ContentItem {
  return {
    id,
    title: '合成文档',
    status: 'unknown',
    platform_status: 'NEW_STATE',
    posted_at: '',
    kind: 'document',
    cover_urls: [],
    metrics: { views: { value: null, unit: 'count', begin_at: '', end_at: '' } },
    extensions: {},
  };
}
const page = (
  items: ContentItem[],
  next_cursor: string | null,
  complete: boolean,
): ContentSourcePage => ({ identity, items, next_cursor, complete, total: 2 });
const config = {
  accountId: 'synthetic-account',
  platform: definition.id,
  username: identity.username,
  userId: identity.user_id,
};
const claim: Claim = {
  job: {
    id: 'synthetic-job',
    kind: 'sync_contents',
    platform: definition.id,
    account_id: config.accountId,
    account_username: identity.username,
    account_native_id: identity.user_id,
    title: '',
    markdown: '',
    run_mode: 'execute',
    external_started: false,
    remote_id: null,
    reconcile_candidate_id: null,
  },
  lease_token: 'synthetic-lease',
  lease_seconds: 60,
  lease_expires_at: '2026-11-09T00:01:00Z',
};

describe('平台无关内容采集', () => {
  it('接受不透明标识与游标，保留未知状态和空指标', async () => {
    const read = vi.fn(async (cursor: string | null) =>
      cursor === null
        ? page([item('post:alpha/one')], 'opaque/next:two', false)
        : page([item('post:beta')], null, true),
    );
    const snapshot = await collectContents(identity, read, new AbortController().signal);
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'opaque/next:two']);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items[0]).toMatchObject({
      id: 'post:alpha/one',
      status: 'unknown',
      metrics: { views: { value: null } },
    });
  });
  it.each([
    'duplicate',
    'cursor-loop',
    'identity',
    'incomplete',
    'total',
    'empty-page',
    'overflow',
  ])('拒绝 %s，无法形成完整快照', async (failure) => {
    let reads = 0;
    const read = async (): Promise<ContentSourcePage> => {
      reads++;
      if (reads === 1) return page([item('post:one')], 'cursor', false);
      const next = page([item('post:two')], null, true);
      if (failure === 'duplicate') next.items[0].id = 'post:one';
      if (failure === 'cursor-loop') {
        next.complete = false;
        next.next_cursor = 'cursor';
      }
      if (failure === 'identity') next.identity = { ...identity, user_id: 'another' };
      if (failure === 'incomplete') next.complete = false;
      if (failure === 'total') next.total = 3;
      if (failure === 'empty-page') {
        next.items = [];
        next.complete = false;
        next.next_cursor = 'next';
      }
      if (failure === 'overflow')
        next.items = Array.from({ length: 2001 }, (_, i) => item('post:' + i));
      return next;
    };
    await expect(collectContents(identity, read, new AbortController().signal)).rejects.toThrow();
  });
  it('取消后停止读取下一页', async () => {
    const stop = new AbortController();
    const read = vi.fn(async () => {
      stop.abort();
      return page([item('post:one')], 'next', false);
    });
    await expect(collectContents(identity, read, stop.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('无浏览器平台注册与任务执行', () => {
  function registry() {
    const close = vi.fn(async () => {});
    const run = vi.fn(async (_job, hooks, signal) => {
      await hooks.progress({ stage: 'checking_login' });
      const contents = await collectContents(
        identity,
        async (cursor) =>
          cursor === null
            ? page([item('post:one')], 'next', false)
            : page([item('post:two')], null, true),
        signal,
      );
      await hooks.progress({ stage: 'verifying' });
      return {
        status: 'succeeded',
        contents,
        content_identity: identity,
        article: { id: 'unexpected' },
      } as JobResult;
    });
    const platforms = platformRegistry([{ definition, open: async () => ({ run, close }) }]);
    return { platforms, close, run };
  }
  it('通过现有执行框架运行新平台，过滤串入载荷并关闭会话', async () => {
    const { platforms, close } = registry();
    const complete = vi.fn<JobAPI['complete']>(async () => {});
    await executeClaim(
      { heartbeat: async () => ({ cancel_requested: false }), progress: async () => {}, complete },
      claim,
      () => platforms.open(config),
      new AbortController().signal,
    );
    expect(complete).toHaveBeenCalledWith(
      'synthetic-job',
      'synthetic-lease',
      expect.objectContaining({
        status: 'succeeded',
        contents: expect.objectContaining({ complete: true }),
        content_identity: identity,
      }),
    );
    expect(complete.mock.calls[0]?.[2]?.article).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('拒绝跨账号、未实现能力和未知平台', async () => {
    const { platforms, run } = registry();
    const session = await platforms.open(config);
    const hooks = { progress: async () => {} };
    const signal = new AbortController().signal;
    expect(await session.run({ ...claim.job, account_id: 'other' }, hooks, signal)).toMatchObject({
      error_code: 'account_mismatch',
    });
    expect(await session.run({ ...claim.job, kind: 'read_content' }, hooks, signal)).toMatchObject({
      error_code: 'adapter_mismatch',
    });
    expect(run).not.toHaveBeenCalled();
    await expect(platforms.open({ ...config, platform: 'unregistered' })).rejects.toThrow();
    await session.close();
  });
  it.each(['cancel', 'lease'])('任务 %s 时不提交内容载荷并清理会话', async (reason) => {
    const { platforms, close } = registry();
    const complete = vi.fn<JobAPI['complete']>(async () => {});
    await executeClaim(
      {
        heartbeat: async () => {
          if (reason === 'lease') throw Error('expired');
          return { cancel_requested: true };
        },
        progress: async () => {},
        complete,
      },
      claim,
      () => platforms.open(config),
      new AbortController().signal,
    );
    expect(close).toHaveBeenCalledTimes(1);
    if (reason === 'lease') expect(complete).not.toHaveBeenCalled();
    else
      expect(complete.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ status: 'cancelled' }));
  });
});
