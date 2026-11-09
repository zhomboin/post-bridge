import { describe, it, expect } from 'vitest';
import { loginRequestAllowed } from '../src/login-browser.js';
describe('首次扫码及短信认证的真实请求范围', () => {
  it.each([
    '/v1/register/pc/wxapplets/createQrCode',
    '/v1/register/pc/wxapplets/checkScan',
    '/v1/register/pc/wxapplets/checkLogin',
    '/v1/register/pc/wxapplets/doLogin',
    '/v1/register/pc/sendVerifyCode',
    '/v1/register/pc/login/doLogin',
    '/v1/api/get/mobileAreaCode',
    '/cdn_cgi_bs_bot/api',
  ])('放行官方页面使用的认证请求 %s', (path) => {
    expect(loginRequestAllowed('https://passport.csdn.net' + path, 'POST')).toBe(true);
  });
  it('只准微信登录脚本的精确GET路径', () => {
    expect(
      loginRequestAllowed('https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js', 'GET'),
    ).toBe(true);
    expect(
      loginRequestAllowed('https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js', 'POST'),
    ).toBe(false);
    expect(loginRequestAllowed('https://res.wx.qq.com/other.js', 'GET')).toBe(false);
  });
  it.each([
    'https://passport.csdn.net/v1/register',
    'https://passport.csdn.net/v1/register/pc/changePassword',
    'https://passport.csdn.net/v1/register/pc/wxapplets/delete',
    'https://passport.csdn.net/v1/register/pc/login/doLogin/extra',
    'https://evil.test/v1/register/pc/wxapplets/createQrCode',
    'https://passport.csdn.net:8443/v1/register/pc/wxapplets/checkScan',
  ])('拒绝未授权路径或来源 %s', (url) => {
    expect(loginRequestAllowed(url, 'POST')).toBe(false);
  });
});
