/*!
 * pwdmg · 主密码加密（PBKDF2 + AES-GCM）
 *
 * 加密后的密码库文件格式（WebDAV 上的 vault.json）：
 * {
 *   "format": "pwdmg-vault",
 *   "version": 2,
 *   "encrypted": true,
 *   "kdf":    { "name": "PBKDF2", "hash": "SHA-256", "iterations": 310000, "salt": "base64" },
 *   "cipher": { "name": "AES-GCM", "iv": "base64", "tagLength": 128 },
 *   "data":   "base64(密文+认证标签)",
 *   "updatedAt": "..."
 * }
 *
 * 主密码本身永远不会被保存或上传；只保存 KDF 参数（盐 + 迭代次数）。
 * 挂载为 globalThis.PwdmgCrypto，同时支持 Node require（用于单元测试）。
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = mod;
  if (root) root.PwdmgCrypto = mod;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const FORMAT = 'pwdmg-vault';
  const ENVELOPE_VERSION = 2;
  const DEFAULT_ITERATIONS = 310000; // OWASP 对 PBKDF2-HMAC-SHA256 的建议量级
  /* 迭代次数上限：信封里的 iterations 来自远端文件，若不设上限，
     一个被篡改 / 恶意构造的信封可以让解锁卡住几分钟（PBKDF2 是故意慢的）。
     2,000,000 次约等于 4 秒，足够覆盖未来几年的强度提升。 */
  const MAX_ITERATIONS = 2000000;
  const MIN_ITERATIONS = 10000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const TAG_BITS = 128;

  class CryptoError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'CryptoError';
      this.code = code || 'crypto';
    }
  }

  function webcrypto() {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
      throw new CryptoError('当前环境不支持 WebCrypto', 'unsupported');
    }
    return c;
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    webcrypto().getRandomValues(bytes);
    return bytes;
  }

  function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return Buffer.from(view).toString('base64');
    }
    let binary = '';
    for (const byte of view) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const raw = String(text || '');
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return new Uint8Array(Buffer.from(raw, 'base64'));
    }
    const binary = atob(raw);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  function encodeText(text) {
    return new TextEncoder().encode(String(text));
  }

  function decodeText(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function normalizeKdf(kdf) {
    const input = kdf || {};
    const salt = typeof input.salt === 'string' ? input.salt : '';
    if (!salt) throw new CryptoError('缺少加密参数（salt）', 'invalid-envelope');
    const iterations = Number(input.iterations);
    if (!Number.isFinite(iterations) || iterations < MIN_ITERATIONS) {
      throw new CryptoError('加密参数（iterations）不合法', 'invalid-envelope');
    }
    if (iterations > MAX_ITERATIONS) {
      throw new CryptoError(
        '加密参数（iterations）超出上限（' + MAX_ITERATIONS + '），文件可能已被篡改',
        'invalid-envelope'
      );
    }
    return {
      name: 'PBKDF2',
      hash: input.hash === 'SHA-1' ? 'SHA-1' : 'SHA-256',
      iterations: Math.floor(iterations),
      salt,
    };
  }

  /** 由主密码派生 AES-GCM-256 密钥 */
  async function deriveKey(password, kdf) {
    const params = normalizeKdf(kdf);
    const subtle = webcrypto().subtle;
    const baseKey = await subtle.importKey('raw', encodeText(password), { name: 'PBKDF2' }, false, [
      'deriveKey',
    ]);
    return subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: base64ToBytes(params.salt),
        iterations: params.iterations,
        hash: params.hash,
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      true, // 需要导出原始密钥以便放进 session storage
      ['encrypt', 'decrypt']
    );
  }

  /** 生成一套新的 KDF 参数（每次启用 / 修改主密码都换新盐） */
  function createKdf(iterations) {
    return {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: Math.min(
        MAX_ITERATIONS,
        Math.max(MIN_ITERATIONS, Math.floor(Number(iterations) || DEFAULT_ITERATIONS))
      ),
      salt: bytesToBase64(randomBytes(SALT_BYTES)),
    };
  }

  /** 加密任意 JSON 文本，返回信封对象（每次都用新的随机 IV） */
  async function encryptText(plaintext, key, kdf) {
    const params = normalizeKdf(kdf);
    const subtle = webcrypto().subtle;
    const iv = randomBytes(IV_BYTES);
    const ciphertext = await subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_BITS },
      key,
      encodeText(plaintext)
    );
    return {
      format: FORMAT,
      version: ENVELOPE_VERSION,
      encrypted: true,
      kdf: params,
      cipher: { name: 'AES-GCM', iv: bytesToBase64(iv), tagLength: TAG_BITS },
      data: bytesToBase64(new Uint8Array(ciphertext)),
      updatedAt: new Date().toISOString(),
    };
  }

  /** 解密信封，返回明文 JSON 文本；主密码错误时抛 code='bad-key' */
  async function decryptText(envelope, key) {
    const env = envelope || {};
    if (env.encrypted !== true || typeof env.data !== 'string' || !env.cipher || !env.cipher.iv) {
      throw new CryptoError('不是有效的加密密码库文件', 'invalid-envelope');
    }
    const subtle = webcrypto().subtle;
    try {
      const plaintext = await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64ToBytes(env.cipher.iv),
          tagLength: TAG_BITS,
        },
        key,
        base64ToBytes(env.data)
      );
      return decodeText(plaintext);
    } catch (err) {
      throw new CryptoError('主密码不正确，或文件已损坏', 'bad-key');
    }
  }

  /** 判断文本是不是加密信封；不是则返回 null（明文密码库 / 空文件） */
  function parseEnvelope(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw || raw.charAt(0) !== '{') return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return null;
    }
    if (!data || typeof data !== 'object') return null;
    if (data.encrypted !== true) return null;
    if (typeof data.data !== 'string' || !data.kdf || !data.cipher) return null;
    return data;
  }

  function serializeEnvelope(envelope) {
    return JSON.stringify(envelope, null, 2) + '\n';
  }

  /** 导出 / 导入原始密钥（base64），用于 storage.session 缓存 */
  async function exportKey(key) {
    const raw = await webcrypto().subtle.exportKey('raw', key);
    return bytesToBase64(new Uint8Array(raw));
  }

  async function importKey(base64) {
    const raw = base64ToBytes(base64);
    if (!raw.length) throw new CryptoError('密钥为空', 'invalid-key');
    return webcrypto().subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }

  /** 密码强度提示（只用于 UI 提示，不强制） */
  function passwordHint(password) {
    const value = String(password || '');
    if (value.length < 8) return '至少 8 位';
    if (value.length >= 12) return '强度不错';
    return '建议 12 位以上';
  }

  return {
    FORMAT,
    ENVELOPE_VERSION,
    DEFAULT_ITERATIONS,
    MAX_ITERATIONS,
    MIN_ITERATIONS,
    CryptoError,
    randomBytes,
    bytesToBase64,
    base64ToBytes,
    deriveKey,
    createKdf,
    normalizeKdf,
    encryptText,
    decryptText,
    parseEnvelope,
    serializeEnvelope,
    exportKey,
    importKey,
    passwordHint,
  };
});
