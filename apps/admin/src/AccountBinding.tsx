import { useState, type FormEvent } from 'react';
import { errorText, useWorkspace, type Account } from './runtime';

export default function AccountBinding({
  onChanged,
  account,
}: {
  onChanged: (id: string, removed: boolean) => void;
  account?: Account;
}) {
  const { api, navigate } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState('csdn');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  async function bind(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const result = await api<{ account: Account }>('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({ platform, username, display_name: name }),
      });
      setOpen(false);
      setUsername('');
      setName('');
      onChanged(result.account.id, false);
      navigate('/account?account=' + encodeURIComponent(result.account.id) + '&tab=settings');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  }
  async function unbind() {
    if (!account || pending) return;
    setPending(true);
    setError('');
    try {
      await api('/api/accounts/' + encodeURIComponent(account.id), { method: 'DELETE' });
      setConfirm(false);
      onChanged(account.id, true);
      navigate('/account');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="surface account-binding">
      <div className="surface-header">
        <h2>账号管理</h2>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setOpen(!open);
            setError('');
          }}
        >
          绑定账号
        </button>
      </div>
      {open && (
        <form className="surface-body account-binding-form" onSubmit={(event) => void bind(event)}>
          <label>
            平台
            <select
              value={platform}
              disabled={pending}
              onChange={(event) => setPlatform(event.target.value)}
            >
              <option value="csdn">CSDN</option>
              <option value="xiaohongshu">小红书</option>
            </select>
          </label>
          <label>
            {platform === 'csdn' ? 'CSDN 用户名' : '小红书号'}
            <input
              required
              maxLength={100}
              value={username}
              disabled={pending}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            显示名称
            <input
              maxLength={100}
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button className="primary" type="submit" disabled={pending}>
            {pending ? '正在绑定…' : '绑定并登录'}
          </button>
        </form>
      )}
      {account && (
        <div className="surface-body">
          {!confirm ? (
            <button type="button" disabled={pending} onClick={() => setConfirm(true)}>
              解绑当前账号
            </button>
          ) : (
            <div className="notice warning" role="group" aria-label="确认解绑账号">
              <p>解绑后停止新任务并清理登录凭据，已有处理记录保留。请先核对尚未确认的平台结果。</p>
              <button type="button" disabled={pending} onClick={() => void unbind()}>
                {pending ? '正在解绑…' : '确认解绑'}
              </button>
              <button type="button" disabled={pending} onClick={() => setConfirm(false)}>
                取消
              </button>
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="notice error error-inline" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
