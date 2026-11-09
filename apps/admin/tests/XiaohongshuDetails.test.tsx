import { contentFixture } from './content-fixtures';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import PlatformAccount from '../src/PlatformAccount';
import NoteDetail from '../src/NoteDetail';
import { WorkspaceContext, type Api } from '../src/runtime';
import { platformMediaURL } from '../src/platform-media';

const id = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const note = {
  id,
  title: '合成图文',
  status: 'published',
  posted_at: '2026-11-01T00:00:00Z',
  type: 'image',
  views: 0,
  likes: 1,
  comments: null,
  favorites: null,
  cover_urls: ['https://sns-webpic-qc.xhscdn.com/cover.jpg'],
  note_url: 'https://www.xiaohongshu.com/explore/' + id,
};
const profile = {
  nickname: '合成昵称',
  avatar_url: 'https://img.xiaohongshu.com/avatar/test.jpg',
  description: '合成简介',
  following: 2,
  followers: 0,
  liked_and_collected: 3,
};
const snapshot = {
  synced_at: '2026-11-08T00:00:00Z',
  profile,
  stats: {
    begin_at: '2026-11-01T00:00:00Z',
    end_at: '2026-11-07T00:00:00Z',
    published: 1,
    views: 0,
    likes: 2,
    comments: null,
    favorites: null,
    shares: 1,
    exposures: 3,
    net_followers: -1,
  },
  trend: [],
};
function Harness({ api, detail = false }: { api: Api; detail?: boolean }) {
  const [route, navigate] = useState(
    detail
      ? '/notes/' + id + '?account=xhs&back=' + encodeURIComponent('/account?account=xhs&page=2')
      : '/account?account=xhs',
  );
  return (
    <WorkspaceContext.Provider
      value={{
        api: (async (path, init) => contentFixture(await api(path, init), 'xiaohongshu')) as Api,
        route,
        navigate,
      }}
    >
      {detail ? <NoteDetail id={id} account="xhs" /> : <PlatformAccount />}
    </WorkspaceContext.Provider>
  );
}
afterEach(() => vi.restoreAllMocks());
describe('小红书资料和详情', () => {
  it('头像、昵称、简介、封面与独立详情链接，统计按固定周期展示', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/api/accounts')
        return {
          items: [
            {
              account: {
                id: 'xhs',
                platform: 'xiaohongshu',
                username: 'synthetic',
                display_name: '导入名',
                status: 'connected',
              },
            },
          ],
        };
      if (path === '/api/accounts/xhs')
        return { account: { id: 'xhs', platform: 'xiaohongshu', status: 'connected' } };
      if (path.startsWith('/api/accounts/xhs/contents?'))
        return { items: [note], total: 1, page: 1, page_size: 20, snapshot, sync_job: null };
      throw Error('unexpected');
    });
    render(<Harness api={api as Api} />);
    await screen.findByRole('heading', { name: '合成昵称' });
    expect(screen.getByText('合成简介')).toBeTruthy();
    expect(screen.getByRole('img', { name: '账号头像' }).getAttribute('referrerpolicy')).toBe(
      'no-referrer',
    );
    expect(screen.getByRole('link', { name: '合成图文' }).getAttribute('href')).toContain(
      '/notes/' + id + '?account=xhs',
    );
    expect(screen.getByRole('img', { name: '笔记封面' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '数据统计' }));
    await screen.findByRole('heading', { name: '数据统计' });
    expect(screen.getByText('近 7 日')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '净增粉丝' })).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
    expect(screen.queryByText('公开发布')).toBeNull();
  });
  it('正文按文本展示，拒绝外域图片，读取失败保留已缓存正文和返回筛选', async () => {
    const data = {
      note,
      body: {
        id,
        title: '合成图文',
        text: '<script>不能执行</script>\n只读正文',
        images: ['https://sns-webpic-qc.xhscdn.com/body.jpg', 'https://evil.test/pixel'],
        tags: ['合成话题'],
      },
      fetched_at: '2026-11-09T00:00:00Z',
      read_job: { id: 'failed', status: 'failed', error_message: '读取失败' },
    };
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw Error('网络失败');
      return data;
    });
    render(<Harness detail api={api as Api} />);
    expect(await screen.findByText(/不能执行/)).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    fireEvent.error(screen.getByRole('img', { name: '笔记图片 1' }));
    expect(screen.getByText('图片暂不可用')).toBeTruthy();
    expect(screen.getByRole('link', { name: '返回笔记' }).getAttribute('href')).toBe(
      '/account?account=xhs&page=2',
    );
    fireEvent.click(screen.getByRole('button', { name: '重新读取正文' }));
    await screen.findByRole('alert');
    expect(screen.getByText(/只读正文/)).toBeTruthy();
  });
  it('首次缺失正文只发起一次读取，失败任务不自动循环', async () => {
    let reads = 0;
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        reads++;
        return { id: 'read', status: 'queued' };
      }
      return {
        note,
        body: null,
        fetched_at: null,
        read_job: reads ? { id: 'read', status: 'failed', error_message: '结构变化' } : null,
      };
    });
    render(<Harness detail api={api as Api} />);
    await screen.findByText('正文读取失败');
    await waitFor(() => expect(reads).toBe(1));
    expect(api.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toBe(
      '/api/accounts/xhs/contents/' + id + '/read',
    );
  });
  it('拒绝伪装域、明文和带凭据媒体地址', () => {
    for (const value of [
      'http://img.xiaohongshu.com/a',
      'https://img.xiaohongshu.com.evil.test/a',
      'https://u@img.xiaohongshu.com/a',
      'https://evil.test/a',
    ])
      expect(platformMediaURL(value, 'xiaohongshu')).toBeUndefined();
  });
});
