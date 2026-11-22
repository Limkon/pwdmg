/*!
 * pwdmg · 浏览器 API 兼容层
 *
 * Chrome / Edge 使用 chrome.*（MV3 下大部分接口返回 Promise），
 * Firefox 优先使用 browser.*（原生 Promise）。挂载为 globalThis.PwdmgApi。
 */
(function (root, factory) {
  'use strict';
  const mod = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = mod;
  if (root) root.PwdmgApi = mod;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (root) {
  'use strict';

  const g = root || {};
  const has = (ns) => !!(ns && ns.runtime && ns.runtime.id);
  const isFirefox = has(g.browser) && typeof g.browser.runtime.getBrowserInfo === 'function';
  const api = has(g.browser) ? g.browser : has(g.chrome) ? g.chrome : null;

  /** 兼容 Firefox MV3 的 action / Chrome 的 action */
  function action() {
    if (!api) return null;
    return api.action || api.browserAction || null;
  }

  /**
   * 统一发送运行时消息，失败（无接收方、扩展上下文失效等）时返回 null。
   * content script / popup / options 都用它，避免到处写 try/catch。
   */
  async function sendMessage(message) {
    if (!api) return null;
    try {
      const result = await api.runtime.sendMessage(message);
      return result === undefined ? null : result;
    } catch (err) {
      return null;
    }
  }

  /** 扩展上下文是否仍然有效（插件更新/重载后旧页面会失效） */
  function contextAlive() {
    try {
      return !!(api && api.runtime && api.runtime.id);
    } catch (err) {
      return false;
    }
  }

  return { api, isFirefox, action, sendMessage, contextAlive };
});
