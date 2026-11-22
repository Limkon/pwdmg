/*!
 * pwdmg · 本地设置、缓存与会话密钥
 *
 * - settings：WebDAV 配置 + 行为开关（storage.local）
 * - vaultCache：密码库缓存记录。启用主密码加密后，其中只有密文（storage.local）
 * - 会话密钥：派生出的 AES 密钥（storage.session，浏览器重启即失效）
 * 挂载为 globalThis.PwdmgStore。
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = mod;
  if (root) root.PwdmgStore = mod;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const g = typeof globalThis !== 'undefined' ? globalThis : self;
  const api = g.PwdmgApi && g.PwdmgApi.api;
  const Vault = g.PwdmgVault;

  const SETTINGS_KEY = 'settings';
  const CACHE_KEY = 'vaultCache';
  const SESSION_KEY = 'vaultKey';
  const HISTORY_KEY = 'vaultHistory';

  const DEFAULT_SETTINGS = {
    // WebDAV
    webdavUrl: '',
    username: '',
    password: '',
    authType: 'basic', // 'basic' | 'bearer' | 'none'
    token: '',
    createDirs: true,
    noIfMatch: false,
    // 加密
    encryptVault: false,
    // 行为
    autoSave: true,
    autoPrompt: true,
    autoOpenPanel: true,
    autoFillSingle: true,
    confirmPasswordChange: true,
    syncIntervalMin: 15,
    lastExportAt: '',
  };

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.round(n), min), max);
  }

  function normalizeSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    return {
      webdavUrl: String(s.webdavUrl || '').trim(),
      username: String(s.username || ''),
      password: String(s.password || ''),
      authType: ['basic', 'bearer', 'none'].includes(s.authType) ? s.authType : 'basic',
      token: String(s.token || ''),
      createDirs: !!s.createDirs,
      noIfMatch: !!s.noIfMatch,
      encryptVault: !!s.encryptVault,
      autoSave: !!s.autoSave,
      autoPrompt: !!s.autoPrompt,
      autoOpenPanel: !!s.autoOpenPanel,
      autoFillSingle: !!s.autoFillSingle,
      confirmPasswordChange: !!s.confirmPasswordChange,
      lastExportAt: typeof s.lastExportAt === 'string' ? s.lastExportAt : '',
      syncIntervalMin: clampNumber(s.syncIntervalMin, 1, 1440, 15),
    };
  }

  async function getSettings() {
    if (!api) return normalizeSettings({});
    const data = await api.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(data && data[SETTINGS_KEY]);
  }

  /**
   * 保存设置。读-改-写之间用一条串行链排队，
   * 否则两个页面同时保存（比如「导出」写 lastExportAt 时用户正好拨了一个开关）
   * 会互相覆盖，丢掉对方刚写入的字段。
   */
  let settingsQueue = Promise.resolve();

  function saveSettings(patch) {
    const run = settingsQueue.then(async () => {
      const current = await getSettings();
      const next = normalizeSettings(Object.assign({}, current, patch || {}));
      if (api) await api.storage.local.set({ [SETTINGS_KEY]: next });
      return next;
    });
    settingsQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /* ---------------------------------------------------------------- *
   * 密码库缓存记录
   * { etag, lastSyncAt, lastError, dirty, rev, encrypted, kdf,
   *   vault?: 明文密码库（未加密时）
   *   cipher?: 加密信封（加密时） }
   * ---------------------------------------------------------------- */

  async function readCacheRecord() {
    if (!api) return null;
    const data = await api.storage.local.get(CACHE_KEY);
    const record = data && data[CACHE_KEY];
    if (!record || typeof record !== 'object') return null;
    return record;
  }

  async function writeCacheRecord(record) {
    if (!api) return record;
    await api.storage.local.set({ [CACHE_KEY]: record });
    return record;
  }

  async function clearCacheRecord() {
    if (!api) return;
    await api.storage.local.remove(CACHE_KEY);
  }

  function emptyVault() {
    return Vault
      ? Vault.empty()
      : { version: 1, updatedAt: new Date().toISOString(), entries: [], tombstones: {} };
  }

  /* ---------------------------------------------------------------- *
   * 历史快照（远端损坏 / 误导入时的救命稻草）
   *
   * 每条：{ at, kind, text }，text 是当时的文件内容（加密库存密文信封）。
   * 只保留最近几条，见 background 的 rememberHistory()。
   * ---------------------------------------------------------------- */

  async function readHistory() {
    if (!api) return [];
    try {
      const data = await api.storage.local.get(HISTORY_KEY);
      const list = data && data[HISTORY_KEY];
      return Array.isArray(list) ? list.filter((item) => item && typeof item.text === 'string') : [];
    } catch (err) {
      return [];
    }
  }

  async function writeHistory(list) {
    if (!api) return;
    await api.storage.local.set({ [HISTORY_KEY]: Array.isArray(list) ? list : [] });
  }

  async function clearHistory() {
    if (!api) return;
    await api.storage.local.remove(HISTORY_KEY);
  }

  /* ---------------------------------------------------------------- *
   * 会话密钥（只在当前浏览器会话内有效）
   * ---------------------------------------------------------------- */

  const memorySession = new Map();

  /**
   * 读取会话级数据（浏览器重启即失效）。
   * 不支持 storage.session 的环境退化为内存，进程内保持一致。
   */
  async function readSession(name) {
    const key = String(name);
    if (api && api.storage && api.storage.session) {
      try {
        const data = await api.storage.session.get(key);
        if (data && data[key] !== undefined && data[key] !== null) {
          memorySession.set(key, data[key]);
          return data[key];
        }
      } catch (err) {
        /* 某些环境不支持 storage.session，退化为内存 */
      }
    }
    return memorySession.has(key) ? memorySession.get(key) : null;
  }

  async function writeSession(name, value) {
    const key = String(name);
    const empty = value === null || value === undefined;
    if (empty) memorySession.delete(key);
    else memorySession.set(key, value);
    if (!api || !api.storage || !api.storage.session) return;
    try {
      if (empty) await api.storage.session.remove(key);
      else await api.storage.session.set({ [key]: value });
    } catch (err) {
      /* ignore */
    }
  }

  async function readSessionKey() {
    return readSession(SESSION_KEY);
  }

  async function writeSessionKey(value) {
    return writeSession(SESSION_KEY, value || null);
  }

  return {
    SETTINGS_KEY,
    CACHE_KEY,
    SESSION_KEY,
    DEFAULT_SETTINGS,
    normalizeSettings,
    getSettings,
    saveSettings,
    emptyVault,
    readCacheRecord,
    writeCacheRecord,
    clearCacheRecord,
    readSession,
    writeSession,
    readHistory,
    writeHistory,
    clearHistory,
    HISTORY_KEY,
    readSessionKey,
    writeSessionKey,
  };
});
