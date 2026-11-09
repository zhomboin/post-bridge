import { useId, useState, type KeyboardEvent } from 'react';
import type { ArticleSnapshot } from './article-types';
import './AccountTrend.css';

const series = [
  ['views', '阅读'],
  ['comments', '评论'],
  ['favorites', '收藏'],
  ['followers', '粉丝'],
  ['promotion_clicks', '推广点击'],
  ['outlink_clicks', '外链点击'],
] as const;
type TrendRow = ArticleSnapshot['trend'][number] & {
  likes?: number | null;
  exposures?: number | null;
};
type Metric = (typeof series)[number][0] | 'likes' | 'exposures';
const numberText = (value: number | null | undefined) =>
  value != null && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '暂无数据';
const day = (date: string) => Date.parse(date + 'T00:00:00Z');

function TrendChart({
  rows,
  metric,
  label,
  announce,
}: {
  rows: TrendRow[];
  metric: Metric;
  label: string;
  announce: (value: string) => void;
}) {
  const descriptionId = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const index = Math.max(0, Math.min(selected ?? rows.length - 1, rows.length - 1));
  const current = rows[index];
  const values = rows
    .map((row) => row[metric])
    .filter((value): value is number => value != null && Number.isFinite(value));
  const lower = Math.min(0, ...values);
  const upper = Math.max(0, ...values);
  const min = lower === upper ? -1 : lower;
  const max = lower === upper ? 1 : upper;
  const range = max - min;
  const firstDay = rows.length ? day(rows[0].date) : 0;
  const duration = rows.length ? day(rows[rows.length - 1].date) - firstDay : 0;
  const x = (i: number) =>
    duration ? 48 + ((day(rows[i].date) - firstDay) / duration) * 286 : 191;
  const y = (value: number) => 24 + ((max - value) / range) * 104;
  const segments: string[][] = [];
  let segment: string[] = [];
  rows.forEach((row, i) => {
    const value = row[metric];
    if (
      value == null ||
      !Number.isFinite(value) ||
      (i > 0 && day(row.date) - day(rows[i - 1].date) > 86400000)
    ) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (value != null && Number.isFinite(value)) segment.push(x(i) + ',' + y(value));
  });
  if (segment.length) segments.push(segment);
  function select(next: number) {
    setSelected(next);
    if (rows[next]) announce(rows[next].date + ' ' + label + ' ' + numberText(rows[next][metric]));
  }
  function keyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (!rows.length) return;
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'ArrowRight') next = Math.min(rows.length - 1, index + 1);
    else return;
    event.preventDefault();
    select(next);
  }
  return (
    <figure className="account-trend-chart">
      <figcaption>
        <h3>{label}</h3>
        <span>
          {current ? (
            <>
              <time dateTime={current.date}>{current.date.slice(5)}</time>
              <strong>{numberText(current[metric])}</strong>
            </>
          ) : (
            '暂无趋势数据'
          )}
        </span>
      </figcaption>
      <svg
        viewBox="0 0 350 162"
        role="img"
        aria-label={label + '趋势'}
        aria-describedby={descriptionId}
        tabIndex={0}
        onKeyDown={keyDown}
        onFocus={() => select(index)}
      >
        <desc id={descriptionId}>
          {rows.length
            ? '左右方向键切换日期，Home 跳到首日，End 跳到末日。' +
              rows.map((row) => row.date + ' ' + numberText(row[metric])).join('；')
            : '暂无趋势数据'}
        </desc>
        {[0, 1, 2].map((tick) => {
          const value = max - (range * tick) / 2;
          return (
            <g key={tick} className="account-trend-axis">
              <line x1="48" x2="334" y1={24 + tick * 52} y2={24 + tick * 52} />
              <text x="42" y={28 + tick * 52} textAnchor="end">
                {values.length
                  ? new Intl.NumberFormat('zh-CN', {
                      notation: 'compact',
                      maximumFractionDigits: 1,
                    }).format(value)
                  : '—'}
              </text>
            </g>
          );
        })}
        {segments
          .filter((points) => points.length > 1)
          .map((points, i) => (
            <polyline key={i} points={points.join(' ')} className="account-trend-line" />
          ))}
        {rows.map((row, i) =>
          row[metric] != null && Number.isFinite(row[metric]) ? (
            <circle
              key={row.date}
              cx={x(i)}
              cy={y(row[metric]!)}
              r={selected === i ? 4 : 3}
              className="account-trend-point"
              onPointerEnter={() => select(i)}
            >
              <title>{row.date + ' ' + label + ' ' + numberText(row[metric])}</title>
            </circle>
          ) : null,
        )}
        {rows.length > 0 && (
          <g className="account-trend-axis">
            <text x="48" y="153">
              {rows[0].date.slice(5)}
            </text>
            {rows.length > 1 && (
              <text x="334" y="153" textAnchor="end">
                {rows[rows.length - 1].date.slice(5)}
              </text>
            )}
          </g>
        )}
      </svg>
    </figure>
  );
}

export default function AccountTrend({
  trend,
  metrics = series,
}: {
  trend: TrendRow[];
  metrics?: readonly (readonly [Metric, string])[];
}) {
  const rows = [...trend].sort((a, b) => a.date.localeCompare(b.date));
  const [announcement, setAnnouncement] = useState('');
  return (
    <section className="account-trend" aria-label="近期趋势数据">
      <h2>近期趋势</h2>
      <div className="account-trend-grid">
        {metrics.map(([metric, label]) => (
          <TrendChart
            key={metric}
            rows={rows}
            metric={metric}
            label={label}
            announce={setAnnouncement}
          />
        ))}
      </div>
      <span
        className="account-trend-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>
    </section>
  );
}
