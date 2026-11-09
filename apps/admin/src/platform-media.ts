export function platformMediaURL(
  value?: string,
  platform: 'csdn' | 'xiaohongshu' = 'csdn',
): string | undefined {
  if (!value || /[\s#\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    const allowed =
      platform === 'csdn'
        ? url.hostname === 'profile-avatar.csdnimg.cn'
        : url.hostname === 'img.xiaohongshu.com' || url.hostname.endsWith('.xhscdn.com');
    return allowed &&
      url.protocol === 'https:' &&
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
export function notePublicURL(value: string | undefined, id: string): string | undefined {
  return /^[a-f0-9]{24}$/.test(id) && value === 'https://www.xiaohongshu.com/explore/' + id
    ? value
    : undefined;
}
