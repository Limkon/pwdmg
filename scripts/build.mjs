#!/usr/bin/env node
/**
 * 构建脚本：把 src/ + icons/ + 对应 manifest 组装成可直接加载的扩展目录，并打包 zip。
 *
 * 用法：node scripts/build.mjs
 * 产物：dist/chrome/、dist/firefox/、dist/pwdmg-chrome.zip、dist/pwdmg-firefox.zip
 *
 * zip 由 scripts/lib/zip.mjs 自己写，不依赖系统的 zip 命令（Windows 也能跑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const TARGETS = [
  { name: 'chrome', manifest: 'manifest.chrome.json' },
  { name: 'firefox', manifest: 'manifest.firefox.json' },
];

function validateManifest(manifest, outDir) {
  const problems = [];
  const check = (rel) => {
    if (!rel) return;
    const target = path.join(outDir, rel);
    if (!fs.existsSync(target)) problems.push('缺少文件: ' + rel);
  };

  const background = manifest.background || {};
  check(background.service_worker);
  if (Array.isArray(background.scripts)) background.scripts.forEach(check);
  if (manifest.action) {
    check(manifest.action.default_popup);
    Object.values(manifest.action.default_icon || {}).forEach(check);
  }
  if (manifest.options_ui) check(manifest.options_ui.page);
  Object.values(manifest.icons || {}).forEach(check);
  for (const cs of manifest.content_scripts || []) {
    (cs.js || []).forEach(check);
    (cs.css || []).forEach(check);
  }
  return problems;
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const target of TARGETS) {
  const outDir = path.join(DIST, target.name);
  fs.mkdirSync(outDir, { recursive: true });

  for (const dir of ['src', 'icons']) {
    fs.cpSync(path.join(ROOT, dir), path.join(outDir, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'manifests', target.manifest), path.join(outDir, 'manifest.json'));

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const problems = validateManifest(manifest, outDir);
  if (problems.length) {
    console.error(`✗ ${target.name}: manifest 校验失败`);
    problems.forEach((p) => console.error('  - ' + p));
    process.exitCode = 1;
    continue;
  }

  const zipPath = path.join(DIST, `pwdmg-${target.name}.zip`);
  fs.rmSync(zipPath, { force: true });
  const zipped = zipDirectory(outDir, zipPath);
  const size = (zipped.bytes / 1024).toFixed(1);
  console.log(
    `✓ ${target.name}: dist/${target.name}/  →  dist/pwdmg-${target.name}.zip (${size} KB, ${zipped.files} 个文件)`
  );
}

console.log('\n加载方式：');
console.log('  Chrome / Edge：chrome://extensions → 打开开发者模式 → 加载已解压的扩展程序 → 选择 dist/chrome');
console.log('  Firefox：about:debugging#/runtime/this-firefox → 临时载入附加组件 → 选择 dist/firefox/manifest.json');
