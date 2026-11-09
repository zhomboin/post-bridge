import { useState } from 'react';
import './AccountAvatar.css';
import { platformMediaURL } from './platform-media';

function avatarURL(value?: string) {
  if (
    !value ||
    !/^https:\/\/profile-avatar\.csdnimg\.cn(?:[/?]|$)/.test(value) ||
    /[\s#\\]/.test(value)
  )
    return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'profile-avatar.csdnimg.cn' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function AvatarImage({ url, fallback }: { url: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span aria-hidden="true">{fallback}</span>
  ) : (
    <img src={url} alt="账号头像" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  );
}

export default function AccountAvatar({
  url,
  platform = 'csdn',
}: {
  url?: string;
  platform?: 'csdn' | 'xiaohongshu';
}) {
  const safe = platform === 'csdn' ? avatarURL(url) : platformMediaURL(url, platform);
  const fallback = platform === 'csdn' ? 'C' : '小';
  return (
    <div className="account-icon account-avatar">
      {safe ? (
        <AvatarImage key={safe} url={safe} fallback={fallback} />
      ) : (
        <span aria-hidden="true">{fallback}</span>
      )}
    </div>
  );
}
