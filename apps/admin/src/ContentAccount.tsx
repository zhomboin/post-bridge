import { useContentTask } from './content-task';
import { useEffect, useState, type ReactNode } from 'react';
import type { ContentPlatform } from './content-contract';
import {
  contentBase,
  canReadContent,
  type ContentDetail,
  type ContentPage,
} from './content-resource';
import {
  Empty,
  Pagination,
  RefreshBar,
  ResourceError,
  RouteLink,
  Status,
  time,
  useResource,
  useWorkspace,
} from './runtime';

const contentStatusLabels: Record<string, string> = {
  published: '已发布',
  draft: '草稿',
  reviewing: '审核中',
  rejected: '未通过',
  recycled: '回收站',
  unknown: '状态待确认',
};

export function ContentAccount({
  account,
  platform,
  picker,
}: {
  account: string;
  platform: string;
  picker: ReactNode;
}) {
  const { route, navigate } = useWorkspace();
  const params = new URLSearchParams(route.split('?')[1]);
  const query = new URLSearchParams({
    q: params.get('q') || '',
    status: params.get('status') || '',
    page: params.get('page') || '1',
    page_size: '20',
  });
  const data = useResource<ContentPage>(contentBase(account) + '?' + query);
  const [search, setSearch] = useState(query.get('q') || '');
  useEffect(() => setSearch(new URLSearchParams(route.split('?')[1]).get('q') || ''), [route]);
  const definitions = useResource<{ items: ContentPlatform[] }>('/api/content-platforms');
  const definition = definitions.data?.items.find((entry) => entry.id === platform);
  const action = useContentTask();
  const busy =
    !!data.data?.sync_job &&
    ['queued', 'running', 'waiting_user'].includes(data.data.sync_job.status);
  async function sync() {
    const result = await action.submit(contentBase(account) + '/sync');
    if (result) {
      data.refresh();
    }
  }
  return (
    <div className="page">
      <div className="page-heading">
        <h1>账号内容</h1>
        {picker}
      </div>
      <section className="surface">
        <div className="surface-header">
          <h2>内容列表</h2>
          <button
            disabled={!definition?.capabilities.list?.enabled || busy || action.pending}
            onClick={() => void sync()}
          >
            同步内容
          </button>
        </div>
        <div className="surface-body">
          <form
            className="toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              params.set('q', search);
              params.delete('page');
              navigate('/account?' + params);
            }}
          >
            <label>
              搜索内容
              <input value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <button>筛选</button>
          </form>
          <RefreshBar resource={data} name="刷新本地状态" />
          <ResourceError error={data.error} stale={!!data.data} />
          <ResourceError error={definitions.error} stale={!!definitions.data} />
          <ResourceError error={action.error} />
          {data.data?.sync_job && <Status value={data.data.sync_job.status} />}
          {data.data?.items.length ? (
            <ul>
              {data.data.items.map((item) => (
                <li key={item.id}>
                  <RouteLink
                    href={
                      '/contents/' +
                      encodeURIComponent(item.id) +
                      '?' +
                      new URLSearchParams({ account, back: route })
                    }
                  >
                    {item.title}
                  </RouteLink>
                  <span>
                    {' '}
                    · {contentStatusLabels[item.status] || '状态待确认'} · {time(item.posted_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty loading={data.loading}>暂无内容</Empty>
          )}
          {data.data && (
            <Pagination
              total={data.data.total}
              page={data.data.page}
              pageSize={data.data.page_size}
              onPage={(page) => {
                params.set('page', String(page));
                navigate('/account?' + params);
              }}
            />
          )}
        </div>
      </section>
    </div>
  );
}

export function ContentDetailPage({ account, id }: { account: string; id: string }) {
  const { route } = useWorkspace();
  const data = useResource<ContentDetail>(contentBase(account) + '/' + encodeURIComponent(id));
  const definitions = useResource<{ items: ContentPlatform[] }>('/api/content-platforms');
  const definition = definitions.data?.items.find((entry) => entry.id === data.data?.platform);
  const action = useContentTask();
  const params = new URLSearchParams(route.split('?')[1]);
  const candidate = params.get('back') || '';
  const back =
    candidate.startsWith('/account?') &&
    new URLSearchParams(candidate.split('?')[1]).get('account') === account
      ? candidate
      : '/account?' + new URLSearchParams({ account });
  async function read() {
    const result = await action.submit(
      contentBase(account) + '/' + encodeURIComponent(id) + '/read',
    );
    if (result) {
      data.refresh();
    }
  }
  const active =
    !!data.data?.read_job &&
    ['queued', 'running', 'waiting_user'].includes(data.data.read_job.status);
  return (
    <div className="page">
      <RouteLink href={back}>返回账号内容</RouteLink>
      <h1>{data.data?.item.title || '内容详情'}</h1>
      <RefreshBar resource={data} name="刷新本地状态" />
      <ResourceError error={data.error} stale={!!data.data} />
      <ResourceError error={action.error} />
      {definition && data.data && canReadContent(definition, data.data.item) && (
        <button disabled={active || action.pending} onClick={() => void read()}>
          读取正文
        </button>
      )}
      {data.data?.read_job && <Status value={data.data.read_job.status} />}
      {data.data?.body ? (
        <section className="surface surface-body">
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {data.data.body.text || data.data.body.html}
          </pre>
        </section>
      ) : (
        <Empty loading={data.loading}>暂无正文</Empty>
      )}
    </div>
  );
}
