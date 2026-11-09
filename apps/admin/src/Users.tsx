import { useState, type FormEvent } from 'react';
import { Empty, RefreshBar, ResourceError, useAction, useResource, useWorkspace } from './runtime';

type User = { id: string; username: string; role: string; enabled: boolean };
export default function Users() {
  const { api } = useWorkspace();
  const users = useResource<{ items: User[] }>('/api/users');
  const action = useAction();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  async function create(event: FormEvent) {
    event.preventDefault();
    const result = await action.run((signal) =>
      api<User>('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
        signal,
      }),
    );
    setPassword('');
    if (result) {
      setUsername('');
      users.refresh();
    }
  }
  async function change(user: User) {
    const result = await action.run((signal) =>
      api('/api/users/' + encodeURIComponent(user.id), {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !user.enabled }),
        signal,
      }),
    );
    if (result) users.refresh();
  }
  return (
    <div className="page users-page">
      <div className="page-heading">
        <h1>用户管理</h1>
      </div>
      <section className="surface">
        <div className="surface-header">
          <h2>创建用户</h2>
        </div>
        <form
          className="surface-body account-binding-form"
          onSubmit={(event) => void create(event)}
        >
          <label>
            账号
            <input
              required
              autoComplete="off"
              maxLength={128}
              value={username}
              disabled={action.pending}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            初始密码
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={72}
              value={password}
              disabled={action.pending}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="primary" type="submit" disabled={action.pending}>
            {action.pending ? '正在创建…' : '创建用户'}
          </button>
        </form>
      </section>
      <section className="surface section-gap">
        <RefreshBar resource={users} />
        <ResourceError error={users.error} stale={!!users.data} />
        {users.data ? (
          <div className="table-scroll">
            <table className="data-table users-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((user) => (
                  <tr key={user.id}>
                    <td>{user.username}</td>
                    <td>{user.role === 'admin' ? '管理员' : '用户'}</td>
                    <td>{user.enabled ? '启用' : '停用'}</td>
                    <td>
                      {user.role !== 'admin' && (
                        <button disabled={action.pending} onClick={() => void change(user)}>
                          {user.enabled ? '停用' : '启用'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty loading={users.loading}>暂无用户</Empty>
        )}
      </section>
      {action.error && (
        <div className="notice error" role="alert">
          {action.error}
        </div>
      )}
    </div>
  );
}
