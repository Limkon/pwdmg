'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, WebDavError, normalizeUrl } = require('../src/shared/webdav.js');
const { startWebDavServer } = require('./helpers/webdav-server.js');

test('读取不存在的文件返回 exists:false', async (t) => {
  const server = await startWebDavServer();
  t.after(() => server.close());

  const client = createClient({ url: server.baseUrl + '/dav/vault.json' });
  const result = await client.read();
  assert.equal(result.exists, false);
  assert.equal(result.text, '');
});

test('写入会自动创建目录并成功回读', async (t) => {
  const server = await startWebDavServer({ auth: { username: 'me', password: 'pa ss' } });
  t.after(() => server.close());

  const client = createClient({
    url: server.baseUrl + '/remote.php/dav/files/me/pwdmg/vault.json',
    username: 'me',
    password: 'pa ss',
  });

  const empty = await client.read();
  assert.equal(empty.exists, false);

  const payload = JSON.stringify({ version: 1, entries: [] });
  const written = await client.write(payload, { createDirs: true });
  assert.ok(written.etag);

  // 目录已按层级创建
  assert.ok(server.dirs.has('/remote.php/'));
  assert.ok(server.dirs.has('/remote.php/dav/'));
  assert.ok(server.dirs.has('/remote.php/dav/files/'));
  assert.ok(server.dirs.has('/remote.php/dav/files/me/pwdmg/'));

  const readBack = await client.read();
  assert.equal(readBack.exists, true);
  assert.equal(readBack.text, payload);
  assert.equal(readBack.etag, written.etag);
});

test('ETag 不匹配时抛出 conflict', async (t) => {
  const server = await startWebDavServer();
  t.after(() => server.close());

  const url = server.baseUrl + '/vault.json';
  const client = createClient({ url });
  const first = await client.write('{"a":1}', {});
  assert.ok(first.etag);

  // 模拟另一台设备先写入
  server.seed('/vault.json', '{"a":2}');

  await assert.rejects(
    () => client.write('{"a":3}', { etag: first.etag }),
    (err) => {
      assert.equal(err.code, 'conflict');
      assert.equal(err.status, 412);
      return true;
    }
  );

  // 用最新 etag 可以写入
  const latest = await client.read();
  const ok = await client.write('{"a":4}', { etag: latest.etag });
  assert.ok(ok.etag);
  assert.equal((await client.read()).text, '{"a":4}');
});

test('认证失败给出可读错误', async (t) => {
  const server = await startWebDavServer({ auth: { username: 'me', password: 'right' } });
  t.after(() => server.close());

  const client = createClient({ url: server.baseUrl + '/vault.json', username: 'me', password: 'wrong' });
  await assert.rejects(
    () => client.read(),
    (err) => {
      assert.ok(err instanceof WebDavError);
      assert.equal(err.code, 'auth');
      assert.match(err.message, /认证失败/);
      return true;
    }
  );
});

test('Bearer 令牌认证', async (t) => {
  const server = await startWebDavServer({ auth: { username: 'token', password: '' } });
  t.after(() => server.close());

  // 服务器只认 Basic，这里用 Basic('token:') 验证 Bearer 分支不会发送 Basic
  const bearer = createClient({ url: server.baseUrl + '/vault.json', authType: 'bearer', token: 'abc' });
  await assert.rejects(() => bearer.read(), (err) => {
    assert.equal(err.code, 'auth');
    return true;
  });
  const basic = createClient({ url: server.baseUrl + '/vault.json', authType: 'basic', username: 'token', password: '' });
  const result = await basic.read();
  assert.equal(result.exists, false);
});

