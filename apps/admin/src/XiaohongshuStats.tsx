import AccountTrend from './AccountTrend';
import type { NoteSnapshot } from './xiaohongshu-types';
import { noteNumber } from './xiaohongshu-types';
import { Empty } from './runtime';

const periodDate = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '—';

export default function XiaohongshuStats({ snapshot }: { snapshot?: NoteSnapshot | null }) {
  const stats = snapshot?.stats;
  return (
    <section className="surface article-overview">
      <div className="surface-header">
        <h2>数据统计</h2>
        <span>近 7 日</span>
      </div>
      {stats ? (
        <>
          <p className="xhs-period">
            {periodDate(stats.begin_at)} — {periodDate(stats.end_at)}
          </p>
          <dl className="article-metrics">
            {(
              [
                ['published', '发布笔记'],
                ['views', '阅读'],
                ['exposures', '曝光'],
                ['likes', '点赞'],
                ['comments', '评论'],
                ['favorites', '收藏'],
                ['shares', '分享'],
                ['net_followers', '净增粉丝'],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{noteNumber(stats[key])}</dd>
              </div>
            ))}
          </dl>
          <AccountTrend
            trend={(snapshot?.trend || []).map((row) => ({
              ...row,
              promotion_clicks: null,
              outlink_clicks: null,
            }))}
            metrics={[
              ['views', '阅读'],
              ['likes', '点赞'],
              ['comments', '评论'],
              ['favorites', '收藏'],
              ['exposures', '曝光'],
              ['followers', '净增粉丝'],
            ]}
          />
        </>
      ) : (
        <Empty>尚未同步统计</Empty>
      )}
    </section>
  );
}
