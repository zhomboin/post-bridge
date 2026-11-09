import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { fillLoginInput, focusNextLoginInput } from '../src/login-focus.js';

const origin = 'http://127.0.0.1:48179';
const loginURL = 'https://passport.csdn.net/account/login';
const fields =
  '<a href="#">短信登录</a><input type="hidden"><input style="display:none"><input disabled><fieldset disabled><input></fieldset><input readonly><input id="phone" type="tel"><button>发送验证码</button><input id="code" inputmode="numeric"><input type="checkbox"><a href="#">帮助</a>';
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  });
});
afterAll(async () => {
  await browser?.close();
});

async function fixture(run: (page: Page) => Promise<void>, html = fields, childURL = loginURL) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body:
          route.request().url() === origin + '/'
            ? '<input id="search"><a href="#">背景链接</a><iframe id="login" src="' +
              childURL +
              '"></iframe>'
            : html,
      }),
    );
    await page.goto(origin);
    await page.frameLocator('#login').locator('body').waitFor();
    await run(page);
  } finally {
    await page.close();
  }
}

async function focused(page: Page) {
  return page
    .frames()
    .find((frame) => frame.parentFrame() && frame.url() !== 'about:blank')!
    .evaluate(() => ({ id: document.activeElement?.id, focused: document.hasFocus() }));
}