test('testConnection 报告文件是否存在', async (t) => {
  const server = await startWebDavServer();
  t.after(() => server.close());

  const url = server.baseUrl + '/pwdmg/vault.json';
  const client = createClient({ url });

  const missing = await client.testConnection();
  assert.equal(missing.ok, true);
  assert.equal(missing.exists, false);
  assert.match(missing.message, /尚不存在/);

  await client.write('{"version":1,"entries":[]}', { createDirs: true });
  const exists = await client.testConnection();
  assert.equal(exists.exists, true);
  assert.ok(exists.bytes > 0);
  assert.match(exists.message, /连接成功/);
});

test('配置错误在创建客户端时就被拦截', () => {
  assert.throws(() => createClient({ url: '' }), /尚未填写/);
  assert.throws(() => createClient({ url: 'ftp://dav.example.com/x.json' }), /http/);
});

test('目录链解析', () => {
  const { dirChain } = require('../src/shared/webdav.js');
  assert.deepEqual(dirChain('https://dav.example.com/a/b/c.json'), [
    'https://dav.example.com/a/',
    'https://dav.example.com/a/b/',
  ]);
  assert.deepEqual(dirChain('https://dav.example.com/vault.json'), []);
});

test('normalizeUrl：目录地址自动补成 vault.json', () => {
  assert.equal(normalizeUrl('https://h/dav/'), 'https://h/dav/vault.json');
  assert.equal(normalizeUrl('https://h/dav'), 'https://h/dav/vault.json');
  assert.equal(normalizeUrl('https://h/dav/pwdmg'), 'https://h/dav/pwdmg/vault.json');
  assert.equal(
    normalizeUrl('https://h/remote.php/dav/files/me'),
    'https://h/remote.php/dav/files/me/vault.json'
  );
  assert.equal(normalizeUrl('https://h'), 'https://h/vault.json');
  // 已经是文件地址就原样保留
  assert.equal(normalizeUrl('https://h/dav/pwdmg/vault.json'), 'https://h/dav/pwdmg/vault.json');
  assert.equal(normalizeUrl('  https://h/dav/x.json#frag  '), 'https://h/dav/x.json');
  assert.equal(normalizeUrl(''), '');
  assert.throws(() => normalizeUrl('ftp://h/x.json'), /http:\/\//);
});

test('地址填成目录时客户端仍写到 vault.json', async (t) => {
  const server = await startWebDavServer();
  t.after(() => server.close());

  const client = createClient({ url: server.baseUrl + '/dav/pwdmg/' });
  assert.equal(client.url, server.baseUrl + '/dav/pwdmg/vault.json');

  await client.write('{"version":1,"entries":[]}', { createDirs: true });
  assert.ok(server.dirs.has('/dav/pwdmg/'));
  assert.ok(server.files.has('/dav/pwdmg/vault.json'));
});

test('GET 到网页时给出明确提示，而不是 JSON 解析错误', async (t) => {
  const html =
    '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN"><html><head><title>Index of /dav</title></head><body></body></html>';
  const server = await startWebDavServer({ htmlPages: { '/dav/vault.json': html } });
  t.after(() => server.close());

  const client = createClient({ url: server.baseUrl + '/dav/vault.json' });
  await assert.rejects(
    () => client.read(),
    (err) => {
      assert.equal(err.code, 'html');
      assert.match(err.message, /返回的是网页/);
      assert.match(err.message, /vault\.json/);
      return true;
    }
  );
});

test('测试连接遇到网页时失败，不会误报成功', async (t) => {
  const server = await startWebDavServer({ htmlPages: { '/dav/vault.json': '<html><body>login</body></html>' } });
  t.after(() => server.close());

  const client = createClient({ url: server.baseUrl + '/dav/vault.json' });
  await assert.rejects(() => client.testConnection(), (err) => err.code === 'html');
});

test('测试连接在文件不存在时报可以创建', async (t) => {
  const server = await startWebDavServer();
  t.after(() => server.close());

  const client = createClient({ url: server.baseUrl + '/dav/pwdmg/vault.json' });
  const info = await client.testConnection();
  assert.equal(info.ok, true);
  assert.equal(info.exists, false);
  assert.match(info.message, /尚不存在/);
});
