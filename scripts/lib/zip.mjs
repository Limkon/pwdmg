/**
 * 零依赖 ZIP 打包（deflate / store），不依赖系统的 zip 命令。
 *
 * 打包结果对同一份输入是**确定的**（固定时间戳、固定顺序、固定压缩级别），
 * 方便对比两次构建是否真的只改了想改的东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ---------------------------------------------------------------- *
 * CRC32
 * ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------- *
 * 文件遍历
 * ---------------------------------------------------------------- */

function walk(dir, prefix, out) {
  const names = fs.readdirSync(dir).sort();
  for (const name of names) {
    if (name === '.DS_Store' || name === 'Thumbs.db') continue;
    const full = path.join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, rel, out);
    } else if (stat.isFile()) {
      out.push({ name: rel, data: fs.readFileSync(full) });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * ZIP 结构
 * ---------------------------------------------------------------- */

// 固定成 2020-01-01 00:00:00，保证同样内容产出同样的字节
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function buildEntry(file) {
  const nameBytes = Buffer.from(file.name, 'utf8');
  const crc = crc32(file.data);
  const deflated = zlib.deflateRawSync(file.data, { level: 9 });
  const useDeflate = deflated.length < file.data.length;
  const payload = useDeflate ? deflated : file.data;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(SIG_LOCAL, 0);
  local.writeUInt16LE(20, 4); // 解压所需版本
  local.writeUInt16LE(FLAG_UTF8, 6);
  local.writeUInt16LE(useDeflate ? METHOD_DEFLATE : METHOD_STORE, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(file.data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  const central = Buffer.alloc(46);
  central.writeUInt32LE(SIG_CENTRAL, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(FLAG_UTF8, 8);
  central.writeUInt16LE(useDeflate ? METHOD_DEFLATE : METHOD_STORE, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(file.data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset（稍后回填）

  return { nameBytes, local, central, payload };
}

/**
 * 把一个目录打包成 zip（目录内部就是 zip 根）。
 * @param {string} dir 源目录
 * @param {string} zipPath 输出文件
 * @returns {{ files: number, bytes: number }}
 */
export function zipDirectory(dir, zipPath) {
  if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
  const files = walk(dir, '', []);
  if (!files.length) throw new Error('目录是空的：' + dir);

  const chunks = [];
  const entries = [];
  let offset = 0;

  for (const file of files) {
    const entry = buildEntry(file);
    entry.central.writeUInt32LE(offset, 42);
    chunks.push(entry.local, entry.nameBytes, entry.payload);
    entries.push(entry);
    offset += entry.local.length + entry.nameBytes.length + entry.payload.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const entry of entries) {
    chunks.push(entry.central, entry.nameBytes);
    centralSize += entry.central.length + entry.nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // central dir disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length
  chunks.push(end);

  const buffer = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, buffer);
  return { files: entries.length, bytes: buffer.length };
}
