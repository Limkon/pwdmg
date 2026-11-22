'use strict';

/**
 * 兜底能力：历史快照、本地覆盖远端、恢复、导出提醒。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startWebDavServer } = require('./helpers/webdav-server.js');
const { loadBackground, waitFor } = require('./helpers/background-harness.js');

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
    confirmPasswordChange: true,
    syncIntervalMin: 15,
  };
}

async function setup(t, extra) {
  const server = await startWebDavServer(Object.assign({ auth: { username: 'me', password: 'secret' } }, extra || {}));
  t.after(() => server.close());
  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server));
  return { server, fake };
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

/* ------------------------------------------------------------------ *
 * 历史快照
 * ------------------------------------------------------------------ */

test('每次覆盖远端前会把旧文件留成本地快照', async (t) => {
  const { server, fake } = await setup(t);

  await capture(fake, 'alice', 'pw-alice');
  await waitFor(() => (server.files.has('/pwdmg/vault.json') ? true : null), { label: '第一次上传' });

  let history = await fake.send({ type: 'vault:history' });
  assert.equal(history.items.length, 0, '远端本来不存在，不需要快照');

  await capture(fake, 'bob', 'pw-bob');
  await waitFor(() => {
    const file = server.files.get('/pwdmg/vault.json');
    return file && file.content.includes('pw-bob') ? true : null;
  }, { label: '第二次上传' });

  history = await fake.send({ type: 'vault:history' });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].kind, 'remote');
  assert.equal(history.items[0].entries, 1, '快照里只有覆盖前的那条账号');
  assert.equal(history.items[0].encrypted, false);
  assert.ok(history.items[0].bytes > 0);
});

test('快照最多 5 份，内容重复不会重复保存', async (t) => {
  const { fake } = await setup(t);
  for (let i = 0; i < 8; i++) {
    await capture(fake, 'user' + i, 'pw-' + i);
    await fake.send({ type: 'vault:sync' });
  }
  const history = await fake.send({ type: 'vault:history' });
  assert.equal(history.items.length, 5);
  // 最新的在最前面
  assert.ok(history.items[0].entries >= history.items[4].entries);
});

test('恢复快照会把密码库回滚到那一次的状态', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'pw-alice');
  await fake.send({ type: 'vault:sync' });
  await capture(fake, 'bob', 'pw-bob');
  await fake.send({ type: 'vault:sync' });

  const before = await fake.send({ type: 'vault:list' });
  assert.equal(before.vault.entries.length, 2);

  const history = await fake.send({ type: 'vault:history' });
  const snapshot = history.items.find((item) => item.entries === 1);
  assert.ok(snapshot, '应该有一份只含 1 个账号的快照');

  const res = await fake.send({ type: 'vault:restoreHistory', at: snapshot.at });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.entries, 1);

  const after = await fake.send({ type: 'vault:list' });
  assert.equal(after.vault.entries.length, 1);
  assert.equal(after.vault.entries[0].username, 'alice');

  // 恢复前的内容也应该被留了一份，能再恢复回去
  const history2 = await fake.send({ type: 'vault:history' });
  assert.ok(history2.items.some((item) => item.kind === 'before-restore'));
});

test('导入前会留一份本地快照', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'pw-alice');

  const res = await fake.send({
    type: 'vault:importEntries',
    entries: [{ url: 'https://github.com/login', username: 'alice', password: 'pw-gh' }],
  });
  assert.equal(res.added, 1);

  const history = await fake.send({ type: 'vault:history' });
  const snapshot = history.items.find((item) => item.kind === 'before-import');
  assert.ok(snapshot, '导入前应有快照');
  assert.equal(snapshot.entries, 1);
});

