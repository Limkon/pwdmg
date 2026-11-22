'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { startWebDavServer } = require('./helpers/webdav-server.js');
const { loadBackground, waitFor } = require('./helpers/background-harness.js');

const SHARED = (name) => require(path.resolve(__dirname, '..', 'src/shared', name));
const MASTER = 'correct horse battery staple';

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

async function seedCredential(fake, server, username, password) {
  const res = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username, password },
    { url: 'https://example.com/login' }
  );
  assert.equal(res.saved, true);
  await waitFor(async () => {
    const file = server.files.get('/pwdmg/vault.json');
    return file && file.content.includes(password) ? file : null;
  }, { label: '凭据已上传' });
  return res;
}

test('启用加密：远端只剩密文，本地缓存也不含明文', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'plain-text-password');

  const enabled = await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  assert.equal(enabled.ok, true, enabled.error);
  assert.equal(enabled.encrypted, true);

  const remote = server.files.get('/pwdmg/vault.json').content;
  const envelope = JSON.parse(remote);
  assert.equal(envelope.encrypted, true);
  assert.equal(envelope.format, 'pwdmg-vault');
  assert.equal(remote.includes('plain-text-password'), false, '远端不应出现明文密码');
  assert.equal(remote.includes('alice'), false, '远端不应出现用户名');
  assert.ok(envelope.kdf.iterations >= 10000);

  // 本地缓存记录同样只保存密文
  const record = fake.store.get('vaultCache');
  assert.ok(record.cipher, '本地缓存应为加密信封');
  assert.equal(JSON.stringify(record).includes('plain-text-password'), false);

  // 设置里标记为加密
  assert.equal(fake.store.get('settings').encryptVault, true);

  // 已解锁状态下还能正常读取
  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.encrypted, true);
  assert.equal(list.locked, false);
  assert.equal(list.vault.entries.length, 1);
  assert.equal(list.vault.entries[0].password, 'plain-text-password');
});

test('新设备：远端加密需要先解锁，错误主密码被拒绝', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });

  // 模拟另一台设备（全新 storage）
  const fresh = loadBackground();
  fresh.store.set('settings', baseSettings(server));

  const status = await fresh.send({ type: 'vault:status' });
  assert.equal(status.locked, true);
  assert.equal(status.entries, 0);

  const wrong = await fresh.send({ type: 'vault:unlock', password: 'not-the-password' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'bad-password');
  assert.match(wrong.error, /主密码不正确/);

  const ok = await fresh.send({ type: 'vault:unlock', password: MASTER });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.entries, 1);

  const list = await fresh.send({ type: 'vault:list' });
  assert.equal(list.locked, false);
  assert.equal(list.vault.entries[0].username, 'alice');
  assert.equal(list.vault.entries[0].password, 'pw-1');

  // 解锁后可以继续同步新记录
  const added = await fresh.send(
    { type: 'credential:capture', url: 'https://other.example/login', username: 'bob', password: 'pw-2' },
    { url: 'https://other.example/login' }
  );
  assert.equal(added.saved, true);
  await waitFor(async () => {
    const remote = server.files.get('/pwdmg/vault.json');
    return remote && remote.content.includes('"encrypted": true') ? remote : null;
  }, { label: '新设备写入仍为密文' });

  const remoteText = server.files.get('/pwdmg/vault.json').content;
  assert.equal(remoteText.includes('pw-2'), false);
});

test('锁定后无法读写，密钥只存在于会话中', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });

  const locked = await fake.send({ type: 'vault:lock' });
  assert.equal(locked.ok, true);
  assert.equal(locked.locked, true);

  const status = await fake.send({ type: 'vault:status' });
  assert.equal(status.locked, true);
  assert.equal(status.entries, 0);

  const denied = await fake.send({
    type: 'vault:saveEntry',
    entry: { id: 'x', host: 'a.com', url: 'https://a.com', username: 'u', password: 'p' },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'locked');

  const capture = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'new' },
    { url: 'https://example.com/login' }
  );
  assert.equal(capture.saved, false);
  assert.equal(capture.reason, 'locked');

  // 会话密钥已清除
  assert.equal(fake.session.size, 0);

  const sync = await fake.send({ type: 'vault:sync' });
  assert.equal(sync.ok, false);
  assert.equal(sync.locked, true);

  // 解锁后数据回来
  const unlocked = await fake.send({ type: 'vault:unlock', password: MASTER });
  assert.equal(unlocked.ok, true, unlocked.error);
  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.locked, false);
  assert.equal(list.vault.entries.length, 1);
  assert.equal(list.vault.entries[0].password, 'pw-1');
});

