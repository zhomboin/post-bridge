import { useState } from 'react';
import { RouteLink, useResource, type Account } from './runtime';
import FormattingPanel from './FormattingPanel';
export default function FormattingNew() {
  const accounts = useResource<{ items: { account: Account }[] }>('/api/accounts');
  const capabilities = useResource<{ enabled: boolean; local_enabled: boolean }>(
    '/api/formatting-capabilities',
  );
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [account, setAccount] = useState('');
  const [selection, setPlatform] = useState('csdn');
  const platforms = [
    ...(capabilities.data?.enabled ? ['csdn', 'xiaohongshu'] : []),
    ...(capabilities.data?.local_enabled ? ['wechat'] : []),
  ];
  const platform = platforms.includes(selection) ? selection : platforms[0] || '';
  return (
    <div className="page">
      <RouteLink href="/formatting" className="back-link">
        返回格式化稿
      </RouteLink>
      <div className="page-heading">
        <h1>新建格式化稿</h1>
      </div>
      <section className="surface">
        <div className="surface-body">
          <div className="form-grid">
            <label>
              目标平台
              <select
                value={platform}
                disabled={!platform}
                onChange={(e) => setPlatform(e.target.value)}
              >
                {!platform && (
                  <option value="">{capabilities.loading ? '正在读取' : '未启用'}</option>
                )}
                {platforms.includes('csdn') && <option value="csdn">CSDN</option>}
                {platforms.includes('xiaohongshu') && <option value="xiaohongshu">小红书</option>}
                {platforms.includes('wechat') && <option value="wechat">微信公众号</option>}
              </select>
            </label>
            <label>
              原稿标题
              <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              原稿 Markdown
              <textarea
                className="markdown-editor"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            {platform === 'csdn' && (
              <label>
                CSDN 账号
                <select value={account} onChange={(e) => setAccount(e.target.value)}>
                  <option value="">请选择</option>
                  {accounts.data?.items
                    .filter(
                      (item) => item.account.platform === 'csdn' && item.account.verified !== false,
                    )
                    .map(({ account }) => (
                      <option key={account.id} value={account.id}>
                        {account.display_name || account.id}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
          {capabilities.error && (
            <div className="notice error" role="alert">
              {capabilities.error}
            </div>
          )}
          {platform && (
            <FormattingPanel
              key={platform}
              source={{
                account_id: platform === 'csdn' ? account : '',
                snapshot: { title, body, body_format: 'markdown', summary: '', tags: [] },
              }}
              disabled={!title.trim() || !body.trim() || (platform === 'csdn' && !account)}
              platforms={[platform]}
            />
          )}
        </div>
      </section>
    </div>
  );
}
