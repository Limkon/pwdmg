#!/usr/bin/env node
/**
 * 静态检查：语法检查所有 JS、校验 manifest / package.json 的 JSON 是否合法。
 * 用法：node scripts/check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const jsFiles = files.filter((f) => JS_EXT.has(path.extname(f)));
const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.includes('package-lock'));

let failures = 0;

for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures += 1;
    console.error('✗ 语法错误: ' + path.relative(ROOT, file));
    console.error(String(err.stderr || err.message).trim());
  }
}

for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failures += 1;
    console.error('✗ JSON 无效: ' + path.relative(ROOT, file) + ' — ' + err.message);
  }
}

if (failures) {
  console.error(`\n共 ${failures} 个问题`);
  process.exit(1);
}
console.log(`✓ 检查通过：${jsFiles.length} 个 JS 文件、${jsonFiles.length} 个 JSON 文件`);
