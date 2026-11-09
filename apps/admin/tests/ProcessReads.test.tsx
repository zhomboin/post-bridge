import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App';

const stamp = '2026-11-04T02:00:00Z';
let kind = 'sync_articles';
let calls: string[];
beforeEach(() => {
  calls = [];
  kind = 'sync_articles';
  window.history.replaceState({}, '', '/logs');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      calls.push(path);
      const job = {
        id: 'read-process',
        title: '',
        kind,
        article_id: kind === 'read_article' ? '12345' : undefined,
        platform: 'csdn',
        account_id: 'csdn-main',
        status: 'succeeded',
        outcome: 'not_submitted',
        stage: 'finished',
        created_at: stamp,
        updated_at: stamp,
      };
      const body =
        path === '/api/session'
          ? { user: { username: '管理员' }, csrf_token: 'test' }
          : path.startsWith('/api/processes?')
            ? {
                items: [
                  {
                    ...job,
                    object_type: kind === 'sync_articles' ? 'account' : 'article',
                    object_id: kind === 'sync_articles' ? 'csdn-main' : '12345',
                    object_name: kind === 'sync_articles' ? '平台账号' : '只读文章',
                    event_count: 1,
                    error_count: 0,
                    warning_count: 0,
                  },
                ],
                total: 1,
                page: 1,
                page_size: 50,
              }
            : path === '/api/jobs/read-process'
              ? job
              : path.includes('/history?')
                ? {
                    items: [
                      {
                        id: 1,
                        stage: 'finished',
                        status: 'succeeded',
                        level: 'info',
                        message: '读取完成',
                        created_at: stamp,
                      },
                    ],
                    transitions: [],
                    total: 1,
                  }
                : {};
      return new Response(JSON.stringify(body));
    }),
  );
});

it.each([
  ['sync_articles', '同步文章', '文章同步完成', '账号', 'csdn-main'],
  ['read_article', '读取正文', '正文读取完成', '文章', '12345'],
])('处理列表和操作筛选正确支持%s', async (value, operation, outcome, objectType, objectID) => {
  kind = value;
  render(<App />);
  const action = await screen.findByRole('option', { name: operation });
  expect(action.getAttribute('value')).toBe(value);
  const row = (
    await within(await screen.findByRole('table')).findByRole('link', {
      name: value === 'sync_articles' ? '平台账号' : '只读文章',
    })
  ).closest('tr')!;
  expect(within(row).getByText(operation)).toBeTruthy();
  expect(within(row).getByText(outcome)).toBeTruthy();
  expect(within(row).getByText(objectType)).toBeTruthy();
  expect(within(row.cells[0]).getByText(objectID)).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '操作' }), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '查询' }));
  await waitFor(() =>
    expect(
      calls.some(
        (path) =>
          path.startsWith('/api/processes?') &&
          new URL(path, 'http://local').searchParams.get('kind') === value,
      ),
    ).toBe(true),
  );
});

it.each([
  ['sync_articles', '同步文章', '文章同步完成', 'csdn-main'],
  ['read_article', '读取正文', '正文读取完成', '12345'],
])('处理详情正确支持%s且保留时间线', async (value, operation, outcome, objectID) => {
  kind = value;
  window.history.replaceState({}, '', '/logs/read-process?back=%2Flogs%3Fkind%3D' + value);
  render(<App />);
  await screen.findByText(outcome);
  expect(screen.getByText(operation)).toBeTruthy();
  expect(screen.getByText('对象标识').nextElementSibling?.textContent).toBe(objectID);
  expect(screen.queryByRole('button', { name: '查看内容变更' })).toBeNull();
  expect(screen.queryByText('尚未保存到CSDN')).toBeNull();
  expect(await screen.findByText('读取完成')).toBeTruthy();
  expect(screen.getByRole('link', { name: '返回处理记录' }).getAttribute('href')).toBe(
    '/logs?kind=' + value,
  );
  fireEvent.click(screen.getByRole('link', { name: '任务详情' }));
  expect(await screen.findByRole('link', { name: '返回处理详情' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '查看内容变更' })).toBeNull();
});
