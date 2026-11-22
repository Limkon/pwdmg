'use strict';

/**
 * 交叉对比：同一个功能的不同入口 / 不同模式，结果必须一致。
 *
 * 这些用例存在的意义不是“再测一遍”，而是捕捉「两条实现悄悄跑偏」：
 *  - 明文模式 vs 主密码加密模式
 *  - 自动记录 vs 设置页手工编辑
 *  - 导出 → 导入 往返
 *  - 以本地覆盖远端 vs 以远端覆盖本地
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = require('node:path').resolve(__dirname, '..');
const { startWebDavServer } = require('./helpers/webdav-server.js');
const { loadBackground } = require('./helpers/background-harness.js');
const U = require(ROOT + '/src/shared/util.js');
const V = require(ROOT + '/src/shared/vault.js');

function settingsFor(server) {
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

const capture = (fake, username, password, host) =>
  fake.send(
    { type: 'credential:capture', url: 'https://' + host + '/login', username, password, force: true },
    { url: 'https://' + host + '/login' }
  );

const summary = (vault) =>
  vault.entries
    .map((e) => [e.host, e.username, e.password, e.useCount].join('|'))
    .sort()
    .join('\n');

/* ------------------------------------------------------------------ *
 * 1. 明文模式与加密模式的行为必须一致
 * ------------------------------------------------------------------ */

test('同样的操作序列在明文模式和加密模式下得到相同的结果', { timeout: 120000 }, async (t) => {
  /** 跑一遍固定脚本（每次都用干净的远端文件），返回最终密码库摘要 */
  async function run(encrypted) {
    const server = await startWebDavServer({});
    t.after(() => server.close());
    const fake = loadBackground();
    fake.store.set('settings', settingsFor(server));
    if (encrypted) {
      const res = await fake.send({ type: 'vault:enableEncryption', password: 'master-pass-123' });
      assert.equal(res.ok, true, res.error);
    }
    await capture(fake, 'alice', 'pw-1', 'a.com');
    await capture(fake, 'bob', 'pw-2', 'a.com');
    await capture(fake, 'carol', 'pw-3', 'b.com');
    await fake.send({ type: 'vault:sync' });

    // 改其中一个密码、删掉一个、再用一次
    await capture(fake, 'alice', 'pw-1-new', 'a.com');
    const listed = await fake.send({ type: 'vault:list' });
    const bob = listed.vault.entries.find((e) => e.username === 'bob');
    await fake.send({ type: 'vault:deleteEntry', id: bob.id });
    const carol = listed.vault.entries.find((e) => e.username === 'carol');
    await fake.send({ type: 'credential:used', id: carol.id });

    await fake.send({ type: 'vault:sync' });
    const final = await fake.send({ type: 'vault:list' });
    return { summary: summary(final.vault), encrypted: final.encrypted };
  }

  const plain = await run(false);
  const secure = await run(true);

  assert.equal(plain.encrypted, false);
  assert.equal(secure.encrypted, true);
  assert.equal(secure.summary, plain.summary, '两种模式的最终数据必须一致');
  assert.match(plain.summary, /a\.com\|alice\|pw-1-new/);
  assert.doesNotMatch(plain.summary, /bob/);
});

/* ------------------------------------------------------------------ *
 * 2. 导出 → 导入 往返
 * ------------------------------------------------------------------ */

test('导出的 JSON 再导入回来，数据完全一致且幂等', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', settingsFor(server));
  await capture(fake, 'alice', 'pw-1', 'a.com');
  await capture(fake, 'bob', 'pw-2', 'b.com');
  await fake.send({ type: 'vault:sync' });

  const before = await fake.send({ type: 'vault:list' });
  const exported = await fake.send({ type: 'vault:export' });
  assert.equal(exported.ok, true);

  // 清空远端 + 本地，模拟“换一台设备”
  const settings = fake.store.get('settings');
  const other = loadBackground();
  other.store.set('settings', settings);
  server.files.delete('/pwdmg/vault.json');

  const imported = await other.send({ type: 'vault:import', text: exported.text });
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.imported, 2);

  const after = await other.send({ type: 'vault:list' });
  assert.equal(summary(after.vault), summary(before.vault));

  // 再导入一次：数量不变
  await other.send({ type: 'vault:import', text: exported.text });
  const again = await other.send({ type: 'vault:list' });
  assert.equal(summary(again.vault), summary(before.vault), '重复导入必须幂等');
});

