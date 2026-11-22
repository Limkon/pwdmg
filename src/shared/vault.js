/*!
 * pwdmg · 密码库数据模型
 *
 * 数据结构（以明文 JSON 保存到 WebDAV）：
 * {
 *   "version": 1,
 *   "updatedAt": "2025-01-01T00:00:00.000Z",
 *   "entries": [ { id, host, origin, url, username, password, title, notes,
 *                  createdAt, updatedAt, useCount, lastUsedAt } ],
 *   "tombstones": { "<entryId>": "<删除时间 ISO>" }
 * }
 *
 * tombstones 用于让“删除”操作能在多设备之间同步，避免删除后又被其他设备同步回来。
 * 挂载为 globalThis.PwdmgVault，同时支持 Node require（用于单元测试）。
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = mod;
  if (root) root.PwdmgVault = mod;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const U =
    typeof require === 'function' && typeof module === 'object' && module && module.exports
      ? require('./util.js')
      : (typeof globalThis !== 'undefined' ? globalThis : self).PwdmgUtil;

  const VERSION = 1;
  const TOMBSTONE_MAX_AGE = 180 * U.DAY;

  function empty() {
    return { version: VERSION, updatedAt: U.nowIso(), entries: [], tombstones: {} };
  }

  function sanitizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const url = String(raw.url == null ? '' : raw.url);
    const host = U.normalizeHost(raw.host || U.hostOf(url));
    if (!host) return null;
    const createdAt = raw.createdAt || U.nowIso();
    const username = String(raw.username == null ? '' : raw.username).trim();
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : U.uid(),
      host,
      origin: String(raw.origin || U.originOf(url) || 'https://' + host),
      url,
      username,
      password: String(raw.password == null ? '' : raw.password),
      title: String(raw.title || U.prettyHost(host)),
      notes: String(raw.notes == null ? '' : raw.notes),
      createdAt,
      updatedAt: raw.updatedAt || createdAt,
      useCount: Number.isFinite(Number(raw.useCount)) ? Math.max(0, Math.floor(Number(raw.useCount))) : 0,
      lastUsedAt: raw.lastUsedAt || null,
    };
  }

  function sanitizeTombstones(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, ts] of Object.entries(raw)) {
      if (!id || !ts) continue;
      const ms = U.toMs(ts);
      if (!ms) continue;
      out[id] = new Date(ms).toISOString();
    }
    return out;
  }

  function sortEntries(entries) {
    return entries.slice().sort((a, b) => {
      if (a.host !== b.host) return a.host < b.host ? -1 : 1;
      const ua = a.username.toLowerCase();
      const ub = b.username.toLowerCase();
      if (ua !== ub) return ua < ub ? -1 : 1;
      return U.toMs(a.updatedAt) - U.toMs(b.updatedAt);
    });
  }

  function pruneTombstones(tombstones, nowMs) {
    const cutoff = (nowMs || Date.now()) - TOMBSTONE_MAX_AGE;
    const out = {};
    for (const [id, ts] of Object.entries(tombstones || {})) {
      if (U.toMs(ts) >= cutoff) out[id] = ts;
    }
    return out;
  }

  /**
   * 规范化：字段清洗 + 去重（同一 host + username 只保留最新的）+ 清理过期墓碑。
   * 返回新对象，不修改入参。
   */
  function normalize(vault) {
    const src = vault && typeof vault === 'object' ? vault : {};
    const tombstones = pruneTombstones(sanitizeTombstones(src.tombstones));
    const list = Array.isArray(src.entries) ? src.entries : [];
    const byId = new Map();
    for (const raw of list) {
      const entry = sanitizeEntry(raw);
      if (!entry) continue;
      const prev = byId.get(entry.id);
      if (!prev || U.toMs(entry.updatedAt) >= U.toMs(prev.updatedAt)) byId.set(entry.id, entry);
    }

    // 去掉已被删除的条目
    for (const [id, entry] of byId) {
      const ts = tombstones[id];
      if (ts && U.toMs(ts) >= U.toMs(entry.updatedAt)) byId.delete(id);
    }

    // 同一站点 + 同一用户名 视为同一条记录
    const deduped = new Map();
    for (const entry of byId.values()) {
      const key = entry.host + '\u0000' + entry.username.trim().toLowerCase();
      const prev = deduped.get(key);
      if (!prev) {
        deduped.set(key, entry);
        continue;
      }
      const keep = U.toMs(entry.updatedAt) > U.toMs(prev.updatedAt) ? entry : prev;
      const drop = keep === entry ? prev : entry;
      keep.useCount = Math.max(keep.useCount, drop.useCount);
      tombstones[drop.id] = U.nowIso();
      deduped.set(key, keep);
    }

    const entries = sortEntries(Array.from(deduped.values()));
    return {
      version: VERSION,
      updatedAt: src.updatedAt || U.nowIso(),
      entries,
      tombstones: pruneTombstones(tombstones),
    };
  }

  /** 解析远端 / 导入的 JSON 文本，失败时抛出带中文说明的错误 */
  function parse(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return empty();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error('JSON 解析失败：' + err.message);
    }
    if (Array.isArray(data)) data = { entries: data };
    if (!data || typeof data !== 'object') throw new Error('密码库格式不正确（不是对象）');
    if (!Array.isArray(data.entries)) throw new Error('密码库格式不正确（缺少 entries 数组）');
    return normalize(data);
  }

  /** 序列化为稳定的 JSON 文本（便于比较差异） */
  function serialize(vault) {
    const normalized = normalize(vault);
    const payload = {
      version: VERSION,
      updatedAt: normalized.updatedAt,
      entries: normalized.entries,
      tombstones: normalized.tombstones,
    };
    return JSON.stringify(payload, null, 2) + '\n';
  }

  /**
   * 查找与「站点 + 用户名」对应的已存条目（与 upsert 的匹配规则一致）。
   * 先精确匹配主机名，再退化为子域匹配。
   */
  function lookup(vault, input) {
    const base = normalize(vault);
    const url = String((input && input.url) || '');
    const host = U.normalizeHost((input && input.host) || U.hostOf(url));
    if (!host) return null;
    const username = String((input && input.username) || '').trim();
    const lower = username.toLowerCase();

    const exact = base.entries.find((e) => e.host === host && e.username === username);
    if (exact) return exact;
    return (
      base.entries.find(
        (e) => U.hostMatches(e.host, host) && e.username.toLowerCase() === lower && lower !== ''
      ) || null
    );
  }

  /**
   * 记录/更新一条凭据。
   * @returns {{vault:object, entry:object, action:'created'|'updated'|'unchanged'}}
   */
  /** 只按「完全相同的主机名 + 用户名」查找（导入时用，避免子域被并到主域） */
  function findExact(vault, host, username) {
    const base = normalize(vault);
    const key = String(host || '').trim().toLowerCase();
    const user = String(username == null ? '' : username).trim();
    return base.entries.find((e) => e.host === key && e.username === user) || null;
  }

  /**
   * @param {object} vault
   * @param {object} input
   * @param {{exact?: boolean}} [options] exact=true 时只匹配同名主机（批量导入用）
   */
  function upsert(vault, input, options) {
    const base = normalize(vault);
    const url = String((input && input.url) || '');
    const host = U.normalizeHost((input && input.host) || U.hostOf(url));
    if (!host) throw new Error('无效的网站地址');
    const username = String((input && input.username) || '').trim();
    const password = String((input && input.password) || '');
    if (!password) throw new Error('密码为空');
    const now = U.nowIso();

    const opts = options || {};
    const existing = opts.exact
      ? findExact(base, host, username)
      : lookup(base, { url, host, username });

    const entries = base.entries.slice();
    if (existing) {
      const idx = entries.findIndex((e) => e.id === existing.id);
      if (existing.password === password) {
        return { vault: base, entry: existing, action: 'unchanged' };
      }
      const notes = String((input && input.notes) || '').trim();
      const updated = Object.assign({}, existing, {
        host,
        origin: U.originOf(url) || existing.origin,
        url: url || existing.url,
        password,
        // 已有备注优先保留，空的时候才用新传入的
        notes: existing.notes || notes,
        updatedAt: now,
      });
      entries[idx] = updated;
      return {
        vault: { version: VERSION, updatedAt: now, entries, tombstones: base.tombstones },
        entry: updated,
        action: 'updated',
      };
    }

    const entry = sanitizeEntry({
      id: U.uid(),
      host,
      origin: U.originOf(url) || 'https://' + host,
      url,
      username,
      password,
      title: (input && input.title) || U.prettyHost(host),
      notes: String((input && input.notes) || '').trim(),
      createdAt: now,
      updatedAt: now,
    });
    entries.push(entry);
    return {
      vault: { version: VERSION, updatedAt: now, entries, tombstones: base.tombstones },
      entry,
      action: 'created',
    };
  }

  /**
   * 批量写入（导入用）。
   *
   * 逐条调用 upsert 时每条都要 normalize 一次（O(n log n)），
   * 导入 5000 行会退化成几十秒；这里只做一次 normalize + 一个索引表。
   *
   * @param {object} vault
   * @param {Array} inputs
   * @param {{exact?: boolean, overwrite?: boolean}} [options]
   *        exact=true 只匹配完全相同的主机名；overwrite=false 时密码不同只记冲突、不改动
   * @returns {{vault: object, stats: {added:number, updated:number, conflicts:number, unchanged:number, invalid:number}}}
   */
  function upsertMany(vault, inputs, options) {
    const opts = options || {};
    const exact = !!opts.exact;
    const overwrite = opts.overwrite !== false;
    const list = Array.isArray(inputs) ? inputs : [];

    const base = normalize(vault);
    const entries = base.entries.slice();
    const index = new Map();
    entries.forEach((entry, i) => index.set(entry.host + '\u0000' + entry.username.toLowerCase(), i));

    const stats = { added: 0, updated: 0, conflicts: 0, unchanged: 0, invalid: 0 };
    const startedAt = Date.now();
    let seq = 0;
    // 每次写入把时间戳推进 1ms：同一个文件里重复出现的账号，最后一条必须“更新”
    const stamp = () => new Date(startedAt + seq++).toISOString();

    // 先按“主机名 + 用户名”折叠文件内的重复行（保留最后一条），
    // 否则同一账号会在导入过程中被反复覆盖，统计里也会多出虚假的 updated。
    const ordered = [];
    const seen = new Map();
    for (const input of list) {
      const url = String((input && input.url) || '');
      const host = U.normalizeHost((input && input.host) || U.hostOf(url));
      const username = String((input && input.username) || '').trim();
      if (!host) {
        ordered.push(input); // 无效行原样保留，交给下面的校验去计数
        continue;
      }
      const key = host + '\u0000' + username.toLowerCase();
      const at = seen.get(key);
      if (at === undefined) {
        seen.set(key, ordered.length);
        ordered.push(input);
      } else {
        ordered[at] = input; // 同一账号：保留最后一条，位置不变
      }
    }

    for (const input of ordered) {
      const url = String((input && input.url) || '');
      const host = U.normalizeHost((input && input.host) || U.hostOf(url));
      const username = String((input && input.username) || '').trim();
      const password = String((input && input.password) || '');
      if (!host || !password) {
        stats.invalid += 1;
        continue;
      }

      const key = host + '\u0000' + username.toLowerCase();
      let idx = index.has(key) ? index.get(key) : -1;
      if (idx < 0 && !exact && username) {
        const lower = username.toLowerCase();
        idx = entries.findIndex((e) => U.hostMatches(e.host, host) && e.username.toLowerCase() === lower);
      }

      if (idx >= 0) {
        const existing = entries[idx];
        if (existing.password === password) {
          stats.unchanged += 1;
          continue;
        }
        if (!overwrite) {
          stats.conflicts += 1;
          continue;
        }
        const notes = String((input && input.notes) || '').trim();
        const updatedEntry = Object.assign({}, existing, {
          host,
          origin: U.originOf(url) || existing.origin,
          url: url || existing.url,
          password,
          notes: existing.notes || notes,
          updatedAt: stamp(),
        });
        entries[idx] = updatedEntry;
        index.delete(key);
        index.set(updatedEntry.host + '\u0000' + updatedEntry.username.toLowerCase(), idx);
        stats.updated += 1;
        continue;
      }

      const now = stamp();
      const entry = sanitizeEntry({
        id: U.uid(),
        host,
        origin: U.originOf(url) || 'https://' + host,
        url,
        username,
        password,
        title: (input && input.title) || U.prettyHost(host),
        notes: String((input && input.notes) || '').trim(),
        createdAt: now,
        updatedAt: now,
      });
      if (!entry) {
        stats.invalid += 1;
        continue;
      }
      entries.push(entry);
      index.set(key, entries.length - 1);
      stats.added += 1;
    }

    if (!stats.added && !stats.updated) return { vault: base, stats };
    const next = normalize({
      version: VERSION,
      updatedAt: new Date(startedAt + seq).toISOString(),
      entries,
      tombstones: base.tombstones,
    });
    return { vault: next, stats };
  }

  /** 保存来自设置页 / 弹窗的完整条目（含编辑），不修改入参 */
  function put(vault, raw) {
    const base = normalize(vault);
    const clean = sanitizeEntry(raw);
    if (!clean) throw new Error('条目缺少网站地址');
    const now = U.nowIso();
    const entries = base.entries.slice();
    const idx = entries.findIndex((e) => e.id === clean.id);
    const tombstones = Object.assign({}, base.tombstones);
    delete tombstones[clean.id];

    if (idx >= 0) {
      entries[idx] = Object.assign({}, entries[idx], clean, {
        updatedAt: now,
        createdAt: entries[idx].createdAt,
        useCount: Math.max(entries[idx].useCount, clean.useCount),
      });
      return {
        vault: { version: VERSION, updatedAt: now, entries, tombstones },
        entry: entries[idx],
        action: 'updated',
      };
    }
    const entry = Object.assign({}, clean, { createdAt: clean.createdAt || now, updatedAt: now });
    entries.push(entry);
    return { vault: { version: VERSION, updatedAt: now, entries, tombstones }, entry, action: 'created' };
  }

  /** 删除条目（写入墓碑，避免被其他设备同步回来） */
  function remove(vault, id) {
    const base = normalize(vault);
    const now = U.nowIso();
    const entries = base.entries.filter((e) => e.id !== id);
    const tombstones = Object.assign({}, base.tombstones, { [id]: now });
    return { version: VERSION, updatedAt: now, entries, tombstones };
  }

  /** 记一次使用（不改变 updatedAt，避免同步抖动） */
  function markUsed(vault, id) {
    const base = normalize(vault);
    let changed = false;
    const entries = base.entries.map((e) => {
      if (e.id !== id) return e;
      changed = true;
      return Object.assign({}, e, { useCount: e.useCount + 1, lastUsedAt: U.nowIso() });
    });
    if (!changed) return base;
    return { version: VERSION, updatedAt: base.updatedAt, entries, tombstones: base.tombstones };
  }

  /** 查找与某个页面匹配的条目，最可能的排在前面 */
  function find(vault, url) {
    const host = U.hostOf(url);
    if (!host) return [];
    const base = normalize(vault);
    return base.entries
      .filter((e) => U.hostMatches(e.host, host))
      .sort((a, b) => {
        const aExact = U.stripWww(a.host) === U.stripWww(host) ? 1 : 0;
        const bExact = U.stripWww(b.host) === U.stripWww(host) ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        const aUsed = U.toMs(a.lastUsedAt);
        const bUsed = U.toMs(b.lastUsedAt);
        if (aUsed !== bUsed) return bUsed - aUsed;
        const aUpd = U.toMs(a.updatedAt);
        const bUpd = U.toMs(b.updatedAt);
        if (aUpd !== bUpd) return bUpd - aUpd;
        return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
      });
  }

  /**
   * 合并两份密码库（用于多设备同步）。
   * 同一条目按 updatedAt 取新；时间相同则偏向 b（本地）。
   * @param {object} a 远端
   * @param {object} b 本地
   */
  function merge(a, b) {
    const left = normalize(a);
    const right = normalize(b);
    const tombstones = Object.assign({}, left.tombstones);
    for (const [id, ts] of Object.entries(right.tombstones)) {
      if (U.toMs(ts) > U.toMs(tombstones[id])) tombstones[id] = ts;
    }

    const byId = new Map();
    for (const entry of left.entries.concat(right.entries)) {
      const prev = byId.get(entry.id);
      if (!prev) {
        byId.set(entry.id, entry);
        continue;
      }
      const newer = U.toMs(entry.updatedAt) >= U.toMs(prev.updatedAt) ? entry : prev;
      const older = newer === entry ? prev : entry;
      byId.set(entry.id, Object.assign({}, newer, { useCount: Math.max(newer.useCount, older.useCount) }));
    }

    for (const [id, entry] of byId) {
      const ts = tombstones[id];
      if (ts && U.toMs(ts) >= U.toMs(entry.updatedAt)) byId.delete(id);
    }

    return normalize({
      version: VERSION,
      updatedAt: U.toMs(right.updatedAt) > U.toMs(left.updatedAt) ? right.updatedAt : left.updatedAt,
      entries: Array.from(byId.values()),
      tombstones,
    });
  }

  /** 供 UI 使用：按站点聚合统计 */
  function stats(vault) {
    const base = normalize(vault);
    const hosts = new Set(base.entries.map((e) => e.host));
    return { entries: base.entries.length, hosts: hosts.size };
  }

  return {
    VERSION,
    TOMBSTONE_MAX_AGE,
    empty,
    normalize,
    parse,
    serialize,
    upsert,
    upsertMany,
    lookup,
    findExact,
    put,
    remove,
    markUsed,
    find,
    merge,
    stats,
    sanitizeEntry,
  };
});
