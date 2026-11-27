'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startWebDavServer } = require('./helpers/webdav-server.js');
const { loadBackground, waitFor } = require('./helpers/background-harness.js');

const SHARED = (name) => require(path.resolve(__dirname, '..', 'src/shared', name));

function baseSettings(server) {
  return {
    webdavUrl: server.baseUrl + '/pwdmg/vault.json',
    authType: 'basic',
    username: 'me',
    password: 'secret',
    createDirs: true,
    autoSave: true,
    autoPrompt: true,
    autoOpenPanel: true,
    autoFillSingle: true,
    syncIntervalMin: 15,
  };
}

async function setup(t, settingsOverrides) {
  const server = await startWebDavServer({ auth: { username: 'me', password: 'secret' } });
  t.after(() => server.close());
  const fake = loadBackground();
  fake.store.set('settings', Object.assign(baseSettings(server), settingsOverrides || {}));
  return { server, fake };
}

test('未配置 WebDAV 时保存到本地并报告未配置', async (t) => {
  const server = await startWebDavServer();
  t.after(() => server.close());
  const fake = loadBackground();

  const state = await fake.send({ type: 'content:getState', url: 'https://example.com/login' });
  assert.equal(state.ok, true);
  assert.equal(state.configured, false);
  assert.deepEqual(state.entries, []);

  const captured = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'pw1' },
    { url: 'https://example.com/login' }
  );
  assert.equal(captured.saved, true);
  assert.equal(captured.action, 'created');

  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, false);
  assert.equal(sync.configured, false);

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.dirty, true);
  assert.equal(list.vault.entries.length, 1);
});

test('记录凭据 → 自动上传 WebDAV → 其他设备能读到', async (t) => {
  const { server, fake } = await setup(t);

  const captured = await fake.send(
    {
      type: 'credential:capture',
      url: 'https://example.com/login?next=/home',
      username: 'alice',
      password: 's3cret!',
      title: 'Example Login',
    },
    { url: 'https://example.com/login?next=/home' }
  );
  assert.equal(captured.saved, true);

  // 后台会在响应后异步上传
  const remote = await waitFor(
    async () => {
      const file = server.files.get('/pwdmg/vault.json');
      return file && /s3cret!/.test(file.content) ? file : null;
    },
    { label: '上传 vualt.json' }
  );

  const parsed = SHARED('vault').parse(remote.content);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].host, 'example.com');
  assert.equal(parsed.entries[0].username, 'alice');
  assert.equal(parsed.entries[0].password, 's3cret!');

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.dirty, false);
  assert.ok(list.lastSyncAt);
  assert.equal(list.lastError, null);
});

test('站点匹配、填充数据与“使用次数”', async (t) => {
  const { fake } = await setup(t);

  await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'pw' },
    { url: 'https://example.com/login' }
  );
  await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'bob', password: 'pw2' },
    { url: 'https://example.com/login' }
  );

  // 子域名也能匹配
  const state = await fake.send({ type: 'content:getState', url: 'https://app.example.com/signin' });
  assert.equal(state.entries.length, 2);
  assert.ok(state.entries.every((e) => typeof e.password === 'string'));

  // 其他站点不匹配
  const other = await fake.send({ type: 'content:getState', url: 'https://not-example.org/' });
  assert.equal(other.entries.length, 0);

  // 使用次数记录
  const entryId = state.entries[0].id;
  await fake.send({ type: 'credential:used', id: entryId });
  const list = await fake.send({ type: 'vault:list' });
  const used = list.vault.entries.find((e) => e.id === entryId);
  assert.ok(used.useCount >= 1);
});

test('多设备合并：远端新增会拉下来，本地改动会上传', async (t) => {
  const { server, fake } = await setup(t);
  const Vault = SHARED('vault');

  // 远端已有另一个设备的账号
  const remoteVault = Vault.empty();
  const remoteEntry = Vault.upsert(remoteVault, {
    url: 'https://example.com/login',
    username: 'remote-user',
    password: 'remote-pw',
  });
  server.seed('/pwdmg/vault.json', Vault.serialize(remoteEntry.vault));

  const sync1 = await fake.send({ type: 'vault:sync' });
  assert.equal(sync1.ok, true);

  let list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 1);
  assert.equal(list.vault.entries[0].username, 'remote-user');

  // 本地再记录一条，应该合并后一起上传
  await fake.send(
    { type: 'credential:capture', url: 'https://site.example.org/login', username: 'local-user', password: 'local-pw' },
    { url: 'https://site.example.org/login' }
  );

  const file = await waitFor(
    async () => {
      const current = server.files.get('/pwdmg/vault.json');
      if (!current) return null;
      const parsed = Vault.parse(current.content);
      return parsed.entries.length === 2 ? current : null;
    },
    { label: '远端同时存在两条记录' }
  );

  const parsed = Vault.parse(file.content);
  const usernames = parsed.entries.map((e) => e.username).sort();
  assert.deepEqual(usernames, ['local-user', 'remote-user']);

  // 本地缓存也被远端内容更新
  list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 2);
});

