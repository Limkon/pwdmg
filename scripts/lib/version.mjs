/**
 * 版本号读写：package.json 与两个 manifest 必须始终一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACKAGE_JSON = path.join(ROOT, 'package.json');
export const LOCKFILE = path.join(ROOT, 'package-lock.json');
export const MANIFESTS = [
  path.join(ROOT, 'manifests', 'manifest.chrome.json'),
  path.join(ROOT, 'manifests', 'manifest.firefox.json'),
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** @returns {{package: string, chrome: string, firefox: string}} */
export function readVersions() {
  return {
    package: readJson(PACKAGE_JSON).version,
    chrome: readJson(MANIFESTS[0]).version,
    firefox: readJson(MANIFESTS[1]).version,
  };
}

/** 把版本号写进 package.json、两个 manifest，以及 package-lock.json（CI 的 npm ci 要用） */
export function writeVersions(version) {
  const pkg = readJson(PACKAGE_JSON);
  pkg.version = version;
  writeJson(PACKAGE_JSON, pkg);
  for (const file of MANIFESTS) {
    const manifest = readJson(file);
    manifest.version = version;
    writeJson(file, manifest);
  }
  if (fs.existsSync(LOCKFILE)) {
    const lock = readJson(LOCKFILE);
    lock.version = version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = version;
    writeJson(LOCKFILE, lock);
  }
}

export function isValidVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value || '').trim());
}

export function bumpVersion(current, kind) {
  const [major, minor, patch] = String(current).split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`未知的递增类型：${kind}（可选 patch / minor / major）`);
}

/**
 * 检查三处版本号是否一致，以及（可选）是否与 git tag 一致。
 * @param {string} [tag] 例如 v1.1.0 或 1.1.0
 */
export function assertConsistent(tag) {
  const versions = readVersions();
  const problems = [];

  if (versions.chrome !== versions.package) {
    problems.push(`manifests/manifest.chrome.json = ${versions.chrome}，package.json = ${versions.package}`);
  }
  if (versions.firefox !== versions.package) {
    problems.push(`manifests/manifest.firefox.json = ${versions.firefox}，package.json = ${versions.package}`);
  }
  if (tag) {
    const fromTag = String(tag).trim().replace(/^v/i, '');
    if (fromTag !== versions.package) {
      problems.push(`git tag ${tag} 与 package.json 的 ${versions.package} 不一致`);
    }
  }

  return { version: versions.package, versions, problems };
}
