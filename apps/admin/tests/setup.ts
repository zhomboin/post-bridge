import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
afterEach(cleanup);

// jsdom 不实现浏览器原生弹窗，组件测试只补齐打开与关闭状态。
HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); this.querySelector<HTMLElement>('[autofocus]')?.focus(); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