test('删除会写入墓碑并同步到远端', async (t) => {
  const { server, fake } = await setup(t);
  const Vault = SHARED('vault');

  const captured = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'pw' },
    { url: 'https://example.com/login' }
  );

  await waitFor(async () => server.files.get('/pwdmg/vault.json'), { label: '首次上传' });

  const del = await fake.send({ type: 'vault:deleteEntry', id: captured.entry.id });
  assert.equal(del.ok, true);

  const file = await waitFor(
    async () => {
      const current = server.files.get('/pwdmg/vault.json');
      if (!current) return null;
      const parsed = Vault.parse(current.content);
      return parsed.entries.length === 0 ? current : null;
    },
    { label: '远端条目被删除' }
  );

  const parsed = Vault.parse(file.content);
  assert.ok(parsed.tombstones[captured.entry.id], '应保留删除墓碑');
});

test('关闭自动记录后不再捕获', async (t) => {
  const { fake } = await setup(t, { autoSave: false });
  const res = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'pw' },
    { url: 'https://example.com/login' }
  );
  assert.equal(res.saved, false);
  assert.equal(res.reason, 'disabled');
});

test('使用 sender 提供的真实地址，忽略伪造的 message.url', async (t) => {
  const { fake } = await setup(t);
  const res = await fake.send(
    { type: 'credential:capture', url: 'https://evil.example/', username: 'alice', password: 'pw' },
    { url: 'https://bank.example/login' }
  );
  assert.equal(res.saved, true);
  assert.equal(res.entry.host, 'bank.example');
});

test('相同凭据重复提交不会产生重复条目', async (t) => {
  const { fake } = await setup(t);
  const message = { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'pw' };
  const sender = { url: 'https://example.com/login' };

  const first = await fake.send(message, sender);
  const second = await fake.send(message, sender);
  assert.equal(first.saved, true);
  assert.equal(second.saved, false);

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 1);
});

test('WebDAV 认证失败会记录错误，但本地数据不丢', async (t) => {
  const server = await startWebDavServer({ auth: { username: 'me', password: 'right' } });
  t.after(() => server.close());
  const fake = loadBackground();
  fake.store.set(
    'settings',
    Object.assign(baseSettings(server), { password: 'wrong' })
  );

  await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'pw' },
    { url: 'https://example.com/login' }
  );

  const failed = await waitFor(
    async () => {
      const list = await fake.send({ type: 'vault:list' });
      return list.lastError ? list : null;
    },
    { label: '记录同步错误' }
  );
  assert.match(failed.lastError, /认证失败/);
  assert.equal(failed.vault.entries.length, 1);
  assert.equal(failed.dirty, true);
});

test('导入 / 导出密码库', async (t) => {
  const { fake } = await setup(t);
  const Vault = SHARED('vault');

  const source = Vault.empty();
  const seeded = Vault.upsert(source, { url: 'https://imported.example/', username: 'u', password: 'p' });
  const text = Vault.serialize(seeded.vault);

  const imported = await fake.send({ type: 'vault:import', text });
  assert.equal(imported.ok, true);
  assert.equal(imported.imported, 1);

  const exported = await fake.send({ type: 'vault:export' });
  assert.equal(exported.ok, true);
  const parsed = Vault.parse(exported.text);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].username, 'u');
});

