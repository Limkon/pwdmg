'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/shared/vault.js');

function vaultWith(entries, tombstones) {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: entries || [],
    tombstones: tombstones || {},
  };
}

function entry(overrides) {
  const now = new Date().toISOString();
  return Object.assign(
    {
      id: 'id-' + Math.random().toString(36).slice(2, 8),
      host: 'example.com',
      origin: 'https://example.com',
      url: 'https://example.com/login',
      username: 'alice',
      password: 'secret',
      title: 'example.com',
      notes: '',
      createdAt: now,
      updatedAt: now,
      useCount: 0,
      lastUsedAt: null,
    },
    overrides || {}
  );
}

test('upsert 新建、更新、去重', () => {
  const empty = V.empty();
  const first = V.upsert(empty, { url: 'https://example.com/login', username: 'alice', password: 'p1' });
  assert.equal(first.action, 'created');
  assert.equal(first.vault.entries.length, 1);
  assert.equal(first.entry.host, 'example.com');
  assert.equal(first.entry.username, 'alice');

  const same = V.upsert(first.vault, { url: 'https://example.com/login', username: 'alice', password: 'p1' });
  assert.equal(same.action, 'unchanged');

  const changed = V.upsert(first.vault, { url: 'https://example.com/login', username: 'alice', password: 'p2' });
  assert.equal(changed.action, 'updated');
  assert.equal(changed.vault.entries.length, 1);
  assert.equal(changed.vault.entries[0].password, 'p2');

  // 子域名登录，同一用户名，会被识别为同一条记录
  const sub = V.upsert(changed.vault, { url: 'https://login.example.com/', username: 'alice', password: 'p3' });
  assert.equal(sub.action, 'updated');
  assert.equal(sub.vault.entries.length, 1);
  assert.equal(sub.vault.entries[0].host, 'login.example.com');

  // 不同用户名是不同记录
  const other = V.upsert(sub.vault, { url: 'https://example.com/', username: 'bob', password: 'x' });
  assert.equal(other.vault.entries.length, 2);
});

test('upsert 拒绝空密码和无效地址', () => {
  assert.throws(() => V.upsert(V.empty(), { url: 'https://a.com', username: 'a', password: '' }), /密码为空/);
  assert.throws(() => V.upsert(V.empty(), { url: '', username: 'a', password: 'b' }), /无效的网站地址/);
});

test('find 优先精确域名，其次最近使用', () => {
  const exact = entry({ id: 'a', host: 'example.com', username: 'alice', updatedAt: '2024-01-01T00:00:00.000Z' });
  const sub = entry({ id: 'b', host: 'login.example.com', username: 'bob', updatedAt: '2024-06-01T00:00:00.000Z' });
  const other = entry({ id: 'c', host: 'other.com', username: 'carol' });
  const vault = V.normalize(vaultWith([sub, exact, other]));

  const matches = V.find(vault, 'https://www.example.com/signin');
  assert.deepEqual(
    matches.map((e) => e.id),
    ['a', 'b']
  );

  const withUsage = V.normalize(
    vaultWith([
      entry({ id: 'x', host: 'example.com', username: 'x', lastUsedAt: '2024-01-01T00:00:00.000Z' }),
      entry({ id: 'y', host: 'example.com', username: 'y', lastUsedAt: '2025-01-01T00:00:00.000Z' }),
    ])
  );
  assert.deepEqual(
    V.find(withUsage, 'https://example.com').map((e) => e.id),
    ['y', 'x']
  );
  assert.deepEqual(V.find(vault, 'chrome://settings'), []);
});

test('remove 写入墓碑，序列化后仍能保持删除状态', () => {
  const created = V.upsert(V.empty(), { url: 'https://a.com', username: 'a', password: 'b' });
  const removed = V.remove(created.vault, created.entry.id);
  assert.equal(removed.entries.length, 0);
  assert.ok(removed.tombstones[created.entry.id]);

  const roundTrip = V.parse(V.serialize(removed));
  assert.equal(roundTrip.entries.length, 0);
  assert.equal(roundTrip.tombstones[created.entry.id], removed.tombstones[created.entry.id]);
});

