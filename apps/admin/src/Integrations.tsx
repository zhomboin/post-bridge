import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Empty,
  Pagination,
  RefreshBar,
  ResourceError,
  RouteLink,
  Status,
  errorText,
  isSourcePaused,
  queryPage,
  time,
  useAction,
  useResource,
  useWorkspace,
  type PageData,
} from './runtime';
import {
  integrationStatuses,
  type IntegrationClient,
  type IntegrationDistribution,
  type IssuedSecret,
  type Preparation,
  type Registration,
} from './integration-types';
import './Integrations.css';

import { IntegrationModal, IntegrationState } from './IntegrationDialog';
import { GrantForm, Secret, ClientEditor } from './IntegrationAccess';
function integrationJobHref(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !/^\/jobs\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      return undefined;
    return url.pathname;
  } catch {
    return undefined;
  }
}

function DistributionDetail({
  data,
  loading,
  onRefresh,
}: {
  data?: IntegrationDistribution;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { api, route, navigate } = useWorkspace();
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  async function resume() {
    if (!data?.resume_allowed) return;
    const result = await action.run(
      (signal) =>
        api('/api/integration-distributions/' + encodeURIComponent(data.id) + '/resume', {
          method: 'POST',
          body: JSON.stringify({ confirmation_fingerprint: data.confirmation_fingerprint }),
          signal,
        }),
      '请重新核对来源和当前授权后刷新。',
    );
    if (result) {
      setConfirm(false);
      onRefresh();
    }
  }
  function back() {
    const next = new URLSearchParams(route.split('?')[1]);
    next.delete('distribution_id');
    navigate('/integrations?' + next);
  }
  if (!data)
    return (
      <div className="surface-body">
        <button onClick={back}>返回分发记录</button>
        <Empty loading={loading}>暂时无法读取分发记录</Empty>
      </div>
    );
  const external: Record<string, string> = {
    unknown: '结果未知',
    not_submitted: '尚未保存',
    draft: '草稿',
    draft_saved: '草稿已保存',
    published: '已公开',
    private: '私密',
    deleted: '已删除',
  };
  return (
    <div className="surface-body">
      <button onClick={back}>返回分发记录</button>
      <div className="page-heading section-gap">
        <h2>分发 {data.article_id}</h2>
        <IntegrationState value={data.status} />
      </div>
      <dl className="detail-facts">
        <div>
          <dt>来源</dt>
          <dd>{data.source_id}</dd>
        </div>
        <div>
          <dt>来源版本</dt>
          <dd>{data.source_version ?? '—'}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{time(data.created_at)}</dd>
        </div>
      </dl>
      <div className="integration-children section-gap">
        {(data.children || []).map((child) => (
          <section className="integration-child" key={child.id}>
            <div className="integration-child-heading">
              <h3>
                {child.platform === 'csdn' ? 'CSDN' : child.platform} · {child.account_id}
              </h3>
              <Status
                value={child.status}
                label={
                  isSourcePaused({ ...child, integration_distribution_id: data.id })
                    ? '来源待处理'
                    : undefined
                }
              />
            </div>
            <dl className="readonly-list">
              <dt>目标操作</dt>
              <dd>{child.operation === 'save_draft' ? '保存草稿' : '未开放操作'}</dd>
              <dt>平台状态</dt>
              <dd>{external[child.external_status] || '结果未知'}</dd>
              <dt>最近核对</dt>
              <dd>{time(child.last_confirmed_at)}</dd>
            </dl>
            {child.error_message && (
              <div className="notice warning section-gap" role="status">
                {child.error_message}
              </div>
            )}
            {integrationJobHref(child.detail_url) && (
              <RouteLink className="button section-gap" href={integrationJobHref(child.detail_url)}>
                查看草稿任务
              </RouteLink>
            )}
          </section>
        ))}
      </div>
      {data.resume_allowed && (
        <button
          className="primary section-gap"
          disabled={action.pending}
          onClick={() => setConfirm(true)}
        >
          恢复原任务
        </button>
      )}
      {action.error && (
        <div className="notice error section-gap" role="alert">
          {action.error}
        </div>
      )}
      {confirm && (
        <IntegrationModal
          title="恢复原任务"
          onClose={() => {
            if (!action.pending) setConfirm(false);
          }}
        >
          <p>确认已核对当前来源内容和授权，并恢复原草稿任务？</p>
          <button
            className="primary"
            disabled={action.pending || !data.resume_allowed}
            onClick={() => void resume()}
          >
            {action.pending ? '正在处理…' : '确认恢复原任务'}
          </button>
          {action.error && (
            <div className="notice error section-gap" role="alert">
              {action.error}
            </div>
          )}
        </IntegrationModal>
      )}
    </div>
  );
}

const tabs = [
  ['drafts', '平台稿'],
  ['distributions', '分发记录'],
  ['clients', '应用'],
  ['registrations', '申请'],
  ['invitations', '邀请'],
  ['audit', '审计'],
] as const;
export default function Integrations() {
  const { api, route, navigate } = useWorkspace();
  const params = new URLSearchParams(route.split('?')[1]);
  const tab = tabs.find(([key]) => key === params.get('tab'))?.[0] || 'drafts';
  const status = params.get('status') || '';
  const page = queryPage(params);
  const view = useRef({ route, generation: 0 });
  if (view.current.route !== route)
    view.current = { route, generation: view.current.generation + 1 };
  const generation = view.current.generation;
  function reveal(value: IssuedSecret) {
    if (view.current.generation === generation && document.visibilityState !== 'hidden')
      setSecret(value);
  }
  const distributionId = tab === 'distributions' ? params.get('distribution_id') || '' : '';
  const path =
    tab === 'distributions'
      ? '/api/integration-distributions' +
        (distributionId
          ? '/' + encodeURIComponent(distributionId)
          : '?page=' + page + (status ? '&status=' + encodeURIComponent(status) : ''))
      : tab === 'drafts'
        ? '/api/integration-preparations?page=' +
          page +
          (status ? '&status=' + encodeURIComponent(status) : '')
        : '/api/integration-' + (tab === 'audit' ? 'audit' : tab);
  const resource = useResource<
    | PageData<
        Preparation &
          IntegrationClient &
          Registration & { action: string; actor: string; invitation_id?: string }
      >
    | IntegrationDistribution
  >(path);
  const [selected, setSelected] = useState('');
  const [approval, setApproval] = useState<Registration>();
  const [reject, setReject] = useState<Registration>();
  const [invite, setInvite] = useState(false);
  const [secret, setSecret] = useState<IssuedSecret>();
  const action = useAction();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    setSelected('');
    setApproval(undefined);
    setReject(undefined);
    setInvite(false);
    setSecret(undefined);
  }, [route]);
  function distributionHref(id: string) {
    const next = new URLSearchParams(params);
    next.set('tab', 'distributions');
    next.set('distribution_id', id);
    return '/integrations?' + next;
  }
  function select(value: string) {
    const next = new URLSearchParams();
    if (value !== 'drafts') next.set('tab', value);
    navigate('/integrations' + (next.size ? '?' + next : ''));
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    select(tabs[next][0]);
    buttons.current[next]?.focus();
  }
  const states =
    tab === 'distributions'
      ? ['in_progress', 'needs_attention', 'completed']
      : tab === 'drafts'
        ? ['prepared', 'confirmed', 'submitted', 'revoked', 'expired']
        : tab === 'clients'
          ? ['active', 'pending_activation', 'suspended', 'revoked']
          : tab === 'invitations'
            ? ['pending', 'consumed', 'expired']
            : ['pending', 'approved', 'rejected', 'expired'];
  const listing = resource.data && 'items' in resource.data ? resource.data : undefined;
  const distribution = resource.data && 'children' in resource.data ? resource.data : undefined;
  const items = (listing?.items || []).filter((item) => !status || item.status === status);
  return (
    <div className="page integrations-page">
      <div className="page-heading">
        <h1>内容来源</h1>
      </div>
      <div className="account-tabs integration-tabs" role="tablist" aria-label="内容来源">
        {tabs.map(([key, label], index) => (
          <button
            key={key}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            id={'integration-tab-' + key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            aria-controls={'integration-panel-' + key}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => select(key)}
            onKeyDown={(event) => keyDown(event, index)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={'integration-panel-' + tab}
        aria-labelledby={'integration-tab-' + tab}
        tabIndex={0}
      >
        <section className="surface">
          <div className="surface-header">
            <h2>
              {tab === 'drafts'
                ? '平台稿'
                : tab === 'distributions'
                  ? '分发记录'
                  : tab === 'clients'
                    ? '接入应用'
                    : tab === 'registrations'
                      ? '注册申请'
                      : tab === 'invitations'
                        ? '注册邀请'
                        : '管理审计'}
            </h2>
            <div className="heading-actions">
              {tab === 'invitations' && (
                <button className="primary" onClick={() => setInvite(true)}>
                  创建邀请
                </button>
              )}
            </div>
          </div>
          {tab !== 'audit' && !distributionId && (
            <div className="toolbar">
              <label>
                状态筛选
                <select
                  value={status}
                  onChange={(event) => {
                    if (event.target.value) params.set('status', event.target.value);
                    else params.delete('status');
                    params.delete('page');
                    navigate('/integrations' + (params.size ? '?' + params : ''));
                  }}
                >
                  <option value="">全部状态</option>
                  {states.map((value) => (
                    <option key={value} value={value}>
                      {tab === 'invitations' && value === 'pending'
                        ? '待使用'
                        : integrationStatuses[value]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <RefreshBar resource={resource} name="刷新列表" />
          <ResourceError error={resource.error} stale={!!resource.data} />
          {distributionId ? (
            <DistributionDetail
              key={distributionId}
              data={distribution}
              loading={resource.loading}
              onRefresh={resource.refresh}
            />
          ) : items.length ? (
            <table className="data-table integration-table">
              <thead>
                <tr>
                  <th>
                    {tab === 'drafts'
                      ? '原稿'
                      : tab === 'distributions'
                        ? '原稿标识'
                        : tab === 'audit'
                          ? '操作'
                          : '名称'}
                  </th>
                  <th>{tab === 'audit' ? '操作者' : '来源'}</th>
                  <th>{tab === 'audit' ? '应用' : '状态'}</th>
                  <th>{tab === 'registrations' ? '操作' : '时间'}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id || item.invitation_id}>
                    <td className="title-cell">
                      {tab === 'drafts' ? (
                        <RouteLink
                          className="title-link"
                          href={
                            '/integration-preparations/' +
                            encodeURIComponent(item.id) +
                            '?back=' +
                            encodeURIComponent(route)
                          }
                        >
                          {item.snapshot?.title || '无标题'}
                        </RouteLink>
                      ) : tab === 'distributions' ? (
                        <RouteLink className="title-link" href={distributionHref(item.id)}>
                          {item.article_id}
                        </RouteLink>
                      ) : tab === 'clients' ? (
                        <button className="integration-name" onClick={() => setSelected(item.id)}>
                          {item.name}
                        </button>
                      ) : tab === 'audit' ? (
                        <span>
                          {(
                            {
                              registered: '提交申请',
                              approved: '批准应用',
                              registration_rejected: '拒绝申请',
                              activated: '激活应用',
                              permissions_updated: '更新权限',
                              key_rotated: '轮换密钥',
                              suspend: '暂停应用',
                              resume: '启用应用',
                              revoke: '撤销应用',
                              request_denied: '拒绝访问',
                              invitation_created: '创建邀请',
                            } as Record<string, string>
                          )[item.action] || '管理操作'}
                        </span>
                      ) : (
                        <span>{item.name || item.id || item.invitation_id}</span>
                      )}
                    </td>
                    <td>{tab === 'audit' ? item.actor : item.source_id || '—'}</td>
                    <td>
                      {tab === 'audit' ? (
                        item.client_id || '—'
                      ) : (
                        <IntegrationState
                          value={
                            tab === 'invitations' && item.status === 'pending'
                              ? 'invitation_pending'
                              : item.status
                          }
                        />
                      )}
                    </td>
                    <td>
                      {tab === 'registrations' && item.status === 'pending' ? (
                        <div className="heading-actions">
                          <button disabled={action.pending} onClick={() => setApproval(item)}>
                            审批
                          </button>
                          <button
                            className="danger"
                            disabled={action.pending}
                            onClick={() => setReject(item)}
                          >
                            拒绝
                          </button>
                        </div>
                      ) : (
                        <time>{time(item.created_at || item.expires_at)}</time>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty loading={resource.loading}>{resource.error ? '暂时无法读取' : '暂无记录'}</Empty>
          )}
          {(tab === 'drafts' || tab === 'distributions') && !distributionId && listing && (
            <Pagination
              total={listing.total}
              page={page}
              pageSize={listing.page_size || 20}
              onPage={(value) => {
                params.set('page', String(value));
                navigate('/integrations?' + params);
              }}
            />
          )}
        </section>
        {selected && (
          <ClientEditor
            key={selected}
            id={selected}
            onClose={() => setSelected('')}
            onChange={resource.refresh}
            onSecret={reveal}
          />
        )}
        {approval && (
          <IntegrationModal
            title={'批准 ' + approval.name}
            onClose={() => {
              if (!action.pending) setApproval(undefined);
            }}
          >
            <GrantForm
              value={approval}
              pending={action.pending}
              onSubmit={async (body) => {
                const result = await action.run((signal) =>
                  api<IssuedSecret>(
                    '/api/integration-registrations/' +
                      encodeURIComponent(approval.id) +
                      '/approve',
                    { method: 'POST', body: JSON.stringify(body), signal },
                  ),
                );
                if (result) {
                  setApproval(undefined);
                  reveal(result);
                  resource.refresh();
                }
              }}
            />
            {action.error && (
              <div className="notice error section-gap" role="alert">
                {action.error}
              </div>
            )}
          </IntegrationModal>
        )}
        {reject && (
          <IntegrationModal
            title="拒绝申请"
            onClose={() => {
              if (!action.pending) setReject(undefined);
            }}
          >
            <p>确认拒绝 {reject.name} 的注册申请？</p>
            <button
              className="danger"
              disabled={action.pending}
              onClick={() =>
                void action
                  .run((signal) =>
                    api(
                      '/api/integration-registrations/' + encodeURIComponent(reject.id) + '/reject',
                      { method: 'POST', body: '{}', signal },
                    ),
                  )
                  .then((result) => {
                    if (result) {
                      setReject(undefined);
                      resource.refresh();
                    }
                  })
              }
            >
              {action.pending ? '正在处理…' : '确认拒绝'}
            </button>
            {action.error && (
              <div role="alert" className="notice error">
                {action.error}
              </div>
            )}
          </IntegrationModal>
        )}
        {invite && (
          <IntegrationModal
            title="创建邀请"
            onClose={() => {
              if (!action.pending) setInvite(false);
            }}
          >
            <GrantForm
              invitation
              pending={action.pending}
              onSubmit={async (body) => {
                const result = await action.run((signal) =>
                  api<IssuedSecret>('/api/integration-invitations', {
                    method: 'POST',
                    body: JSON.stringify(body),
                    signal,
                  }),
                );
                if (result) {
                  setInvite(false);
                  reveal(result);
                  resource.refresh();
                }
              }}
            />
            {action.error && (
              <div className="notice error section-gap" role="alert">
                {action.error}
              </div>
            )}
          </IntegrationModal>
        )}
        {secret && <Secret value={secret} onClose={() => setSecret(undefined)} />}
      </div>
    </div>
  );
}
