'use strict';

/**
 * 弹窗 / 设置页的冒烟测试（依赖 jsdom）。
 * 未安装 jsdom 时自动跳过：npm install --no-save jsdom
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch (err) {
  JSDOM = null;
}
const skip = JSDOM ? false : '未安装 jsdom，跳过页面测试';

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SHARED = {
  api: read('src/shared/api.js'),
  util: read('src/shared/util.js'),
  vault: read('src/shared/vault.js'),
  webdav: read('src/shared/webdav.js'),
  csv: read('src/shared/csv.js'),
  store: read('src/shared/store.js'),
};

const VAULT = {
  version: 1,
  updatedAt: new Date().toISOString(),
  entries: [
    {
      id: 'e1',
      host: 'example.com',
      origin: 'https://example.com',
      url: 'https://example.com/login',
      username: 'alice',
      password: 'pw-alice',
      title: 'example.com',
      notes: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      useCount: 3,
      lastUsedAt: null,
    },
    {
      id: 'e2',
      host: 'example.com',
      origin: 'https://example.com',
      url: 'https://example.com/login',
      username: 'bob',
      password: 'pw-bob',
      title: 'example.com',
      notes: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-03T00:00:00.000Z',
      useCount: 0,
      lastUsedAt: null,
    },
    {
      id: 'e3',
      host: 'other.org',
      origin: 'https://other.org',
      url: 'https://other.org/',
      username: 'carol',
      password: 'pw-carol',
      title: 'other.org',
      notes: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-04T00:00:00.000Z',
      useCount: 0,
      lastUsedAt: null,
    },
  ],
  tombstones: {},
};

function makeChrome(overrides) {
  const calls = { messages: [], tabMessages: [], permissions: [] };
  const chrome = {
    runtime: {
      id: 'pwdmg-test',
      lastError: null,
      getManifest: () => ({ version: '1.0.0' }),
      sendMessage: async (message) => {
        calls.messages.push(message);
        if (overrides && overrides.sendMessage) return overrides.sendMessage(message);
        return { ok: true };
      },
      onMessage: { addListener: () => undefined },
      openOptionsPage: async () => undefined,
    },
    tabs: {
      query: async () => [
        { id: 42, url: 'https://example.com/login', title: 'Example Login' },
      ],
      sendMessage: async (tabId, message, options) => {
        calls.tabMessages.push({ tabId, message, options });
        return { ok: true };
      },
    },
    scripting: { executeScript: async () => [] },
    permissions: {
      contains: async () => false,
      request: async (request) => {
        calls.permissions.push(request);
        return true;
      },
    },
    storage: {
      local: {
        get: async (key) => {
          const map = (overrides && overrides.storage) || {};
          const out = {};
          const keys = typeof key === 'string' ? [key] : Array.isArray(key) ? key : Object.keys(key || {});
          for (const k of keys) if (k in map) out[k] = JSON.parse(JSON.stringify(map[k]));
          return out;
        },
        set: async (items) => {
          if (overrides && overrides.onSet) overrides.onSet(items);
        },
        remove: async () => undefined,
      },
      onChanged: { addListener: () => undefined },
    },
  };
  return { chrome, calls };
}

async function until(predicate, label, timeout) {
  const limit = timeout || 2000;
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待超时：' + (label || '条件未满足'));
}

test('弹窗：列出当前站点账号、显示密码、填充', { skip }, async () => {
  const vaultList = {
    ok: true,
    configured: true,
    dirty: false,
    lastSyncAt: new Date().toISOString(),
    lastError: null,
    vault: VAULT,
  };
  const { chrome, calls } = makeChrome({
    sendMessage: async (message) => {
      if (message.type === 'vault:list') return vaultList;
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/popup/popup.html'), {
    url: 'https://localhost/popup.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;
  window.close = () => {
    calls.closed = true;
  };

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(read('src/popup/popup.js'));

  await until(() => window.document.querySelectorAll('.entry').length === 2, '渲染 2 条当前站点账号');
  assert.equal(window.document.getElementById('site-host').textContent, 'example.com');
  assert.equal(window.document.getElementById('count').textContent, '2');

  // 列表按“最近使用 / 更新时间”排序：bob 更新更晚，排在前面
  const entries = Array.from(window.document.querySelectorAll('.entry'));
  assert.deepEqual(
    entries.map((e) => e.querySelector('.uname').textContent),
    ['bob', 'alice']
  );

  const aliceRow = entries.find((e) => e.querySelector('.uname').textContent === 'alice');
  // 密码默认不显示
  assert.equal(aliceRow.querySelector('.pw-line').hidden, true);
  assert.equal(aliceRow.querySelector('.pw-line').textContent, '');

  // 点击“显示”
  const buttons = Array.from(aliceRow.querySelectorAll('.mini'));
  const showBtn = buttons.find((b) => b.textContent === '显示');
  showBtn.click();
  assert.equal(aliceRow.querySelector('.pw-line').hidden, false);
  assert.equal(aliceRow.querySelector('.pw-line').textContent, 'pw-alice');

  // 点击“填充”
  const fillBtn = buttons.find((b) => b.textContent === '填充');
  fillBtn.click();
  await until(() => calls.tabMessages.some((m) => m.message.type === 'content:fill'), '发送填充消息');
  const fillCall = calls.tabMessages.find((m) => m.message.type === 'content:fill');
  assert.equal(fillCall.message.entry.username, 'alice');
  assert.equal(fillCall.message.entry.password, 'pw-alice');
  // 带上条目 id，页面里填完才会记账（useCount / 最近使用）
  assert.equal(fillCall.message.entry.id, 'e1');
  await until(() => calls.closed === true, '填充成功后关闭弹窗');

  dom.window.close();
});

test('弹窗：未配置 WebDAV 时显示提示，可手动保存账号', { skip }, async () => {
  const vaultList = {
    ok: true,
    configured: false,
    dirty: true,
    lastSyncAt: null,
    lastError: null,
    vault: { version: 1, updatedAt: new Date().toISOString(), entries: [], tombstones: {} },
  };
  const saved = [];
  const { chrome } = makeChrome({
    sendMessage: async (message) => {
      if (message.type === 'vault:list') return vaultList;
      if (message.type === 'vault:saveEntry') saved.push(message.entry);
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/popup/popup.html'), {
    url: 'https://localhost/popup.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;
  window.close = () => undefined;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(read('src/popup/popup.js'));

  await until(() => window.document.getElementById('banner').hidden === false, '显示未配置提示');
  assert.match(window.document.getElementById('banner-text').textContent, /尚未配置 WebDAV/);

  // 打开手动添加表单
  window.document.getElementById('add-toggle').click();
  window.document.getElementById('f-url').value = 'manual.example';
  window.document.getElementById('f-username').value = 'me';
  window.document.getElementById('f-password').value = 'secret';
  window.document.getElementById('add-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await until(() => saved.length === 1, '保存条目');
  assert.equal(saved[0].host, 'manual.example');
  assert.equal(saved[0].url, 'https://manual.example');
  assert.equal(saved[0].password, 'secret');

  dom.window.close();
});

test('设置页：回填配置、保存并测试连接、渲染密码库', { skip }, async () => {
  const settings = {
    webdavUrl: 'https://dav.example.com/pwdmg/vault.json',
    username: 'me',
    password: 'secret',
    authType: 'basic',
    token: '',
    createDirs: true,
    autoSave: true,
    autoPrompt: true,
    autoOpenPanel: false,
    autoFillSingle: true,
    syncIntervalMin: 30,
  };

  let storedSettings = null;
  const { chrome, calls } = makeChrome({
    storage: { settings },
    onSet: (items) => {
      if (items.settings) storedSettings = items.settings;
    },
    sendMessage: async (message) => {
      if (message.type === 'vault:list') {
        return {
          ok: true,
          configured: true,
          dirty: false,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
          vault: VAULT,
          settings,
        };
      }
      if (message.type === 'vault:test') {
        return { ok: true, exists: true, bytes: 2048, message: '连接成功，已找到远端文件' };
      }
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/options/options.html'), {
    url: 'https://localhost/options.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(SHARED.webdav);
  window.eval(SHARED.csv);
  window.eval(SHARED.store);
  window.eval(read('src/options/options.js'));

  await until(() => window.document.querySelectorAll('#vault-list li').length === 3, '渲染密码库列表');
  assert.equal(window.document.getElementById('wd-url').value, settings.webdavUrl);
  assert.equal(window.document.getElementById('opt-autofill').checked, true);
  assert.equal(window.document.getElementById('opt-autoopen').checked, false);
  assert.equal(window.document.getElementById('opt-interval').value, '30');
  assert.equal(window.document.getElementById('vault-count').textContent, '3');

  // 保存并测试连接
  window.document.getElementById('save-conn').click();
  await until(() => /连接成功/.test(window.document.getElementById('conn-result').textContent), '显示连接结果');
  assert.equal(window.document.getElementById('conn-result').dataset.state, 'ok');
  assert.equal(calls.permissions.length, 1);
  assert.equal(calls.permissions[0].origins[0], 'https://dav.example.com/*');
  assert.ok(storedSettings, '设置已写入 storage');
  assert.equal(storedSettings.webdavUrl, settings.webdavUrl);

  dom.window.close();
});

test('弹窗：加密未解锁时只显示解锁框，解锁后恢复账号列表', { skip }, async () => {
  const emptyVault = { version: 1, updatedAt: new Date().toISOString(), entries: [], tombstones: {} };
  const responses = [
    {
      ok: true,
      configured: true,
      dirty: false,
      lastSyncAt: null,
      lastError: null,
      encrypted: true,
      locked: true,
      vault: emptyVault,
    },
    {
      ok: true,
      configured: true,
      dirty: false,
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      encrypted: true,
      locked: false,
      vault: VAULT,
    },
  ];
  let listCalls = 0;
  const unlocks = [];
  const { chrome } = makeChrome({
    sendMessage: async (message) => {
      if (message.type === 'vault:list') return responses[Math.min(listCalls++, 1)];
      if (message.type === 'vault:unlock') {
        unlocks.push(message.password);
        return { ok: true, entries: 3 };
      }
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/popup/popup.html'), {
    url: 'https://localhost/popup.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;
  window.close = () => undefined;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(read('src/popup/popup.js'));

  await until(() => window.document.getElementById('lock-box').hidden === false, '显示解锁框');
  assert.equal(window.document.getElementById('site-card').hidden, true);
  assert.equal(window.document.getElementById('lock-btn').hidden, true);
  assert.equal(window.document.getElementById('add-toggle').hidden, true);
  assert.equal(window.document.getElementById('status').textContent, '已加密 · 未解锁');

  window.document.getElementById('unlock-password').value = 'master-pass';
  window.document.getElementById('unlock-btn').click();

  await until(() => unlocks.length === 1, '发送解锁请求');
  assert.equal(unlocks[0], 'master-pass');
  await until(() => window.document.querySelectorAll('.entry').length === 2, '解锁后显示账号');
  assert.equal(window.document.getElementById('lock-box').hidden, true);
  assert.equal(window.document.getElementById('lock-btn').hidden, false);
  dom.window.close();
});

test('设置页：加密状态下可以解锁，未启用时可以设置主密码', { skip }, async () => {
  const settingsLocked = {
    webdavUrl: 'https://dav.example.com/pwdmg/vault.json',
    username: 'me',
    password: 'secret',
    authType: 'basic',
    token: '',
    createDirs: true,
    encryptVault: true,
    autoSave: true,
    autoPrompt: true,
    autoOpenPanel: false,
    autoFillSingle: true,
    confirmPasswordChange: true,
    syncIntervalMin: 15,
  };

  let listResponse = {
    ok: true,
    configured: true,
    dirty: false,
    lastSyncAt: null,
    lastError: null,
    encrypted: true,
    locked: true,
    kdfIterations: 310000,
    vault: { version: 1, updatedAt: new Date().toISOString(), entries: [], tombstones: {} },
    settings: settingsLocked,
  };
  const unlocks = [];
  const enables = [];

  const { chrome } = makeChrome({
    storage: { settings: settingsLocked },
    sendMessage: async (message) => {
      if (message.type === 'vault:list') return listResponse;
      if (message.type === 'vault:unlock') {
        unlocks.push(message.password);
        listResponse = Object.assign({}, listResponse, { locked: false, vault: VAULT, encrypted: true });
        return { ok: true, entries: 3 };
      }
      if (message.type === 'vault:enableEncryption') {
        enables.push(message.password);
        return { ok: true, encrypted: true, entries: 0 };
      }
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/options/options.html'), {
    url: 'https://localhost/options.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;
  window.confirm = () => true;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(SHARED.webdav);
  window.eval(SHARED.csv);
  window.eval(SHARED.store);
  window.eval(read('src/options/options.js'));

  await until(() => window.document.getElementById('enc-unlock').hidden === false, '显示解锁区');
  assert.equal(window.document.getElementById('enc-enable').hidden, true);
  assert.equal(window.document.getElementById('enc-manage').hidden, true);
  assert.match(window.document.getElementById('enc-status').textContent, /锁定/);

  window.document.getElementById('enc-unlock-pass').value = 'master-pass';
  window.document.getElementById('enc-unlock-btn').click();
  await until(() => unlocks.length === 1, '发送解锁请求');
  assert.equal(unlocks[0], 'master-pass');
  await until(() => window.document.getElementById('enc-manage').hidden === false, '解锁后显示管理区');
  assert.equal(window.document.getElementById('enc-unlock').hidden, true);
  assert.match(window.document.getElementById('enc-status').textContent, /已启用加密/);

  dom.window.close();
});

test('设置页：未加密时可以设置主密码启用加密', { skip }, async () => {
  const settingsPlain = {
    webdavUrl: 'https://dav.example.com/pwdmg/vault.json',
    username: 'me',
    password: 'secret',
    authType: 'basic',
    token: '',
    createDirs: true,
    encryptVault: false,
    autoSave: true,
    autoPrompt: true,
    autoOpenPanel: false,
    autoFillSingle: true,
    confirmPasswordChange: true,
    syncIntervalMin: 15,
  };

  let listResponse = {
    ok: true,
    configured: true,
    dirty: false,
    lastSyncAt: new Date().toISOString(),
    lastError: null,
    encrypted: false,
    locked: false,
    vault: VAULT,
    settings: settingsPlain,
  };
  const enables = [];

  const { chrome } = makeChrome({
    storage: { settings: settingsPlain },
    sendMessage: async (message) => {
      if (message.type === 'vault:list') return listResponse;
      if (message.type === 'vault:enableEncryption') {
        enables.push(message.password);
        listResponse = Object.assign({}, listResponse, { encrypted: true, locked: false });
        return { ok: true, encrypted: true, entries: 3 };
      }
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/options/options.html'), {
    url: 'https://localhost/options.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;
  window.confirm = () => true;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(SHARED.webdav);
  window.eval(SHARED.csv);
  window.eval(SHARED.store);
  window.eval(read('src/options/options.js'));

  await until(() => window.document.getElementById('enc-enable').hidden === false, '显示启用区');
  assert.match(window.document.getElementById('enc-status').textContent, /未启用加密/);

  window.document.getElementById('enc-pass1').value = 'master-pass';
  window.document.getElementById('enc-pass2').value = 'master-pass';
  window.document.getElementById('enc-enable-btn').click();

  await until(() => enables.length === 1, '发送启用请求');
  assert.equal(enables[0], 'master-pass');
  await until(() => window.document.getElementById('enc-manage').hidden === false, '启用后进入管理区');
  assert.equal(window.document.getElementById('enc-enable').hidden, true);
  dom.window.close();
});

test('设置页：地址只填到目录时保存会自动补全为 vault.json', { skip }, async () => {
  const settings = {
    webdavUrl: 'https://miya.teracloud.jp/dav/',
    username: 'me',
    password: 'secret',
    authType: 'basic',
    token: '',
    createDirs: true,
    encryptVault: false,
    autoSave: true,
    autoPrompt: true,
    autoOpenPanel: true,
    autoFillSingle: true,
    confirmPasswordChange: true,
    syncIntervalMin: 15,
  };
  let storedSettings = null;

  const { chrome } = makeChrome({
    storage: { settings },
    sendMessage: async (message) => {
      if (message.type === 'vault:list') {
        return {
          ok: true,
          configured: true,
          dirty: false,
          lastSyncAt: null,
          lastError: null,
          vault: { version: 1, updatedAt: new Date().toISOString(), entries: [], tombstones: {} },
          settings,
        };
      }
      if (message.type === 'vault:test') {
        return { ok: true, exists: false, message: '连接成功，远端文件尚不存在（首次保存时会自动创建）' };
      }
      return { ok: true };
    },
    onSet: (items) => {
      if (items.settings) storedSettings = items.settings;
    },
  });

  const dom = new JSDOM(read('src/options/options.html'), {
    url: 'https://localhost/options.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(SHARED.webdav);
  window.eval(SHARED.csv);
  window.eval(SHARED.store);
  window.eval(read('src/options/options.js'));

  await until(() => window.document.getElementById('wd-url').value !== '', '回填设置');
  window.document.getElementById('wd-url').value = 'https://miya.teracloud.jp/dav/pwdmg/';
  window.document.getElementById('save-conn').click();

  await until(() => /尚不存在/.test(window.document.getElementById('conn-result').textContent), '显示连接结果');
  assert.equal(
    window.document.getElementById('wd-url').value,
    'https://miya.teracloud.jp/dav/pwdmg/vault.json',
    '输入框应显示补全后的地址'
  );
  assert.ok(storedSettings, '设置已写入');
  assert.equal(storedSettings.webdavUrl, 'https://miya.teracloud.jp/dav/pwdmg/vault.json');

  dom.window.close();
});

test('设置页：导入 Chrome 密码 CSV（预览统计 + 跳过已存在）', { skip }, async () => {
  const settings = {
    webdavUrl: 'https://dav.example.com/pwdmg/vault.json',
    username: 'me',
    password: 'secret',
    authType: 'basic',
    token: '',
    createDirs: true,
    encryptVault: false,
    autoSave: true,
    autoPrompt: true,
    autoOpenPanel: true,
    autoFillSingle: true,
    confirmPasswordChange: true,
    syncIntervalMin: 15,
  };
  const sent = [];
  const { chrome } = makeChrome({
    storage: { settings },
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type === 'vault:list') {
        return {
          ok: true,
          configured: true,
          dirty: false,
          lastSyncAt: null,
          lastError: null,
          encrypted: false,
          locked: false,
          vault: VAULT,
          settings,
        };
      }
      if (message.type === 'vault:importEntries') {
        return {
          ok: true,
          added: message.entries.length,
          updated: 0,
          conflicts: 0,
          unchanged: 0,
          invalid: 0,
          sync: { ok: true },
        };
      }
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/options/options.html'), {
    url: 'https://localhost/options.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;
  window.confirm = () => true;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(SHARED.webdav);
  window.eval(SHARED.csv);
  window.eval(SHARED.store);
  window.eval(read('src/options/options.js'));

  await until(() => window.document.querySelectorAll('#vault-list li').length === 3, '渲染密码库列表');

  const csv = [
    'name,url,username,password,note',
    'GitHub,https://github.com/login,alice,pw-new,工作',
    'Mail,https://mail.example.com,bob,pw-bob,',
    'App,android://hash@com.example/,carol,pw-app,',
  ].join('\r\n');

  const input = window.document.getElementById('file-import');
  const file = { name: 'Chrome 密码.csv', text: async () => csv };
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));

  await until(() => /导入完成/.test(window.document.getElementById('sync-status').textContent), '显示导入结果');

  const importCall = sent.find((m) => m.type === 'vault:importEntries');
  assert.ok(importCall, '应该发送 vault:importEntries');
  assert.equal(importCall.entries.length, 2, 'android:// 条目应被跳过');
  assert.equal(importCall.overwrite, false, '默认不覆盖已有密码');
  // jsdom 里的数组属于另一个 realm，比较字符串更稳
  assert.equal(
    Array.from(importCall.entries, (e) => [e.host, e.username, e.password].join('|')).join(','),
    'github.com|alice|pw-new,mail.example.com|bob|pw-bob'
  );
  assert.match(window.document.getElementById('sync-status').textContent, /新增 2/);

  dom.window.close();
});

test('设置页：渲染快照列表、导出提醒与「以本地覆盖远端」', { skip }, async () => {
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const settings = {
    webdavUrl: 'https://dav.example.com/pwdmg/vault.json',
    username: 'me',
    password: 'secret',
    authType: 'basic',
    token: '',
    createDirs: true,
    autoSave: true,
    autoPrompt: true,
    autoOpenPanel: false,
    autoFillSingle: true,
    syncIntervalMin: 30,
    lastExportAt: old,
  };

  const { chrome, calls } = makeChrome({
    storage: { settings },
    sendMessage: async (message) => {
      if (message.type === 'vault:list') {
        return {
          ok: true,
          configured: true,
          dirty: false,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
          vault: VAULT,
          settings,
        };
      }
      if (message.type === 'vault:history') {
        return {
          ok: true,
          items: [
            { at: new Date().toISOString(), kind: 'remote', bytes: 2048, entries: 2, encrypted: false },
            { at: old, kind: 'before-import', bytes: 4096, entries: 3, encrypted: true },
          ],
        };
      }
      if (message.type === 'vault:push') return { ok: true, entries: 3 };
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/options/options.html'), {
    url: 'https://localhost/options.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;
  window.confirm = () => true;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(SHARED.webdav);
  window.eval(SHARED.csv);
  window.eval(SHARED.store);
  window.eval(read('src/options/options.js'));

  await until(() => window.document.querySelectorAll('#history-list li').length === 2, '渲染快照列表');
  const rows = Array.from(window.document.querySelectorAll('#history-list li'));
  assert.equal(window.document.getElementById('history-empty').hidden, true);
  assert.equal(rows[0].querySelector('button').textContent, '恢复');
  assert.match(rows[0].querySelector('.kind').textContent, /2 个账号/);
  assert.match(rows[1].querySelector('.kind').textContent, /密文/);

  // 超过一周没导出要提醒
  const hint = window.document.getElementById('export-hint');
  assert.match(hint.textContent, /超过一周/);
  assert.equal(hint.dataset.state, 'warn');

  // 点「以本地覆盖远端」→ 二次确认后发送 vault:push
  window.document.getElementById('btn-push').click();
  await until(() => calls.messages.some((m) => m.type === 'vault:push'), '发送 vault:push');
  await until(() => /已用本地覆盖远端/.test(window.document.getElementById('sync-status').textContent), '显示覆盖结果');

  dom.window.close();
});

test('设置页：后台留下严重提示时显示横幅，点「知道了」可清除', { skip }, async () => {
  const settings = {
    webdavUrl: 'https://dav.example.com/pwdmg/vault.json',
    authType: 'basic',
    username: 'me',
    password: 'secret',
    token: '',
    createDirs: true,
  };
  const notice = '远端密码库是明文，本地也找不到主密码参数，主密码加密已失效。';

  const { chrome, calls } = makeChrome({
    storage: { settings },
    sendMessage: async (message) => {
      if (message.type === 'vault:list') {
        return {
          ok: true,
          configured: true,
          dirty: false,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
          encrypted: false,
          locked: false,
          notice,
          vault: VAULT,
          settings,
        };
      }
      if (message.type === 'vault:clearNotice') return { ok: true };
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/options/options.html'), {
    url: 'https://localhost/options.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(SHARED.webdav);
  window.eval(SHARED.csv);
  window.eval(SHARED.store);
  window.eval(read('src/options/options.js'));

  await until(() => window.document.getElementById('notice-bar').hidden === false, '显示提示横幅');
  assert.equal(window.document.getElementById('notice-text').textContent, notice);
  assert.equal(window.document.getElementById('notice-bar').dataset.state, 'error');

  window.document.getElementById('notice-dismiss').click();
  await until(() => calls.messages.some((m) => m.type === 'vault:clearNotice'), '发送清除提示请求');
  await until(() => window.document.getElementById('notice-bar').hidden === true, '横幅收起');

  dom.window.close();
});

test('弹窗：后台提示（如加密参数丢失）会在横幅里显示', { skip }, async () => {
  const notice = '远端密码库是明文，本地也找不到主密码参数，主密码加密已失效。';
  const { chrome } = makeChrome({
    sendMessage: async (message) => {
      if (message.type === 'vault:list') {
        return {
          ok: true,
          configured: true,
          dirty: false,
          lastSyncAt: new Date().toISOString(),
          lastError: null,
          locked: false,
          notice,
          vault: VAULT,
        };
      }
      return { ok: true };
    },
  });

  const dom = new JSDOM(read('src/popup/popup.html'), {
    url: 'https://localhost/popup.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.chrome = chrome;
  window.browser = undefined;
  window.close = () => undefined;

  window.eval(SHARED.api);
  window.eval(SHARED.util);
  window.eval(SHARED.vault);
  window.eval(read('src/popup/popup.js'));

  await until(() => window.document.getElementById('banner').hidden === false, '显示提示横幅');
  assert.equal(window.document.getElementById('banner-text').textContent, notice);
  assert.equal(window.document.getElementById('banner-action').textContent, '打开设置');

  dom.window.close();
});
