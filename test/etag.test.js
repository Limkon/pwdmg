'use strict';

/**
 * ETag 兼容性：有的 WebDAV 服务器 ETag 是弱校验符、每次都在变，或者干脆不接受 If-Match。
 * 这些服务器上「第一次建文件能成功、之后每次同步都 412」，本文件锁住降级逻辑。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = require('node:path').resolve(__dirname, '..');
const { startWebDavServer } = require('./helpers/webdav-server.js');
const { loadBackground } = require('./helpers/background-harness.js');
const D = require(ROOT + '/src/shared/webdav.js');

function settingsFor(server, extra) {
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
    { type: 'credential:capture', url: 'https://' + deviceHost(host) + '/login', username, password, force: true },
    { url: 'https://' + deviceHost(host) + '/login' }
  );

function deviceHost(host) {
  return host || 'example.com';
}

const entriesOf = (server) => JSON.parse(server.files.get('/pwdmg/vault.json').content).entries;

/* ------------------------------------------------------------------ *
 * 客户端层
 * ------------------------------------------------------------------ */

test('strongTag：弱校验符会被转成强校验符', () => {
  assert.equal(D.strongTag('W/"abc"'), '"abc"');
  assert.equal(D.strongTag('w/"abc"'), '"abc"');
  assert.equal(D.strongTag('"abc"'), '"abc"');
  assert.equal(D.strongTag('  W/"a b"  '), '"a b"');
  assert.equal(D.strongTag(null), '');
  assert.equal(D.isWeakTag('W/"abc"'), true);
  assert.equal(D.isWeakTag('"abc"'), false);
  assert.equal(D.isWeakTag(null), false);
});

test('write：conditional:false 时不发送 If-Match', async (t) => {
  const server = await startWebDavServer();
  t.after(() => server.close());

  const client = D.createClient({ url: server.baseUrl + '/vault.json' });
  const first = await client.write('{"a":1}', {});
  await client.write('{"a":2}', { etag: first.etag, conditional: false });

  const puts = server.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.equal(puts[1].ifMatch, null, '兼容模式下不能带 If-Match');
});

test('write：弱 ETag 用强形式发送，能写入', async (t) => {
  const server = await startWebDavServer({ weakEtag: true });
  t.after(() => server.close());

  const client = D.createClient({ url: server.baseUrl + '/vault.json' });
  const first = await client.write('{"a":1}', {});
  assert.match(first.etag, /^W\//, '假服务器返回弱 ETag');
  const again = await client.write('{"a":2}', { etag: first.etag });
  assert.ok(again.etag);
  assert.equal((await client.read()).text, '{"a":2}');
});

/* ------------------------------------------------------------------ *
 * 同步层
 * ------------------------------------------------------------------ */

test('服务器返回弱 ETag 时，同步照常上传', async (t) => {
  const server = await startWebDavServer({ weakEtag: true });
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', settingsFor(server));
  assert.equal((await capture(fake, 'alice', 'pw-1')).saved, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await capture(fake, 'bob', 'pw-2')).saved, true);

  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, true, sync.error);
  assert.equal(entriesOf(server).length, 2);
  assert.ok(!(fake.store.get('settings') || {}).noIfMatch, '弱 ETag 能修好，不该降级');
});

test('ETag 每次都变时自动降级为兼容模式，并留下提示', async (t) => {
  const server = await startWebDavServer({ rotatingEtag: true });
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', settingsFor(server));
  await capture(fake, 'alice', 'pw-1');
  await new Promise((r) => setTimeout(r, 150));
  await capture(fake, 'bob', 'pw-2');

  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, true, sync.error);
  assert.equal(sync.compat, true, '应该已经切到兼容模式');
  assert.equal(entriesOf(server).length, 2, '数据必须写进远端');

  const settings = fake.store.get('settings');
  assert.equal(settings.noIfMatch, true, '兼容模式要写进设置');
  const list = await fake.send({ type: 'vault:list' });
  assert.match(list.notice, /412|兼容模式/);

  // 之后的同步不再需要试探，直接成功
  const again = await fake.send({ type: 'vault:sync' });
  assert.equal(again.ok, true, again.error);
});