test('删除账号前会留快照，删错了能找回', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'pw-alice');
  const listed = await fake.send({ type: 'vault:list' });
  const id = listed.vault.entries[0].id;

  await fake.send({ type: 'vault:deleteEntry', id });
  const after = await fake.send({ type: 'vault:list' });
  assert.equal(after.vault.entries.length, 0);

  const history = await fake.send({ type: 'vault:history' });
  const snapshot = history.items.find((item) => item.kind === 'before-delete');
  assert.ok(snapshot, '删除前应有快照');
  const restored = await fake.send({ type: 'vault:restoreHistory', at: snapshot.at });
  assert.equal(restored.ok, true, restored.error);
  assert.equal((await fake.send({ type: 'vault:list' })).vault.entries.length, 1);
});

/* ------------------------------------------------------------------ *
 * 以本地覆盖远端（远端损坏时的修复手段）
 * ------------------------------------------------------------------ */

test('远端返回网页（损坏）时，可以用本地覆盖把它修好', async (t) => {
  const htmlPages = { '/pwdmg/vault.json': '<!DOCTYPE html><html><body>broken</body></html>' };
  const { server, fake } = await setup(t, { htmlPages });

  // 先正常存一条（此时会走 push：读坏了->无 etag->PUT 覆盖）
  const saved = await capture(fake, 'alice', 'pw-alice');
  assert.equal(saved.saved, true, saved.reason);

  // 服务器不再返回坏内容后，同步应当恢复正常
  delete htmlPages['/pwdmg/vault.json'];
  await waitFor(() => {
    const file = server.files.get('/pwdmg/vault.json');
    return file && file.content.startsWith('{') ? true : null;
  }, { label: '远端恢复成 JSON' });

  const res = await fake.send({ type: 'vault:push' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.entries, 1);

  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, true, sync.error);
});

test('以本地覆盖远端会先留一份旧的远端内容', async (t) => {
  const { server, fake } = await setup(t);
  server.seed('/pwdmg/vault.json', JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: [], tombstones: {} }));

  const res = await fake.send({ type: 'vault:push' });
  assert.equal(res.ok, true, res.error);

  const history = await fake.send({ type: 'vault:history' });
  assert.ok(history.items.some((item) => item.kind === 'remote' && item.entries === 0));
});

/* ------------------------------------------------------------------ *
 * 加密库的快照与恢复
 * ------------------------------------------------------------------ */

test('加密库的快照是密文，恢复需要解锁', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'pw-alice');
  await fake.send({ type: 'vault:sync' });

  const enabled = await fake.send({ type: 'vault:enableEncryption', password: 'master-pass-123' });
  assert.equal(enabled.ok, true, enabled.error);

  await capture(fake, 'bob', 'pw-bob');
  await fake.send({ type: 'vault:sync' });

  const history = await fake.send({ type: 'vault:history' });
  const snapshot = history.items[0];
  assert.equal(snapshot.encrypted, true, '快照应保存密文信封');
  assert.equal(snapshot.entries, null, '密文快照不解析条目数');

  // 锁定后不能恢复
  await fake.send({ type: 'vault:lock' });
  const locked = await fake.send({ type: 'vault:restoreHistory', at: snapshot.at });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, 'locked');

  // 解锁后可以恢复
  const unlocked = await fake.send({ type: 'vault:unlock', password: 'master-pass-123' });
  assert.equal(unlocked.ok, true, unlocked.error);
  const restored = await fake.send({ type: 'vault:restoreHistory', at: snapshot.at });
  assert.equal(restored.ok, true, restored.error);
});

/* ------------------------------------------------------------------ *
 * 导出提醒
 * ------------------------------------------------------------------ */

test('导出会记录时间，用于「该备份了」提醒', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'pw-alice');

  const settingsBefore = await fake.send({ type: 'vault:list' });
  assert.equal(settingsBefore.settings.lastExportAt, '');

  const exported = await fake.send({ type: 'vault:export' });
  assert.equal(exported.ok, true);
  assert.match(exported.text, /pw-alice/);

  const settingsAfter = await fake.send({ type: 'vault:list' });
  assert.match(settingsAfter.settings.lastExportAt, /^\d{4}-\d{2}-\d{2}T/);
  // 导出内容不应包含主密码，只是账号数据
  assert.doesNotMatch(exported.text, /master/i);
});