test('保存 / 编辑条目走 vault:saveEntry', async (t) => {
  const { fake } = await setup(t);
  const saved = await fake.send({
    type: 'vault:saveEntry',
    entry: {
      id: 'fixed-id',
      url: 'https://manual.example/login',
      host: 'manual.example',
      username: 'manual-user',
      password: 'manual-pw',
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.action, 'created');

  const updated = await fake.send({
    type: 'vault:saveEntry',
    entry: {
      id: 'fixed-id',
      url: 'https://manual.example/login',
      host: 'manual.example',
      username: 'manual-user',
      password: 'new-pw',
    },
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.action, 'updated');

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 1);
  assert.equal(list.vault.entries[0].password, 'new-pw');
});

test('WebDAV 不可达时返回可读错误', async (t) => {
  const fake = loadBackground();
  fake.store.set('settings', {
    webdavUrl: 'http://127.0.0.1:9/vault.json',
    authType: 'none',
    createDirs: true,
    autoSave: true,
  });
  const res = await fake.send({ type: 'vault:sync' });
  assert.equal(res.ok, false);
  assert.match(res.error, /网络请求失败|ECONNREFUSED|fetch failed/i);
});

test('同步上传进行中删除条目，删除不会被旧快照覆盖', async (t) => {
  const server = await startWebDavServer({ putDelayMs: 250 });
  t.after(() => server.close());
  const fake = loadBackground();
  fake.store.set(
    'settings',
    Object.assign(baseSettings(server), { authType: 'none', username: '', password: '' })
  );
  const Vault = SHARED('vault');

  const captured = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'pw' },
    { url: 'https://example.com/login' }
  );
  assert.equal(captured.saved, true);

  // 上传还在 250ms 的延迟里，立刻删除
  const del = await fake.send({ type: 'vault:deleteEntry', id: captured.entry.id });
  assert.equal(del.ok, true);

  const file = await waitFor(
    async () => {
      const current = server.files.get('/pwdmg/vault.json');
      if (!current) return null;
      const parsed = Vault.parse(current.content);
      return parsed.entries.length === 0 ? current : null;
    },
    { label: '远端最终为空', timeout: 5000 }
  );

  const parsed = Vault.parse(file.content);
  assert.equal(parsed.entries.length, 0);
  assert.ok(parsed.tombstones[captured.entry.id], '墓碑应被上传');

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 0, '本地也不能复活已删除条目');
});

test('分步登录：只有密码框时沿用该站点唯一账号的用户名', async (t) => {
  const { fake } = await setup(t);
  const first = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'old-pw' },
    { url: 'https://example.com/login' }
  );
  assert.equal(first.saved, true);

  // 第二步页面只有密码框（拿不到用户名），密码也换了：应先提示确认
  const second = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: '', password: 'new-pw' },
    { url: 'https://example.com/login' }
  );
  assert.equal(second.saved, false);
  assert.equal(second.reason, 'password-changed');

  const confirmed = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: '', password: 'new-pw', force: true },
    { url: 'https://example.com/login' }
  );
  assert.equal(confirmed.saved, true);
  assert.equal(confirmed.action, 'updated');

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 1);
  assert.equal(list.vault.entries[0].username, 'alice');
  assert.equal(list.vault.entries[0].password, 'new-pw');
});

test('远端返回网页时同步失败，并给出「不是密码库文件」的提示', async (t) => {
  const server = await startWebDavServer({
    auth: { username: 'me', password: 'secret' },
    htmlPages: {
      '/pwdmg/vault.json':
        '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN"><html><head><title>登录</title></head></html>',
    },
  });
  t.after(() => server.close());
  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server));

  const res = await fake.send({ type: 'vault:sync' });
  assert.equal(res.ok, false);
  assert.match(res.error, /返回的是网页/);

  const status = await fake.send({ type: 'vault:status' });
  assert.match(status.lastError, /返回的是网页/);
  assert.doesNotMatch(status.lastError, /Unexpected token/);
});

test('地址只填到目录时，测试连接和保存都落到 vault.json', async (t) => {
  const server = await startWebDavServer({ auth: { username: 'me', password: 'secret' } });
  t.after(() => server.close());
  const fake = loadBackground();

  const dirSettings = Object.assign(baseSettings(server), {
    webdavUrl: server.baseUrl + '/pwdmg/',
  });

  const test = await fake.send({ type: 'vault:test', settings: dirSettings });
  assert.equal(test.ok, true, test.error);
  assert.equal(test.exists, false);
  assert.match(test.message, /尚不存在/);

  fake.store.set('settings', dirSettings);
  const saved = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'pw-dir' },
    { url: 'https://example.com/login' }
  );
  assert.equal(saved.saved, true, saved.reason);

  await waitFor(
    () => (server.files.has('/pwdmg/vault.json') ? true : null),
    { label: '写入补全后的 vault.json' }
  );
  assert.equal(server.dirs.has('/pwdmg/'), true);
  assert.equal(server.files.get('/pwdmg/vault.json').content.includes('pw-dir'), true);
});

