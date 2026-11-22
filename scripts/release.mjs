#!/usr/bin/env node
/**
 * 打包 / 发布脚本。
 *
 * 用法：
 *   npm run release                      用当前版本号打包（不改文件、不碰 git）
 *   npm run release -- 1.2.0             改版本号 → 校验 → 测试 → 打包
 *   npm run release -- --bump patch      按语义化版本递增（patch / minor / major）
 *   npm run release -- 1.2.0 --tag       同上，并提交 + 打 git tag（推送后触发 GitHub Actions 发版）
 *   npm run release -- --pack-only       只打包（CI 用：不改版本、不碰 git）
 *   npm run release -- --skip-test       跳过测试（不推荐）
 *   npm run release -- --allow-dirty     允许工作区有未提交的改动
 *
 * 产物：
 *   dist/chrome/、dist/firefox/              可直接「加载已解压的扩展程序」
 *   dist/pwdmg-chrome.zip、dist/pwdmg-firefox.zip
 *   dist/SHA256SUMS.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  ROOT,
  assertConsistent,
  bumpVersion,
  isValidVersion,
  readVersions,
  writeVersions,
} from './lib/version.mjs';

const DIST = path.join(ROOT, 'dist');
const ARTIFACTS = ['pwdmg-chrome.zip', 'pwdmg-firefox.zip'];

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    version: '',
    bump: '',
    tag: false,
    packOnly: false,
    skipTest: false,
    allowDirty: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tag') options.tag = true;
    else if (arg === '--pack-only') options.packOnly = true;
    else if (arg === '--skip-test') options.skipTest = true;
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--bump') options.bump = argv[++i] || '';
    else if (arg.startsWith('--bump=')) options.bump = arg.slice('--bump='.length);
    else if (!arg.startsWith('-')) options.version = arg;
    else throw new Error('未知参数：' + arg);
  }

  return options;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const log = (text) => console.log(text);
const ok = (text) => console.log('✓ ' + text);

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options });
}

function isDirty() {
  try {
    return git(['status', '--porcelain']).trim() !== '';
  } catch (err) {
    return false;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function writeChecksums() {
  const lines = [];
  for (const name of ARTIFACTS) {
    const file = path.join(DIST, name);
    if (!fs.existsSync(file)) continue;
    lines.push(`${sha256(file)}  ${name}`);
  }
  const sums = path.join(DIST, 'SHA256SUMS.txt');
  fs.writeFileSync(sums, lines.join('\n') + '\n');
  ok(`dist/SHA256SUMS.txt`);
  for (const line of lines) log('  ' + line);
}

function printArtifacts() {
  log('\n产物：');
  for (const name of ARTIFACTS) {
    const file = path.join(DIST, name);
    if (fs.existsSync(file)) log(`  dist/${name}  (${humanSize(fs.statSync(file).size)})`);
  }
  log('  dist/chrome/     → Chrome / Edge：chrome://extensions → 开发者模式 → 加载已解压的扩展程序');
  log('  dist/firefox/    → Firefox：about:debugging → 临时载入附加组件 → 选 manifest.json');
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    const source = fs.readFileSync(new URL(import.meta.url), 'utf8');
    const doc = source.slice(source.indexOf('/**') + 3, source.indexOf('*/'));
    log(doc.replace(/^ \* ?/gm, '').trim());
    return;
  }

  const current = readVersions();
  let target = current.package;

  if (options.version && options.bump) throw new Error('版本号和 --bump 只能二选一');
  if (options.version) {
    if (!isValidVersion(options.version)) throw new Error(`版本号格式不对：${options.version}（应形如 1.2.0）`);
    target = options.version.trim();
  } else if (options.bump) {
    target = bumpVersion(current.package, options.bump);
  }

  if (options.packOnly) {
    if (options.version || options.bump) throw new Error('--pack-only 不能和版本号参数一起用');
    log(`打包 pwdmg v${current.package}（不改版本、不碰 git）\n`);
  } else {
    log(`发布 pwdmg v${target}（当前 v${current.package}）\n`);
  }

  // 打 tag 要求工作区干净，避免把无关改动一起提交
  if (options.tag && !options.allowDirty && isDirty()) {
    throw new Error('工作区有未提交的改动。先提交，或者加 --allow-dirty 只提交版本号文件');
  }

  // 1. 版本号
  if (!options.packOnly) {
    writeVersions(target);
    ok(`版本号已写入 package.json + 2 个 manifest：${target}`);
    if (current.chrome !== current.package || current.firefox !== current.package) {
      log('  （原先 manifest 版本与 package.json 不一致，已一并修正）');
    }
  }

  const consistent = assertConsistent();
  if (consistent.problems.length) {
    console.error('✗ 版本号不一致：');
    consistent.problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }
  ok(`版本号一致：v${consistent.version}`);

  // 2. 静态检查
  run(process.execPath, ['scripts/check.mjs']);

  // 3. 测试
  //    没装 jsdom 时内容脚本 / 页面测试会静默跳过（见 test/pages.test.js），
  //    所以发版（--tag）必须要求依赖齐全，避免"测试全绿"其实没跑 DOM 用例。
  const hasJsdom = fs.existsSync(path.join(ROOT, 'node_modules', 'jsdom'));
  if (!hasJsdom && !options.skipTest) {
    if (options.tag) {
      throw new Error(
        '未安装依赖（缺少 jsdom），内容脚本与页面测试会被跳过，不能用于发版。先执行：npm ci'
      );
    }
    log('\n⚠ 未安装依赖（缺少 jsdom）：内容脚本 / 页面测试将被跳过。执行 npm ci 后可跑完整测试。');
  }

  if (options.skipTest) {
    log('\n⚠ 已跳过测试（--skip-test）');
  } else {
    run('npm', ['test']);
  }

  // 4. 构建 + 打包
  run(process.execPath, ['scripts/build.mjs']);
  writeChecksums();
  printArtifacts();

  // 5. 提交 + 打 tag
  if (options.packOnly) {
    log('\n完成（--pack-only：没有改文件，也没有打 tag）');
    return;
  }

  if (options.tag) {
    const files = [
      'package.json',
      'package-lock.json',
      'manifests/manifest.chrome.json',
      'manifests/manifest.firefox.json',
    ];
    git(['add', ...files]);
    const staged = git(['diff', '--cached', '--name-only']).trim();
    if (staged) {
      git(['commit', '-m', `chore(release): v${target}`]);
      ok(`已提交：chore(release): v${target}`);
    } else {
      log('（版本号没有变化，跳过提交）');
    }

    const tagName = `v${target}`;
    try {
      git(['tag', '-d', tagName], { stdio: 'ignore' });
    } catch (err) {
      /* 没有旧 tag，忽略 */
    }
    git(['tag', '-a', tagName, '-m', `pwdmg ${tagName}`]);
    ok(`已打 tag：${tagName}`);

    log('\n推送并触发 GitHub Actions 发版：');
    log(`  git push origin HEAD --follow-tags`);
    return;
  }

  log('\n下一步（打包已完成；要正式发版就打 tag 并推送）：');
  log(`  git add package.json manifests`);
  log(`  git commit -m "chore(release): v${target}"`);
  log(`  git tag -a v${target} -m "pwdmg v${target}"`);
  log(`  git push origin HEAD --follow-tags`);
}

try {
  main();
} catch (err) {
  console.error('\n✗ ' + (err && err.message ? err.message : err));
  process.exit(1);
}
