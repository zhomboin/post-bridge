import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import FormattingPanel from '../src/FormattingPanel';
import FormattingNew from '../src/FormattingNew';
import WechatFormatting from '../src/WechatFormatting';
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
it('仅启用本地转换时默认选择公众号并隐藏未启用的 AI 平台', async () => {
  workspace(<FormattingNew />, (path) =>
    path === '/api/formatting-capabilities'
      ? { enabled: false, local_enabled: true }
      : { items: [] },
  );
  expect(await screen.findByRole('option', { name: '微信公众号' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'CSDN' })).toBeNull();
  expect(await screen.findByRole('button', { name: '生成公众号本地稿' })).toBeTruthy();
});
it('公众号本地稿不要求 AI 授权，可查看并确认当前修订', async () => {
  const wechat: FormattingJob = {
    ...job,
    platform: 'wechat',
    result: {
      ...output,
      wechat: { blocks: [{ source_block_id: 'b0-demo', html: '<p>完整正文。</p>' }], issues: [] },
    },
  };
  const api = workspace(
    <FormattingPanel source={source} platforms={['wechat']} />,
    (path, init) => {
      if (path === '/api/formatting-capabilities')
        return { enabled: false, local_enabled: true, platforms: [] };
      if (path === '/api/formatting-sessions') return { id: 'session-one' };
      if (path.endsWith('/confirm')) return { ...wechat, status: 'adopted', confirmed: true };
      if (path.endsWith('/jobs') && init?.method === 'POST') return wechat;
      return wechat;
    },
  );
  fireEvent.click(await screen.findByRole('button', { name: '生成公众号本地稿' }));
  expect((await screen.findByTitle('公众号本地稿预览')).getAttribute('sandbox')).toBe('');
  const session = vi.mocked(api).mock.calls.find(([path]) => path === '/api/formatting-sessions');
  expect(JSON.parse(String(session?.[1]?.body))).toMatchObject({
    allow_ai_processing: false,
    platforms: ['wechat'],
  });
  fireEvent.click(screen.getByRole('button', { name: '确认本地稿' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/api/formatting-jobs/format-one/confirm',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ revision: 1 }) }),
    ),
  );
});
it('公众号存在阻断问题时保留预览并不允许确认', async () => {
  const wechat: FormattingJob = {
    ...job,
    platform: 'wechat',
    status: 'needs_review',
    result: {
      ...output,
      wechat: {
        blocks: [{ source_block_id: 'b0-demo', html: '<p>部分正文</p>' }],
        issues: [
          { code: 'image_unavailable', field: 'b0-demo', message: '图片需要核对', blocking: true },
        ],
      },
    },
  };
  workspace(<FormattingPanel source={source} platforms={['wechat']} />, (path, init) => {
    if (path === '/api/formatting-capabilities')
      return { enabled: false, local_enabled: true, platforms: [] };
    if (path === '/api/formatting-sessions') return { id: 'session-one' };
    if (path.endsWith('/jobs') && init?.method === 'POST') return wechat;
    return wechat;
  });
  fireEvent.click(await screen.findByRole('button', { name: '生成公众号本地稿' }));
  expect(await screen.findByText(/图片需要核对/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '确认本地稿' })).toBeNull();
});
it('编辑公众号候选并选择本地素材后提交新修订', async () => {
  const wechat: FormattingJob = {
    ...job,
    platform: 'wechat',
    status: 'needs_review',
    result: {
      ...output,
      wechat: {
        blocks: [{ source_block_id: 'b0-sample', html: '<p>正文</p>' }],
        issues: [],
        candidate_markdown: '原始正文',
        images: [
          {
            id: 'b0-sample:0',
            source_block_id: 'b0-sample',
            source: 'https://example.test/a.png',
            alt: '合成图',
          },
        ],
      },
    },
  };
  const api = workspace(
    <FormattingPanel source={source} platforms={['wechat']} />,
    (path, init) => {
      if (path === '/api/formatting-capabilities') return { enabled: false, local_enabled: true };
      if (path === '/api/formatting-sessions') return { id: 'session-one' };
      if (path.endsWith('/wechat') && init?.method === 'PUT')
        return { ...wechat, revision: 2, operation: 'wechat_edit', status: 'queued' };
      return wechat;
    },
  );
  fireEvent.click(await screen.findByRole('button', { name: '生成公众号本地稿' }));
  fireEvent.click(await screen.findByRole('button', { name: '编辑候选稿' }));
  fireEvent.change(screen.getByLabelText('候选稿 Markdown'), { target: { value: '修改后的正文' } });
  fireEvent.change(screen.getByLabelText('选择第 1 张图片'), {
    target: { files: [new File(['synthetic'], 'example.png', { type: 'image/png' })] },
  });
  await screen.findByRole('button', { name: '移除第 1 张素材' });
  expect(screen.queryByRole('button', { name: '确认本地稿' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存并重新排版' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      '/api/formatting-jobs/format-one/wechat',
      expect.objectContaining({ method: 'PUT' }),
    ),
  );
  const request = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/wechat'));
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
    revision: 1,
    markdown: '修改后的正文',
    attachments: [{ image_id: 'b0-sample:0', data: 'c3ludGhldGlj' }],
  });
});
it('编辑公众号候选时不能确认尚未保存的内容', async () => {
  const wechat: FormattingJob = {
    ...job,
    platform: 'wechat',
    result: {
      ...output,
      wechat: {
        blocks: [{ source_block_id: 'b0', html: '<p>原文</p>' }],
        issues: [],
        candidate_markdown: '原文',
      },
    },
  };
  workspace(<FormattingPanel source={source} platforms={['wechat']} />, (path) => {
    if (path === '/api/formatting-capabilities') return { enabled: false, local_enabled: true };
    if (path === '/api/formatting-sessions') return { id: 'session-one' };
    return wechat;
  });
  fireEvent.click(await screen.findByRole('button', { name: '生成公众号本地稿' }));
  fireEvent.click(await screen.findByRole('button', { name: '编辑候选稿' }));
  expect(screen.queryByRole('button', { name: '确认本地稿' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
  expect(screen.getByRole('button', { name: '确认本地稿' })).toBeTruthy();
});
it('公众号原稿信息迟到时不覆盖正在编辑的候选稿', () => {
  const wechat: FormattingJob = {
    ...job,
    platform: 'wechat',
    result: {
      ...output,
      wechat: {
        blocks: [{ source_block_id: 'b0', html: '<p>原文</p>' }],
        issues: [],
        candidate_markdown: '原文',
      },
    },
  };
  const api = vi.fn() as Api;
  const view = (original: string) => (
    <WorkspaceContext.Provider value={{ api, route: '/formatting/sample', navigate: vi.fn() }}>
      <WechatFormatting job={wechat} onChange={vi.fn()} originalMarkdown={original} />
    </WorkspaceContext.Provider>
  );
  const rendered = render(view(''));
  fireEvent.click(screen.getByRole('button', { name: '编辑候选稿' }));
  fireEvent.change(screen.getByLabelText('候选稿 Markdown'), { target: { value: '正在修改' } });
  rendered.rerender(view('迟到的原稿'));
  expect((screen.getByLabelText('候选稿 Markdown') as HTMLTextAreaElement).value).toBe('正在修改');
});
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
