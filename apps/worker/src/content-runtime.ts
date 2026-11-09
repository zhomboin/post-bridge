import { contentPlatforms, type ContentPlatform } from './content-contract.js';
import type { Job, JobResult, Session } from './types.js';

export interface ExecutionAccount {
  accountId?: string;
  platform?: string;
  username: string;
  userId?: string;
}

export interface PlatformRegistration<T extends ExecutionAccount = ExecutionAccount> {
  definition: ContentPlatform;
  open(config: T): Promise<Session>;
}

// 执行入口只依赖会话协议；官方 API 实现无需创建浏览器。
export function platformRegistry<T extends ExecutionAccount>(
  registrations: readonly PlatformRegistration<T>[],
) {
  const entries = new Map<string, PlatformRegistration<T>>();
  for (const registration of registrations) {
    if (entries.has(registration.definition.id) || typeof registration.open !== 'function')
      throw Error('平台注册重复或缺少执行器');
    entries.set(registration.definition.id, registration);
  }
  return {
    async open(config: T): Promise<Session> {
      if (!config.accountId || !config.platform) throw Error('缺少执行账号');
      const entry = entries.get(config.platform || '');
      if (!entry) throw Error('平台尚未注册执行器');
      const session = await entry.open(config);
      return {
        platform: entry.definition,
        run: (job, hooks, signal) => {
          const definition = entry.definition;
          if (
            job.platform !== definition.id ||
            job.account_id !== config.accountId ||
            job.account_username !== config.username ||
            (job.account_native_id || '') !== (config.userId || '')
          )
            return Promise.resolve({ status: 'failed', error_code: 'account_mismatch' });
          const operation =
            job.kind === definition.sync_job
              ? 'list'
              : job.kind === definition.read_job
                ? 'body'
                : job.kind;
          if (!definition.capabilities[operation]?.enabled)
            return Promise.resolve({ status: 'failed', error_code: 'adapter_mismatch' });
          return session.run(job, hooks, signal);
        },
        close: () => session.close(),
      };
    },
  };
}

const payloadKeys = [
  'articles',
  'article',
  'notes',
  'note',
  'account_identity',
  'contents',
  'content',
  'content_identity',
] as const;
export function sanitizeContentResult(job: Job, result: JobResult, supplied?: ContentPlatform) {
  const definition =
    supplied ||
    contentPlatforms.find((entry) =>
      job.platform
        ? entry.id === job.platform
        : [entry.sync_job, entry.read_job].includes(job.kind),
    );
  const allowed = new Set<string>();
  if (result.status === 'succeeded' && definition) {
    if (job.kind === definition.sync_job) allowed.add(definition.sync_result);
    if (job.kind === definition.read_job) allowed.add(definition.read_result);
    if (
      job.kind === 'check_account' ||
      job.kind === definition.sync_job ||
      job.kind === definition.read_job
    )
      allowed.add(definition.identity_result);
  }
  for (const key of payloadKeys) if (!allowed.has(key)) delete result[key];
}
