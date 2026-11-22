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
    rememberDevice: false,
    rememberDeviceDays: 7,
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
      rememberDevice: s.rememberDevice !== undefined ? !!s.rememberDevice : Number(s.rememberDeviceDays) > 0,
      rememberDeviceDays: clampNumber(s.rememberDeviceDays, 0, 365, 7),
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
   * 站点自适应记忆（「智能识别」用）
   *
   * 每个站点记住：上次成功填充的用户名 / 密码框选择器、页面状态关键词。
   * 选择器只写进内容脚本，登录时命中就直接用，命中不了再走通用猜法并重新学习。
   * 纯本地数据，不同步、不含任何账号密码。
   * ---------------------------------------------------------------- */

  const SITE_MEMORY_KEY = 'siteMemory';
  const SITE_MEMORY_LIMIT = 120;

  function normalizeSiteMemory(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [host, value] of Object.entries(raw)) {
      if (!host || !value || typeof value !== 'object') continue;
      const item = {
        user: typeof value.user === 'string' ? value.user.slice(0, 300) : '',
        pass: typeof value.pass === 'string' ? value.pass.slice(0, 300) : '',
        markers: Array.isArray(value.markers)
          ? value.markers.filter((m) => typeof m === 'string' && m.trim()).slice(0, 6).map((m) => m.slice(0, 40))
          : [],
        at: typeof value.at === 'string' ? value.at : '',
        hits: Number.isFinite(value.hits) ? value.hits : 0,
      };
      if (!item.user && !item.pass && !item.markers.length) continue;
      out[String(host).toLowerCase()] = item;
    }
    return out;
  }

  async function readSiteMemory() {
    if (!api) return {};
    try {
      const data = await api.storage.local.get(SITE_MEMORY_KEY);
      return normalizeSiteMemory(data && data[SITE_MEMORY_KEY]);
    } catch (err) {
      return {};
    }
  }

  async function writeSiteMemory(map) {
    if (!api) return {};
    const normalized = normalizeSiteMemory(map);
    // 超出上限时丢掉最久没用的站点
    const hosts = Object.keys(normalized);
    if (hosts.length > SITE_MEMORY_LIMIT) {
      hosts
        .sort((a, b) => (normalized[a].at < normalized[b].at ? -1 : 1))
        .slice(0, hosts.length - SITE_MEMORY_LIMIT)
        .forEach((host) => delete normalized[host]);
    }
    await api.storage.local.set({ [SITE_MEMORY_KEY]: normalized });
    return normalized;
  }

  /** 记一个站点的识别线索（只保留最近一次成功的结果） */
  async function saveSiteMemory(host, patch) {
    const key = String(host || '').trim().toLowerCase();
    if (!key) return {};
    const map = await readSiteMemory();
    const prev = map[key] || { user: '', pass: '', markers: [], at: '', hits: 0 };
    const next = Object.assign({}, prev, patch || {}, { at: new Date().toISOString() });
    next.hits = (Number(prev.hits) || 0) + 1;
    if (Array.isArray(next.markers)) next.markers = next.markers.slice(0, 6);
    map[key] = next;
    return writeSiteMemory(map);
  }

  async function forgetSiteMemory(host) {
    const key = String(host || '').trim().toLowerCase();
    const map = await readSiteMemory();
    if (map[key]) {
      delete map[key];
      await writeSiteMemory(map);
    }
    return map;
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

  /* ---------------------------------------------------------------- *
   * 本机记住的解锁密钥（「记住本机」开关）
   *
   * 只保存从主密码派生出的 AES-GCM 原始密钥（base64）+ 过期时间。
   * 主密码本身永不写入、永不落盘；过期/清理后必须重新输入主密码。
   * ---------------------------------------------------------------- */

  const REMEMBERED_KEY_KEY = 'rememberedKey';

  /**
   * 读出「本机记住」的原始记录（不判断是否过期，给状态展示用）。
   * 过期后密钥会被清掉，但会留一条 `expired: true` 的标记（不含密钥），
   * 这样界面能说清「已过期，需要重新输入主密码」，而不是含糊的「未开启」。
   */
  async function readRememberedRecord() {
    if (!api) return null;
    try {
      const data = await api.storage.local.get(REMEMBERED_KEY_KEY);
      const entry = data && data[REMEMBERED_KEY_KEY];
      if (!entry) return null;
      if (!entry.key && !entry.expired) return null;
      return entry;
    } catch (err) {
      return null;
    }
  }

  async function readRememberedKey() {
    if (!api) return null;
    try {
      const entry = await readRememberedRecord();
      if (!entry || !entry.key) return null;
      if (!entry.expiresAt) return entry.key; // 0 天 = 永久（直到手动清除）
      const expiresAt = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        await markRememberedExpired(entry);
        return null;
      }
      return entry.key;
    } catch (err) {
      return null;
    }
  }

  /** 过期时丢掉密钥，只留一条不含密钥的「已过期」标记 */
  async function markRememberedExpired(entry) {
    if (!api) return;
    try {
      await api.storage.local.set({
        [REMEMBERED_KEY_KEY]: {
          key: '',
          expired: true,
          expiresAt: (entry && entry.expiresAt) || null,
          savedAt: (entry && entry.savedAt) || null,
          days: entry && Number.isFinite(entry.days) ? entry.days : 0,
        },
      });
    } catch (err) {
      /* 忽略 */
    }
  }

  async function writeRememberedKey(keyBase64, days) {
    if (!api) return;
    const n = Math.floor(Number(days));
    // days <= 0 表示永久（直到手动清除），不写过期时间
    const now = Date.now();
    const expiresAt = Number.isFinite(n) && n > 0
      ? new Date(now + n * 24 * 60 * 60 * 1000).toISOString()
      : null;
    // savedAt / days 只用于界面展示（「记住本机 · 还剩 5 天」），不参与解密
    await api.storage.local.set({
      [REMEMBERED_KEY_KEY]: {
        key: String(keyBase64 || ''),
        expired: false,
        expiresAt,
        savedAt: new Date(now).toISOString(),
        days: Number.isFinite(n) ? n : 0,
      },
    });
  }

  /** 忘记本机密钥并抹掉「已过期」标记（用户主动关闭 / 锁定 / 主密码已变） */
  async function forgetRememberedKey() {
    return clearRememberedKey();
  }

  async function clearRememberedKey() {
    if (!api) return;
    try {
      await api.storage.local.remove(REMEMBERED_KEY_KEY);
    } catch (err) {
      /* 忽略 */
    }
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
    SITE_MEMORY_KEY,
    readSiteMemory,
    writeSiteMemory,
    saveSiteMemory,
    forgetSiteMemory,
    REMEMBERED_KEY_KEY,
    readRememberedRecord,
    readRememberedKey,
    writeRememberedKey,
    clearRememberedKey,
  };
});
