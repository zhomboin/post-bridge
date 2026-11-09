import { contentFixture } from './content-fixtures';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlatformAccount from '../src/PlatformAccount';
import { WorkspaceContext, type Api } from '../src/runtime';
import { useState } from 'react';
const account = (id: string, platform: string) => ({
  id,
  platform,
  username: id,
  display_name: platform === 'csdn' ? '合成 CSDN 作者' : '合成小红书作者',
  status: 'connected',
});
const response = {
  items: [
    { account: account('csdn-main', 'csdn') },
    { account: account('xhs-main', 'xiaohongshu') },
  ],
};
const listing = {
  items: [
    {
      id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      title: '合成小红书笔记',
      status: 'unknown',
      posted_at: '',
      views: null,
      likes: 0,
      comments: null,
      favorites: null,
    },
  ],
  total: 1,
  page: 1,
  page_size: 20,
  snapshot: { synced_at: '2026-11-08T01:00:00Z' },
  sync_job: null,
};
afterEach(() => vi.restoreAllMocks());
function Harness({ api, initial = '/account?account=xhs-main' }: { api: Api; initial?: string }) {
  const [route, navigate] = useState(initial);
  return (
    <WorkspaceContext.Provider
      value={{
        api: (async (path, init) => contentFixture(await api(path, init), 'xiaohongshu')) as Api,
        route,
        navigate,
      }}
    >
      <PlatformAccount />
    </WorkspaceContext.Provider>
  );
}
function apiMock() {
  return vi.fn(async (path: string) => {
    if (path === '/api/accounts') return response;
    if (path === '/api/accounts/xhs-main') return { account: account('xhs-main', 'xiaohongshu') };
    if (path.startsWith('/api/accounts/xhs-main/contents?')) return listing;
    if (path === '/api/account') return account('csdn-main', 'csdn');
    if (path.startsWith('/api/accounts/csdn-main/contents?'))
      return { items: [], total: 0, page: 1, page_size: 20, snapshot: null, sync_job: null };
    throw Error('未预期请求');
  });
}
describe('多平台账号工作台', () => {
  it('未配置账号的旧链接可以切回 CSDN，不显示旧笔记', async () => {
    const fallback = apiMock();
    const api = vi.fn(async (path: string) => {
      if (path === '/api/accounts') return { items: [response.items[0]] };
      return fallback(path);
    });
    render(<Harness api={api as Api} />);
    await screen.findByText('未找到平台账号');
    const picker = screen.getByRole('combobox', { name: '选择平台账号' });
    expect((picker as HTMLSelectElement).value).toBe('xhs-main');
    expect(screen.queryByText('合成小红书笔记')).toBeNull();
    fireEvent.change(picker, { target: { value: 'csdn-main' } });
    await screen.findByText('合成 CSDN 作者');
    expect(screen.getByRole('button', { name: '同步文章' })).toBeTruthy();
  });

  it('小红书仅展示只读能力，缺失统计不显示为零', async () => {
    const api = apiMock();
    render(<Harness api={api as Api} />);
    expect(await screen.findByText('合成小红书笔记')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('cell', { name: '状态待确认' })).toBeTruthy();
    expect(screen.queryByText('发布预设')).toBeNull();
    expect(screen.queryByText('远程登录')).toBeNull();
    expect(screen.queryByText('公开发布')).toBeNull();
    fireEvent.click(screen.getByText('账号设置'));
    expect(await screen.findByRole('button', { name: '检查登录状态' })).toBeTruthy();
    expect(
      api.mock.calls.some(([path]) => path.startsWith('/api/accounts/csdn-main/contents')),
    ).toBe(false);
  });
  it('账号切换清空旧列表，不把延迟请求显示到另一账号', async () => {
    const api = apiMock();
    render(<Harness api={api as Api} />);
    await screen.findByText('合成小红书笔记');
    fireEvent.change(screen.getByRole('combobox', { name: '选择平台账号' }), {
      target: { value: 'csdn-main' },
    });
    await screen.findByText('合成 CSDN 作者');
    expect(screen.queryByText('合成小红书笔记')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: '选择平台账号' }), {
      target: { value: 'xhs-main' },
    });
    await screen.findByText('合成小红书笔记');
  });
  it('同步动作绑定选中账号，失败仍保留快照', async () => {
    const fallback = apiMock();
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw Error('连接失败');
      return fallback(path);
    });
    render(<Harness api={api as Api} />);
    await screen.findByText('合成小红书笔记');
    fireEvent.click(screen.getByRole('button', { name: '同步笔记' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '连接失败');
    expect(screen.getByText('合成小红书笔记')).toBeTruthy();
    expect(api.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toBe(
      '/api/accounts/xhs-main/contents/sync',
    );
  });
});
