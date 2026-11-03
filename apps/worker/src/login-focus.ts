import type { Frame, Page } from 'playwright';

const unavailable = '未找到可用的登录输入框，请切换到登录表单后重试';

async function frameVisible(frame: Frame): Promise<boolean> {
  const parent = frame.parentFrame();
  if (!parent) return true;
  const element = await frame.frameElement();
  try { return await element.isVisible() && await frameVisible(parent); }
  finally { await element.dispose(); }
}

export async function focusNextLoginInput(page: Page, backwards = false, fixtureOrigin?: string): Promise<void> {
  if (fixtureOrigin !== undefined) {
    let valid = false;
    try {
      valid = process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin) && new URL(fixtureOrigin).origin === fixtureOrigin;
    } catch {}
    if (!valid) throw new Error('登录模拟站点仅限测试回环地址');
  }
  const origin = fixtureOrigin ?? 'https://passport.csdn.net';
  const frames = page.frames();
  const candidates: { frame: Frame; active: boolean }[] = [];
  for (const frame of frames) {
    try {
      if (new URL(frame.url()).origin !== origin) continue;
      // 测试父页可能包含背景搜索框；存在子页面时仅在子页面中寻找登录输入。
      if (fixtureOrigin && !frame.parentFrame() && frames.length > 1) continue;
      if (!await frameVisible(frame)) continue;
      candidates.push({ frame, active: await frame.evaluate(() => document.hasFocus()) });
    } catch {}
  }
  candidates.sort((left, right) => Number(right.active) - Number(left.active));
  for (const { frame } of candidates) {
    try {
      const focused = await frame.evaluate(({ origin, backwards }) => {
        if (location.origin !== origin) return false;
        const inputs = Array.from(document.querySelectorAll('input')).filter(input => {
          if (!['text', 'tel', 'email', 'password', 'number'].includes(input.type) || input.matches(':disabled') || input.readOnly || input.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
          const style = getComputedStyle(input);
          const rect = input.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.visibility !== 'collapse' && rect.width > 0 && rect.height > 0;
        });
        if (!inputs.length) return false;
        const current = document.hasFocus() ? inputs.indexOf(document.activeElement as HTMLInputElement) : -1;
        const index = current < 0 ? (backwards ? inputs.length - 1 : 0) : (current + (backwards ? -1 : 1) + inputs.length) % inputs.length;
        const input = inputs[index];
        input.focus();
        return document.activeElement === input && document.hasFocus();
      }, { origin, backwards });
      if (focused) return;
    } catch {}
  }
  throw new Error(unavailable);
}
