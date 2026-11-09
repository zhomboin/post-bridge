import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App';
import { Workflow } from '../src/ProcessTimeline';

const stamp = '2026-11-04T02:00:00Z';
const job = {
  id: 'process-1',
  title: '需要更新的技术文章',
  kind: 'save_draft',
  platform: 'csdn',
  account_id: 'csdn-main',
  status: 'succeeded',
  outcome: 'draft_saved',
  stage: 'finished',
  attempts: 2,
  created_at: stamp,
  updated_at: stamp,
  remote_id: '123',
  markdown: '任务期望正文',
};
const events = [
  {
    id: 1,
    job_id: job.id,
    attempt: 0,
    level: 'info',
    stage: 'queued',
    status: 'queued',
    run_mode: 'execute',
    message: '任务已加入队列',
    created_at: stamp,
  },
  {
    id: 2,
    job_id: job.id,
    attempt: 1,
    level: 'warning',
    stage: 'saving',
    status: 'reconciling',
    run_mode: 'execute',
    message: '平台结果尚未确认',
    created_at: stamp,
  },
  {
    id: 3,
    job_id: job.id,
    attempt: 2,
    level: 'info',
    stage: 'finished',
    status: 'succeeded',
    outcome: 'draft_saved',
    run_mode: 'reconcile',
    message: '执行器已上报任务结果',
    created_at: stamp,
  },
];
let snapshots: object[];
let calls: string[];
let account = false;
beforeEach(() => {
  calls = [];
  account = false;
  window.history.replaceState({}, '', '/logs');
  snapshots = [
    {
      id: 1,
      attempt: 1,
      phase: 'before',
      object_type: 'article',
      title: '处理前标题',
      markdown: '第一行\n旧的文字',
      status: 'editor',
      captured_at: stamp,
    },
    {
      id: 2,
      attempt: 2,
      phase: 'after',
      object_type: 'article',
      title: '处理后标题',
      markdown: '第一行\n新的文字<script>示例</script>',
      status: '2',
      remote_id: '123',
      captured_at: stamp,
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      calls.push(path);
      const summary = {
        ...job,
        markdown: undefined,
        object_type: 'article',
        object_id: '123',
        object_name: job.title,
        account_name: '测试平台账号',
        event_count: 3,
        warning_count: 1,
        error_count: 0,
      };
      const body =
        path === '/api/session'
          ? { user: { username: '管理员' }, csrf_token: 'test' }
          : path.startsWith('/api/processes?')
            ? {
                items: [
                  summary,
                  { ...summary, id: 'process-2', updated_at: '2026-11-04T03:00:00Z' },
                ],
                total: 2,
                page: 1,
                page_size: 50,
              }
            : path === '/api/jobs/process-1'
              ? account
                ? { ...job, kind: 'check_account', title: '', markdown: '' }
                : job
              : path.startsWith('/api/jobs/process-1/history?')
                ? { items: [events[0]], transitions: events, total: 3, page: 1, page_size: 50 }
                : path.startsWith('/api/jobs/process-1/changes')
                  ? {
                      submitted: { title: job.title, markdown: job.markdown },
                      snapshots,
                      attempts: [1, 2],
                      content_retained: snapshots.length > 0,
                    }
                  : path.startsWith('/api/logs?')
                    ? { items: [], total: 0, page: 1, page_size: 50 }
                    : {};
      if (path.includes('/history?')) await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

it('默认以对象一次处理为行，同一对象的两次处理保持两条记录', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: '处理记录' });
  const records = await screen.findAllByRole('link', { name: job.title });
  expect(records).toHaveLength(2);
  expect(records.map((link) => link.getAttribute('href'))).toEqual(
    expect.arrayContaining([
      expect.stringContaining('/logs/process-1'),
      expect.stringContaining('/logs/process-2'),
    ]),
  );
  const rows = screen.getAllByRole('row').slice(1);
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByText('测试平台账号')).toBeTruthy();
  expect(within(rows[0]).getByText('CSDN')).toBeTruthy();
  expect(within(rows[0]).getByText('草稿已保存')).toBeTruthy();
  expect(calls.some((path) => path.startsWith('/api/logs?'))).toBe(false);
});

