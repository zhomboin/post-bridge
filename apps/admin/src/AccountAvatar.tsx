import { useState } from 'react';
import './AccountAvatar.css';

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

function AvatarImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span aria-hidden="true">C</span>
  ) : (
    <img src={url} alt="账号头像" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  );
}

export default function AccountAvatar({ url }: { url?: string }) {
  const safe = avatarURL(url);
  return (
    <div className="account-icon account-avatar">
      {safe ? <AvatarImage key={safe} url={safe} /> : <span aria-hidden="true">C</span>}
    </div>
  );
}