test('merge：较新的密码覆盖较旧的，删除墓碑优先', () => {
  const local = vaultWith([
    entry({ id: '1', username: 'alice', password: 'new', updatedAt: '2025-05-01T00:00:00.000Z' }),
    entry({ id: '2', username: 'bob', password: 'bobpass' }),
  ]);
  const remote = vaultWith(
    [
      entry({ id: '1', username: 'alice', password: 'old', updatedAt: '2025-01-01T00:00:00.000Z' }),
      entry({ id: '3', username: 'carol', password: 'carolpass' }),
    ],
    {}
  );

  const merged = V.merge(remote, local);
  const byId = new Map(merged.entries.map((e) => [e.id, e]));
  assert.equal(byId.get('1').password, 'new');
  assert.ok(byId.get('2'));
  assert.ok(byId.get('3'));

  // 远端删除了 2，且删除时间比条目更新的时间晚
  const remoteDeleted = vaultWith(
    [entry({ id: '1', username: 'alice', password: 'old', updatedAt: '2025-01-01T00:00:00.000Z' })],
    { 2: new Date(Date.now() + 1000).toISOString() }
  );
  const merged2 = V.merge(remoteDeleted, local);
  assert.equal(
    merged2.entries.some((e) => e.id === '2'),
    false
  );
});

test('merge：两份同时创建的相同账号会合并为一条', () => {
  const a = vaultWith([entry({ id: 'a1', username: 'alice', password: 'p1', updatedAt: '2025-01-01T00:00:00.000Z' })]);
  const b = vaultWith([entry({ id: 'b1', username: 'alice', password: 'p2', updatedAt: '2025-02-01T00:00:00.000Z' })]);
  const merged = V.merge(a, b);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].password, 'p2');
  // 被丢弃的副本应写入墓碑，防止反复复活
  assert.ok(merged.tombstones.a1);
});

test('merge 保持幂等', () => {
  const a = vaultWith([entry({ id: '1' }), entry({ id: '2', username: 'bob' })]);
  const b = vaultWith([entry({ id: '2', username: 'bob', password: 'changed' })]);
  const once = V.merge(a, b);
  const twice = V.merge(once, once);
  assert.deepEqual(
    twice.entries.map((e) => [e.id, e.password]),
    once.entries.map((e) => [e.id, e.password])
  );
});

test('parse 对错误输入给出中文提示', () => {
  assert.throws(() => V.parse('{oops'), /JSON 解析失败/);
  assert.throws(() => V.parse('{"foo":1}'), /缺少 entries/);
  assert.equal(V.parse('').entries.length, 0);
  const arrayForm = V.parse(
    JSON.stringify([entry({ host: 'a.com', username: 'u', password: 'p' })])
  );
  assert.equal(arrayForm.entries.length, 1);
});

test('normalize 会补全字段并排除无 host 的垃圾数据', () => {
  const normalized = V.normalize(
    vaultWith([
      { id: 'x', url: 'https://a.com/login', username: ' u ', password: 'p' },
      { id: 'y', username: 'no-host' },
      null,
    ])
  );
  assert.equal(normalized.entries.length, 1);
  const e = normalized.entries[0];
  assert.equal(e.host, 'a.com');
  assert.equal(e.username, 'u');
  assert.equal(e.title, 'a.com');
  assert.equal(e.useCount, 0);
});

test('normalize：同一站点 + 用户名的两条记录 updatedAt 完全相同时，后写入的那条生效', () => {
  // 自动记录和手工在设置页改同一账号几乎总是前后脚发生，在同一毫秒内完成时
  // updatedAt 会完全相等。之前用 `>` 判断新旧，时间相同时谁赢取决于 Map 的
  // 历史迭代顺序，表现为随机抖动；回归点是改成 `>=` 后，数组里排在后面的
  // （也就是后写入的）那条应该始终胜出，不依赖具体时间差。
  const tie = '2025-06-01T00:00:00.000Z';
  const normalized = V.normalize(
    vaultWith([
      entry({ id: 'auto-captured', username: 'alice', password: 'pw-auto', updatedAt: tie, createdAt: tie }),
      entry({ id: 'manual-edit', username: 'alice', password: 'pw-manual', updatedAt: tie, createdAt: tie }),
    ])
  );
  assert.equal(normalized.entries.length, 1, '同一 host + 用户名只能留一条');
  assert.equal(normalized.entries[0].id, 'manual-edit');
  assert.equal(normalized.entries[0].password, 'pw-manual');
});

test('markUsed 只更新使用次数，不改变 updatedAt', () => {
  const created = V.upsert(V.empty(), { url: 'https://a.com', username: 'a', password: 'b' });
  const used = V.markUsed(created.vault, created.entry.id);
  assert.equal(used.entries[0].useCount, 1);
  assert.equal(used.entries[0].updatedAt, created.vault.entries[0].updatedAt);
});

