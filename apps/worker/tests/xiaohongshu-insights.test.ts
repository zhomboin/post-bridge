import { describe, expect, it } from 'vitest';
import { profilePayload, statsPayload, xhsImageURL } from '../src/xiaohongshu-insights.js';
import { notesPayload } from '../src/xiaohongshu-model.js';
import { noteBodyPayload } from '../src/xiaohongshu-detail.js';
import { xiaohongshuRequestAllowed } from '../src/xiaohongshu-network.js';

const id = 'bbbbbbbbbbbbbbbbbbbbbbbb',
  user = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const payload = (data: unknown) => ({ success: true, code: 0, data });
describe('小红书账号、统计和正文', () => {
  it('账号字段只保留展示信息，不包含手机等私有认证字段', () => {
    const profile = profilePayload(
      payload({
        red_num: 'synthetic',
        name: '合成作者',
        avatar: 'https://img.xiaohongshu.com/avatar/test.jpg',
        personal_desc: '简介',
        fans_count: 0,
        phone: 'never-export',
      }),
      'synthetic',
    );
    expect(profile).toMatchObject({ nickname: '合成作者', followers: 0, following: null });
    expect(JSON.stringify(profile)).not.toContain('never-export');
    expect(() => profilePayload(payload({ red_num: 'other' }), 'synthetic')).toThrow(
      'account_mismatch',
    );
  });
  it('按官方非空卡片字段解析，时间使用毫秒并保留未知状态', () => {
    const note = notesPayload(
      payload({
        notes: [
          {
            id,
            display_title: '图文笔记',
            time: 1793980800000,
            tab_status: 1,
            type: 'normal',
            images_list: [{ url: 'https://sns-webpic-qc.xhscdn.com/synthetic.jpg' }],
            view_count: 12,
            collected_count: 3,
            comments_count: 0,
            shared_count: 1,
          },
        ],
        page: -1,
      }),
    ).items[0];
    expect(note).toMatchObject({
      title: '图文笔记',
      type: 'image',
      status: 'published',
      views: 12,
      comments: 0,
      favorites: 3,
      shares: 1,
      likes: null,
      posted_at: '2026-11-06T16:00:00.000Z',
    });
    for (const [value, status] of [
      [2, 'reviewing'],
      [3, 'rejected'],
      [4, 'unknown'],
      [99, 'unknown'],
    ] as const)
      expect(
        notesPayload(
          payload({ notes: [{ id, display_title: '测试', tab_status: value }], page: -1 }),
        ).items[0].status,
      ).toBe(status);
  });
  it('七日指标不冒充累计值，净增允许负数、缺失不补零，日期转北京时间', () => {
    const d = {
      begin_time: 1793462400000,
      end_time: 1793980800000,
      view_count: 0,
      net_rise_fans_count: -2,
      view_list: [{ date: 1793980800000, count: 0 }],
    };
    const result = statsPayload(payload({ seven: d }));
    expect(result.stats).toMatchObject({ views: 0, likes: null, net_followers: -2 });
    expect(result.trend[0]).toMatchObject({
      date: '2026-11-07',
      views: 0,
      likes: null,
      followers: null,
    });
    expect(() => statsPayload(payload({ seven: { ...d, view_count: -1 } }))).toThrow();
    expect(() =>
      statsPayload(payload({ seven: { ...d, view_list: [...d.view_list, ...d.view_list] } })),
    ).toThrow();
    expect(() => statsPayload(payload({ seven: { ...d, end_time: 0 } }))).toThrow();
  });
  it('正文核对笔记和作者身份，文本不转 HTML，图片仅接受平台 HTTPS 域名', () => {
    const raw = {
      noteId: id,
      user: { userId: user },
      title: '正文标题',
      desc: '<script>不执行</script>\n第二行',
      imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/image.jpg' }],
      tagList: [{ name: '合成话题' }],
    };
    expect(noteBodyPayload(raw, id, user)).toMatchObject({
      id,
      user_id: user,
      text: raw.desc,
      images: ['https://sns-webpic-qc.xhscdn.com/image.jpg'],
      tags: ['合成话题'],
    });
    expect(() => noteBodyPayload({ ...raw, noteId: user }, id, user)).toThrow('account_mismatch');
    expect(() => noteBodyPayload({ ...raw, user: { userId: id } }, id, user)).toThrow(
      'account_mismatch',
    );
    for (const url of [
      'https://evil.test/image.jpg',
      'http://img.xiaohongshu.com/a',
      'https://img.xiaohongshu.com.evil.test/a',
      'https://user@img.xiaohongshu.com/a',
      'https://img.xiaohongshu.com/a#x',
    ])
      expect(() => xhsImageURL(url)).toThrow();
  });
  it('详情只放行任务指定的官方只读页面，编辑发布和其他笔记仍拒绝', () => {
    expect(
      xiaohongshuRequestAllowed('https://www.xiaohongshu.com/explore/' + id, 'GET', 'document', id),
    ).toBe(true);
    expect(
      xiaohongshuRequestAllowed(
        'https://www.xiaohongshu.com/explore/' + user,
        'GET',
        'document',
        id,
      ),
    ).toBe(false);
    for (const [path, method] of [
      ['/publish/publish', 'GET'],
      ['/api/galaxy/note/publish', 'POST'],
      ['/web_api/sns/capa/postgw/note/update', 'POST'],
      ['/api/galaxy/creator/home/personal_info', 'POST'],
    ])
      expect(
        xiaohongshuRequestAllowed('https://creator.xiaohongshu.com' + path, method, 'xhr', id),
      ).toBe(false);
  });
});
