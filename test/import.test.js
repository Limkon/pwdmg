'use strict';

/**
 * 批量导入（CSV）与「待确认的密码变更」的端到端测试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { startWebDavServer } = require('./helpers/webdav-server.js');
const { loadBackground, waitFor } = require('./helpers/background-harness.js');

const Csv = require(path.resolve(__dirname, '..', 'src/shared/csv.js'));

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

async function setup(t) {
  const server = await startWebDavServer({ auth: { username: 'me', password: 'secret' } });
  t.after(() => server.close());
  const fake = loadBackground();
  fake.store.set('settings', baseSettings(server));
  return { server, fake };
}

const capture = (fake, username, password, extra) =>
  fake.send(
    Object.assign(
      { type: 'credential:capture', url: 'https://example.com/login', username, password },
      extra || {}
    ),
    { url: 'https://example.com/login' }
  );

/* ------------------------------------------------------------------ *
 * CSV 导入
 * ------------------------------------------------------------------ */

test('CSV 导入：新增账号并同步到 WebDAV', async (t) => {
  const { server, fake } = await setup(t);

  const csv = [
    'name,url,username,password,note',
    'GitHub,https://github.com/login,alice,pw-a,工作',
    'Mail,https://mail.example.com,bob,pw-b,',
    'App,android://h@com.x/,carol,pw-c,',
  ].join('\r\n');
  const parsed = Csv.parse(csv);
  assert.equal(parsed.entries.length, 2);

  const res = await fake.send({ type: 'vault:importEntries', entries: parsed.entries });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.added, 2);
  assert.equal(res.updated, 0);
  assert.equal(res.conflicts, 0);

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 2);
  const github = list.vault.entries.find((e) => e.host === 'github.com');
  assert.equal(github.username, 'alice');
  assert.equal(github.password, 'pw-a');
  assert.equal(github.notes, '工作');

  await waitFor(
    () => {
      const file = server.files.get('/pwdmg/vault.json');
      return file && file.content.includes('github.com') ? file : null;
    },
    { label: '导入结果已上传' }
  );
});

test('CSV 导入：默认跳过已存在的密码，勾选覆盖后替换', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'old-pw');
  await waitFor(async () => (await fake.send({ type: 'vault:list' })).vault.entries.length === 1, {
    label: '初始账号已保存',
  });

  const entries = [
    { url: 'https://example.com/login', host: 'example.com', username: 'alice', password: 'new-pw' },
    { url: 'https://other.example/x', username: 'bob', password: 'pw-bob' },
  ];

  const skipped = await fake.send({ type: 'vault:importEntries', entries });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.added, 1);
  assert.equal(skipped.updated, 0);
  assert.equal(skipped.conflicts, 1, '密码不同默认算冲突，不覆盖');

  let list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.find((e) => e.host === 'example.com').password, 'old-pw');

  const forced = await fake.send({ type: 'vault:importEntries', entries, overwrite: true });
  assert.equal(forced.updated, 1);
  assert.equal(forced.added, 0);
  assert.equal(forced.conflicts, 0);

  list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.find((e) => e.host === 'example.com').password, 'new-pw');
});

test('CSV 导入：密码相同的条目计为未变，不产生改动', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'same-pw');

  const res = await fake.send({
    type: 'vault:importEntries',
    entries: [{ url: 'https://example.com/login', username: 'alice', password: 'same-pw' }],
  });
  assert.equal(res.added, 0);
  assert.equal(res.updated, 0);
  assert.equal(res.unchanged, 1);
  assert.equal(res.sync, null, '没有改动就不需要同步');
});

test('CSV 导入：空密码与无效地址被忽略', async (t) => {
  const { fake } = await setup(t);
  const res = await fake.send({
    type: 'vault:importEntries',
    entries: [
      { url: 'https://a.example', username: 'u', password: '' },
      { url: 'not a url', username: 'v', password: 'pw' },
      { url: 'https://b.example', username: 'w', password: 'pw-ok' },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.added, 1);
  assert.equal(res.invalid, 2);
});

test('CSV 导入：加密锁定状态下拒绝导入', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: 'master-pass-123' });
  await fake.send({ type: 'vault:lock' });

  const res = await fake.send({
    type: 'vault:importEntries',
    entries: [{ url: 'https://c.example', username: 'u', password: 'pw' }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'locked');
});

/* ------------------------------------------------------------------ *
 * 待确认的密码变更
 * ------------------------------------------------------------------ */

test('密码变化：待确认状态存在会话里，确认后才真正更新', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'old-pw');

  const changed = await capture(fake, 'alice', 'new-pw');
  assert.equal(changed.reason, 'password-changed');

  const pending = await fake.send({ type: 'credential:pending', host: 'example.com' });
  assert.equal(pending.pending.host, 'example.com');
  assert.equal(pending.pending.username, 'alice');
  assert.equal(pending.pending.password, 'new-pw');

  // 别的站点不应该看到这条待确认
  const other = await fake.send({ type: 'credential:pending', host: 'other.example' });
  assert.equal(other.pending, null);

  const resolved = await fake.send({ type: 'credential:resolvePending', accept: true });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.accepted, true);
  assert.equal(resolved.saved, true);

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.find((e) => e.host === 'example.com').password, 'new-pw');

  const cleared = await fake.send({ type: 'credential:pending', host: 'example.com' });
  assert.equal(cleared.pending, null, '确认后应清空');
});

test('密码变化：拒绝后清空待确认，且不会改动密码', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'old-pw');
  await capture(fake, 'alice', 'other-pw');

  const res = await fake.send({ type: 'credential:resolvePending', accept: false });
  assert.equal(res.ok, true);
  assert.equal(res.accepted, false);

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries[0].password, 'old-pw');

  const pending = await fake.send({ type: 'credential:pending', host: 'example.com' });
  assert.equal(pending.pending, null);
});

test('待确认变更有 30 分钟有效期，且锁定后清空', async (t) => {
  const { fake } = await setup(t);
  await capture(fake, 'alice', 'old-pw');
  await capture(fake, 'alice', 'new-pw');

  // 手动把时间改成 31 分钟前
  const stored = fake.session.get('pendingChange');
  assert.ok(stored, '应该有会话级待确认');
  stored.at = Date.now() - 31 * 60 * 1000;
  fake.session.set('pendingChange', stored);

  const expired = await fake.send({ type: 'credential:pending', host: 'example.com' });
  assert.equal(expired.pending, null, '过期后自动丢弃');

  await capture(fake, 'alice', 'newer-pw');
  await fake.send({ type: 'vault:enableEncryption', password: 'master-pass-123' });
  await fake.send({ type: 'vault:lock' });
  const afterLock = await fake.send({ type: 'credential:pending', host: 'example.com' });
  assert.equal(afterLock.pending, null, '锁定后清空');
});

test('CSV 导入：子域不会被并进主域（mail.x.com 与 x.com 分开存）', async (t) => {
  const { fake } = await setup(t);
  const res = await fake.send({
    type: 'vault:importEntries',
    entries: [
      { url: 'https://x.example/login', username: 'alice', password: 'pw-main' },
      { url: 'https://mail.x.example/login', username: 'alice', password: 'pw-mail' },
    ],
  });
  assert.equal(res.added, 2, '两条都应新建，不能合并');
  assert.equal(res.unchanged, 0);

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 2);
  const byHost = {};
  for (const entry of list.vault.entries) byHost[entry.host] = entry.password;
  assert.equal(byHost['x.example'], 'pw-main');
  assert.equal(byHost['mail.x.example'], 'pw-mail');
});