test('upsertMany：批量导入只算一次，规则与逐条 upsert 一致', () => {
  const rows = [
    { url: 'https://a.com/login', username: 'alice', password: 'p1' },
    { url: 'https://mail.a.com/login', username: 'bob', password: 'p2' },
    { url: 'https://a.com/login', username: 'alice', password: 'p1-new' }, // 文件内重复，保留最后一条
    { url: 'https://b.com/', username: 'carol', password: '' }, // 空密码 → 无效
    { url: '', username: 'nohost', password: 'x' }, // 无网址 → 无效
  ];

  const { vault, stats } = V.upsertMany(V.empty(), rows, { exact: true });
  // 文件内的重复行先折叠成一条，所以是 2 条新增 + 2 条无效，而不是“新增 2 覆盖 1”
  assert.deepEqual(stats, { added: 2, updated: 0, conflicts: 0, unchanged: 0, invalid: 2 });
  assert.equal(vault.entries.length, 2);

  const alice = vault.entries.find((e) => e.username === 'alice');
  assert.equal(alice.password, 'p1-new');
  const bob = vault.entries.find((e) => e.username === 'bob');
  assert.equal(bob.host, 'mail.a.com', 'exact 模式下子域不能被并进主域');

  // 再导入同一批：全部 unchanged，密码不被回退
  const again = V.upsertMany(vault, rows.slice(0, 3), { exact: true });
  assert.equal(again.stats.added, 0);
  assert.equal(again.stats.unchanged, 2, 'alice 与 bob 都已存在且密码相同');
  assert.equal(again.vault.entries.find((e) => e.username === 'alice').password, 'p1-new');
});

test('upsertMany：overwrite=false 时冲突只统计不改动', () => {
  const existing = V.normalize({
    entries: [{ id: 'e1', host: 'a.com', username: 'alice', password: 'old', updatedAt: '2025-01-01T00:00:00.000Z' }],
  });
  const rows = [
    { url: 'https://a.com/', username: 'alice', password: 'new' },
    { url: 'https://b.com/', username: 'bob', password: 'b1' },
  ];

  const kept = V.upsertMany(existing, rows, { exact: true, overwrite: false });
  assert.deepEqual(kept.stats, { added: 1, updated: 0, conflicts: 1, unchanged: 0, invalid: 0 });
  assert.equal(kept.vault.entries.find((e) => e.username === 'alice').password, 'old');

  const replaced = V.upsertMany(existing, rows, { exact: true, overwrite: true });
  assert.deepEqual(replaced.stats, { added: 1, updated: 1, conflicts: 0, unchanged: 0, invalid: 0 });
  assert.equal(replaced.vault.entries.find((e) => e.username === 'alice').password, 'new');
});

test('upsertMany：写入时间戳单调递增，最后一条就是最终状态', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ url: 'https://a.com/', username: 'alice', password: 'pw-' + i });
  const { vault } = V.upsertMany(V.empty(), rows, { exact: true });
  const alice = vault.entries.find((e) => e.username === 'alice');
  assert.equal(alice.password, 'pw-19');
  assert.deepEqual(vault.entries.length, 1);
});

test('upsertMany：不传 exact 时退化为主域 / 子域匹配', () => {
  const existing = V.normalize({
    entries: [{ id: 'e1', host: 'a.com', username: 'alice', password: 'old', updatedAt: '2025-01-01T00:00:00.000Z' }],
  });
  const { vault, stats } = V.upsertMany(existing, [{ url: 'https://mail.a.com/', username: 'alice', password: 'new' }], {
    overwrite: true,
  });
  assert.equal(stats.updated, 1);
  assert.equal(vault.entries.length, 1);
});

test('upsertMany：5000 条不会退化成几十秒（性能守卫）', () => {
  const rows = [];
  for (let i = 0; i < 5000; i++) rows.push({ url: 'https://h' + i + '.com/', username: 'u' + i, password: 'p' + i });
  const started = Date.now();
  const { vault } = V.upsertMany(V.empty(), rows, { exact: true });
  const elapsed = Date.now() - started;
  assert.equal(vault.entries.length, 5000);
  assert.ok(elapsed < 5000, '5000 行应在一秒级完成，实际 ' + elapsed + 'ms');
});
