'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, parseRows } = require('../src/shared/csv.js');

test('CSV：引号里的逗号、换行和 "" 转义', () => {
  const text = 'a,"b,c","d""e"\r\n"x\ny",z,\r\n';
  const rows = parseRows(text);
  assert.deepEqual(rows, [
    ['a', 'b,c', 'd"e'],
    ['x\ny', 'z', ''],
  ]);
});

test('CSV：BOM 与空行会被忽略', () => {
  const rows = parseRows('\uFEFFurl,password\r\n\r\nhttps://a.com,pw\r\n\r\n');
  assert.deepEqual(rows, [
    ['url', 'password'],
    ['https://a.com', 'pw'],
  ]);
});

test('Chrome / Edge：name,url,username,password,note', () => {
  const text = [
    'name,url,username,password,note',
    'GitHub,https://github.com/login,alice,s3cret,工作账号',
    'Mail,https://mail.example.com,bob,pw2,',
  ].join('\r\n');
  const out = parse(text);
  assert.equal(out.ok, true);
  assert.equal(out.format, 'chrome');
  assert.equal(out.stats.rows, 2);
  assert.equal(out.stats.usable, 2);
  assert.deepEqual(
    out.entries.map((e) => [e.host, e.username, e.password, e.title, e.notes]),
    [
      ['github.com', 'alice', 's3cret', 'GitHub', '工作账号'],
      ['mail.example.com', 'bob', 'pw2', 'Mail', ''],
    ]
  );
  assert.equal(out.entries[0].origin, 'https://github.com');
  assert.equal(out.entries[0].url, 'https://github.com/login');
});

test('Bitwarden 表头也能识别', () => {
  const text = [
    'folder,favorite,type,name,login_uri,login_username,login_password,login_totp',
    ',,login,Example,https://example.com,bob,pw-bob,',
  ].join('\n');
  const out = parse(text);
  assert.equal(out.ok, true);
  assert.equal(out.format, 'bitwarden');
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].username, 'bob');
  assert.equal(out.entries[0].password, 'pw-bob');
});

test('Firefox 导出的表头也能识别（url 在第 1 列）', () => {
  const text = [
    'url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged',
    'https://site.example,carol,pw-c,,,guid-1,1700000000,1700000000,1700000000',
  ].join('\n');
  const out = parse(text);
  assert.equal(out.format, 'firefox');
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].host, 'site.example');
  assert.equal(out.entries[0].password, 'pw-c');
});

test('没有表头时按 Chrome 的列序解析', () => {
  const out = parse('T,https://a.example,u,p,\n');
  assert.equal(out.ok, true);
  assert.equal(out.entries[0].host, 'a.example');
  assert.equal(out.entries[0].title, 'T');
});

test('跳过 android:// 与空密码，缺协议时补 https', () => {
  const text = [
    'name,url,username,password,note',
    'App,android://hash@com.example/,u,p,',
    'Empty,https://b.example,v,,',
    'Bare,b.example,w,pw,',
  ].join('\n');
  const out = parse(text);
  assert.equal(out.stats.skippedAndroid, 1);
  assert.equal(out.stats.skippedNoPassword, 1);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].host, 'b.example');
  assert.equal(out.entries[0].origin, 'https://b.example');
});

test('同站点同用户名出现多次时保留最后一条', () => {
  const text = [
    'name,url,username,password,note',
    'Old,https://x.example,alice,old-pw,',
    'New,https://x.example,alice,new-pw,',
    'Other,https://x.example,bob,pw-bob,',
  ].join('\n');
  const out = parse(text);
  assert.equal(out.entries.length, 2);
  assert.equal(out.stats.merged, 1);
  const alice = out.entries.find((e) => e.username === 'alice');
  assert.equal(alice.password, 'new-pw');
});

test('缺 url / password 列时报告不支持的格式', () => {
  const out = parse('foo,bar\n1,2\n');
  assert.equal(out.ok, false);
  assert.match(out.error, /url|password/);
});

test('空文件不会崩', () => {
  const out = parse('');
  assert.equal(out.ok, false);
  assert.equal(out.entries.length, 0);
});