/* ------------------------------------------------------------------ *
 * 3. 以本地覆盖远端 / 以远端覆盖本地 的对称性
 * ------------------------------------------------------------------ */

test('两个方向的强制覆盖都能让两边重新一致', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', settingsFor(server));
  await capture(fake, 'alice', 'pw-1', 'a.com');
  await fake.send({ type: 'vault:sync' });

  // 离线新增一条（此时同步必然失败，本地变成“待上传”）
  fake.store.set('settings', settingsFor(server, { webdavUrl: 'http://127.0.0.1:1/pwdmg/vault.json' }));
  await capture(fake, 'bob', 'pw-2', 'b.com');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const localSummary = summary((await fake.send({ type: 'vault:list' })).vault);
  assert.match(localSummary, /bob/);

  // 恢复网络 → 以本地覆盖远端，远端应与本地一致
  fake.store.set('settings', settingsFor(server));
  const pushed = await fake.send({ type: 'vault:push' });
  assert.equal(pushed.ok, true, pushed.error);
  assert.equal(summary(JSON.parse(server.files.get('/pwdmg/vault.json').content)), localSummary);

  // 远端被别的程序改写 → 以远端覆盖本地，本地应与远端一致
  server.seed('/pwdmg/vault.json', JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [{ id: 'x1', host: 'c.org', url: 'https://c.org/', username: 'carol', password: 'pw-3' }],
    tombstones: {},
  }));
  const pulled = await fake.send({ type: 'vault:pull' });
  assert.equal(pulled.ok, true, pulled.error);
  const after = summary((await fake.send({ type: 'vault:list' })).vault);
  assert.equal(after, 'c.org|carol|pw-3|0');
});

/* ------------------------------------------------------------------ *
 * 4. 自动记录与手工编辑的匹配规则
 * ------------------------------------------------------------------ */

test('自动记录和设置页编辑同一账号时只留一条', async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  const fake = loadBackground();
  fake.store.set('settings', settingsFor(server));

  await capture(fake, 'alice', 'pw-auto', 'a.com');
  const listed = await fake.send({ type: 'vault:list' });
  const entry = listed.vault.entries[0];

  // 设置页里用不同的 id、同样的 host+username 保存 → 规范化后仍是一条
  await fake.send({
    type: 'vault:saveEntry',
    entry: Object.assign({}, entry, { id: 'manual-copy', password: 'pw-manual', updatedAt: undefined }),
  });

  const after = await fake.send({ type: 'vault:list' });
  assert.equal(after.vault.entries.length, 1, '同一 host + 用户名只能有一条');
  assert.equal(after.vault.entries[0].password, 'pw-manual');
});

/* ------------------------------------------------------------------ *
 * 5. find / lookup 两个匹配入口
 * ------------------------------------------------------------------ */

test('find（列表）与 lookup（写入前的匹配）规则一致', () => {
  const vault = V.normalize({
    entries: [
      { id: 'e1', host: 'example.com', username: 'alice', password: '1', updatedAt: '2025-01-01T00:00:00.000Z' },
      { id: 'e2', host: 'mail.example.com', username: 'bob', password: '2', updatedAt: '2025-01-01T00:00:00.000Z' },
      { id: 'e3', host: 'other.org', username: 'carol', password: '3', updatedAt: '2025-01-01T00:00:00.000Z' },
    ],
  });

  const cases = [
    ['https://example.com/login', 'alice'],
    ['https://example.com/login', 'bob'],
    ['https://mail.example.com/login', 'alice'],
    ['https://www.example.com/login', 'bob'],
    ['https://other.org/', 'carol'],
    ['https://example.com/login', 'nobody'],
  ];

  for (const [url, username] of cases) {
    const matched = V.lookup(vault, { url, username });
    const listed = V.find(vault, url).some((e) => e.username === username);
    assert.equal(!!matched, listed, url + ' / ' + username + ' 的两个入口结论不一致');
  }

  // 子域双向匹配、www 归一、大小写不敏感
  assert.equal(U.hostMatches('login.example.com', 'example.com'), true);
  assert.equal(U.hostMatches('www.example.com', 'example.com'), true);
  assert.equal(U.hostMatches('example.com', 'evil-example.com'), false);
  assert.equal(U.hostMatches('example.com', 'example.com.evil.net'), false);
});
