import { useEffect, useState, type FormEvent } from 'react';
import {
  Empty,
  ResourceError,
  errorText,
  useAction,
  useResource,
  useWorkspace,
  type Account,
} from './runtime';
import { integrationScopes, type IntegrationClient, type IssuedSecret } from './integration-types';
import { IntegrationModal, IntegrationState } from './IntegrationDialog';
const list = (value: string) =>
  value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
const localDate = (value?: string) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : '';
type Grant = {
  source_id: string;
  environment: string;
  scopes: string[];
  accounts: string;
  expires_at: string;
  client_expires_at: string;
  rate_limit_per_minute: number;
};
export function GrantForm({
  value,
  invitation = false,
  pending,
  onSubmit,
}: {
  value?: Partial<IntegrationClient>;
  invitation?: boolean;
  pending: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const accounts = useResource<{ items: { account: Account }[] }>('/api/accounts');
  const [form, setForm] = useState<Grant>({
    source_id: value?.source_id || '',
    environment: value?.environment || '',
    scopes: value?.scopes || [
      'targets:read',
      'preparations:read',
      'preparations:write',
      'distributions:read',
      'distributions:write',
    ],
    accounts: (value?.accounts || []).join(', '),
    expires_at: localDate(value?.expires_at),
    client_expires_at: '',
    rate_limit_per_minute: value?.rate_limit_per_minute || 60,
  });
  const [error, setError] = useState('');
  function field(
    key: keyof Grant,
    label: string,
    options: { required?: boolean; type?: string } = {},
  ) {
    return (
      <label>
        {label}
        <input
          type={options.type || 'text'}
          required={options.required}
          autoComplete="off"
          value={String(form[key])}
          disabled={pending}
          onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
        />
      </label>
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!form.scopes.length || !list(form.accounts).length) {
      setError('请选择权限并填写允许的账号。');
      return;
    }
    if (!Number.isFinite(Date.parse(form.expires_at))) {
      setError('请填写有效的有效期。');
      return;
    }
    const body = {
      ...form,
      scopes: form.scopes,
      accounts: list(form.accounts),
      operations: ['save_draft'],
      expires_at: new Date(form.expires_at).toISOString(),
      rate_limit_per_minute: Number(form.rate_limit_per_minute),
    };
    if (invitation && !form.client_expires_at) {
      setError('请填写应用有效期。');
      return;
    }
    const result: Record<string, unknown> = { ...body };
    if (invitation) {
      result.client_expires_at = new Date(form.client_expires_at).toISOString();
    } else {
      delete result.client_expires_at;
      delete result.environment;
    }
    await onSubmit(result);
  }
  return (
    <form className="form-grid" onSubmit={(event) => void submit(event)}>
      <fieldset className="integration-fields" disabled={pending}>
        {(invitation || value?.id) && field('source_id', '来源标识', { required: true })}
        {invitation && field('environment', '运行环境', { required: true })}
        <fieldset className="integration-scopes">
          <legend>允许权限</legend>
          {integrationScopes.map(([scope, label]) => (
            <label className="checkbox" key={scope}>
              <input
                type="checkbox"
                checked={form.scopes.includes(scope)}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    scopes: event.target.checked
                      ? [...current.scopes, scope]
                      : current.scopes.filter((item) => item !== scope),
                  }))
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset className="integration-scopes">
          <legend>允许账号</legend>
          <ResourceError error={accounts.error} />
          {(accounts.data?.items || [])
            .filter((item) => item.account.platform === 'csdn' && item.account.verified !== false)
            .map(({ account }) => (
              <label className="checkbox" key={account.id}>
                <input
                  type="checkbox"
                  checked={list(form.accounts).includes(account.id)}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      accounts: (event.target.checked
                        ? [...list(current.accounts), account.id]
                        : list(current.accounts).filter((id) => id !== account.id)
                      ).join(','),
                    }))
                  }
                />
                {account.display_name || account.username || account.id}
              </label>
            ))}
        </fieldset>
        <label>
          允许操作
          <input value="保存 CSDN 草稿" disabled />
        </label>
        {field('expires_at', invitation ? '邀请有效期' : '应用有效期', {
          required: true,
          type: 'datetime-local',
        })}
        {invitation &&
          field('client_expires_at', '应用有效期', { required: true, type: 'datetime-local' })}
        <label>
          每分钟请求上限
          <input
            type="number"
            min={1}
            max={600}
            value={form.rate_limit_per_minute}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                rate_limit_per_minute: Number(event.target.value),
              }))
            }
          />
        </label>
      </fieldset>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <button type="submit" className="primary" disabled={pending}>
        {pending
          ? '正在处理…'
          : invitation
            ? '生成邀请'
            : value?.grant_version
              ? '保存应用配置'
              : '批准并签发密钥'}
      </button>
    </form>
  );
}
export function Secret({ value, onClose }: { value: IssuedSecret; onClose: () => void }) {
  return (
    <IntegrationModal
      title={value.client_secret ? '一次性应用密钥' : '一次性邀请'}
      closeLabel="关闭密钥"
      onClose={onClose}
    >
      <dl className="readonly-list">
        <dt>{value.client_id ? '应用标识' : '邀请标识'}</dt>
        <dd>{value.client_id || value.invitation_id}</dd>
        {value.key_id && (
          <>
            <dt>密钥标识</dt>
            <dd>{value.key_id}</dd>
          </>
        )}
        <dt>{value.client_secret ? '应用密钥' : '邀请令牌'}</dt>
        <dd className="integration-secret" tabIndex={0}>
          {value.client_secret || value.invitation_token}
        </dd>
      </dl>
      <div className="notice warning section-gap">关闭后无法再次查看，请妥善保存。</div>
    </IntegrationModal>
  );
}
export function ClientEditor({
  id,
  onClose,
  onChange,
  onSecret,
}: {
  id: string;
  onClose: () => void;
  onChange: () => void;
  onSecret: (value: IssuedSecret) => void;
}) {
  const { api } = useWorkspace();
  const [data, setData] = useState<IntegrationClient>();
  const [error, setError] = useState('');
  const action = useAction();
  const [confirm, setConfirm] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<IntegrationClient>('/api/integration-clients/' + encodeURIComponent(id), {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [id, api]);
  async function perform() {
    const result = await action.run((signal) =>
      api<IssuedSecret>('/api/integration-clients/' + encodeURIComponent(id) + '/' + confirm, {
        method: 'POST',
        body: '{}',
        signal,
      }),
    );
    if (result) {
      setConfirm('');
      onChange();
      if (result.client_secret) {
        onClose();
        onSecret(result);
      } else {
        onClose();
      }
    }
  }
  const names: Record<string, string> = {
    rotate: '轮换',
    suspend: '暂停',
    resume: '启用',
    revoke: '撤销',
  };
  return (
    <section className="surface section-gap">
      <div className="surface-header">
        <h2>{data?.name || '应用配置'}</h2>
        <button type="button" onClick={onClose} disabled={action.pending}>
          关闭配置
        </button>
      </div>
      <div className="surface-body">
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {!data ? (
          <Empty loading={!error}>无法读取应用</Empty>
        ) : (
          <>
            <dl className="readonly-list">
              <dt>应用状态</dt>
              <dd>
                <IntegrationState value={data.status} />
              </dd>
              <dt>授权版本</dt>
              <dd>{data.grant_version}</dd>
              <dt>运行环境</dt>
              <dd>{data.environment}</dd>
            </dl>
            <div className="heading-actions section-gap">
              {data.status !== 'revoked' && (
                <>
                  {['active', 'pending_activation'].includes(data.status) && (
                    <button disabled={action.pending} onClick={() => setConfirm('rotate')}>
                      轮换密钥
                    </button>
                  )}
                  <button
                    disabled={action.pending}
                    onClick={() => setConfirm(data.status === 'suspended' ? 'resume' : 'suspend')}
                  >
                    {data.status === 'suspended' ? '启用应用' : '暂停应用'}
                  </button>
                  <button
                    className="danger"
                    disabled={action.pending}
                    onClick={() => setConfirm('revoke')}
                  >
                    撤销应用
                  </button>
                </>
              )}
            </div>
            {data.status !== 'revoked' && (
              <div className="section-gap">
                <GrantForm
                  value={data}
                  pending={action.pending}
                  onSubmit={async (body) => {
                    const result = await action.run((signal) =>
                      api<IntegrationClient>('/api/integration-clients/' + encodeURIComponent(id), {
                        method: 'PUT',
                        body: JSON.stringify(body),
                        signal,
                      }),
                    );
                    if (result) {
                      setData(result);
                      onChange();
                    }
                  }}
                />
              </div>
            )}
          </>
        )}
        {action.error && (
          <div className="notice error section-gap" role="alert">
            {action.error}
          </div>
        )}
      </div>
      {confirm && (
        <IntegrationModal
          title={names[confirm] + '应用'}
          onClose={() => {
            if (!action.pending) setConfirm('');
          }}
        >
          <p>
            {confirm === 'rotate'
              ? '确认轮换密钥？新密钥激活后，现有密钥将在十分钟内失效。'
              : confirm === 'revoke'
                ? '确认撤销此应用？该应用将无法继续访问。'
                : '确认' + names[confirm] + '此应用？'}
          </p>
          <button
            className={confirm === 'resume' ? 'primary' : 'danger'}
            disabled={action.pending}
            onClick={() => void perform()}
          >
            {action.pending ? '正在处理…' : '确认' + names[confirm]}
          </button>
          {action.error && (
            <div className="notice error" role="alert">
              {action.error}
            </div>
          )}
        </IntegrationModal>
      )}
    </section>
  );
}