it('处理详情状态图使用完整流转而非当前日志分页，并保留重试与只读核对', async () => {
  window.history.replaceState({}, '', '/logs/process-1?back=%2Flogs%3Fstatus%3Dfailed');
  render(<App />);
  const graph = await screen.findByRole('region', { name: '状态流转' });
  expect(within(graph).queryByText('状态未采集')).toBeNull();
  await within(graph).findByText('待核对');
  expect(within(graph).getAllByText('执行完成').length).toBeGreaterThan(0);
  expect(within(graph).getByText('只读核对')).toBeTruthy();
  expect(screen.getByRole('link', { name: '返回处理记录' }).getAttribute('href')).toBe(
    '/logs?status=failed',
  );
  expect(await screen.findByText('任务已加入队列')).toBeTruthy();
});

it('按实际快照展示标题正文前后差异，任务期望正文不会充当平台实际值', async () => {
  window.history.replaceState({}, '', '/logs/process-1');
  const { container } = render(<App />);
  await screen.findByRole('heading', { name: job.title });
  fireEvent.click(await screen.findByRole('button', { name: '查看内容变更' }));
  const comparison = await screen.findByRole('region', { name: '内容变更' });
  await waitFor(() => expect(comparison.textContent).toContain('处理前标题'));
  expect(comparison.textContent).toContain('处理后标题');
  expect(comparison.textContent).toContain('旧的文字');
  expect(comparison.textContent).toContain('新的文字<script>示例</script>');
  expect(comparison.textContent).not.toContain('任务期望正文');
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelectorAll('mark').length).toBeGreaterThan(0);
});

it('缺少处理前后快照时明确未采集，不生成虚假内容变化', async () => {
  snapshots = [];
  window.history.replaceState({}, '', '/logs/process-1');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '查看内容变更' }));
  const comparison = await screen.findByRole('region', { name: '内容变更' });
  expect(within(comparison).getAllByText('未采集').length).toBeGreaterThanOrEqual(2);
  expect(comparison.textContent).not.toContain('任务期望正文');
});

it('未采集的账号检查仍显示账号字段，不误报过期或显示文章字段', async () => {
  account = true;
  snapshots = [];
  window.history.replaceState({}, '', '/logs/process-1');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '查看内容变更' }));
  const comparison = screen.getByRole('region', { name: '内容变更' });
  await within(comparison).findByText('连接状态');
  expect(within(comparison).queryByText('标题')).toBeNull();
  expect(within(comparison).queryByText('正文')).toBeNull();
  expect(comparison.textContent).not.toContain('到保留期限');
});

it('实际空标题正文显示空值，不能误标为未采集', async () => {
  snapshots = [
    {
      id: 1,
      attempt: 1,
      phase: 'before',
      object_type: 'article',
      title: '',
      markdown: '',
      status: 'editor',
      captured_at: stamp,
    },
  ];
  window.history.replaceState({}, '', '/logs/process-1');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '查看内容变更' }));
  const comparison = screen.getByRole('region', { name: '内容变更' });
  await within(comparison).findAllByText('（空）');
  expect(within(comparison).getAllByText('（空）')).toHaveLength(2);
});

it('保存转入核对时只标记实际核对节点，不把本轮写操作标为只读', () => {
  const mixed = [
    {
      ...events[0],
      id: 'writing',
      attempt: 1,
      status: 'running',
      stage: 'filling',
      run_mode: 'execute',
    },
    {
      ...events[1],
      id: 'checking',
      attempt: 1,
      status: 'reconciling',
      stage: 'saving',
      run_mode: 'reconcile',
    },
  ];
  render(<Workflow events={mixed} />);
  const mode = screen.getByText('只读核对');
  expect(mode.closest('li')?.textContent).toContain('待核对');
  expect(mode.closest('li')?.textContent).not.toContain('填写正文');
  expect(screen.getByRole('heading', { name: '第 1 次执行' }).textContent).not.toContain(
    '只读核对',
  );
});

it('已有事件缺少状态时仍展示实际记录的步骤，不补造终结状态', () => {
  render(
    <Workflow
      events={events.map((event) => ({ ...event, status: '', outcome: '', run_mode: '' }))}
    />,
  );
  expect(screen.getByText('部分状态未采集')).toBeTruthy();
  expect(screen.getByText('等待执行')).toBeTruthy();
  expect(screen.getByText('保存草稿')).toBeTruthy();
  expect(screen.getByText('处理结束')).toBeTruthy();
  expect(screen.queryByText('执行完成')).toBeNull();
  expect(screen.queryByText('只读核对')).toBeNull();
});
