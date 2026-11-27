/*!
 * pwdmg · 后台脚本（Chrome MV3 service worker / Firefox MV3 event page）
 *
 * 职责：
 *  1. 维护本地密码库缓存（storage.local；启用主密码后只存密文）
 *  2. 与 WebDAV 双向同步（ETag 乐观锁 + 按 updatedAt 合并 + 删除墓碑）
 *  3. 主密码（PBKDF2 + AES-GCM）解锁 / 锁定 / 启用 / 修改
 *  4. 接收内容脚本的“记录凭据”请求，并识别“密码已变化，需要确认更新”
 *  5. 向 popup / options 提供查询与增删改接口
 */
(function () {
  'use strict';

  const g = typeof globalThis !== 'undefined' ? globalThis : self;

  // Chrome 的 service worker 没有自动加载脚本的能力，用 importScripts 引入依赖。
  // Firefox 的 MV3 使用 background.scripts，manifest 里已经按顺序列出这些文件。
  if (typeof importScripts === 'function') {
    importScripts(
      '/src/shared/api.js',
      '/src/shared/util.js',
      '/src/shared/vault.js',
      '/src/shared/webdav.js',
      '/src/shared/crypto.js',
      '/src/shared/store.js'
    );
  }

  const { api, action } = g.PwdmgApi;
  const U = g.PwdmgUtil;
  const V = g.PwdmgVault;
  const D = g.PwdmgWebdav;
  const Crypto = g.PwdmgCrypto;
  const S = g.PwdmgStore;

  const SYNC_ALARM = 'pwdmg-sync';
  const RETRY_ALARM = 'pwdmg-retry';
  const AUTO_LOCK_ALARM = 'pwdmg-autolock';
  const BADGE_COLOR = { ok: '#2563eb', dirty: '#f59e0b', error: '#dc2626', locked: '#64748b' };
  const MIN_MASTER_PASSWORD = 8;

  let cache = null;
  let cachePromise = null;
  let syncChain = Promise.resolve();
  let initialSyncStarted = false;
  let lastAttemptAt = 0;
  let followUpTimer = null;
  let consecutiveFailures = 0;
  const recentCaptures = new Map();

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function errText(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    return err.message || String(err);
  }

  function lockedError(message) {
    const err = new Error(message || '密码库已加密，请先解锁');
    err.code = 'locked';
    return err;
  }

  function serialize(task) {
    const run = syncChain.then(task, task);
    syncChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * 每次在本地改动密码库时递增版本号。
   * 同步是异步的：如果上传期间用户又增删了条目，同步结束时不能直接用旧快照覆盖本地，
   * 否则删除的条目会“复活”。performSync 用 rev 检测这种情况并改为合并 + 追加一次同步。
   */
  function bumpRev(c) {
    c.rev = (c.rev || 0) + 1;
    return c.rev;
  }

  function senderWebUrl(message, sender) {
    const candidates = [
      sender && sender.url,
      sender && sender.tab && sender.tab.url,
      message && message.url,
    ];
    for (const candidate of candidates) {
      if (U.isWebUrl(candidate)) return candidate;
    }
    return '';
  }

  function isLocked(c) {
    return !!c.encrypted && !c.key;
  }

  async function setBadge(text, color) {
    const a = action();
    if (!a) return;
    try {
      await a.setBadgeBackgroundColor({ color: color || BADGE_COLOR.ok });
      await a.setBadgeText({ text: text || '' });
    } catch (err) {
      /* 某些浏览器不支持，忽略 */
    }
  }

  async function refreshBadge() {
    const a = action();
    if (!a) return;
    const s = await S.getSettings();
    const c = await getCache();
    let text = '';
    let color = BADGE_COLOR.ok;
    let title = '秦二密码管理 · WebDAV 同步';

    if (!s.webdavUrl) {
      title += '（未配置 WebDAV）';
    } else if (isLocked(c)) {
      text = '锁';
      color = BADGE_COLOR.locked;
      title += ' · 已加密（未解锁）';
    } else if (c.lastError) {
      text = '!';
      color = BADGE_COLOR.error;
      title += ' · 同步失败：' + c.lastError;
    } else if (c.dirty) {
      text = '•';
      color = BADGE_COLOR.dirty;
      title += ' · 有改动待上传';
    } else {
      title +=
        ' · 已同步 ' + U.formatRelativeTime(c.lastSyncAt) + ' · ' + c.vault.entries.length + ' 个账号' +
        (c.encrypted ? '（已加密）' : '');
    }
    await setBadge(text, color);
    try {
      await a.setTitle({ title });
    } catch (err) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * 缓存（明文在内存，落盘时按需加密）
   * ------------------------------------------------------------------ */

  function emptyCache() {
    return {
      vault: V.empty(),
      etag: null,
      lastSyncAt: null,
      lastError: null,
      dirty: false,
      rev: 0,
      encrypted: false,
      kdf: null,
      key: null,
      cipher: null,
      locked: false,
      notice: '',
    };
  }

  async function getKey(c) {
    if (c && c.key) return c.key;
    const raw = await S.readSessionKey();
    if (raw) {
      try {
        return await Crypto.importKey(raw);
      } catch (err) {
        /* 会话密钥损坏，继续尝试本机记住的密钥 */
      }
    }
    // 共享电脑模式：禁止用「本机记住」的密钥自动恢复，必须手动输主密码解锁
    try {
      const settings = await S.getSettings();
      if (settings && settings.sharedMode) return null;
    } catch (err) {
      /* ignore */
    }
    // 「记住本机」：会话密钥丢了（浏览器重启 / 新会话）时，用本地记住的密钥恢复，
    // 主密码不需要再输入。密钥过期或损坏时统一返回 null（保持锁定）。
    const remembered = await S.readRememberedKey();
    if (!remembered) return null;
    try {
      const key = await Crypto.importKey(remembered);
      await S.writeSessionKey(remembered).catch(() => undefined);
      return key;
    } catch (err) {
      await S.clearRememberedKey().catch(() => undefined);
      return null;
    }
    // 注：过期记录已在 store 里换成「expired 标记」，这里readRememberedKey() 返回 null
  }

  async function hydrateCache(record) {
    const settings = await S.getSettings();
    const base = emptyCache();

    if (!record) {
      // 本地缓存丢了（清过扩展数据 / 缓存损坏），但设置里写着“启用了加密”。
      // 不能直接当成锁定：如果远端也是明文，那就再也没有任何 KDF 参数，
      // 用户会卡在“解锁失败 → 关闭加密也要求先解锁”的死循环里。
      // 这里先按未加密处理，等 performSync 读到远端真实内容再决定：
      //   远端是信封 → 自动进入锁定态，照常用主密码解锁；
      //   远端是明文 → 恢复成明文模式，并在设置页提示重新启用加密。
      return base;
    }

    base.etag = record.etag || null;
    base.lastSyncAt = record.lastSyncAt || null;
    base.lastError = record.lastError || null;
    base.dirty = !!record.dirty;
    base.rev = Number(record.rev) || 0;
    base.encrypted = !!record.encrypted;
    base.cipher = record.cipher || null;
    base.kdf = record.kdf || (record.cipher && record.cipher.kdf) || null;
    base.notice = typeof record.notice === 'string' ? record.notice : '';

    if (record.cipher) {
      base.encrypted = true;
      const key = await getKey(base);
      if (!key) {
        base.locked = true;
        return base;
      }
      try {
        base.vault = V.parse(await Crypto.decryptText(record.cipher, key));
        base.key = key;
      } catch (err) {
        base.locked = true;
        base.vault = V.empty();
        await S.writeSessionKey(null);
        // 密钥解不开（远端换过主密码 / 文件损坏）：本机记住的密钥同样失效
        await S.forgetRememberedKey();
      }
      return base;
    }

    if (record.vault) base.vault = V.normalize(record.vault);
    if (settings.encryptVault) {
      // 记录是明文但设置要求加密：保持明文直到重新启用加密（避免把明文误判为已加密）
      base.encrypted = false;
    }
    if (!base.kdf) base.encrypted = !!record.encrypted;
    return base;
  }

  function getCache() {
    if (cache) return Promise.resolve(cache);
    if (!cachePromise) {
      cachePromise = S.readCacheRecord()
        .then((record) => hydrateCache(record))
        .then((value) => {
          cache = value;
          cachePromise = null;
          return cache;
        })
        .catch((err) => {
          cachePromise = null;
          throw err;
        });
    }
    return cachePromise;
  }

  async function persist() {
    if (!cache) return;
    const record = {
      etag: cache.etag || null,
      lastSyncAt: cache.lastSyncAt || null,
      lastError: cache.lastError || null,
      dirty: !!cache.dirty,
      rev: cache.rev || 0,
      encrypted: !!cache.encrypted,
      kdf: cache.kdf || null,
      notice: cache.notice || '',
    };

    if (cache.encrypted) {
      const key = cache.key || (await getKey(cache));
      if (key && cache.kdf) {
        try {
          const envelope = await Crypto.encryptText(V.serialize(cache.vault), key, cache.kdf);
          record.cipher = envelope;
          cache.cipher = envelope;
          cache.key = key;
          cache.locked = false;
        } catch (err) {
          record.cipher = cache.cipher || null;
        }
      } else if (cache.cipher) {
        record.cipher = cache.cipher; // 锁定状态：保留旧密文，等解锁后再更新
      } else {
        return; // 无密钥也无密文，不写入，避免丢失
      }
    } else {
      record.vault = V.normalize(cache.vault);
    }

    await S.writeCacheRecord(record);
  }

  /* ------------------------------------------------------------------ *
   * 同步
   * ------------------------------------------------------------------ */

  /** 读取远端并解密（如需要）；locked 为 true 表示缺少密钥 */
  /* ------------------------------------------------------------------ *
   * 历史快照：每次覆盖远端前，把旧文件留在本地一份
   *
   * - 加密库存的是密文信封，不会因为快照而多一份明文
   * - 条数与总体积都有限制，避免把 storage.local 撑爆
   * ------------------------------------------------------------------ */

  const HISTORY_MAX = 5;
  const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

  async function rememberHistory(kind, text) {
    const value = String(text == null ? '' : text);
    if (!value.trim()) return;
    const list = await S.readHistory();
    if (list.length && list[0].text === value) return;
    const entry = { at: U.nowIso(), kind: String(kind || 'snapshot'), bytes: value.length, text: value };
    list.unshift(entry);

    const kept = [];
    let total = 0;
    for (const item of list) {
      total += item.text.length;
      if (kept.length >= HISTORY_MAX || total > HISTORY_MAX_BYTES) break;
      kept.push(item);
    }
    await S.writeHistory(kept);
  }

  /**
   * 主密码变更 / 关闭加密后，历史快照里的密文也得跟着换密钥，
   * 否则旧快照会变成“解不开的垃圾”（恢复时报主密码错误）。
   */
  async function rekeyHistory(oldKey, newMode) {
    const list = await S.readHistory();
    if (!list.length) return;
    let changed = false;
    const next = [];
    for (const item of list) {
      const envelope = Crypto.parseEnvelope(item.text);
      if (!envelope) {
        next.push(item);
        continue;
      }
      let plain = null;
      try {
        plain = await Crypto.decryptText(envelope, oldKey);
      } catch (err) {
        next.push(item); // 不是这把钥匙加密的，原样保留
        continue;
      }
      let text;
      if (newMode && newMode.encrypted) {
        text = Crypto.serializeEnvelope(await Crypto.encryptText(plain, newMode.key, newMode.kdf));
      } else {
        text = plain; // 关闭加密：快照也转成明文，之后仍然可以恢复
      }
      next.push(Object.assign({}, item, { text, bytes: text.length }));
      changed = true;
    }
    if (changed) await S.writeHistory(next);
  }

  function describeHistory(list) {
    return (list || []).map((item) => {
      const envelope = Crypto.parseEnvelope(item.text);
      let entries = null;
      if (!envelope) {
        try {
          entries = V.parse(item.text).entries.length;
        } catch (err) {
          entries = null;
        }
      }
      return {
        at: item.at,
        kind: item.kind,
        bytes: item.bytes || item.text.length,
        entries,
        encrypted: !!envelope,
      };
    });
  }

  /* 以本地为准强制写远端：不合并远端内容，成功后清理 dirty。
     远端文件损坏、需要回滚时都走这里。 */
  async function forcePushLocal(c, settings) {
    const key = c.key || (await getKey(c));
    if (c.encrypted && (!key || !c.kdf)) return { ok: false, code: 'locked', error: '请先解锁' };

    const client = D.createClient(settings);
    let previous = '';
    let written = null;

    try {
      const compat = !!settings.noIfMatch;
      const maxAttempts = compat ? 2 : 4;
      let degraded = false;
      for (let attempt = 0; attempt < maxAttempts && !written; attempt++) {
        const lastAttempt = attempt === maxAttempts - 1;
        const force = !compat && lastAttempt;
        const conditional = !compat && !lastAttempt;
        let etag = null;
        let remoteText = '';
        try {
          const remote = await client.read();
          if (remote.exists) {
            etag = remote.etag || null;
            remoteText = remote.text || '';
          }
        } catch (err) {
          // 远端内容已经坏了也要能覆盖回去，只有网络 / 认证错误才中止
          if (err && (err.code === 'network' || err.code === 'auth')) {
            return { ok: false, error: errText(err) };
          }
        }

        try {
          written = await writeVault(client, settings, c.vault, conditional ? etag : null, {
            encrypted: c.encrypted,
            key,
            kdf: c.kdf,
            conditional,
          });
          degraded = force;
          if (remoteText) previous = remoteText;
        } catch (err) {
          // 后台自动同步可能正在上传，etag 过期就拿最新的再覆盖一次
          if (err.code !== 'conflict' || !conditional) throw err;
        }
      }
      if (!written) throw new Error('覆盖远端失败：重试次数已用尽');
      if (degraded) await markIfMatchCompat(c, settings, '覆盖远端时连续被拒');

      if (previous) await rememberHistory('remote', previous);
      c.key = c.encrypted ? key : c.key;
      c.etag = written.etag || null;
      c.dirty = false;
      c.lastError = null;
      c.lastSyncAt = U.nowIso();
      await persist();
      await refreshBadge();
      return { ok: true, entries: c.vault.entries.length, etag: c.etag };
    } catch (err) {
      c.lastError = errText(err);
      await persist();
      await refreshBadge();
      return { ok: false, error: errText(err) };
    }
  }

  async function readRemoteVault(client, key) {
    const remote = await client.read();
    if (!remote.exists) {
      return { exists: false, etag: null, vault: V.empty(), encrypted: false, envelope: null, locked: false, text: '' };
    }
    const envelope = Crypto.parseEnvelope(remote.text);
    if (envelope) {
      if (!key) {
        return {
          exists: true,
          etag: remote.etag || null,
          vault: null,
          encrypted: true,
          envelope,
          locked: true,
          text: remote.text,
        };
      }
      const text = await Crypto.decryptText(envelope, key);
      return {
        exists: true,
        etag: remote.etag || null,
        vault: V.parse(text),
        encrypted: true,
        envelope,
        locked: false,
        text: remote.text,
      };
    }
    return {
      exists: true,
      etag: remote.etag || null,
      vault: V.parse(remote.text),
      encrypted: false,
      envelope: null,
      locked: false,
      text: remote.text,
    };
  }

  async function writeVault(client, settings, vaultObject, etag, mode) {
    const text = V.serialize(vaultObject);
    let body = text;
    if (mode && mode.encrypted) {
      if (!mode.key || !mode.kdf) throw lockedError();
      body = Crypto.serializeEnvelope(await Crypto.encryptText(text, mode.key, mode.kdf));
    }
    // 兼容模式（settings.noIfMatch）下不带 If-Match：有些服务器的 ETag 是弱校验符
    // 或者每次都变，带条件写永远 412。mode.conditional 可以让调用方强制指定。
    const conditional =
      mode && mode.conditional !== undefined ? !!mode.conditional : !settings.noIfMatch;
    return client.write(body, {
      etag: conditional ? etag : null,
      conditional,
      createDirs: settings.createDirs,
    });
  }

  /**
   * 服务器拒绝条件写入时的降级：把「不再发送 If-Match」记进设置，
   * 并在设置页留一条提示（用户随时可以在设置里改回去）。
   */
  async function markIfMatchCompat(c, settings, reason) {
    const message =
      '这台 WebDAV 服务器不接受 ETag 条件写入（HTTP 412：' +
      (reason || 'If-Match 校验失败') +
      '），已自动切换为兼容模式：不再发送 If-Match。' +
      '多台设备同时写入时，以最后一次上传为准。';
    const changed = !settings.noIfMatch;
    settings.noIfMatch = true;
    if (changed) await S.saveSettings({ noIfMatch: true });
    if (c.notice !== message) {
      c.notice = message;
      await persist();
    }
  }

  async function pushMerged(client, settings, localVault, firstRemote, mode) {
    let remote = firstRemote;
    const compat = !!settings.noIfMatch;
    // 兼容模式下直接无条件写；否则先带 If-Match 试 3 次（每次都重读拿最新 ETag），
    // 第 4 次改为无条件写入——即「服务器不认这个校验符」时也能把数据传上去。
    const maxAttempts = compat ? 2 : 4;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const lastAttempt = attempt === maxAttempts - 1;
      // 非兼容模式：最后一次放弃条件写入；兼容模式：从一开始就不带 If-Match
      const force = !compat && lastAttempt;
      const conditional = !compat && !lastAttempt;
      const remoteVault = remote && remote.vault ? remote.vault : V.empty();
      const merged = V.merge(remoteVault, localVault);
      try {
        const res = await writeVault(
          client,
          settings,
          merged,
          conditional ? remote && remote.etag : null,
          Object.assign({}, mode, { conditional })
        );
        return { vault: merged, etag: res.etag, degraded: force };
      } catch (err) {
        if (err.code !== 'conflict') throw err;
        if (!conditional) throw err;
        remote = await readRemoteVault(client, mode.key);
        if (remote.locked) throw lockedError();
      }
    }
    throw new Error('同步冲突重试次数已用尽');
  }

  /**
   * 失败退避：0.5 → 1 → 2 → 4 … 最多 30 分钟。
   * 否则配置错了一个密码就会每 30 秒撞一次服务器。
   */
  function retryDelayMinutes() {
    const n = Math.min(Math.max(consecutiveFailures, 1), 7);
    return Math.min(0.5 * Math.pow(2, n - 1), 30);
  }

  function scheduleRetry() {
    try {
      api.alarms.create(RETRY_ALARM, { delayInMinutes: retryDelayMinutes() });
    } catch (err) {
      /* ignore */
    }
  }

  /** 上传期间本地又变了：稍等一下再同步一次（同时留一个 alarm 兜底） */
  function scheduleFollowUpSync() {
    if (followUpTimer) return;
    followUpTimer = setTimeout(() => {
      followUpTimer = null;
      syncNow().then((result) => {
        if (result && !result.ok && result.configured && !result.locked) scheduleRetry();
        return undefined;
      });
    }, 250);
    try {
      api.alarms.create(RETRY_ALARM, { delayInMinutes: 1 });
    } catch (err) {
      /* ignore */
    }
  }

  /** 拉取 + （如有本地改动）上传 */
  async function performSync() {
    const settings = await S.getSettings();
    const c = await getCache();

    if (!settings.webdavUrl) {
      await refreshBadge();
      return { ok: false, configured: false, error: '尚未配置 WebDAV 地址' };
    }
    if (isLocked(c)) {
      await refreshBadge();
      return { ok: false, configured: true, locked: true, error: '密码库已加密，请先解锁' };
    }

    lastAttemptAt = Date.now();
    await setBadge('↻', BADGE_COLOR.ok);

    const startRev = c.rev || 0;
    const changedMeanwhile = () => (c.rev || 0) !== startRev;

    try {
      const client = D.createClient(settings);
      const key = c.key || (await getKey(c));
      const first = await readRemoteVault(client, key);

      if (first.locked) {
        c.encrypted = true;
        c.locked = true;
        if (first.envelope) c.kdf = first.envelope.kdf;
        await persist();
        await refreshBadge();
        return { ok: false, configured: true, locked: true, error: '密码库已加密，请先解锁' };
      }

      // 远端是明文、本地也没有任何加密参数：主密码加密实际上已经不存在了。
      // 继续抛“缺少加密参数”只会让密码库彻底不可用，这里降级为明文并提示。
      if (!first.encrypted && !c.kdf && !c.cipher && (settings.encryptVault || c.encrypted)) {
        c.encrypted = false;
        c.locked = false;
        c.notice =
          '远端密码库是明文，本地也找不到主密码参数，主密码加密已失效（通常是清理过扩展数据）。' +
          '已恢复为明文模式，请到「主密码加密」里重新设置主密码。';
        if (settings.encryptVault) {
          await S.saveSettings({ encryptVault: false });
          settings.encryptVault = false;
        }
      }

      if (first.encrypted && !c.encryptionDisabled) {
        c.encrypted = true;
        c.kdf = first.envelope.kdf;
        if (key) {
          c.key = key;
          c.locked = false;
        }
      }

      const wantEncrypt =
        c.encrypted || settings.encryptVault || (first.encrypted && !c.encryptionDisabled);
      if (wantEncrypt) {
        c.encrypted = true;
        if (!c.kdf) c.kdf = first.envelope ? first.envelope.kdf : null;
        if (!c.kdf) throw new Error('缺少加密参数，请在设置里重新启用主密码加密');
        if (!c.key && key) {
          c.key = key;
          c.locked = false;
        }
        if (!c.key) throw lockedError();
      } else {
        c.encrypted = false;
      }

      let resultVault;
      let etag = first.etag;
      // 远端文件不见了（被别的程序删了 / 目录被清空），本地有数据就补传回去，
      // 否则会出现“本地显示已同步、远端其实什么都没有”的假象。
      const localHasData =
        c.vault.entries.length > 0 || Object.keys(c.vault.tombstones || {}).length > 0;
      const remoteMissing = !first.exists && localHasData;
      if (c.dirty || remoteMissing) {
        const pushed = await pushMerged(client, settings, c.vault, first, {
          encrypted: c.encrypted,
          key: c.key,
          kdf: c.kdf,
        });
        resultVault = pushed.vault;
        etag = pushed.etag;
        if (pushed.degraded) await markIfMatchCompat(c, settings, '同步时连续 3 次被拒');
        // 覆盖前的内容留一份，远端写坏 / 误删时能救回来
        if (first.exists && first.text) await rememberHistory('remote', first.text);
      } else {
        resultVault = V.merge(first.vault || V.empty(), c.vault);
      }

      if (changedMeanwhile()) {
        c.vault = V.merge(resultVault, c.vault);
        c.dirty = true;
      } else {
        c.vault = resultVault;
        c.dirty = false;
      }
      c.etag = etag || c.etag || null;
      c.lastSyncAt = U.nowIso();
      c.lastError = null;
      consecutiveFailures = 0;
      await persist();
      await refreshBadge();
      if (c.dirty) scheduleFollowUpSync();

      return {
        ok: true,
        entries: c.vault.entries.length,
        lastSyncAt: c.lastSyncAt,
        exists: first.exists,
        pending: !!c.dirty,
        encrypted: !!c.encrypted,
        compat: !!settings.noIfMatch,
      };
    } catch (err) {
      const code = err && err.code;
      const message = errText(err);
      if (code === 'locked') {
        c.locked = true;
        c.lastError = null;
      } else if (code === 'bad-key') {
        // 本地密文与远端信封互相解不开（另一台设备可能改过主密码 / 重加密）：
        // 清掉当前会话密钥，回到锁定态，让用户重新输入当前主密码（解锁时会用远端信封兜底）。
        c.locked = true;
        c.lastError = null;
        c.notice = '远端密码库已重加密（其他设备可能改过主密码），请重新输入当前主密码';
        c.key = null;
        await S.writeSessionKey(null).catch(() => undefined);
        await S.clearRememberedKey().catch(() => undefined);
      } else {
        c.lastError = message;
        consecutiveFailures += 1;
      }
      await persist();
      await refreshBadge();
      return { ok: false, configured: true, locked: code === 'locked' || code === 'bad-key', error: message, code: code || 'error' };
    }
  }

  function syncNow() {
    return serialize(performSync);
  }

  function requestSync() {
    return getCache().then((c) => {
      if (isLocked(c)) return { ok: false, configured: true, locked: true, error: '密码库已加密，请先解锁' };
      return syncNow().then((result) => {
        if (!result.ok && result.configured && !result.locked) scheduleRetry();
        return result;
      });
    });
  }

  /**
   * 首次运行（本地还没有任何缓存）时，先探一次远端：
   * 只有这样才能知道远端的密码库是不是加密的，避免把明文写进加密库。
   */
  /**
   * 通知所有已打开的页面重新读取状态（解锁 / 锁定后立即生效，无需刷新页面）。
   * 没有内容脚本的标签页（扩展页、about: 等）会抛错，直接忽略。
   */
  async function notifyTabs() {
    try {
      const tabs = api.tabs;
      if (!tabs || typeof tabs.query !== 'function' || typeof tabs.sendMessage !== 'function') return;
      const list = await tabs.query({});
      await Promise.all(
        (list || []).map((tab) => {
          if (!tab || typeof tab.id !== 'number' || tab.id < 0) return null;
          return Promise.resolve()
            .then(() => tabs.sendMessage(tab.id, { type: 'content:rescan' }))
            .catch(() => undefined);
        })
      );
    } catch (err) {
      /* 忽略：没有权限或没有接收方 */
    }
  }

  async function probeRemoteState() {
    const settings = await S.getSettings();
    const c = await getCache();
    if (!settings.webdavUrl) return c;
    if (c.encrypted || c.lastSyncAt || c.dirty) return c;
    await syncNow().catch(() => undefined);
    return c;
  }

  async function ensureInitialSync() {
    if (initialSyncStarted) return;
    const settings = await S.getSettings();
    const c = await getCache();
    if (!settings.webdavUrl) return;
    if (isLocked(c)) return;
    if (c.lastSyncAt || c.dirty) return;
    if (Date.now() - lastAttemptAt < 20000) return;
    initialSyncStarted = true;
    lastAttemptAt = Date.now();
    try {
      await syncNow();
    } finally {
      initialSyncStarted = false;
    }
  }

  async function setupAlarm() {
    const settings = await S.getSettings();
    try {
      await api.alarms.clear(SYNC_ALARM);
    } catch (err) {
      /* ignore */
    }
    if (settings.webdavUrl) {
      try {
        api.alarms.create(SYNC_ALARM, {
          delayInMinutes: Math.max(1, settings.syncIntervalMin),
          periodInMinutes: Math.max(1, settings.syncIntervalMin),
        });
      } catch (err) {
        /* ignore */
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 共享电脑模式：闲置自动锁定
   *
   * 解锁后挂一个一次性 alarm，autoLockMinutes 分钟后自动锁定。
   * 解锁 / 设置变更会强制重排（force: true）；锁定后清除。未加密时不挂（没有可锁的东西）。
   *
   * MV3 的 service worker 没有活动就会被系统回收，之后任何事件（周期同步 /
   * 同步失败重试 / 页面消息……）都会把整份脚本重新跑一遍，包括文件末尾那次
   * 兜底的 scheduleAutoLock() 调用。如果这次兜底调用也无条件清掉重挂 alarm，
   * 倒计时就会被这些后台杂事不断续命，导致“设置了闲置锁定，但挂着页面一直
   * 不操作也永远不锁”。chrome.alarms 本身在 service worker 重启、甚至浏览器
   * 重启之间都会持续存在并按时触发，所以兜底调用只需要在 alarm 确实丢失时才
   * 补一个，已经在倒计时的 alarm 不该被打断重置。
   * ------------------------------------------------------------------ */

  function clearAutoLock() {
    try {
      api.alarms.clear(AUTO_LOCK_ALARM);
    } catch (err) {
      /* ignore */
    }
  }

  async function scheduleAutoLock(options) {
    const force = !!(options && options.force);
    try {
      const settings = await S.getSettings();
      const c = await getCache();
      const eligible = !!(settings && settings.sharedMode && c && c.encrypted && !isLocked(c));
      if (!eligible) {
        clearAutoLock();
        return;
      }
      if (force) {
        clearAutoLock();
      } else {
        // 非强制：只在还没有倒计时的时候才补挂一个，不打断已经在跑的倒计时
        const existing = await api.alarms.get(AUTO_LOCK_ALARM).catch(() => null);
        if (existing) return;
      }
      const minutes = Math.min(Math.max(Number(settings.autoLockMinutes) || 5, 1), 60);
      api.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
    } catch (err) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * 凭据记录（含“密码已变化”检测）
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * 待确认的密码变更（页面跳转 / 刷新后仍能继续确认）
   *
   * 只放在 storage.session：加密用户的明文新密码不会落到磁盘上，
   * 浏览器重启后自然失效，超过 30 分钟也自动丢弃。
   * ------------------------------------------------------------------ */

  const PENDING_KEY = 'pendingChange';
  const PENDING_TTL = 30 * 60 * 1000;

  async function readPendingChange() {
    const value = await S.readSession(PENDING_KEY);
    if (!value || typeof value !== 'object' || !value.host || !value.password) return null;
    if (Date.now() - Number(value.at || 0) > PENDING_TTL) {
      await S.writeSession(PENDING_KEY, null);
      return null;
    }
    return value;
  }

  async function savePendingChange(pending) {
    await S.writeSession(PENDING_KEY, pending);
  }

  async function clearPendingChange() {
    await S.writeSession(PENDING_KEY, null);
  }

  async function captureCredential(message, sender) {
    const settings = await S.getSettings();
    if (!settings.autoSave) return { ok: false, saved: false, reason: 'disabled' };

    const url = senderWebUrl(message, sender);
    if (!url) return { ok: false, saved: false, reason: 'invalid-url' };

    const password = String((message && message.password) || '');
    let username = String((message && message.username) || '').trim();
    if (!password) return { ok: false, saved: false, reason: 'empty-password' };
    if (password.length > 4096) return { ok: false, saved: false, reason: 'too-long' };

    const c = await getCache();
    if (!c.encrypted && !c.lastSyncAt && !c.dirty) await probeRemoteState();
    if (isLocked(c)) return { ok: false, saved: false, reason: 'locked' };

    // 分步登录（先填用户名、下一页只有密码框）时，沿用该站点唯一账号的用户名
    if (!username) {
      const matches = V.find(c.vault, url);
      if (matches.length === 1) username = matches[0].username;
    }

    const force = !!message.force;
    const updateOnly = !!message.updateOnly;
    const existing = V.lookup(c.vault, { url, username });

    // 已存在同站点同用户名、但密码不同：默认先询问用户是否更新
    if (existing && existing.password !== password && !force) {
      await savePendingChange({
        host: existing.host || U.hostOf(url),
        username: existing.username || username,
        password,
        url,
        title: (message && message.title) || '',
        at: Date.now(),
      });
      return {
        ok: true,
        saved: false,
        reason: 'password-changed',
        entry: { id: existing.id, host: existing.host, username: existing.username },
        host: existing.host,
      };
    }
    if (!existing && updateOnly) return { ok: false, saved: false, reason: 'no-entry', host: U.hostOf(url) };

    const key = U.hostOf(url) + '\u0000' + username + '\u0000' + password;
    const now = Date.now();
    for (const [k, ts] of recentCaptures) {
      if (now - ts > 10000) recentCaptures.delete(k);
    }
    if (recentCaptures.has(key) && !force) return { ok: false, saved: false, reason: 'duplicate' };
    recentCaptures.set(key, now);

    let outcome;
    try {
      outcome = V.upsert(c.vault, {
        url,
        username,
        password,
        title: (message && message.title) || U.prettyHost(U.hostOf(url)),
      });
    } catch (err) {
      return { ok: false, saved: false, reason: 'invalid', error: errText(err) };
    }

    if (outcome.action === 'unchanged') return { ok: true, saved: false, reason: 'unchanged' };

    // 这条变更已经落库，待确认状态可以清了
    const pending = await readPendingChange();
    if (pending && pending.host === (outcome.entry.host || '') && pending.username === outcome.entry.username) {
      await clearPendingChange();
    }

    c.vault = outcome.vault;
    c.dirty = true;
    bumpRev(c);
    await persist();
    await refreshBadge();
    requestSync().catch(() => undefined);

    return {
      ok: true,
      saved: true,
      action: outcome.action,
      entry: { id: outcome.entry.id, host: outcome.entry.host, username: outcome.entry.username },
      host: outcome.entry.host,
    };
  }

  /* ------------------------------------------------------------------ *
   * 主密码
   * ------------------------------------------------------------------ */

  /**
   * 「在本机记住」的当前状态。
   *
   * 开关打开 != 现在真的能免密：密钥可能还没写入（当前是锁定态）、
   * 已经过期、或者被「锁定」清掉了。界面必须能看出「现在是什么状态、还剩几天」。
   */
  async function rememberedStatus(c) {
    const settings = await S.getSettings();
    // 共享电脑模式下「本机记住」被强制关闭，状态一律报未开启
    const on = settings && settings.sharedMode ? false : !!settings.rememberDevice;
    const out = {
      on,
      days: Number(settings.rememberDeviceDays) || 0,
      active: false, // 现在真的有可用的记住密钥
      expiresAt: null,
      savedAt: null,
      remainingMs: null,
      remainingDays: null,
      expired: false,
    };
    let record = null;
    try {
      record = await S.readRememberedRecord();
    } catch (err) {
      record = null;
    }
    if (!record) return out;

    out.savedAt = record.savedAt || null;
    out.expiresAt = record.expiresAt || null;
    if (record.expired || !record.key) {
      out.expired = true;
      return out;
    }
    if (!record.expiresAt) {
      out.active = true; // 0 天 = 永久
      return out;
    }
    const expiresAt = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      out.expired = true;
      return out;
    }
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      out.expired = true;
      return out;
    }
    // 有记录且未过期，但密码库现在是锁定态：密钥还在，解锁时会被清掉/覆盖
    out.active = !isLocked(c);
    out.remainingMs = remainingMs;
    out.remainingDays = Math.max(1, Math.ceil(remainingMs / 86400000));
    return out;
  }

  async function rememberKey(c, key) {
    c.key = key;
    c.locked = false;
    const raw = await Crypto.exportKey(key);
    await S.writeSessionKey(raw);
    try {
      const settings = await S.getSettings();
      if (settings && settings.sharedMode) {
        // 共享电脑模式：绝不落盘记住密钥
        await S.clearRememberedKey();
      } else if (settings && settings.rememberDevice) {
        const days = Number(settings.rememberDeviceDays);
        // days <= 0 表示永久（直到手动锁定）
        await S.writeRememberedKey(raw, Number.isFinite(days) ? days : 7);
      } else {
        await S.clearRememberedKey();
      }
    } catch (err) {
      /* 记住本机失败不阻塞解锁 */
    }
  }

  async function unlockVault(message) {
    const password = String((message && message.password) || '');
    if (!password) return { ok: false, error: '请输入主密码' };

    const c = await getCache();
    const settings = await S.getSettings();
    let kdf = c.kdf || (c.cipher && c.cipher.kdf) || null;
    let envelope = null;

    // 已有本地密文时直接用本地信封验证，不必每次访问远端（快路径）；
    // 全新设备没有本地缓存，必须先从远端拿信封再解锁。
    if (!kdf) {
      if (settings.webdavUrl) {
        try {
          const client = D.createClient(settings);
          const remote = await client.read();
          const remoteEnvelope = remote.exists ? Crypto.parseEnvelope(remote.text) : null;
          if (remoteEnvelope) {
            envelope = remoteEnvelope;
            kdf = remoteEnvelope.kdf;
          }
        } catch (err) {
          return { ok: false, error: '无法读取远端密码库：' + errText(err) };
        }
      }
      if (!kdf) return { ok: false, code: 'not-encrypted', error: '密码库还没有启用主密码加密' };
    }

    let key;
    try {
      key = await Crypto.deriveKey(password, kdf);
    } catch (err) {
      return { ok: false, error: errText(err) };
    }

    // 用本地密文验证主密码（无网络请求）。
    let verified = false;
    let localVault = null;
    if (c.cipher) {
      try {
        localVault = V.parse(await Crypto.decryptText(c.cipher, key));
        verified = true;
      } catch (err) {
        verified = false;
      }
    }

    // 全新设备没有本地密文一种情形：本地验证失败时，
    // 用远端信封兜底（另一台设备改过主密码时本地 KDF 已失效，
    // 重新拿远端 KDF 可救回这次解锁；失败则按主密码错误处理）。
    if (!verified && settings.webdavUrl) {
      try {
        const client = D.createClient(settings);
        const remote = await client.read();
        envelope = remote.exists ? Crypto.parseEnvelope(remote.text) : null;
        if (envelope) {
          kdf = envelope.kdf;
          key = await Crypto.deriveKey(password, kdf);
          localVault = V.parse(await Crypto.decryptText(envelope, key));
          verified = true;
        }
      } catch (err) {
        /* 退回到主密码错误 */
      }
    }
    if (!verified) return { ok: false, code: 'bad-password', error: '主密码不正确' };

    c.encrypted = true;
    c.kdf = kdf;
    await rememberKey(c, key);
    if (localVault) {
      // 远端 / 本地密文解出来的内容为准，但合并本地缓存里还没上传的条目：
      // 例如离线时记录过密码，之后远端被别的设备加密，解锁不能把它冲掉。
      const before = V.serialize(c.vault);
      c.vault = V.merge(localVault, c.vault);
      if (V.serialize(c.vault) !== before) c.dirty = true;
    }
    c.lastError = null;
    await persist();
    await refreshBadge();

    // 解锁立即返回，同步在后台继续执行，避免因远端/写入慢而卡住界面
    requestSync().catch(() => undefined);
    notifyTabs();
    // 共享电脑模式：解锁后挂闲置自动锁定（刚解锁，强制给一个全新的倒计时）
    scheduleAutoLock({ force: true }).catch(() => undefined);
    return {
      ok: true,
      encrypted: true,
      locked: false,
      entries: c.vault.entries.length,
    };
  }

  async function lockVault() {
    clearAutoLock();
    const c = await getCache();
    if (!c.encrypted) return { ok: false, error: '密码库未启用加密' };
    await persist(); // 先确保密文是最新的
    await S.writeSessionKey(null);
    await S.clearRememberedKey();
    c.key = null;
    c.locked = true;
    c.vault = V.empty();
    await clearPendingChange();
    await refreshBadge();
    notifyTabs();
    return { ok: true, locked: true };
  }

  async function enableEncryption(message) {
    const password = String((message && message.password) || '');
    if (password.length < MIN_MASTER_PASSWORD) {
      return { ok: false, error: '主密码至少 ' + MIN_MASTER_PASSWORD + ' 位' };
    }
    const c = await getCache();
    if (c.encrypted) return { ok: false, error: '密码库已处于加密状态' };

    // 先把远端内容合并进来，避免启用加密时漏掉别的设备的记录
    const pre = await syncNow();
    if (pre.configured && !pre.ok) {
      return { ok: false, error: '同步失败，暂时无法启用加密：' + (pre.error || '未知错误') };
    }

    const kdf = Crypto.createKdf();
    const key = await Crypto.deriveKey(password, kdf);
    c.encrypted = true;
    c.kdf = kdf;
    c.dirty = true;
    bumpRev(c);
    await rememberKey(c, key);
    await persist();
    await refreshBadge();
    await S.saveSettings({ encryptVault: true });

    c.notice = '';
    const sync = await syncNow();
    if (!sync.ok) {
      if (!sync.configured) {
        // 还没配置 WebDAV：先本地加密，等配置好再上传
        return { ok: true, encrypted: true, localOnly: true, entries: c.vault.entries.length };
      }
      return { ok: false, encrypted: true, error: '已启用加密，但上传失败：' + (sync.error || '未知错误') };
    }
    notifyTabs();
    return { ok: true, encrypted: true, entries: c.vault.entries.length };
  }

  async function disableEncryption() {
    const c = await getCache();
    if (!c.encrypted) return { ok: false, error: '密码库未启用加密' };
    const key = c.key || (await getKey(c));
    if (!key) return { ok: false, code: 'locked', locked: true, error: '请先解锁再关闭加密' };

    c.encrypted = false;
    c.kdf = null;
    c.cipher = null;
    c.dirty = true;
    c.encryptionDisabled = true;
    bumpRev(c);
    await S.writeSessionKey(null);
    await S.clearRememberedKey();
    await S.saveSettings({ encryptVault: false });
    await persist();
    await refreshBadge();

    await rekeyHistory(key, null);

    // c.key 暂时保留，用于解密远端密文后以明文覆盖
    const sync = await syncNow();
    // 这次上传会把“加密版远端”留成快照，同样转成明文，别留一堆打不开的东西
    await rekeyHistory(key, null);
    delete c.encryptionDisabled;
    c.key = null;
    await persist();
    await refreshBadge();

    if (!sync.ok) {
      return { ok: false, encrypted: false, error: '已关闭加密，但上传失败：' + (sync.error || '未知错误') };
    }
    notifyTabs();
    return { ok: true, encrypted: false, entries: c.vault.entries.length };
  }

  /**
   * 用新密钥重写远端：先用旧密钥解密远端密文、合并本地改动，再用新密钥加密上传。
   * 用于修改主密码（不能用普通 performSync，因为同步会先用新密钥去解旧密文）。
   */
  async function reencryptRemote(client, settings, localVault, oldKey, newMode) {
    let remote = await client.read();
    // 改主密码会用新密钥整份重写远端，旧密文只有旧密码能解；
    // 先把旧文件留在本地快照里，新密码记错时还有救。
    if (remote.exists && remote.text) await rememberHistory('remote', remote.text);
    const compat = !!settings.noIfMatch;
    const maxAttempts = compat ? 2 : 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let remoteVault = V.empty();
      if (remote.exists) {
        const envelope = Crypto.parseEnvelope(remote.text);
        remoteVault = envelope
          ? V.parse(await Crypto.decryptText(envelope, oldKey))
          : V.parse(remote.text);
      }
      const merged = V.merge(remoteVault, localVault);
      const lastAttempt = attempt === maxAttempts - 1;
      const force = !compat && lastAttempt;
      const conditional = !compat && !lastAttempt;
      try {
        const res = await writeVault(
          client,
          settings,
          merged,
          conditional ? remote.etag : null,
          Object.assign({}, newMode, { conditional })
        );
        return { vault: merged, etag: res.etag, degraded: force };
      } catch (err) {
        if (err.code !== 'conflict' || !conditional) throw err;
        remote = await client.read();
      }
    }
    throw new Error('重加密重试次数已用尽');
  }

  async function changeMasterPassword(message) {
    const oldPassword = String((message && message.oldPassword) || '');
    const newPassword = String((message && message.newPassword) || '');
    if (newPassword.length < MIN_MASTER_PASSWORD) {
      return { ok: false, error: '新主密码至少 ' + MIN_MASTER_PASSWORD + ' 位' };
    }
    const c = await getCache();
    if (!c.encrypted) return { ok: false, error: '密码库未启用加密' };
    if (!c.kdf) return { ok: false, error: '缺少加密参数' };

    let verified = false;
    try {
      const oldKey = await Crypto.deriveKey(oldPassword, c.kdf);
      if (c.cipher) {
        await Crypto.decryptText(c.cipher, oldKey);
        verified = true;
      } else if (c.key) {
        verified = (await Crypto.exportKey(oldKey)) === (await Crypto.exportKey(c.key));
      }
    } catch (err) {
      verified = false;
    }
    if (!verified) return { ok: false, code: 'bad-password', error: '原主密码不正确' };

    const settings = await S.getSettings();

    // 没有配置远端时只换本地密钥
    if (!settings.webdavUrl) {
      const oldLocalKey = c.key || (await getKey(c));
      const localKdf = Crypto.createKdf();
      const localKey = await Crypto.deriveKey(newPassword, localKdf);
      c.kdf = localKdf;
      c.dirty = true;
      bumpRev(c);
      await rememberKey(c, localKey);
      await persist();
      await rekeyHistory(oldLocalKey, { encrypted: true, key: localKey, kdf: localKdf });
      await refreshBadge();
      notifyTabs();
      return { ok: true, encrypted: true, entries: c.vault.entries.length };
    }

    // 先用旧密钥把两边同步一致，避免重加密时丢数据
    const pre = await syncNow();
    if (!pre.ok) return { ok: false, error: '修改前同步失败：' + (pre.error || '未知错误') };

    const oldKey = c.key || (await getKey(c));
    if (!oldKey) return { ok: false, code: 'locked', locked: true, error: '请先解锁' };

    const kdf = Crypto.createKdf();
    const key = await Crypto.deriveKey(newPassword, kdf);

    try {
      c.dirty = true; // 防止并发同步用旧密钥覆盖
      bumpRev(c);
      const client = D.createClient(settings);
      const rewritten = await reencryptRemote(client, settings, c.vault, oldKey, {
        encrypted: true,
        key,
        kdf,
      });
      c.kdf = kdf;
      await rememberKey(c, key);
      await rekeyHistory(oldKey, { encrypted: true, key, kdf });
      if (rewritten.degraded) await markIfMatchCompat(c, settings, '改主密码时连续被拒');
      c.vault = rewritten.vault;
      c.etag = rewritten.etag || c.etag;
      c.dirty = false;
      c.lastError = null;
      c.lastSyncAt = U.nowIso();
      await persist();
      await refreshBadge();
      notifyTabs();
      return { ok: true, encrypted: true, entries: c.vault.entries.length };
    } catch (err) {
      c.lastError = errText(err);
      await persist();
      await refreshBadge();
      return { ok: false, encrypted: true, error: '修改主密码失败：' + c.lastError };
    }
  }

  /* ------------------------------------------------------------------ *
   * 消息处理
   * ------------------------------------------------------------------ */

  const handlers = {
    async ping() {
      return { ok: true, version: api.runtime.getManifest().version };
    },

    async 'vault:status'() {
      const settings = await S.getSettings();
      const c = await probeRemoteState();
      const locked = isLocked(c);
      return {
        ok: true,
        configured: !!settings.webdavUrl,
        encrypted: !!c.encrypted,
        locked,
        dirty: !!c.dirty,
        lastSyncAt: c.lastSyncAt,
        lastError: c.lastError,
        entries: locked ? 0 : c.vault.entries.length,
        kdfIterations: c.kdf ? c.kdf.iterations : null,
        notice: c.notice || '',
        remember: await rememberedStatus(c),
        sharedMode: !!settings.sharedMode,
        autoLockMinutes: settings.autoLockMinutes,
      };
    },

    /** 单独查询 / 刷新「本机记住」状态（设置页与弹窗共用） */
    async 'vault:rememberStatus'() {
      const c = await getCache();
      const settings = await S.getSettings();
      return { ok: true, remember: await rememberedStatus(c), settings };
    },

    /**
     * 站点识别线索（「智能识别」）。
     * 只存选择器与页面状态关键词，不含账号密码；纯本地，不参与同步。
     */
    async 'site:memory'(message) {
      const host = U.normalizeHost((message && message.host) || '');
      const map = await S.readSiteMemory();
      return { ok: true, host, memory: (host && map[host]) || null };
    },

    async 'site:learn'(message) {
      const host = U.normalizeHost((message && message.host) || '');
      if (!host) return { ok: false, error: '缺少站点' };
      const patch = (message && message.memory) || {};
      const clean = {
        user: typeof patch.user === 'string' ? patch.user : '',
        pass: typeof patch.pass === 'string' ? patch.pass : '',
        markers: Array.isArray(patch.markers) ? patch.markers : [],
      };
      const map = await S.saveSiteMemory(host, clean);
      return { ok: true, memory: map[host] || null };
    },

    async 'site:forget'(message) {
      const host = U.normalizeHost((message && message.host) || '');
      if (!host) return { ok: false, error: '缺少站点' };
      await S.forgetSiteMemory(host);
      return { ok: true };
    },

    async 'vault:clearNotice'() {
      const c = await getCache();
      c.notice = '';
      await persist();
      return { ok: true };
    },

    async 'content:getState'(message) {
      const settings = await S.getSettings();
      const c = await getCache();
      const locked = isLocked(c);
      const url = U.isWebUrl(message.url) ? message.url : '';
      const entries = !locked && url ? V.find(c.vault, url) : [];
      const pending = !!(settings.webdavUrl && !c.lastSyncAt && !c.dirty && !locked);
      if (pending) ensureInitialSync().catch(() => undefined);

      return {
        ok: true,
        host: U.hostOf(url),
        configured: !!settings.webdavUrl,
        pending,
        locked,
        dirty: !!c.dirty,
        lastSyncAt: c.lastSyncAt,
        lastError: c.lastError,
        settings: {
          autoSave: settings.autoSave,
          autoPrompt: settings.autoPrompt,
          autoOpenPanel: settings.autoOpenPanel,
          autoFillSingle: settings.autoFillSingle,
          confirmPasswordChange: settings.confirmPasswordChange,
          sharedMode: !!settings.sharedMode,
          autoLockMinutes: settings.autoLockMinutes,
        },
        entries: entries.map((e) => ({
          id: e.id,
          host: e.host,
          title: e.title,
          username: e.username,
          password: e.password,
          url: e.url,
        })),
      };
    },

    async 'credential:capture'(message, sender) {
      return captureCredential(message, sender);
    },

    async 'credential:pending'(message) {
      const pending = await readPendingChange();
      if (!pending) return { ok: true, pending: null };
      const host = U.normalizeHost((message && message.host) || '');
      if (host && pending.host && host !== pending.host && !U.hostMatches(pending.host, host)) {
        return { ok: true, pending: null };
      }
      return { ok: true, pending };
    },

    async 'credential:resolvePending'(message) {
      const pending = await readPendingChange();
      if (!pending) return { ok: false, reason: 'no-pending' };
      const accept = !!(message && message.accept);
      await clearPendingChange();
      if (!accept) return { ok: true, accepted: false };
      const result = await captureCredential(
        {
          url: pending.url,
          username: pending.username,
          password: pending.password,
          title: pending.title,
          force: true,
        },
        { url: pending.url }
      );
      return Object.assign({ accepted: true }, result || {});
    },

    async 'credential:used'(message) {
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked' };
      const next = V.markUsed(c.vault, message.id);
      if (next !== c.vault) {
        c.vault = next;
        bumpRev(c);
        await persist();
      }
      return { ok: true };
    },

    async 'credential:delete'(message) {
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked', error: '请先解锁' };
      await rememberHistory('before-delete', V.serialize(c.vault));
      c.vault = V.remove(c.vault, message.id);
      c.dirty = true;
      bumpRev(c);
      await persist();
      await refreshBadge();
      requestSync().catch(() => undefined);
      return { ok: true };
    },

    async 'vault:list'() {
      const settings = await S.getSettings();
      const c = await probeRemoteState();
      const locked = isLocked(c);
      return {
        ok: true,
        configured: !!settings.webdavUrl,
        dirty: !!c.dirty,
        lastSyncAt: c.lastSyncAt,
        lastError: c.lastError,
        etag: c.etag,
        encrypted: !!c.encrypted,
        locked,
        kdfIterations: c.kdf ? c.kdf.iterations : null,
        notice: c.notice || '',
        remember: await rememberedStatus(c),
        vault: locked ? V.empty() : V.normalize(c.vault),
        settings: {
          autoSave: settings.autoSave,
          autoPrompt: settings.autoPrompt,
          autoOpenPanel: settings.autoOpenPanel,
          autoFillSingle: settings.autoFillSingle,
          confirmPasswordChange: settings.confirmPasswordChange,
          syncIntervalMin: settings.syncIntervalMin,
          encryptVault: settings.encryptVault,
          lastExportAt: settings.lastExportAt,
          sharedMode: !!settings.sharedMode,
          autoLockMinutes: settings.autoLockMinutes,
        },
        sharedMode: !!settings.sharedMode,
        autoLockMinutes: settings.autoLockMinutes,
      };
    },

    async 'vault:saveEntry'(message) {
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked', error: '请先解锁' };
      const outcome = V.put(c.vault, message.entry);
      c.vault = outcome.vault;
      c.dirty = true;
      bumpRev(c);
      await persist();
      await refreshBadge();
      requestSync().catch(() => undefined);
      return { ok: true, entry: outcome.entry, action: outcome.action };
    },

    async 'vault:deleteEntry'(message) {
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked', error: '请先解锁' };
      await rememberHistory('before-delete', V.serialize(c.vault));
      c.vault = V.remove(c.vault, message.id);
      c.dirty = true;
      bumpRev(c);
      await persist();
      await refreshBadge();
      requestSync().catch(() => undefined);
      return { ok: true };
    },

    async 'vault:sync'() {
      const result = await syncNow();
      return Object.assign({ ok: result.ok }, result);
    },

    async 'vault:test'(message) {
      const settings = message.settings ? S.normalizeSettings(message.settings) : await S.getSettings();
      if (!settings.webdavUrl) return { ok: false, error: '请先填写 WebDAV 文件地址' };
      try {
        const client = D.createClient(settings);
        const info = await client.testConnection();
        let encrypted = false;
        try {
          const read = await client.read();
          encrypted = !!(read.exists && Crypto.parseEnvelope(read.text));
        } catch (err) {
          encrypted = false;
        }
        return Object.assign({ ok: true, encrypted }, info);
      } catch (err) {
        return { ok: false, error: errText(err), code: err.code || 'error' };
      }
    },

    async 'vault:push'() {
      const settings = await S.getSettings();
      if (!settings.webdavUrl) return { ok: false, configured: false, error: '尚未配置 WebDAV 地址' };
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked', error: '请先解锁' };
      return forcePushLocal(c, settings);
    },

    async 'vault:history'() {
      const list = await S.readHistory();
      return { ok: true, items: describeHistory(list) };
    },

    async 'vault:restoreHistory'(message) {
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked', error: '请先解锁' };
      const at = String((message && message.at) || '');
      const list = await S.readHistory();
      const item = list.find((entry) => entry.at === at);
      if (!item) return { ok: false, error: '找不到这条快照（可能已经过期被清理）' };

      let text = item.text;
      const envelope = Crypto.parseEnvelope(text);
      if (envelope) {
        if (!c.encrypted) {
          return { ok: false, error: '这是加密快照，请先在设置里启用主密码加密并解锁' };
        }
        const key = c.key || (await getKey(c));
        if (!key) return { ok: false, code: 'locked', error: '请先解锁' };
        try {
          text = await Crypto.decryptText(envelope, key);
        } catch (err) {
          return { ok: false, error: '无法解密这条快照：' + errText(err) };
        }
      }

      let vault;
      try {
        vault = V.parse(text);
      } catch (err) {
        return { ok: false, error: '快照内容无法解析：' + errText(err) };
      }

      await rememberHistory('before-restore', V.serialize(c.vault));
      c.vault = vault;
      c.dirty = true;
      bumpRev(c);
      await persist();
      await refreshBadge();

      const settings = await S.getSettings();
      if (!settings.webdavUrl) {
        return { ok: true, entries: vault.entries.length, sync: { ok: false, pending: true } };
      }
      // 恢复是「回到那一次」，不能和远端再合并回来，所以强制覆盖
      const pushed = await forcePushLocal(c, settings);
      return { ok: true, entries: vault.entries.length, sync: pushed };
    },

    async 'vault:clearHistory'() {
      await S.clearHistory();
      return { ok: true };
    },

    async 'vault:importEntries'(message) {
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked', error: '请先解锁再导入' };
      const list = Array.isArray(message && message.entries) ? message.entries : [];
      if (!list.length) return { ok: false, error: '没有可导入的条目' };
      const overwrite = !!(message && message.overwrite);

      // 单次导入上限：再多就让用户分批，避免一条消息卡死后台
      const MAX_IMPORT = 5000;
      const limited = list.slice(0, MAX_IMPORT);
      const skipped = list.length - limited.length;

      // upsertMany：只 normalize 一次，5000 行从 ~22 秒降到 ~0.1 秒
      const outcome = V.upsertMany(c.vault, limited, { exact: true, overwrite });
      const stats = Object.assign({}, outcome.stats, { total: list.length, skipped });
      if (skipped) stats.truncated = true;

      if (!outcome.stats.added && !outcome.stats.updated) {
        return Object.assign({ ok: true, sync: null }, stats);
      }

      await rememberHistory('before-import', V.serialize(c.vault));
      c.vault = outcome.vault;
      c.dirty = true;
      bumpRev(c);
      await persist();
      await refreshBadge();
      const sync = await syncNow();
      return Object.assign({ ok: true, sync }, stats);
    },

    async 'vault:import'(message) {
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked', error: '请先解锁' };
      const before = V.serialize(c.vault);
      const imported = V.parse(message.text);
      await rememberHistory('before-import', before);
      c.vault = V.merge(c.vault, imported);
      c.dirty = true;
      bumpRev(c);
      await persist();
      await refreshBadge();
      const result = await syncNow();
      return { ok: true, imported: imported.entries.length, sync: result };
    },

    async 'vault:export'() {
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked', error: '请先解锁' };
      const text = V.serialize(c.vault);
      await S.saveSettings({ lastExportAt: U.nowIso() });
      return { ok: true, text, entries: c.vault.entries.length };
    },

    async 'vault:pull'() {
      const settings = await S.getSettings();
      if (!settings.webdavUrl) return { ok: false, error: '尚未配置 WebDAV 地址' };
      const c = await getCache();
      if (isLocked(c)) return { ok: false, code: 'locked', error: '请先解锁' };
      await rememberHistory('before-pull', V.serialize(c.vault));
      // 保留加密状态与密钥，只丢弃本地内容
      const keep = { encrypted: c.encrypted, kdf: c.kdf, key: c.key, cipher: c.cipher };
      cache = Object.assign(emptyCache(), keep, { locked: isLocked(keep) });
      await S.clearCacheRecord();
      await persist();
      const result = await syncNow();
      return Object.assign({ ok: result.ok }, result);
    },

    async 'vault:unlock'(message) {
      return unlockVault(message);
    },

    async 'vault:lock'() {
      return lockVault();
    },

    async 'vault:enableEncryption'(message) {
      return enableEncryption(message);
    },

    async 'vault:disableEncryption'() {
      return disableEncryption();
    },

    async 'vault:changeMasterPassword'(message) {
      return changeMasterPassword(message);
    },

    async 'vault:rememberDevice'(message) {
      const before = await S.getSettings();
      if (before && before.sharedMode) {
        await S.clearRememberedKey().catch(() => undefined);
        return { ok: false, error: '共享电脑模式下无法开启“本机记住”', settings: before };
      }
      const remember = !!(message && message.remember);
      const daysRaw = Number(message && message.days);
      const days = remember && Number.isFinite(daysRaw) && daysRaw >= 0 ? Math.min(Math.round(daysRaw), 365) : 7;
      const settings = await S.saveSettings({ rememberDevice: remember, rememberDeviceDays: days });
      if (!remember) {
        await S.clearRememberedKey();
        return { ok: true, settings };
      }
      // 当前处于解锁状态时立即写入本机记住的密钥，
      // 否则下次输入主密码解锁时会写入（滚动有效期，0 = 永久）。
      const c = await getCache();
      const key = c && c.key ? c.key : await getKey(c);
      if (key && !isLocked(c)) {
        await S.writeRememberedKey(await Crypto.exportKey(key), days);
      }
      return { ok: true, settings };
    },

    async 'settings:changed'() {
      await setupAlarm();
      await refreshBadge();
      const settings = await S.getSettings();
      if (settings && settings.sharedMode) {
        await S.clearRememberedKey().catch(() => undefined);
        // 已强制关闭的本地行为无需额外动作，normalizeSettings 已保证
        const cLock = await getCache();
        if (cLock && cLock.encrypted && !isLocked(cLock)) {
          // 用户在设置页改了分钟数 / 刚打开共享模式：按新值重新起算
          await scheduleAutoLock({ force: true }).catch(() => undefined);
        } else {
          clearAutoLock();
        }
      } else {
        // 退出共享模式：若仍是解锁态，清理掉残留的自动锁定闹钟
        const c2 = await getCache();
        if (!settings.sharedMode && c2 && c2.encrypted && isLocked(c2)) clearAutoLock();
        // 未开启共享模式时，若当前无自动锁定需求也清理
        try {
          const s2 = await S.getSettings();
          if (!s2.sharedMode) clearAutoLock();
        } catch (err) { /* ignore */ }
      }
      if (settings.webdavUrl) {
        const c = await getCache();
        if (!isLocked(c)) requestSync().catch(() => undefined);
      }
      return { ok: true };
    },

    async 'ui:openOptions'() {
      await api.runtime.openOptionsPage();
      return { ok: true };
    },
  };

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message && message.type;
    const handler = handlers[type];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(message, sender))
      .then((result) => sendResponse(result || { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: errText(err) }));
    return true;
  });

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  api.runtime.onInstalled.addListener((details) => {
    setupAlarm().catch(() => undefined);
    refreshBadge().catch(() => undefined);
    if (details && details.reason === 'install') {
      api.runtime.openOptionsPage().catch(() => undefined);
    } else {
      requestSync().catch(() => undefined);
    }
  });

  api.runtime.onStartup.addListener(() => {
    setupAlarm().catch(() => undefined);
    requestSync().catch(() => undefined);
  });

  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) {
      // 共享电脑模式下的闲置自动锁定
      (async () => {
        try {
          const settings = await S.getSettings();
          if (!settings || !settings.sharedMode) return;
          const c = await getCache();
          if (!c || !c.encrypted || isLocked(c)) return;
          await lockVault();
        } catch (err) { /* ignore */ }
      })();
      return;
    }
    if (alarm.name === SYNC_ALARM || alarm.name === RETRY_ALARM) {
      syncNow().then((result) => {
        if (!result.ok && result.configured && !result.locked) scheduleRetry();
        return undefined;
      });
    }
  });

  // 页面配置变化后（比如在设置页改了同步间隔）无需 reload 扩展
  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        setupAlarm().catch(() => undefined);
        refreshBadge().catch(() => undefined);
        // 共享模式切换 / 改了闲置分钟数时重排自动锁定（都是用户显式保存设置触发的）
        (async () => {
          try {
            const settings = await S.getSettings();
            if (settings && settings.sharedMode) await scheduleAutoLock({ force: true });
            else clearAutoLock();
          } catch (err) { /* ignore */ }
        })();
      }
    });
  }

  setupAlarm()
    .then(() => refreshBadge())
    // 脚本每次被系统重新唤醒都会跑到这里：不能传 force，否则周期同步 /
    // 失败重试等后台杂事会不断把倒计时续命，导致闲置锁定永远不触发。
    .then(() => scheduleAutoLock())
    .catch(() => undefined);
})();
