#!/usr/bin/env node
/**
 * 校验 package.json 与两个 manifest 的版本号是否一致。
 *
 * 用法：
 *   node scripts/check-version.mjs            # 只比三处文件
 *   node scripts/check-version.mjs v1.1.0     # 额外比 git tag（CI 里传 GITHUB_REF_NAME）
 */
import { assertConsistent } from './lib/version.mjs';

// 只有 tag 触发时才拿 GITHUB_REF_NAME 比对，手动触发时它是分支名
const fromEnv = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '';
const tag = process.argv[2] || fromEnv || '';
const { version, problems } = assertConsistent(tag);

if (problems.length) {
  console.error('✗ 版本号不一致：');
  for (const problem of problems) console.error('  - ' + problem);
  console.error('\n修复：node scripts/release.mjs <版本号>');
  process.exit(1);
}

console.log(`✓ 版本号一致：v${version}${tag ? `（tag ${tag}）` : ''}`);