test('修改主密码：旧密码失效，新密码可解，远端仍是密文', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: 'old-master-pass' });

  const wrongOld = await fake.send({
    type: 'vault:changeMasterPassword',
    oldPassword: 'nope',
    newPassword: 'new-master-pass',
  });
  assert.equal(wrongOld.ok, false);
  assert.equal(wrongOld.code, 'bad-password');

  const changed = await fake.send({
    type: 'vault:changeMasterPassword',
    oldPassword: 'old-master-pass',
    newPassword: 'new-master-pass',
  });
  assert.equal(changed.ok, true, changed.error);

  await fake.send({ type: 'vault:lock' });
  const withOld = await fake.send({ type: 'vault:unlock', password: 'old-master-pass' });
  assert.equal(withOld.ok, false);
  assert.equal(withOld.code, 'bad-password');

  const withNew = await fake.send({ type: 'vault:unlock', password: 'new-master-pass' });
  assert.equal(withNew.ok, true, withNew.error);

  const remote = server.files.get('/pwdmg/vault.json').content;
  assert.equal(JSON.parse(remote).encrypted, true);
  assert.equal(remote.includes('pw-1'), false);
});

test('关闭加密：远端恢复明文，并清除会话密钥', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });

  const off = await fake.send({ type: 'vault:disableEncryption' });
  assert.equal(off.ok, true, off.error);
  assert.equal(off.encrypted, false);

  const remote = server.files.get('/pwdmg/vault.json').content;
  const parsed = JSON.parse(remote);
  assert.equal(parsed.encrypted, undefined);
  assert.ok(remote.includes('pw-1'), '关闭加密后远端应为明文');

  assert.equal(fake.store.get('settings').encryptVault, false);
  assert.equal(fake.session.size, 0);
  const record = fake.store.get('vaultCache');
  assert.ok(record.vault, '本地缓存应恢复为明文结构');
  assert.equal(record.cipher, undefined);
});

test('未解锁时普通记录不会写入，避免覆盖加密密码库', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  await fake.send({ type: 'vault:lock' });

  const before = server.files.get('/pwdmg/vault.json').content;
  const capture = await fake.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'mallory', password: 'evil' },
    { url: 'https://example.com/login' }
  );
  assert.equal(capture.ok, false);
  assert.equal(capture.reason, 'locked');

  // 远端文件未被改动
  assert.equal(server.files.get('/pwdmg/vault.json').content, before);
});

test('密码变化：默认只提示，确认后才更新', async (t) => {
  const ctx = await setup(t);
  const client = ctx.fake;
  const sender = { url: 'https://example.com/login' };

  const first = await client.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'old-pw' },
    sender
  );
  assert.equal(first.saved, true);

  const detected = await client.send(
    { type: 'credential:capture', url: 'https://example.com/login', username: 'alice', password: 'new-pw' },
    sender
  );
  assert.equal(detected.ok, true);
  assert.equal(detected.saved, false);
  assert.equal(detected.reason, 'password-changed');
  assert.equal(detected.entry.username, 'alice');

  let list = await client.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 1);
  assert.equal(list.vault.entries[0].password, 'old-pw', '确认前不应覆盖旧密码');

  const confirmed = await client.send(
    {
      type: 'credential:capture',
      url: 'https://example.com/login',
      username: 'alice',
      password: 'new-pw',
      force: true,
    },
    sender
  );
  assert.equal(confirmed.saved, true);
  assert.equal(confirmed.action, 'updated');

  list = await client.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 1);
  assert.equal(list.vault.entries[0].password, 'new-pw');

  await waitFor(async () => {
    const file = ctx.server.files.get('/pwdmg/vault.json');
    return file && file.content.includes('new-pw') ? file : null;
  }, { label: '新密码已同步' });
});

