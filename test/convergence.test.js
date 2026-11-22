'use strict';

/**
 * 多设备随机收敛测试（属性测试）。
 *
 * 三台“设备”各自有独立的 storage，共用同一个 WebDAV 文件，
 * 随机记录 / 改密码 / 删除 / 同步，最后要求：
 *   1. 所有设备与远端的内容完全一致（收敛）
 *   2. 最后一次操作是「保存」的账号一个都不能少，密码以最后一次为准
 *   3. 没被删除过的账号不会凭空消失
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startWebDavServer } = require('./helpers/webdav-server.js');
const { loadBackground } = require('./helpers/background-harness.js');

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

/** 可复现的伪随机数 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fingerprint(vault) {
  return vault.entries
    .map((e) => [e.host, e.username, e.password].join('|'))
    .sort()
    .join('\n');
}

test('三台设备随机操作后完全收敛，且不丢数据', { timeout: 180000 }, async (t) => {
  const server = await startWebDavServer({});
  t.after(() => server.close());

  const random = makeRandom(Number(process.env.PWDMG_SEED || 20261122));
  const devices = [loadBackground(), loadBackground(), loadBackground()];
  for (const device of devices) device.store.set('settings', settingsFor(server));

  // 模型：host|user -> { password, savedAt, deletedAt }
  const model = new Map();
  // 故意用互不构成子域关系的主机名：这个用例只考察同步收敛，
  // 子域模糊匹配（mail.a.com 会被当成 a.com 的同一条记录）另有专门的用例。
  const hosts = ['a.com', 'b.com', 'c.org', 'd.net'];
  const users = ['alice', 'bob', 'carol'];
  let clock = 0;
  const stamp = () => ++clock;

  const keyOf = (host, user) => host + '|' + user;

  for (let step = 0; step < 45; step++) {
    const device = devices[Math.floor(random() * devices.length)];
    const host = hosts[Math.floor(random() * hosts.length)];
    const user = users[Math.floor(random() * users.length)];
    const action = random();
    const modelKey = keyOf(host, user);
    const current = model.get(modelKey);

    if (action < 0.55) {
      // 保存 / 更新密码（模拟真实时间顺序，避免同一毫秒的时间戳打平）
      const password = 'pw-' + step;
      const res = await device.send(
        {
          type: 'credential:capture',
          url: 'https://' + host + '/login',
          username: user,
          password,
          force: true, // 直接覆盖，不走“是否更新”确认
        },
        { url: 'https://' + host + '/login' }
      );
      assert.equal(res.saved, true, 'capture 应成功：' + JSON.stringify(res));
      model.set(modelKey, { password, savedAt: stamp(), deletedAt: current ? current.deletedAt : 0 });
    } else if (action < 0.75 && current && !current.deletedAt) {
      // 删除某个设备上存在的那条
      const listed = await device.send({ type: 'vault:list' });
      const target = listed.vault.entries.find((e) => e.host === host && e.username === user);
      if (target) {
        await device.send({ type: 'vault:deleteEntry', id: target.id });
        model.set(modelKey, Object.assign({}, current, { deletedAt: stamp() }));
      }
    } else {
      // 只同步
      await device.send({ type: 'vault:sync' });
    }

    // 偶尔同步 / 让出事件循环，保证时间戳严格递增
    if (random() < 0.5) await device.send({ type: 'vault:sync' });
    await sleep(2);
  }

  // 收尾：每台设备都同步两轮
  for (let round = 0; round < 2; round++) {
    for (const device of devices) {
      const res = await device.send({ type: 'vault:sync' });
      assert.equal(res.ok, true, '收尾同步失败：' + res.error);
    }
    await sleep(20);
  }

  const fingerprints = [];
  for (const device of devices) {
    fingerprints.push(fingerprint((await device.send({ type: 'vault:list' })).vault));
  }
  const remote = JSON.parse(server.files.get('/pwdmg/vault.json').content);
  const remoteFingerprint = fingerprint(remote);

  assert.equal(fingerprints[0], fingerprints[1], '设备 1 与设备 2 应一致');
  assert.equal(fingerprints[1], fingerprints[2], '设备 2 与设备 3 应一致');
  assert.equal(fingerprints[0], remoteFingerprint, '设备与远端应一致');

  // 逐条核对模型：最后的动作是保存 → 必须在；最后的动作是删除 → 必须不在
  const finalByKey = new Map();
  for (const entry of remote.entries) finalByKey.set(keyOf(entry.host, entry.username), entry);

  for (const [key, state] of model) {
    const entry = finalByKey.get(key);
    if (state.deletedAt > state.savedAt) {
      assert.equal(entry, undefined, key + ' 应已删除');
    } else {
      assert.ok(entry, key + ' 不该消失');
      assert.equal(entry.password, state.password, key + ' 的密码应是最后一次保存的值');
    }
  }
});
