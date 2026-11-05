import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';

const presetPath = '/api/account/csdn-publish-preset';
const draftPath = '/api/integration-preparations/prep-one';
const options = {
  tags: ['默认标签'], summary: '', categories: [], article_type: 'original',
  creation_declaration: 'none', visibility: 'public', template: 'default', cover_image_url: '',
};
const preset = { revision: 2, options, available_categories: ['技术专栏', '数据库', '工程', '前端'] };
const preparation = {
  id: 'prep-one', source_id: 'cms', article_id: 'article-one', source_version: 1, revision: 1,
  confirmed: false, status: 'prepared', expires_at: '2099-01-01T00:00:00Z',
  snapshot: { title: '原稿标题', summary: '来源摘要', body: '来源正文', tags: ['来源标签'] },
  drafts: [{ id: 'draft-one', platform: 'csdn', account_id: 'csdn-main', operation: 'save_draft',
    title: '平台标题', markdown: '平台正文', revision: 1,
    publish_options: { ...options, tags: ['来源标签'], summary: '来源摘要' } }],
};
const response = (value: unknown) => new Response(JSON.stringify(value));

afterEach(() => vi.unstubAllGlobals());

function openPage(path: string, fixture: typeof preparation & { preview_image_urls?: string[] } = preparation) {
  window.history.replaceState({}, '', path);
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (raw: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      writes.push({ url: raw, body });
      if (raw === presetPath) return response({ ...preset, revision: 3, options: body.options });
      if (raw === draftPath) return response({ ...preparation, revision: 2, drafts: body.drafts });
    }
    if (raw === '/api/session') return response({ user: { username: '管理员' }, csrf_token: 'csrf' });
    if (raw === '/api/account') return response({ id: 'csdn-main', platform: 'csdn', status: 'connected' });
    if (raw === presetPath) return response(preset);
    if (raw === draftPath) return response(fixture);
    return response({ items: [] });
  }));
  render(<App />);
  return writes;
}

it('账号设置显式保存发布预设', async () => {
  const writes = openPage('/account?tab=settings');
  const tags = await screen.findByLabelText('标签（每行一个）');
  fireEvent.change(tags, { target: { value: '新默认标签' } });
  fireEvent.change(screen.getByLabelText('添加专栏'), { target: { value: '技术专栏' } });
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '保存发布预设' }));
  await screen.findByText('已保存发布预设');
  expect(writes).toEqual([{ url: presetPath, body: { revision: 2, options: {
    ...options, tags: ['新默认标签'], categories: ['技术专栏'],
  } } }]);
});

it('平台稿覆盖进入新修订且保持账号预设独立', async () => {
  const writes = openPage('/integration-preparations/prep-one');
  expect((await screen.findByLabelText('标签（每行一个）') as HTMLTextAreaElement).value).toBe('来源标签');
  const summary = screen.getByLabelText('摘要');
  fireEvent.change(summary, { target: { value: '文'.repeat(257) } });
  fireEvent.click(screen.getByRole('button', { name: '保存新修订' }));
  await screen.findByText('摘要最多 256 个字符。');
  expect(writes).toHaveLength(0);
  fireEvent.change(summary, { target: { value: '本篇摘要' } });
  fireEvent.change(screen.getByLabelText('可见范围'), { target: { value: 'fans' } });
  expect((screen.getByRole('button', { name: '确认平台稿' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '保存新修订' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].url).toBe(draftPath);
  expect(writes[0].body).toMatchObject({
    revision: 1, drafts: [{ publish_options: { tags: ['来源标签'], summary: '本篇摘要', visibility: 'fans' } }],
  });
});

it('预览只展示已批准的原图链接且不会自动请求图片', async () => {
  const approved = 'https://images.example.test/album/approved.webp';
  const pasted = 'https://images.example.test/album/other.webp';
  openPage('/integration-preparations/prep-one', {
    ...preparation,
    preview_image_urls: [approved],
    snapshot: { ...preparation.snapshot, body: `![来源图片](${approved})` },
  });
  const editor = await screen.findByLabelText('平台 Markdown 正文');
  fireEvent.change(editor, { target: { value: `![允许图片](${approved})\n\n![未批准](${pasted})\n\n<img src="http://127.0.0.1/private">` } });
  fireEvent.click(screen.getByRole('button', { name: '预览' }));
  const imageLink = screen.getByRole('link', { name: '允许图片' });
  expect(imageLink.getAttribute('href')).toBe(approved);
  expect(imageLink.getAttribute('rel')).toContain('noreferrer');
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByRole('link', { name: '未批准' })).toBeNull();
});

it('选满三个专栏后允许移除再添加', async () => {
  openPage('/account?tab=settings');
  const categories = await screen.findByLabelText<HTMLSelectElement>('添加专栏');
  for (const value of ['技术专栏', '数据库', '工程']) fireEvent.change(categories, { target: { value } });
  expect(categories.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '移除专栏 工程' }));
  expect(categories.disabled).toBe(false);
  fireEvent.change(categories, { target: { value: '前端' } });
  expect(categories.disabled).toBe(true);
});
