'use strict';

/**
 * 审计回归：崩溃 / 数据丢失 / 卡死类问题的防线。
 *
 * 每个用例对应一次真实审计发现的缺陷，改这里之前先想清楚会不会把洞重新打开。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = require('node:path').resolve(__dirname, '..');
const { startWebDavServer } = require('./helpers/webdav-server.js');
const { loadBackground, waitFor } = require('./helpers/background-harness.js');
const Crypto = require(ROOT + '/src/shared/crypto.js');

function baseSettings(server, extra) {
  return Object.assign(
    {
      webdavUrl: server.baseUrl + '/pwdmg/vault.json',
      authType: 'basic',
      username: 'me',
      password: 'secret',
      createDirs: true,
      autoSave: true,
      autoPrompt: true,
      autoOpenPanel: true,
      autoFillSingle: true,
      confirmPasswordChange: true,
      syncIntervalMin: 15,
    },
    extra || {}
  );
}

const capture = (fake, username, password, host) =>
  fake.send(
    {
      type: 'credential:capture',
      url: 'https://' + (host || 'example.com') + '/login',
      username,
      password,
    },
    { url: 'https://' + (host || 'example.com') + '/login' }
  );

const plainVault = (entries) =>
  JSON.stringify(
    { version: 1, updatedAt: new Date().toISOString(), entries, tombstones: {} },
    null,
    2
  );

/* ------------------------------------------------------------------ *
 * 1. 加密参数彻底丢失时不能把密码库锁死
 * ------------------------------------------------------------------ */

test('缓存丢失且远端是明文时，降级为明文并提示重新加密（而不是永远锁定）', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());
  server.seed(
    '/pwdmg/vault.json',
    plainVault([{ id: 'e1', host: 'example.com', url: 'https://example.com', username: 'alice', password: 'pw' }])
  );

  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server, { encryptVault: true }));

  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, true, sync.error);

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.locked, false, '不能停在锁定状态');
  assert.equal(list.vault.entries.length, 1, '远端明文内容要能读到');
  assert.match(list.notice, /主密码加密已失效/);
  assert.equal(fake.store.get('settings').encryptVault, false, '设置要同步关掉，避免状态不一致');

  // 仍然可以记录新凭据
  const saved = await capture(fake, 'bob', 'pw2');
  assert.equal(saved.saved, true);

  // 用户可以重新设置主密码，提示随之消失
  const enabled = await fake.send({ type: 'vault:enableEncryption', password: 'master-pass-123' });
  assert.equal(enabled.ok, true, enabled.error);
  assert.equal((await fake.send({ type: 'vault:list' })).notice, '');
});

/* ------------------------------------------------------------------ *
 * 2. 解锁不能吃掉本地还没上传的条目
 * ------------------------------------------------------------------ */

test('远端被别的设备加密后，解锁时保留本地未同步的条目', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  // 别的设备：加密上传
  const other = loadBackground();
  other.store.set('settings', baseSettings(server));
  await capture(other, 'remote-user', 'pw-remote');
  await other.send({ type: 'vault:sync' });
  await other.send({ type: 'vault:enableEncryption', password: 'master-pass-123' });

  // 本机：先在离线状态下记录一条（同步必然失败），再把地址改回真服务器
  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server, { webdavUrl: 'http://127.0.0.1:1/pwdmg/vault.json' }));
  const offline = await capture(fake, 'offline-local', 'pw-offline');
  assert.equal(offline.saved, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fake.store.get('vaultCache').dirty, true);

  fake.store.set('settings', baseSettings(server));
  const unlock = await fake.send({ type: 'vault:unlock', password: 'master-pass-123' });
  assert.equal(unlock.ok, true, unlock.error);

  const users = (await fake.send({ type: 'vault:list' })).vault.entries.map((e) => e.username).sort();
  assert.deepEqual(users, ['offline-local', 'remote-user']);
  assert.equal(server.files.get('/pwdmg/vault.json').content.includes('"encrypted": true'), true, '不能退化成明文');
});

/* ------------------------------------------------------------------ *
 * 3. 远端文件被删除后自动补传
 * ------------------------------------------------------------------ */

test('远端文件被删掉时，下一次同步自动重建，不会“假装已同步”', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server));
  await capture(fake, 'alice', 'pw-alice');
  await fake.send({ type: 'vault:sync' });
  assert.ok(server.files.has('/pwdmg/vault.json'));

  server.files.delete('/pwdmg/vault.json');
  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, true, sync.error);
  assert.ok(server.files.has('/pwdmg/vault.json'), '本地有数据就应该补传');
  assert.equal(JSON.parse(server.files.get('/pwdmg/vault.json').content).entries.length, 1);
});

test('空密码库不会在远端凭空建文件', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());
  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server));
  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, true, sync.error);
  assert.equal(server.files.has('/pwdmg/vault.json'), false);
});

/* ------------------------------------------------------------------ *
 * 4. 信封里的 iterations 不能无限大
 * ------------------------------------------------------------------ */

