'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/shared/util.js');

test('hostOf / originOf 解析', () => {
  assert.equal(U.hostOf('https://login.example.com/path?x=1'), 'login.example.com');
  assert.equal(U.hostOf('not a url'), '');
  assert.equal(U.originOf('https://example.com:8443/a'), 'https://example.com:8443');
  assert.equal(U.originOf('chrome://extensions'), '');
  assert.equal(U.isWebUrl('https://a.com'), true);
  assert.equal(U.isWebUrl('ftp://a.com'), false);
  assert.equal(U.isWebUrl('javascript:alert(1)'), false);
});

test('normalizeHost 接受 URL 或裸域名', () => {
  assert.equal(U.normalizeHost('https://Example.com/login'), 'example.com');
  assert.equal(U.normalizeHost(' Example.COM '), 'example.com');
  assert.equal(U.normalizeHost(''), '');
});

test('hostMatches 支持子域双向匹配，且不会误匹配后缀', () => {
  assert.equal(U.hostMatches('example.com', 'example.com'), true);
  assert.equal(U.hostMatches('login.example.com', 'example.com'), true);
  assert.equal(U.hostMatches('example.com', 'login.example.com'), true);
  assert.equal(U.hostMatches('www.example.com', 'example.com'), true);
  assert.equal(U.hostMatches('example.com', 'evil-example.com'), false);
  assert.equal(U.hostMatches('example.com', 'example.com.evil.net'), false);
  assert.equal(U.hostMatches('', 'example.com'), false);
});

test('prettyHost / firstLetter / formatRelativeTime', () => {
  assert.equal(U.prettyHost('www.example.com'), 'example.com');
  assert.equal(U.firstLetter('alice'), 'A');
  assert.equal(U.firstLetter(''), '?');
  assert.equal(U.formatRelativeTime(null), '从未');
  assert.equal(U.formatRelativeTime(new Date().toISOString()), '刚刚');
  assert.match(U.formatRelativeTime(new Date(Date.now() - 3600 * 1000).toISOString()), /小时前/);
});

test('escapeHtml 处理危险字符', () => {
  assert.equal(U.escapeHtml('<b>"x"&y</b>'), '&lt;b&gt;&quot;x&quot;&amp;y&lt;/b&gt;');
});

test('debounce 合并调用', async () => {
  let calls = 0;
  const fn = U.debounce(() => {
    calls += 1;
  }, 10);
  fn();
  fn();
  fn();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});

test('withTimeout 在超时后拒绝', async () => {
  const slow = new Promise(() => {});
  await assert.rejects(() => U.withTimeout(slow, 30, '测试'), /测试超时/);
});

test('formatRemaining：把剩余时间说成人话', () => {
  assert.equal(U.formatRemaining(null), '');
  assert.equal(U.formatRemaining(0), '已过期');
  assert.equal(U.formatRemaining(-1), '已过期');
  assert.equal(U.formatRemaining(30 * 60 * 1000), '不到 1 小时');
  assert.equal(U.formatRemaining(5 * 3600 * 1000), '5 小时');
  assert.equal(U.formatRemaining(86400000), '1 天');
  assert.equal(U.formatRemaining(4.2 * 86400000), '5 天');
});
