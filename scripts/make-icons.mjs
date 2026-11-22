#!/usr/bin/env node
/**
 * 生成扩展图标（无第三方依赖）。
 *
 * 设计：蓝色渐变圆角方块 + 白色钥匙孔。
 * 通过 4x 超采样做抗锯齿，输出 RGBA PNG 到 icons/ 目录。
 *
 * 用法：node scripts/make-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor

const COLORS = {
  gradA: [0x3b, 0x82, 0xf6],
  gradB: [0x1d, 0x4e, 0xd8],
  white: [0xff, 0xff, 0xff],
};

/** 圆角矩形内部判定（坐标基于 0..128 的设计画布，可缩放） */
function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insideCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 返回该设计坐标点的颜色 [r,g,b,a]，128x128 设计空间 */
function sample(x, y) {
  if (!insideRoundedRect(x, y, 0, 0, 128, 128, 28)) return [0, 0, 0, 0];
  // 对角渐变
  const t = Math.min(1, Math.max(0, (x + y) / 256));
  const bg = [
    Math.round(COLORS.gradA[0] + (COLORS.gradB[0] - COLORS.gradA[0]) * t),
    Math.round(COLORS.gradA[1] + (COLORS.gradB[1] - COLORS.gradA[1]) * t),
    Math.round(COLORS.gradA[2] + (COLORS.gradB[2] - COLORS.gradA[2]) * t),
  ];
  const keyhole = insideCircle(x, y, 64, 52, 17) || insideRoundedRect(x, y, 54, 58, 74, 98, 5);
  const c = keyhole ? COLORS.white : bg;
  return [c[0], c[1], c[2], 255];
}

function renderRGBA(size) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = (pxi + (sx + 0.5) / SS) * scale;
          const dy = (py + (sy + 0.5) / SS) * scale;
          const [cr, cg, cb, ca] = sample(dx, dy);
          const w = ca / 255;
          r += cr * w;
          g += cg * w;
          b += cb * w;
          a += ca;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const i = (py * size + pxi) * 4;
      if (alpha <= 0) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
      } else {
        const norm = alpha / 255;
        px[i] = Math.round(r / n / norm);
        px[i + 1] = Math.round(g / n / norm);
        px[i + 2] = Math.round(b / n / norm);
        px[i + 3] = Math.round(alpha);
      }
    }
  }
  return px;
}

function encodePNG(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePNG(size, renderRGBA(size));
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(ROOT, file)} (${png.length} bytes)`);
}
