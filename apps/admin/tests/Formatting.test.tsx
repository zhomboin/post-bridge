import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import FormattingPanel from '../src/FormattingPanel';
import { FormattingDetail } from '../src/FormattingPages';
import { WorkspaceContext, type Api } from '../src/runtime';
import type { FormattingJob, FormattingOutput } from '../src/formatting-contract';
const output: FormattingOutput = {
  title: '格式化技术文章',
  summary: '原稿技术说明',
  markdown: '## 技术说明\n\n完整正文。',
  tags: ['技术'],
  body: '',
  topics: [],
  cover_title: '',
  cover_subtitle: '',
  cards: [],
  omissions: [],
  issues: [],
  assets: [],
};
const job: FormattingJob = {
  id: 'format-one',
  title: '原始技术文章',
  session_id: 'session-one',
  platform: 'csdn',
  operation: 'generate',
  edit_request_id: '',
  edit_fingerprint: '',
  status: 'succeeded',
  stage: 'finished',
  revision: 1,
  base_revision: 1,
  request_id: 'request-one',
  result: output,
  error_code: '',
  created_at: '',
  updated_at: '',
  prompt_version: '1',
  rules_version: '1',
  template: '',
  model: 'deepseek-flash',
  input_tokens: 100,
  output_tokens: 30,
  confirmed: false,
  confirmation_fingerprint: '',
};
const source = {
  account_id: 'csdn-main',
  snapshot: {
    title: '原始技术文章',
    body: '# 技术说明\n\n完整正文。',
    body_format: 'markdown',
    summary: '',
    tags: [],
  },
};
function workspace(child: React.ReactNode, handler: (path: string, init?: RequestInit) => unknown) {
  const api = vi.fn(async (path: string, init?: RequestInit) => handler(path, init)) as Api;
  render(
    <WorkspaceContext.Provider value={{ api, route: '/jobs/new', navigate: vi.fn() }}>
      {child}
    </WorkspaceContext.Provider>,
  );
  return api;
}
afterEach(() => vi.useRealTimers());
it('生成结果需明确采用，原稿不会在生成后自动替换', async () => {
  const adopted = vi.fn();
  const api = workspace(<FormattingPanel source={source} onAdopt={adopted} />, (path, init) => {
    if (path === '/api/formatting-capabilities') return { enabled: true, platforms: ['csdn'] };
    if (path === '/api/formatting-sessions') return { id: 'session-one' };
    if (path.endsWith('/jobs') && init?.method === 'POST') return job;
    if (path.endsWith('/adopt')) return { job: { ...job, status: 'adopted' } };
    return job;
  });
  fireEvent.click(await screen.findByRole('button', { name: '生成CSDN平台稿' }));
  await screen.findByRole('heading', { name: '格式化技术文章' });
  expect(adopted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '采用CSDN平台稿' }));
  expect(api).not.toHaveBeenCalledWith(expect.stringContaining('/adopt'), expect.anything());
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(adopted).toHaveBeenCalledWith(output, undefined));
  const session = vi.mocked(api).mock.calls.find(([path]) => path === '/api/formatting-sessions');
  expect(JSON.parse(String(session?.[1]?.body))).toMatchObject({
    allow_ai_processing: true,
    platforms: ['csdn'],
    snapshot: source.snapshot,
  });
});
it('来源未授权时不提交模型处理请求', async () => {
  const api = workspace(
    <FormattingPanel source={{ preparation_id: 'source', base_revision: 1 }} authorized={false} />,
    (path) =>
      path === '/api/formatting-capabilities'
        ? { enabled: true, platforms: ['csdn'] }
        : { items: [] },
  );
  const button = await screen.findByRole('button', { name: '生成CSDN平台稿' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('原稿变化后忽略迟到的会话响应', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const api = vi.fn(async (path: string) =>
    path === '/api/formatting-capabilities'
      ? { enabled: true, platforms: ['csdn'] }
      : path === '/api/formatting-sessions'
        ? pending
        : job,
  ) as Api;
  const wrapper = (title: string) => (
    <WorkspaceContext.Provider value={{ api, route: '/jobs/new', navigate: vi.fn() }}>
      <FormattingPanel source={{ ...source, snapshot: { ...source.snapshot, title } }} />
    </WorkspaceContext.Provider>
  );
  const rendered = render(wrapper('原始技术文章'));
  fireEvent.click(await screen.findByRole('button', { name: '生成CSDN平台稿' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/api/formatting-sessions', expect.anything()),
  );
  rendered.rerender(wrapper('另一篇技术文章'));
  resolve({ id: 'stale-session' });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '生成CSDN平台稿' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('stale-session/jobs'))).toBe(
    false,
  );
});
it('小红书编辑只重新排版并恢复轮询，界面没有上传或发布操作', async () => {
  const xhs: FormattingJob = {
    ...job,
    platform: 'xiaohongshu',
    template: 'technical',
    result: {
      ...output,
      markdown: '',
      summary: '',
      tags: [],
      title: '知识笔记',
      body: '保留原文条件。',
      cover_title: '知识笔记',
      cards: [
        { title: '要点', paragraphs: ['原文要点。'], code_refs: [], source_block_ids: ['source'] },
      ],
      assets: [
        {
          id: 'cover',
          sha256: 'a',
          width: 1080,
          height: 1440,
          url: '/api/formatting-assets/cover',
        },
        { id: 'page', sha256: 'b', width: 1080, height: 1440, url: '/api/formatting-assets/page' },
      ],
    },
  };
  let changed = false;
  let reads = 0;
  const api = workspace(<FormattingDetail id={xhs.id} />, (path, init) => {
    if (path === '/api/formatting-sessions/session-one')
      return { id: 'session-one', snapshot: source.snapshot, preparation_id: '' };
    if (init?.method === 'PUT') {
      changed = true;
      return { ...xhs, status: 'queued', revision: 2, operation: 'render' };
    }
    if (changed && reads++ === 0)
      return { ...xhs, status: 'running', revision: 2, operation: 'render' };
    return { ...xhs, revision: changed ? 2 : 1 };
  });
  await screen.findByRole('button', { name: '编辑图文' });
  expect(screen.queryByRole('button', { name: /发布|上传/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '编辑图文' }));
  fireEvent.change(screen.getByLabelText('笔记正文'), { target: { value: '人工核对的正文。' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并重新排版' }));
  await waitFor(() =>
    expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
  );
  await screen.findByRole('button', { name: '确认图文素材' }, { timeout: 4000 });
  expect(
    vi
      .mocked(api)
      .mock.calls.some(([path]) => path.endsWith('/jobs') && path.includes('/sessions/')),
  ).toBe(false);
});
