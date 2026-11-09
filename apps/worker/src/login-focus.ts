import type { ElementHandle, Frame, Page } from 'playwright';

const unavailable = '未找到可用的登录输入框，请切换到登录表单后重试';

function loginOrigin(fixtureOrigin?: string): string {
  if (fixtureOrigin !== undefined) {
    let valid = false;
    try {
      valid =
        process.env.NODE_ENV === 'test' &&
        /^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin) &&
        new URL(fixtureOrigin).origin === fixtureOrigin;
    } catch {}
    if (!valid) throw new Error('登录模拟站点仅限测试回环地址');
  }
  return fixtureOrigin ?? 'https://passport.csdn.net';
}

async function frameVisible(frame: Frame): Promise<boolean> {
  const parent = frame.parentFrame();
  if (!parent) return true;
  const element = await frame.frameElement();
  try {
    return (await element.isVisible()) && (await frameVisible(parent));
  } finally {
    await element.dispose();
  }
}

async function loginFrames(page: Page, origin: string, fixtureOrigin?: string): Promise<Frame[]> {
  const frames = page.frames();
  const result: Frame[] = [];
  for (const frame of frames) {
    try {
      if (new URL(frame.url()).origin !== origin) continue;
      // 测试父页可能包含背景搜索框；存在子页面时仅在子页面中寻找登录输入。
      if (fixtureOrigin && !frame.parentFrame() && frames.length > 1) continue;
      if (await frameVisible(frame)) result.push(frame);
    } catch {}
  }
  return result;
}

export async function focusNextLoginInput(
  page: Page,
  backwards = false,
  fixtureOrigin?: string,
): Promise<void> {
  const origin = loginOrigin(fixtureOrigin);
  const candidates: { frame: Frame; active: boolean }[] = [];
  for (const frame of await loginFrames(page, origin, fixtureOrigin)) {
    try {
      candidates.push({ frame, active: await frame.evaluate(() => document.hasFocus()) });
    } catch {}
  }
  candidates.sort((left, right) => Number(right.active) - Number(left.active));
  for (const { frame } of candidates) {
    try {
      const focused = await frame.evaluate(
        ({ origin, backwards }) => {
          if (location.origin !== origin) return false;
          const inputs = Array.from(document.querySelectorAll('input')).filter((input) => {
            if (
              !['text', 'tel', 'email', 'password', 'number'].includes(input.type) ||
              input.matches(':disabled') ||
              input.readOnly ||
              input.closest('[hidden], [inert], [aria-hidden="true"]')
            )
              return false;
            const style = getComputedStyle(input);
            const rect = input.getBoundingClientRect();
            return (
              style.visibility !== 'hidden' &&
              style.visibility !== 'collapse' &&
              rect.width > 0 &&
              rect.height > 0
            );
          });
          if (!inputs.length) return false;
          const current = document.hasFocus()
            ? inputs.indexOf(document.activeElement as HTMLInputElement)
            : -1;
          const index =
            current < 0
              ? backwards
                ? inputs.length - 1
                : 0
              : (current + (backwards ? -1 : 1) + inputs.length) % inputs.length;
          const input = inputs[index];
          input.focus();
          return document.activeElement === input && document.hasFocus();
        },
        { origin, backwards },
      );
      if (focused) return;
    } catch {}
  }
  throw new Error(unavailable);
}

export async function fillLoginInput(
  page: Page,
  field: 'phone' | 'code',
  text: string,
  fixtureOrigin?: string,
): Promise<void> {
  if (
    (field !== 'phone' && field !== 'code') ||
    typeof text !== 'string' ||
    /[^0-9]/.test(text) ||
    text.length < (field === 'phone' ? 5 : 4) ||
    text.length > (field === 'phone' ? 20 : 8)
  )
    throw new Error('登录输入格式无效');
  const origin = loginOrigin(fixtureOrigin);
  const error = '无法确定唯一可用的输入框，请切换到短信登录后重试';
  const handles: ElementHandle<HTMLInputElement>[] = [];
  try {
    const candidates: { frame: Frame; input: ElementHandle<HTMLInputElement> }[] = [];
    for (const frame of await loginFrames(page, origin, fixtureOrigin)) {
      const inputs = (await frame
        .locator('input')
        .elementHandles()) as ElementHandle<HTMLInputElement>[];
      handles.push(...inputs);
      for (const input of inputs) {
        const matches = await input.evaluate(
          (node, { origin, field }) => {
            if (
              location.origin !== origin ||
              !node.isConnected ||
              !['text', 'tel', 'email', 'number'].includes(node.type) ||
              node.matches(':disabled') ||
              node.readOnly ||
              node.closest('[hidden], [inert], [aria-hidden="true"]')
            )
              return false;
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            if (
              style.visibility === 'hidden' ||
              style.visibility === 'collapse' ||
              rect.width <= 0 ||
              rect.height <= 0
            )
              return false;
            return field === 'phone'
              ? /手机号|手机号码/.test(node.placeholder) || node.type === 'tel'
              : /验证码/.test(node.placeholder) || node.autocomplete === 'one-time-code';
          },
          { origin, field },
        );
        if (matches) candidates.push({ frame, input });
      }
    }
    if (candidates.length !== 1) throw new Error(error);
    const { frame, input } = candidates[0];
    if (new URL(frame.url()).origin !== origin || !(await frameVisible(frame)))
      throw new Error(error);
    await input.fill(text, { timeout: 1500 });
  } catch {
    throw new Error(error);
  } finally {
    await Promise.all(handles.map((input) => input.dispose().catch(() => {})));
  }
}