test('iterations 异常的远端信封会被拒绝，不会卡住解锁', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  const kdf = Crypto.createKdf(1000);
  const key = await Crypto.deriveKey('master-pass-123', kdf);
  const envelope = await Crypto.encryptText(plainVault([]), key, kdf);
  envelope.kdf.iterations = 50000000;
  server.seed('/pwdmg/vault.json', JSON.stringify(envelope));

  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server));

  const started = Date.now();
  const unlock = await fake.send({ type: 'vault:unlock', password: 'master-pass-123' });
  assert.equal(unlock.ok, false);
  assert.match(unlock.error, /上限|篡改/);
  assert.ok(Date.now() - started < 2000, '必须立刻拒绝，而不是真的去派生 5 千万次');

  // 正常强度的信封仍然能解锁
  assert.equal(Crypto.MAX_ITERATIONS, 2000000);
  assert.throws(() => Crypto.normalizeKdf({ salt: 'AAAA', iterations: 1e9 }), /上限|篡改/);
});

/* ------------------------------------------------------------------ *
 * 5. 并发保存设置
 * ------------------------------------------------------------------ */

test('同时保存多个设置字段不会互相覆盖', async (t) => {
  const fake = loadBackground();
  t.after(() => fake.close && fake.close());
  fake.store.set('settings', { webdavUrl: 'https://dav.example.com/pwdmg/vault.json' });

  const Store = globalThis.PwdmgStore;
  await Promise.all([
    Store.saveSettings({ lastExportAt: '2025-01-01T00:00:00.000Z' }),
    Store.saveSettings({ autoOpenPanel: false }),
    Store.saveSettings({ syncIntervalMin: 30 }),
    Store.saveSettings({ autoFillSingle: false }),
  ]);

  const settings = await Store.getSettings();
  assert.equal(settings.lastExportAt, '2025-01-01T00:00:00.000Z');
  assert.equal(settings.autoOpenPanel, false);
  assert.equal(settings.syncIntervalMin, 30);
  assert.equal(settings.autoFillSingle, false);
});

/* ------------------------------------------------------------------ *
 * 6 & 7. 快照跟着密钥走
 * ------------------------------------------------------------------ */

test('修改主密码后，旧密文快照仍能恢复', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server));
  await capture(fake, 'alice', 'pw-alice');
  await fake.send({ type: 'vault:sync' });
  await fake.send({ type: 'vault:enableEncryption', password: 'master-pass-123' });
  await capture(fake, 'bob', 'pw-bob');
  await fake.send({ type: 'vault:sync' });

  const history = await fake.send({ type: 'vault:history' });
  const snapshot = history.items.find((item) => item.encrypted && item.entries === null);
  assert.ok(snapshot, '应有一份密文快照');

  const changed = await fake.send({
    type: 'vault:changeMasterPassword',
    oldPassword: 'master-pass-123',
    newPassword: 'master-pass-456',
  });
  assert.equal(changed.ok, true, changed.error);

  const restored = await fake.send({ type: 'vault:restoreHistory', at: snapshot.at });
  assert.equal(restored.ok, true, restored.error);
});

test('关闭加密后，密文快照会转成明文，仍然可以恢复', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server));
  await capture(fake, 'alice', 'pw-alice');
  await fake.send({ type: 'vault:sync' });
  await fake.send({ type: 'vault:enableEncryption', password: 'master-pass-123' });
  await capture(fake, 'bob', 'pw-bob');
  await fake.send({ type: 'vault:sync' });

  const snapshot = (await fake.send({ type: 'vault:history' })).items.find((item) => item.encrypted);
  assert.ok(snapshot);

  const off = await fake.send({ type: 'vault:disableEncryption' });
  assert.equal(off.ok, true, off.error);

  const list = await fake.send({ type: 'vault:history' });
  assert.equal(list.items.every((item) => !item.encrypted), true, '快照应该都已转成明文');

  const restored = await fake.send({ type: 'vault:restoreHistory', at: snapshot.at });
  assert.equal(restored.ok, true, restored.error);
});

/* ------------------------------------------------------------------ *
 * 8. 失败重试要退避
 * ------------------------------------------------------------------ */

test('连续同步失败时重试间隔递增，成功后复位', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server, { webdavUrl: 'http://127.0.0.1:1/pwdmg/vault.json' }));

  const delays = [];
  for (let i = 0; i < 4; i++) {
    fake.alarms.delete('pwdmg-retry');
    await fake.send({ type: 'settings:changed' });
    await waitFor(() => fake.alarms.get('pwdmg-retry'), { label: '重试闹钟' });
    delays.push(fake.alarms.get('pwdmg-retry').delayInMinutes);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.deepEqual(delays, [0.5, 1, 2, 4]);

  // 换成可用地址：同步成功后计数复位，再失败时回到 0.5 分钟
  fake.store.set('settings', baseSettings(server));
  const ok = await fake.send({ type: 'vault:sync' });
  assert.equal(ok.ok, true, ok.error);

  fake.store.set('settings', baseSettings(server, { webdavUrl: 'http://127.0.0.1:1/pwdmg/vault.json' }));
  fake.alarms.delete('pwdmg-retry');
  await fake.send({ type: 'settings:changed' });
  await waitFor(() => fake.alarms.get('pwdmg-retry'), { label: '重试闹钟' });
  assert.equal(fake.alarms.get('pwdmg-retry').delayInMinutes, 0.5, '成功后失败计数要复位');
});