/* ------------------------------------------------------------------ *
 * 共享电脑模式：闲置自动锁定（真正的活动闲置检测，chrome.idle / browser.idle）
 *
 * 用系统级「有没有键盘鼠标输入」来判断闲置，而不是「解锁后固定 N 分钟」的
 * 倒计时——之前那版倒计时会被后台杂事（周期同步 / 失败重试）不断续命，导致
 * 挂着页面不操作也永远不锁；现在只要系统真的报告 idle / locked 才会锁。
 * ------------------------------------------------------------------ */

const MASTER = 'master-pass-123';

test('共享电脑模式：解锁后按闲置分钟数设置 idle 检测间隔', async (t) => {
  const fake = loadBackground();
  fake.store.set('settings', {}); // 未配置 WebDAV，纯本地也要能用

  const enabled = await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  assert.equal(enabled.ok, true, enabled.error);

  fake.store.set('settings', { sharedMode: true, autoLockMinutes: 15 });
  await fake.send({ type: 'settings:changed' });

  await waitFor(() => fake.idle.detectionInterval === 15 * 60, { label: 'idle 检测间隔' });
  assert.equal(fake.idle.detectionInterval, 15 * 60);
});

test('共享电脑模式：系统报告 idle 状态时锁定密码库', async (t) => {
  const fake = loadBackground();
  fake.store.set('settings', {});
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  fake.store.set('settings', { sharedMode: true, autoLockMinutes: 15 });
  await fake.send({ type: 'settings:changed' });

  const before = await fake.send({ type: 'vault:status' });
  assert.equal(before.locked, false);

  fake.triggerIdle('idle');
  await waitFor(async () => (await fake.send({ type: 'vault:status' })).locked, { label: '系统闲置后锁定' });
  const after = await fake.send({ type: 'vault:status' });
  assert.equal(after.locked, true);
});

test('共享电脑模式：锁屏（locked 状态）同样会触发锁定', async (t) => {
  const fake = loadBackground();
  fake.store.set('settings', {});
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  fake.store.set('settings', { sharedMode: true, autoLockMinutes: 5 });
  await fake.send({ type: 'settings:changed' });

  fake.triggerIdle('locked');
  await waitFor(async () => (await fake.send({ type: 'vault:status' })).locked, { label: '锁屏后锁定' });
});

test('共享电脑模式：没开共享模式 / 没加密时，系统闲置不会锁定', async (t) => {
  const fake = loadBackground();
  fake.store.set('settings', {}); // sharedMode 默认关闭
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });

  fake.triggerIdle('idle');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const status = await fake.send({ type: 'vault:status' });
  assert.equal(status.locked, false, '没开共享模式时闲置检测不应该生效');
});

test('共享电脑模式：service worker 被动唤醒时补查一次 idle 状态（防止错过事件）', async (t) => {
  const fake = loadBackground();
  fake.store.set('settings', {});
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  fake.store.set('settings', { sharedMode: true, autoLockMinutes: 15 });
  await fake.send({ type: 'settings:changed' });

  // 模拟「状态变化恰好发生在 service worker 被回收期间，onStateChanged
  // 事件被错过了」：不调用 triggerIdle（不派发事件），只是让浏览器维护的
  // 闲置状态变成 idle，chrome.storage.session 也照样带过去（浏览器没重启）。
  const fresh = loadBackground({
    store: fake.store,
    session: fake.session,
    idle: { current: 'idle', detectionInterval: fake.idle.detectionInterval },
  });
  await waitFor(async () => (await fresh.send({ type: 'vault:status' })).locked, {
    label: '被动唤醒时补查 idle 状态并锁定',
  });
});

test('共享电脑模式：锁定后手动解锁，之后系统活跃不会被误锁', async (t) => {
  const fake = loadBackground();
  fake.store.set('settings', {});
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  fake.store.set('settings', { sharedMode: true, autoLockMinutes: 5 });
  await fake.send({ type: 'settings:changed' });

  fake.triggerIdle('idle');
  await waitFor(async () => (await fake.send({ type: 'vault:status' })).locked, { label: '先闲置锁定一次' });

  const unlocked = await fake.send({ type: 'vault:unlock', password: MASTER });
  assert.equal(unlocked.ok, true, unlocked.error);

  fake.triggerIdle('active');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const status = await fake.send({ type: 'vault:status' });
  assert.equal(status.locked, false, 'active 状态不应该触发任何锁定逻辑');
});
