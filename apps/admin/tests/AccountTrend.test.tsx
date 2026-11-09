import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AccountTrend from '../src/AccountTrend';
const row = (date: string, views: number | null) => ({
  date,
  views,
  comments: null,
  favorites: 0,
  followers: -2,
  promotion_clicks: null,
  outlink_clicks: null,
});

describe('账号趋势', () => {
  it('默认展示全部六项图表，日期有序且键盘可逐日读取值', () => {
    render(
      <AccountTrend trend={[row('2026-11-03', 20), row('2026-11-01', 10), row('2026-11-02', 0)]} />,
    );
    const region = screen.getByRole('region', { name: '近期趋势数据' });
    expect(within(region).getAllByRole('img')).toHaveLength(6);
    const graph = screen.getByRole('img', { name: '阅读趋势' });
    expect(graph.getAttribute('tabindex')).toBe('0');
    fireEvent.focus(graph);
    expect(screen.getByRole('status').textContent).toContain('2026-11-03 阅读 20');
    fireEvent.keyDown(graph, { key: 'Home' });
    expect(screen.getByRole('status').textContent).toContain('2026-11-01 阅读 10');
    fireEvent.keyDown(graph, { key: 'ArrowRight' });
    expect(screen.getByRole('status').textContent).toContain('2026-11-02 阅读 0');
    fireEvent.keyDown(graph, { key: 'End' });
    expect(screen.getByRole('status').textContent).toContain('2026-11-03 阅读 20');
  });
  it('缺失值不补零且不跨空值连线，负值和零保留', () => {
    render(
      <AccountTrend
        trend={[
          row('2026-11-01', 3),
          row('2026-11-02', null),
          row('2026-11-03', -3),
          row('2026-11-04', 0),
        ]}
      />,
    );
    const graph = screen.getByRole('img', { name: '阅读趋势' });
    expect(graph.querySelectorAll('circle')).toHaveLength(3);
    expect(graph.querySelectorAll('polyline')).toHaveLength(1);
    expect(graph.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(2);
    fireEvent.keyDown(graph, { key: 'Home' });
    fireEvent.keyDown(graph, { key: 'ArrowRight' });
    expect(screen.getByRole('status').textContent).toContain('2026-11-02 阅读 暂无数据');
    fireEvent.keyDown(screen.getByRole('img', { name: '粉丝趋势' }), { key: 'Home' });
    expect(screen.getByRole('status').textContent).toContain('粉丝 -2');
  });
  it('单点有可读圆点，全空仍显示六项空图', () => {
    const { rerender } = render(<AccountTrend trend={[row('2026-11-01', 0)]} />);
    expect(screen.getByRole('img', { name: '阅读趋势' }).querySelectorAll('circle')).toHaveLength(
      1,
    );
    rerender(<AccountTrend trend={[]} />);
    expect(screen.getAllByRole('img')).toHaveLength(6);
    expect(screen.getAllByText('暂无趋势数据', { selector: 'figcaption > span' })).toHaveLength(6);
  });
});

describe('趋势缺失数据', () => {
  it('省略日期保持空隙，六项各用独立刻度', () => {
    render(<AccountTrend trend={[row('2026-11-01', 10000), row('2026-11-03', 20000)]} />);
    const graph = screen.getByRole('img', { name: '阅读趋势' });
    expect(graph.querySelector('polyline')).toBeNull();
    expect(graph.textContent).toContain('2万');
    const followers = screen.getByRole('img', { name: '粉丝趋势' });
    expect(followers.textContent).toContain('-2');
    expect(followers.textContent).not.toContain('2万');
  });
  it('有日期但全部空值时不生成虚构数据点', () => {
    const empty = {
      date: '2026-11-01',
      views: null,
      comments: null,
      favorites: null,
      followers: null,
      promotion_clicks: null,
      outlink_clicks: null,
    };
    const { container } = render(<AccountTrend trend={[empty]} />);
    expect(screen.getAllByRole('img')).toHaveLength(6);
    expect(container.querySelectorAll('circle, polyline')).toHaveLength(0);
    fireEvent.focus(screen.getByRole('img', { name: '阅读趋势' }));
    expect(screen.getByRole('status').textContent).toContain('2026-11-01 阅读 暂无数据');
  });
});

it('零值曲线位于清晰的零刻度且刻度互不重复', () => {
  render(<AccountTrend trend={[row('2026-11-01', 0), row('2026-11-02', 0)]} />);
  const graph = screen.getByRole('img', { name: '阅读趋势' });
  const ticks = [...graph.querySelectorAll('g.account-trend-axis text')]
    .slice(0, 3)
    .map((tick) => tick.textContent);
  expect(new Set(ticks).size).toBe(3);
  expect(graph.querySelector('circle')!.getAttribute('cy')).toBe('76');
});
