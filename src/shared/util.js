/*!
 * pwdmg · 通用工具函数
 * 挂载为 globalThis.PwdmgUtil，同时支持 Node require（用于单元测试）。
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = mod;
  if (root) root.PwdmgUtil = mod;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const DAY = 86400000;

  function uid() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (err) {
      /* ignore */
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /** ISO 字符串 -> 毫秒时间戳，非法值返回 0 */
  function toMs(value) {
    if (!value) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }

  function tryParseUrl(url) {
    try {
      return new URL(String(url));
    } catch (err) {
      return null;
    }
  }

  function isWebUrl(url) {
    const u = tryParseUrl(url);
    return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
  }

  function hostOf(url) {
    const u = tryParseUrl(url);
    return u ? u.hostname.toLowerCase() : '';
  }

  function originOf(url) {
    const u = tryParseUrl(url);
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return '';
    return u.origin;
  }

  /** 允许传入 host 或完整 URL，返回规范化的主机名 */
  function normalizeHost(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return hostOf(raw);
    return raw.replace(/^\/+|\/+$/g, '').toLowerCase();
  }

  function stripWww(host) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  }

  /**
   * 判断保存时的主机名与当前页面主机名是否匹配。
   * 支持子域双向匹配：login.example.com ↔ example.com
   */
  function hostMatches(savedHost, pageHost) {
    const a = stripWww(savedHost);
    const b = stripWww(pageHost);
    if (!a || !b) return false;
    if (a === b) return true;
    return a.endsWith('.' + b) || b.endsWith('.' + a);
  }

  /** 显示用的短主机名（去掉 www.） */
  function prettyHost(host) {
    return stripWww(host) || String(host || '');
  }

  function firstLetter(text) {
    const s = String(text || '').trim();
    if (!s) return '?';
    return s.slice(0, 1).toUpperCase();
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatRelativeTime(iso) {
    const t = toMs(iso);
    if (!t) return '从未';
    const diff = Date.now() - t;
    if (diff < 0 || diff < 45000) return '刚刚';
    if (diff < 3600000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
    if (diff < DAY) return Math.round(diff / 3600000) + ' 小时前';
    if (diff < 7 * DAY) return Math.round(diff / DAY) + ' 天前';
    const d = new Date(t);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /**
   * 把「本机记住」的剩余时间说成人话：
   *   null                     → 永久（0 天）
   *   < 1 小时                 → 「不到 1 小时」
   *   其它                     → 「N 天」「N 小时」
   */
  function formatRemaining(ms) {
    if (ms == null) return '';
    const n = Number(ms);
    if (!Number.isFinite(n)) return '';
    if (n <= 0) return '已过期';
    const hour = 3600000;
    if (n < hour) return '不到 1 小时';
    if (n < 86400000) return Math.max(1, Math.round(n / hour)) + ' 小时';
    return Math.ceil(n / 86400000) + ' 天';
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function debounce(fn, wait) {
    let timer = null;
    const wrapped = function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, wait);
    };
    wrapped.cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    wrapped.flush = function (...args) {
      if (timer) clearTimeout(timer);
      timer = null;
      fn.apply(this, args);
    };
    return wrapped;
  }

  /** 将回调风格结果包装成超时 Promise（后台网络请求用） */
  function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error((label || '操作') + '超时')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function uniqueBy(list, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const key = keyFn(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  return {
    DAY,
    uid,
    nowIso,
    toMs,
    tryParseUrl,
    isWebUrl,
    hostOf,
    originOf,
    normalizeHost,
    stripWww,
    hostMatches,
    prettyHost,
    firstLetter,
    clamp,
    formatRelativeTime,
    formatRemaining,
    escapeHtml,
    debounce,
    withTimeout,
    uniqueBy,
  };
});
