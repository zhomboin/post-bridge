import { useContentTask } from './content-task';
import { useContentDetail } from './content-resource';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  Empty,
  RefreshBar,
  ResourceError,
  RouteLink,
  Status,
  jobHref,
  time,
  useResource,
  useWorkspace,
  type Job,
} from './runtime';
import { noteLabels, type NoteDetailData } from './xiaohongshu-types';
import { platformMediaURL, notePublicURL } from './platform-media';
import './Xiaohongshu.css';

function NoteImage({ url, index }: { url: string; index: number }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <div
      className="xhs-image-error"
      role="img"
      aria-label={'笔记图片 ' + (index + 1) + ' 加载失败'}
    >
      图片暂不可用
    </div>
  ) : (
    <img
      src={url}
      alt={'笔记图片 ' + (index + 1)}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export default function NoteDetail({ id, account }: { id: string; account: string }) {
  const { route } = useWorkspace();
  const base =
    '/api/accounts/' + encodeURIComponent(account) + '/contents/' + encodeURIComponent(id);
  const data = useContentDetail<NoteDetailData>(base, 'xiaohongshu', 'note');
  const action = useContentTask();
  const once = useRef(false);
  const detail = data.data;
  const active =
    !!detail?.read_job && ['queued', 'running', 'waiting_user'].includes(detail.read_job.status);
  const params = new URLSearchParams(route.split('?')[1]);
  const candidate = params.get('back') || '';
  const back =
    candidate.startsWith('/account?') &&
    new URLSearchParams(candidate.split('?')[1]).get('account') === account
      ? candidate
      : '/account?' + new URLSearchParams({ account });
  async function read() {
    const job = await action.submit(base + '/read');
    if (job) {
      data.refresh();
    }
  }
  useEffect(() => {
    if (
      !once.current &&
      detail &&
      !detail.body &&
      !detail.read_job &&
      detail.note.status === 'published'
    ) {
      once.current = true;
      void read();
    }
  }, [detail]);
  const url = detail ? notePublicURL(detail.note.note_url, id) : undefined;
  return (
    <div className="page xhs-note-detail">
      <RouteLink className="back-link" href={back}>
        <ArrowLeft size={16} aria-hidden="true" />
        返回笔记
      </RouteLink>
      <div className="page-heading">
        <h1>{detail?.body?.title || detail?.note.title || '笔记详情'}</h1>
        {url && (
          <a href={url} target="_blank" rel="noreferrer noopener">
            平台查看
          </a>
        )}
      </div>
      <ResourceError error={data.error} stale={!!detail} />
      {detail ? (
        <>
          <section className="surface">
            <div className="surface-header">
              <h2>笔记信息</h2>
              <span>{noteLabels[detail.note.status] || noteLabels.unknown}</span>
            </div>
            <dl className="readonly-list surface-body">
              <dt>笔记 ID</dt>
              <dd className="mono">{id}</dd>
              <dt>发布时间</dt>
              <dd>{time(detail.note.posted_at)}</dd>
              <dt>最近读取</dt>
              <dd>{time(detail.fetched_at || undefined)}</dd>
            </dl>
            <RefreshBar resource={data} name="刷新本地状态" />
          </section>
          <section className="surface">
            <div className="surface-header">
              <h2>正文与图片</h2>
              <button
                className="primary"
                disabled={action.pending || active || detail.note.status !== 'published'}
                onClick={() => void read()}
              >
                {action.pending || active ? '正在读取…' : '重新读取正文'}
              </button>
            </div>
            {detail.read_job && (
              <div className="article-job">
                <Status value={detail.read_job.status} />
                <RouteLink href={jobHref(detail.read_job.id, route)}>查看读取任务</RouteLink>
                {detail.read_job.error_message && (
                  <span role="status">{detail.read_job.error_message}</span>
                )}
              </div>
            )}
            {detail.body ? (
              <>
                <p className="xhs-note-body">{detail.body.text}</p>
                {!!detail.body.tags.length && (
                  <div className="xhs-note-tags">
                    {detail.body.tags.map((tag, index) => (
                      <span key={index}>#{tag}</span>
                    ))}
                  </div>
                )}
                <div className="xhs-note-images">
                  {detail.body.images.map((image, index) => {
                    const safe = platformMediaURL(image, 'xiaohongshu');
                    return safe ? <NoteImage key={safe + index} url={safe} index={index} /> : null;
                  })}
                </div>
              </>
            ) : (
              <Empty loading={active || action.pending}>
                {detail.read_job?.status === 'failed'
                  ? '正文读取失败'
                  : detail.note.status !== 'published'
                    ? '该笔记暂不可读取正文'
                    : '尚未读取正文'}
              </Empty>
            )}
          </section>
        </>
      ) : (
        <Empty loading={data.loading}>无法读取笔记详情</Empty>
      )}
      {action.error && (
        <div className="notice error" role="alert">
          {action.error}
        </div>
      )}
    </div>
  );
}
