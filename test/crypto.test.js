'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/shared/crypto.js');

const PAYLOAD = JSON.stringify({
  version: 1,
  updatedAt: '2025-01-01T00:00:00.000Z',
  entries: [{ id: 'e1', host: 'example.com', username: 'alice', password: 's3cret!' }],
  tombstones: {},
});

test('PBKDF2 派生 + AES-GCM 加解密往返', async () => {
  const kdf = C.createKdf(10000); // 测试里降低迭代次数加快速度
  const key = await C.deriveKey('master-password', kdf);
  const envelope = await C.encryptText(PAYLOAD, key, kdf);

  assert.equal(envelope.encrypted, true);
  assert.equal(envelope.format, 'pwdmg-vault');
  assert.equal(envelope.kdf.iterations, 10000);
  assert.equal(envelope.kdf.salt, kdf.salt);
  assert.notEqual(envelope.data, PAYLOAD);

  const text = await C.decryptText(envelope, key);
  assert.equal(text, PAYLOAD);
});

test('不同主密码无法解密', async () => {
  const kdf = C.createKdf(10000);
  const key = await C.deriveKey('correct', kdf);
  const envelope = await C.encryptText(PAYLOAD, key, kdf);

  const wrong = await C.deriveKey('wrong', kdf);
  await assert.rejects(
    () => C.decryptText(envelope, wrong),
    (err) => {
      assert.equal(err.code, 'bad-key');
      assert.match(err.message, /主密码不正确/);
      return true;
    }
  );
});

test('每次加密使用不同的随机 IV', async () => {
  const kdf = C.createKdf(10000);
  const key = await C.deriveKey('pw', kdf);
  const a = await C.encryptText(PAYLOAD, key, kdf);
  const b = await C.encryptText(PAYLOAD, key, kdf);
  assert.notEqual(a.cipher.iv, b.cipher.iv);
  assert.notEqual(a.data, b.data);
});

test('密文被篡改时认证失败', async () => {
  const kdf = C.createKdf(10000);
  const key = await C.deriveKey('pw', kdf);
  const envelope = await C.encryptText(PAYLOAD, key, kdf);

  const bytes = C.base64ToBytes(envelope.data);
  bytes[0] ^= 0xff;
  const tampered = Object.assign({}, envelope, { data: C.bytesToBase64(bytes) });

  await assert.rejects(() => C.decryptText(tampered, key), /主密码不正确/);
});

test('parseEnvelope 只认加密信封', async () => {
  const kdf = C.createKdf(10000);
  const key = await C.deriveKey('pw', kdf);
  const envelope = await C.encryptText(PAYLOAD, key, kdf);

  const parsed = C.parseEnvelope(C.serializeEnvelope(envelope));
  assert.ok(parsed);
  assert.equal(parsed.encrypted, true);

  assert.equal(C.parseEnvelope(PAYLOAD), null, '明文密码库不算信封');
  assert.equal(C.parseEnvelope(''), null);
  assert.equal(C.parseEnvelope('not json'), null);
  assert.equal(C.parseEnvelope('{"encrypted":true}'), null, '缺少字段不算信封');
});

test('导出的原始密钥可以重新导入并解密', async () => {
  const kdf = C.createKdf(10000);
  const key = await C.deriveKey('pw', kdf);
  const envelope = await C.encryptText(PAYLOAD, key, kdf);

  const exported = await C.exportKey(key);
  assert.match(exported, /^[A-Za-z0-9+/=]+$/);

  const imported = await C.importKey(exported);
  assert.equal(await C.decryptText(envelope, imported), PAYLOAD);
});

test('非法 KDF 参数会被拒绝', async () => {
  await assert.rejects(() => C.deriveKey('pw', { salt: '' }), /salt/);
  await assert.rejects(() => C.deriveKey('pw', { salt: 'AAAA', iterations: 10 }), /iterations/);
});

test('密码提示', () => {
  assert.equal(C.passwordHint('123'), '至少 8 位');
  assert.equal(C.passwordHint('12345678'), '建议 12 位以上');
  assert.equal(C.passwordHint('123456789012'), '强度不错');
});
