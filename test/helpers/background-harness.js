'use strict';

/**
 * 在 Node 里模拟 Chrome 扩展的运行环境，用来测试 background.js 的真实逻辑：
 *  - chrome.storage.local 用 Map + JSON 深拷贝模拟
 *  - runtime.onMessage 派发 / sendResponse
 *  - alarms / action / runtime 生命周期打桩
 */
const path = require('node:path');

const SHARED_FILES = ['api', 'util', 'vault', 'webdav', 'crypto', 'store'];
const ROOT = path.resolve(__dirname, '..', '..');

function createFakeBrowserApi() {
  const store = new Map();
  const session = new Map();
  const alarms = new Map();
  const listeners = { message: [], alarm: [], installed: [], startup: [], storageChanged: [] };
  const tabsSent = [];

  const deepClone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  const api = {
    runtime: {
      id: 'pwdmg-test-extension',
      lastError: null,
      getManifest: () => ({ version: '1.0.0' }),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      openOptionsPage: async () => undefined,
      sendMessage: async () => undefined,
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
          for (const key of list) {
            if (store.has(key)) out[key] = deepClone(store.get(key));
          }
          return out;
        },
        set: async (items) => {
          for (const [key, value] of Object.entries(items || {})) store.set(key, deepClone(value));
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) store.delete(key);
        },
      },
      session: {
        get: async (keys) => {
          const out = {};
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
          for (const key of list) if (session.has(key)) out[key] = deepClone(session.get(key));
          return out;
        },
        set: async (items) => {
          for (const [key, value] of Object.entries(items || {})) session.set(key, deepClone(value));
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) session.delete(key);
        },
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) },
    },
    alarms: {
      create: (name, info) => {
        alarms.set(name, info || {});
      },
      clear: async (name) => alarms.delete(name),
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
    },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
      setTitle: async () => undefined,
    },
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }],
      sendMessage: async (tabId, message) => {
        tabsSent.push({ tabId, type: message && message.type });
        return undefined;
      },
    },
    permissions: { contains: async () => true, request: async () => true },
    scripting: { executeScript: async () => [] },
  };

  function send(message, sender) {
    return new Promise((resolve) => {
      let settled = false;
      const sendResponse = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        for (const fn of listeners.message) {
          fn(message, sender || {}, sendResponse);
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
        return;
      }
      setTimeout(() => sendResponse(null), 4000);
    });
  }

  return { api, store, session, alarms, listeners, tabsSent, send };
}

/**
 * 载入 background.js（连同共享模块），返回操作句柄。
 * 每次调用都会重建全局 Pwdmg* 命名空间，等同于重新加载扩展。
 */
function loadBackground(options) {
  const fake = createFakeBrowserApi();
  // 模拟「浏览器重启」：保留上一次会话的 storage.local，清空 session 与内存缓存
  if (options && options.store) {
    for (const [key, value] of options.store.entries()) {
      fake.store.set(key, JSON.parse(JSON.stringify(value)));
    }
  }
  globalThis.chrome = fake.api;
  globalThis.browser = undefined;

  for (const name of ['PwdmgApi', 'PwdmgUtil', 'PwdmgVault', 'PwdmgWebdav', 'PwdmgCrypto', 'PwdmgStore']) {
    delete globalThis[name];
  }

  const clearCache = (rel) => {
    try {
      delete require.cache[require.resolve(rel)];
    } catch (err) {
      /* ignore */
    }
  };

  for (const name of SHARED_FILES) clearCache(path.join(ROOT, 'src/shared', name + '.js'));
  clearCache(path.join(ROOT, 'src/background.js'));

  for (const name of SHARED_FILES) require(path.join(ROOT, 'src/shared', name + '.js'));
  require(path.join(ROOT, 'src/background.js'));

  return fake;
}

async function waitFor(predicate, options) {
  const opts = options || {};
  const timeout = opts.timeout || 3000;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待条件超时' + (opts.label ? '：' + opts.label : ''));
}

module.exports = { createFakeBrowserApi, loadBackground, waitFor };
