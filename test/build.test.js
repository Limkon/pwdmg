'use strict';

/**
 * 打包产物测试：scripts/lib/zip.mjs 写出来的 zip 必须能被标准工具正确解开，
 * 否则发版包就是坏的。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');

test('zipDirectory：嵌套目录、中文文件名、内容可还原', async () => {
  const { zipDirectory } = await import(path.join(ROOT, 'scripts/lib/zip.mjs'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwdmg-zip-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ version: '1.1.0' }));
  fs.writeFileSync(path.join(src, 'shared', 'util.js'), 'console.log("你好 pwdmg");\n');
  // 随机内容，保证走 deflate 分支而不是 store
  fs.writeFileSync(path.join(src, 'shared', 'big.bin'), Buffer.alloc(4096, 'A'));

  const zipPath = path.join(tmp, 'out.zip');
  const result = zipDirectory(src, zipPath);
  assert.equal(result.files, 3);
  assert.equal(fs.existsSync(zipPath), true);

  const buffer = fs.readFileSync(zipPath);
  const entries = readZip(buffer);

  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    ['manifest.json', 'shared/big.bin', 'shared/util.js']
  );

  const find = (name) => entries.find((e) => e.name === name);
  assert.equal(find('manifest.json').data.toString('utf8'), JSON.stringify({ version: '1.1.0' }));
  assert.equal(find('shared/util.js').data.toString('utf8'), 'console.log("你好 pwdmg");\n');
  assert.equal(find('shared/big.bin').data.toString('utf8'), 'A'.repeat(4096));
  assert.equal(find('shared/big.bin').method, 8, '可压缩内容应使用 deflate');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('zipDirectory：同样的输入产出同样的字节（可复现）', async () => {
  const { zipDirectory } = await import(path.join(ROOT, 'scripts/lib/zip.mjs'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwdmg-zip2-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(src, 'b.txt'), 'world'.repeat(100));

  const first = path.join(tmp, 'first.zip');
  const second = path.join(tmp, 'second.zip');
  zipDirectory(src, first);
  zipDirectory(src, second);
  assert.equal(fs.readFileSync(first).equals(fs.readFileSync(second)), true);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('构建产物里的 manifest 版本与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of ['manifest.chrome.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifests', name), 'utf8'));
    assert.equal(manifest.version, pkg.version, name + ' 版本号不一致');
  }
});

/* ------------------------------------------------------------------ *
 * 极简 ZIP 读取器：只解析本脚本需要的字段
 * ------------------------------------------------------------------ */

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c ^= buffer[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readZip(buffer) {
  // 从后往前找 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, '找不到 zip 结尾记录');

  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < total; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, '中央目录签名不对');
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString('utf8');

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, '本地文件头签名不对');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.slice(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;

    assert.equal(data.length, size, name + ' 解压后长度不对');
    assert.equal(crc32(data), crc, name + ' CRC 校验失败');

    entries.push({ name, method, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