test('改密表单（updateOnly）在没有已存账号时不会新建条目', async (t) => {
  const { fake } = await setup(t);
  const res = await fake.send(
    {
      type: 'credential:capture',
      url: 'https://example.com/login',
      username: 'stranger',
      password: 'brand-new',
      updateOnly: true,
    },
    { url: 'https://example.com/login' }
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-entry');

  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.vault.entries.length, 0);
});

test('测试连接会报告远端是否已加密', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });

  const plain = await fake.send({ type: 'vault:test', settings: baseSettings(server) });
  assert.equal(plain.ok, true);
  assert.equal(plain.encrypted, true);
  assert.equal(plain.exists, true);
});

test('解锁 / 锁定后通知已打开的页面重新读取状态', async (t) => {
  const { fake } = await setup(t);
  const enabled = await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  assert.equal(enabled.ok, true, enabled.error);
  assert.ok(fake.tabsSent.some((m) => m.type === 'content:rescan'), '启用加密后通知页面');

  const locked = await fake.send({ type: 'vault:lock' });
  assert.equal(locked.ok, true);
  assert.ok(fake.tabsSent.some((m) => m.type === 'content:rescan'), '锁定后通知页面');
  assert.equal(fake.tabsSent.filter((m) => m.type === 'content:rescan').length >= 2, true);

  const unlocked = await fake.send({ type: 'vault:unlock', password: MASTER });
  assert.equal(unlocked.ok, true, unlocked.error);
  assert.equal(fake.tabsSent.filter((m) => m.type === 'content:rescan').length >= 3, true);
  assert.ok(fake.tabsSent.every((m) => m.tabId === 1 || m.tabId === 2));
});

test('记住本机：浏览器重启免输入主密码，锁定后被清除', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });

  const remember = await fake.send({ type: 'vault:rememberDevice', remember: true, days: 7 });
  assert.equal(remember.ok, true);
  const rec = fake.store.get('rememberedKey');
  assert.ok(rec && rec.key, '本机记住的密钥应写入存储');
  assert.ok(Date.parse(rec.expiresAt) > Date.now() + 6 * 24 * 3600 * 1000, '有效期约 7 天');

  // 模拟浏览器重启：session 与内存缓存全部丢失
  const fresh = loadBackground({ store: fake.store });
  const before = await fresh.send({ type: 'vault:list' });
  assert.equal(before.locked, false, '重启后应自动解锁');
  assert.equal(before.encrypted, true);
  assert.equal(before.vault.entries.length, 1);
  assert.equal(before.vault.entries[0].password, 'pw-1');

  // 锁定后本机记住的密钥被清除，且重启后回到锁定态
  const locked = await fresh.send({ type: 'vault:lock' });
  assert.equal(locked.ok, true);
  assert.equal(locked.locked, true);
  assert.equal(fresh.store.get('rememberedKey'), undefined);

  const fresh2 = loadBackground({ store: fresh.store });
  const after = await fresh2.send({ type: 'vault:list' });
  assert.equal(after.locked, true, '锁定后重启应回到锁定态');
});

test('记住本机：已过期的密钥被拒绝，按锁定处理', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  const remember = await fake.send({ type: 'vault:rememberDevice', remember: true, days: 7 });
  assert.equal(remember.ok, true);

  // 把有效期改成已过期再模拟重启
  const rec = fake.store.get('rememberedKey');
  rec.expiresAt = new Date(Date.now() - 1000).toISOString();
  fake.store.set('rememberedKey', rec);

  const fresh = loadBackground({ store: fake.store });
  const list = await fresh.send({ type: 'vault:list' });
  assert.equal(list.locked, true, '过期密钥不能自动解锁');
  // 过期后密钥本身必须丢掉，只留一条不含密钥的「已过期」标记（界面要据此显示状态）
  const leftover = fresh.store.get('rememberedKey');
  assert.equal(leftover && leftover.key, '', '过期密钥必须被清除');
  assert.equal(leftover.expired, true, '留下「已过期」标记');

  const wrong = await fresh.send({ type: 'vault:unlock', password: 'not-the-password' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'bad-password');
});

test('记住本机：关闭开关后立即清除本机记住的密钥', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });

  await fake.send({ type: 'vault:rememberDevice', remember: true, days: 7 });
  assert.ok(fake.store.get('rememberedKey'));

  const off = await fake.send({ type: 'vault:rememberDevice', remember: false });
  assert.equal(off.ok, true);
  assert.equal(fake.store.get('rememberedKey'), undefined);
  assert.equal(off.settings.rememberDevice, false);
});

