import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AccountAvatar from '../src/AccountAvatar';

describe('账号头像', () => {
  it('显示准确头像域且不发送来源信息，失败后使用占位', () => {
    const { rerender } = render(<AccountAvatar url="https://profile-avatar.csdnimg.cn/avatar.png" />);
    const image = screen.getByRole('img', { name: '账号头像' });
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    fireEvent.error(image);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('C')).toBeTruthy();
    rerender(<AccountAvatar url="https://profile-avatar.csdnimg.cn/new.png" />);
    expect(screen.getByRole('img').getAttribute('src')).toContain('/new.png');
  });
  it.each(['', 'not-url', 'http://profile-avatar.csdnimg.cn/a', 'https://profile-avatar.csdnimg.cn.evil.test/a', 'https://evil.test/a', 'https://u:p@profile-avatar.csdnimg.cn/a', 'https://profile-avatar.csdnimg.cn:443/a', 'https://profile-avatar.csdnimg.cn:8443/a', 'https://profile-avatar.csdnimg.cn/a#fragment', '//profile-avatar.csdnimg.cn/a'])('拒绝异常头像 %s', url => {
    render(<AccountAvatar url={url} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('C')).toBeTruthy();
  });
});