test('服务器完全不接受 If-Match 时，同步最终仍能成功', async (t) => {
  const server = await startWebDavServer({ rejectIfMatch: true });
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', settingsFor(server));
  await capture(fake, 'alice', 'pw-1');
  await new Promise((r) => setTimeout(r, 150));
  await capture(fake, 'bob', 'pw-2');

  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, true, sync.error);
  assert.deepEqual(
    entriesOf(server).map((e) => e.username).sort(),
    ['alice', 'bob']
  );
  assert.equal(fake.store.get('settings').noIfMatch, true);

  // 后续改动也能同步上去（这才是关键：不是「只能写一次」）
  await capture(fake, 'carol', 'pw-3');
  await new Promise((r) => setTimeout(r, 250));
  const remote = JSON.parse(server.files.get('/pwdmg/vault.json').content);
  assert.ok(remote.entries.some((e) => e.username === 'carol'), '新账号要能上去');
});

test('勾选兼容模式后，第一次写入就不带 If-Match', async (t) => {
  const server = await startWebDavServer({ rejectIfMatch: true });
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', settingsFor(server, { noIfMatch: true }));
  await capture(fake, 'alice', 'pw-1');
  await new Promise((r) => setTimeout(r, 150));
  await capture(fake, 'bob', 'pw-2');

  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, true, sync.error);

  const puts = server.calls.filter((c) => c.method === 'PUT');
  assert.ok(puts.length >= 1);
  assert.equal(puts.every((c) => c.ifMatch === null), true, '兼容模式下所有 PUT 都不该带 If-Match');
});

test('远端已有文件、第一次就 412 时，用本地覆盖远端也能成功', async (t) => {
  const server = await startWebDavServer({ rejectIfMatch: true });
  t.after(() => server.close());
  server.seed(
    '/pwdmg/vault.json',
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: [], tombstones: {} })
  );

  const fake = loadBackground();
  fake.store.set('settings', settingsFor(server));
  await capture(fake, 'alice', 'pw-1');
  await new Promise((r) => setTimeout(r, 150));

  const pushed = await fake.send({ type: 'vault:push' });
  assert.equal(pushed.ok, true, pushed.error);
  assert.equal(pushed.entries, 1);
  assert.equal(entriesOf(server).length, 1);
  assert.equal(fake.store.get('settings').noIfMatch, true);
});

test('另一台设备只读拉取正常，写入会自动降级（模拟 TeraCLOUD 那类服务器）', async (t) => {
  const server = await startWebDavServer({ weakEtag: true, rejectIfMatch: true });
  t.after(() => server.close());

  // 设备 A：建库并上传
  const a = loadBackground();
  a.store.set('settings', settingsFor(server));
  await capture(a, 'alice', 'pw-1');
  await new Promise((r) => setTimeout(r, 150));
  await capture(a, 'bob', 'pw-2');
  const syncA = await a.send({ type: 'vault:sync' });
  assert.equal(syncA.ok, true, syncA.error);

  // 设备 B：全新环境，只配置了地址
  const b = loadBackground();
  b.store.set('settings', settingsFor(server));
  const syncB = await b.send({ type: 'vault:sync' });
  assert.equal(syncB.ok, true, syncB.error);
  const listB = await b.send({ type: 'vault:list' });
  assert.deepEqual(
    listB.vault.entries.map((e) => e.username).sort(),
    ['alice', 'bob'],
    '新设备要能把远端密码库拉下来'
  );

  // 设备 B 记录新账号：写入走兼容模式，远端要真的更新
  await capture(b, 'carol', 'pw-3');
  await new Promise((r) => setTimeout(r, 300));
  const remoteNames = entriesOf(server).map((e) => e.username).sort();
  assert.deepEqual(remoteNames, ['alice', 'bob', 'carol']);
});

test('兼容模式下加密库依然只写密文', async (t) => {
  const server = await startWebDavServer({ rejectIfMatch: true });
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', settingsFor(server));
  const enabled = await fake.send({ type: 'vault:enableEncryption', password: 'master-pass-123' });
  assert.equal(enabled.ok, true, enabled.error);
  await capture(fake, 'alice', 'pw-1');
  await new Promise((r) => setTimeout(r, 250));

  const text = server.files.get('/pwdmg/vault.json').content;
  assert.equal(text.includes('"encrypted": true'), true);
  assert.equal(text.includes('pw-1'), false, '远端不能出现明文密码');

  // 还能正常解锁并读回
  const other = loadBackground();
  other.store.set('settings', settingsFor(server));
  const unlock = await other.send({ type: 'vault:unlock', password: 'master-pass-123' });
  assert.equal(unlock.ok, true, unlock.error);
  assert.equal(
    (await other.send({ type: 'vault:list' })).vault.entries.some((e) => e.username === 'alice'),
    true
  );
});