describe('登录输入框聚焦', () => {
  it('跨源 iframe 从背景搜索进入手机，跳过不可编辑输入并循环', async () => {
    await fixture(async (page) => {
      await page.locator('#search').focus();
      for (const id of ['phone', 'code', 'phone']) {
        await focusNextLoginInput(page);
        expect(await focused(page)).toEqual({ id, focused: true });
      }
      expect(
        await page.locator('#search').evaluate((node) => node === document.activeElement),
      ).toBe(false);
    });
  });
  it('无焦点时反向进入最后输入并反向循环', async () => {
    await fixture(async (page) => {
      await page.locator('#search').focus();
      for (const id of ['code', 'phone', 'code']) {
        await focusNextLoginInput(page, true);
        expect(await focused(page)).toEqual({ id, focused: true });
      }
    });
  });
  it('切换短信表单后重新查找，不保留已移除的焦点', async () => {
    await fixture(async (page) => {
      await focusNextLoginInput(page);
      await page
        .frames()
        .find((frame) => frame.url() === loginURL)!
        .evaluate(() => {
          document.body.innerHTML = '<input id="sms-phone" type="tel"><input id="sms-code">';
        });
      for (const id of ['sms-phone', 'sms-code']) {
        await focusNextLoginInput(page);
        expect(await focused(page)).toEqual({ id, focused: true });
      }
    });
  });
  it('无可编辑输入时返回中文错误并保留背景焦点', async () => {
    await fixture(async (page) => {
      await page.locator('#search').focus();
      await expect(focusNextLoginInput(page)).rejects.toThrow('未找到可用的登录输入框');
      expect(
        await page.locator('#search').evaluate((node) => node === document.activeElement),
      ).toBe(true);
    }, '<input hidden><input disabled><input readonly><input type="file"><a href="#">帮助</a>');
  });
  it('生产规则不选择背景或非认证域 iframe', async () => {
    await fixture(
      async (page) => {
        await page.locator('#search').focus();
        await expect(focusNextLoginInput(page)).rejects.toThrow('未找到可用的登录输入框');
        expect(
          await page.locator('#search').evaluate((node) => node === document.activeElement),
        ).toBe(true);
      },
      fields,
      origin + '/frame',
    );
  });
  it('测试精确来源白名单选中 iframe，跳过同源父页搜索', async () => {
    await fixture(
      async (page) => {
        await page.locator('#search').focus();
        await focusNextLoginInput(page, false, origin);
        expect(await focused(page)).toEqual({ id: 'phone', focused: true });
      },
      fields,
      origin + '/frame',
    );
  });
  it('拒绝非测试模式及不精确回环来源', async () => {
    await fixture(async (page) => {
      for (const value of [
        'http://localhost:48179',
        origin + '/',
        'https://127.0.0.1:48179',
        'http://127.0.0.1:99999',
      ]) {
        await expect(focusNextLoginInput(page, false, value)).rejects.toThrow(
          '登录模拟站点仅限测试回环地址',
        );
      }
      const previous = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        await expect(focusNextLoginInput(page, false, origin)).rejects.toThrow(
          '登录模拟站点仅限测试回环地址',
        );
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });
  it('不读取或写入输入内容', async () => {
    await fixture(async (page) => {
      await page
        .frames()
        .find((frame) => frame.url() === loginURL)!
        .evaluate(() => {
          Object.defineProperty(HTMLInputElement.prototype, 'value', {
            get() {
              throw new Error('禁止读取输入内容');
            },
            set() {
              throw new Error('禁止写入输入内容');
            },
          });
        });
      for (const id of ['phone', 'code']) {
        await focusNextLoginInput(page);
        expect(await focused(page)).toEqual({ id, focused: true });
      }
    });
  });
});

describe('定向填入短信登录', () => {
  it('跨源 iframe 定向填手机与验证码，父页搜索保持为空', async () => {
    await fixture(async (page) => {
      await page.locator('#search').focus();
      await fillLoginInput(page, 'phone', '12345678901');
      await fillLoginInput(page, 'code', '123456');
      expect(await page.frameLocator('#login').locator('#phone').inputValue()).toBe('12345678901');
      expect(await page.frameLocator('#login').locator('#code').inputValue()).toBe('123456');
      expect(await page.locator('#search').inputValue()).toBe('');
    }, '<input id="phone" placeholder="请输入手机号码"><input id="code" placeholder="短信验证码">');
  });
  it('手机号支持 tel，验证码支持 one-time-code，接受数字长度边界', async () => {
    await fixture(async (page) => {
      for (const text of ['12345', '12345678901234567890'])
        await fillLoginInput(page, 'phone', text);
      for (const text of ['1234', '12345678']) await fillLoginInput(page, 'code', text);
      expect(await page.frameLocator('#login').locator('#phone').inputValue()).toBe(
        '12345678901234567890',
      );
      expect(await page.frameLocator('#login').locator('#code').inputValue()).toBe('12345678');
    }, '<input id="phone" type="tel"><input id="code" autocomplete="one-time-code">');
  });
  it('非法字段和文本直接拒绝，不包含传入内容', async () => {
    await fixture(async (page) => {
      for (const [field, text] of [
        ['search', '123456'],
        ['phone', '1234'],
        ['phone', '123456789012345678901'],
        ['phone', '12345x'],
        ['phone', ' 12345'],
        ['code', '123'],
        ['code', '123456789'],
        ['code', '１２３４'],
        ['code', '1234\n'],
      ]) {
        await expect(fillLoginInput(page, field as 'phone', text)).rejects.toThrow(
          '登录输入格式无效',
        );
      }
      expect(await page.frameLocator('#login').locator('#phone').inputValue()).toBe('');
    }, '<input id="phone" type="tel">');
  });
  it('短信表单没有匹配或出现多个匹配均拒绝，不回退普通账号输入', async () => {
    for (const html of [
      '<input id="account" placeholder="用户名"><input type="password">',
      '<input type="tel"><input placeholder="手机号">',
    ]) {
      await fixture(async (page) => {
        await expect(fillLoginInput(page, 'phone', '12345678901')).rejects.toThrow(
          '请切换到短信登录',
        );
        expect(await page.locator('#search').inputValue()).toBe('');
      }, html);
    }
  });
  it('跳过隐藏、禁用及只读候选，全部不可用时安全失败', async () => {
    const hidden =
      '<input type="tel" hidden><input type="tel" disabled><input type="tel" readonly><input type="tel" style="visibility:hidden">';
    await fixture(async (page) => {
      await fillLoginInput(page, 'phone', '12345678901');
      expect(await page.frameLocator('#login').locator('#phone').inputValue()).toBe('12345678901');
    }, hidden + '<input id="phone" type="tel">');
    await fixture(async (page) => {
      await expect(fillLoginInput(page, 'phone', '12345678901')).rejects.toThrow(
        '请切换到短信登录',
      );
    }, hidden);
  });
  it('精确回环 fixture 只填 iframe，生产拒绝该来源', async () => {
    await fixture(
      async (page) => {
        await expect(fillLoginInput(page, 'phone', '12345678901')).rejects.toThrow(
          '请切换到短信登录',
        );
        await fillLoginInput(page, 'phone', '12345678901', origin);
        expect(await page.frameLocator('#login').locator('#phone').inputValue()).toBe(
          '12345678901',
        );
        expect(await page.locator('#search').inputValue()).toBe('');
        await expect(fillLoginInput(page, 'phone', '12345678901', origin + '/')).rejects.toThrow(
          '登录模拟站点仅限测试回环地址',
        );
      },
      '<input id="phone" type="tel">',
      origin + '/frame',
    );
  });
  it('隐藏的登录 iframe 不得填入', async () => {
    await fixture(async (page) => {
      await page.locator('#login').evaluate((node) => {
        (node as HTMLElement).style.display = 'none';
      });
      await expect(fillLoginInput(page, 'phone', '12345678901')).rejects.toThrow(
        '请切换到短信登录',
      );
      expect(await page.frameLocator('#login').locator('#phone').inputValue()).toBe('');
    }, '<input id="phone" type="tel">');
  });
});

it('定向填入不会读取输入框已有内容', async () => {
  await fixture(async (page) => {
    await page
      .frames()
      .find((frame) => frame.url() === loginURL)!
      .evaluate(() => {
        const input = document.querySelector('input')!;
        Object.defineProperty(input, 'value', {
          get() {
            throw new Error('禁止读取已有内容');
          },
        });
        input.addEventListener('input', () => {
          document.body.dataset.filled = 'phone';
        });
      });
    await fillLoginInput(page, 'phone', '12345678901');
    expect(
      await page
        .frames()
        .find((frame) => frame.url() === loginURL)!
        .evaluate(() => document.body.dataset.filled),
    ).toBe('phone');
  }, '<input type="tel">');
});

it('多个认证 iframe 中重复候选也必须拒绝', async () => {
  await fixture(async (page) => {
    await page.evaluate((url) => {
      const child = document.createElement('iframe');
      child.id = 'duplicate';
      child.src = url;
      document.body.append(child);
    }, loginURL + '?second');
    await page.frameLocator('#duplicate').locator('input').waitFor();
    await expect(fillLoginInput(page, 'phone', '12345678901')).rejects.toThrow('请切换到短信登录');
    expect(await page.frameLocator('#login').locator('input').inputValue()).toBe('');
    expect(await page.frameLocator('#duplicate').locator('input').inputValue()).toBe('');
  }, '<input type="tel">');
});
