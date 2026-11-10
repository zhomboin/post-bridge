import { useState } from 'react';
import { RouteLink, useResource, type Account } from './runtime';
import FormattingPanel from './FormattingPanel';
export default function FormattingNew() {
  const accounts = useResource<{ items: { account: Account }[] }>('/api/accounts');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [account, setAccount] = useState('');
  const [platform, setPlatform] = useState('csdn');
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
              <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="csdn">CSDN</option>
                <option value="xiaohongshu">小红书</option>
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
          <FormattingPanel
            source={{
              account_id: platform === 'csdn' ? account : '',
              snapshot: { title, body, body_format: 'markdown', summary: '', tags: [] },
            }}
            disabled={!title.trim() || !body.trim() || (platform === 'csdn' && !account)}
            platforms={[platform]}
          />
        </div>
      </section>
    </div>
  );
}