test('记住本机：0 天 = 永久有效（直到手动锁定），过期不影响', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });

  const on = await fake.send({ type: 'vault:rememberDevice', remember: true, days: 0 });
  assert.equal(on.ok, true);
  assert.equal(on.settings.rememberDevice, true);
  assert.equal(on.settings.rememberDeviceDays, 0);
  const rec = fake.store.get('rememberedKey');
  assert.ok(rec && rec.key, '永久记住时也应写入密钥');
  assert.equal(rec.expiresAt, null, '0 天 = 不设过期时间');

  // 模拟浏览器重启：即使「过期」也能自动解锁
  const fresh = loadBackground({ store: fake.store });
  const list = await fresh.send({ type: 'vault:list' });
  assert.equal(list.locked, false);
  assert.equal(list.vault.entries.length, 1);

  // 手动锁定后，开启的记忆被清除
  await fresh.send({ type: 'vault:lock' });
  assert.equal(fresh.store.get('rememberedKey'), undefined);
});

test('记住本机：状态里能看到「已生效 / 还剩几天」', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });

  // 还没开启
  const off = await fake.send({ type: 'vault:status' });
  assert.equal(off.remember.on, false);
  assert.equal(off.remember.active, false);

  await fake.send({ type: 'vault:rememberDevice', remember: true, days: 7 });

  const on = await fake.send({ type: 'vault:status' });
  assert.equal(on.remember.on, true);
  assert.equal(on.remember.active, true, '开启后立即生效');
  assert.equal(on.remember.days, 7);
  assert.ok(on.remember.expiresAt, '有到期时间');
  assert.ok(on.remember.remainingMs > 6 * 24 * 3600 * 1000);
  assert.equal(on.remember.remainingDays, 7, '还剩 7 天');
  assert.equal(on.remember.expired, false);

  // 单独的状态查询也能拿到（设置页刷新用）
  const status = await fake.send({ type: 'vault:rememberStatus' });
  assert.equal(status.ok, true);
  assert.equal(status.remember.active, true);
  assert.equal(status.remember.remainingDays, 7);

  // 弹窗用的 vault:list 也要带上
  const list = await fake.send({ type: 'vault:list' });
  assert.equal(list.remember.active, true);
  assert.equal(list.remember.remainingDays, 7);

  // 浏览器重启后仍然显示「已生效 · 还剩 N 天」，而不是让用户猜
  const fresh = loadBackground({ store: fake.store });
  const afterRestart = await fresh.send({ type: 'vault:status' });
  assert.equal(afterRestart.locked, false, '重启后免密');
  assert.equal(afterRestart.remember.active, true);
  assert.ok(afterRestart.remember.remainingDays >= 6 && afterRestart.remember.remainingDays <= 7);
});

test('记住本机：过期或未写入时状态明确区分', async (t) => {
  const { server, fake } = await setup(t);
  await seedCredential(fake, server, 'alice', 'pw-1');
  await fake.send({ type: 'vault:enableEncryption', password: MASTER });
  await fake.send({ type: 'vault:rememberDevice', remember: true, days: 7 });

  // 过期：不自动解锁，状态显示已过期
  const rec = fake.store.get('rememberedKey');
  rec.expiresAt = new Date(Date.now() - 1000).toISOString();
  fake.store.set('rememberedKey', rec);

  const fresh = loadBackground({ store: fake.store });
  const expired = await fresh.send({ type: 'vault:status' });
  assert.equal(expired.locked, true);
  assert.equal(expired.remember.on, true, '开关仍是开着的');
  assert.equal(expired.remember.active, false);
  assert.equal(expired.remember.expired, true);

  // 永久：没有到期时间，active 且不是 expired
  const permanent = await fresh.send({ type: 'vault:unlock', password: MASTER });
  assert.equal(permanent.ok, true, permanent.error);
  await fresh.send({ type: 'vault:rememberDevice', remember: true, days: 0 });
  const forever = await fresh.send({ type: 'vault:status' });
  assert.equal(forever.remember.active, true);
  assert.equal(forever.remember.expiresAt, null);
  assert.equal(forever.remember.expired, false);
});
