/*!
 * pwdmg · 设置页
 */
(function () {
  'use strict';

  const { api, sendMessage } = window.PwdmgApi;
  const U = window.PwdmgUtil;
  const Webdav = window.PwdmgWebdav;
  const Csv = window.PwdmgCsv;
  const Vault = window.PwdmgVault;
  const Store = window.PwdmgStore;

  const el = (id) => document.getElementById(id);

  const state = {
    vault: Vault.empty(),
    settings: null,
    filter: '',
    editingId: null,
  };

  /* ------------------------------ 工具 ------------------------------ */

  function setResult(node, text, stateName) {
    node.textContent = text || '';
    if (stateName) node.dataset.state = stateName;
    else delete node.dataset.state;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function originPatternOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.origin + '/*';
    } catch (err) {
      return '';
    }
  }

  /**
   * 申请 WebDAV 域名的访问权限。
   * 必须作为点击处理函数里的第一个异步调用：Chrome 要求 permissions.request()
   * 处于用户手势上下文中，中间插入其它 await 可能丢失手势。
   * Firefox 在安装时已授予 host_permissions，这里失败/被拒绝也不影响后续请求。
   */
  function requestOriginPermission(url) {
    const pattern = originPatternOf(url);
    if (!pattern) return Promise.resolve(false);
    try {
      return Promise.resolve(api.permissions.request({ origins: [pattern] })).catch(() => false);
    } catch (err) {
      return Promise.resolve(false);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      /* 回退 */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  /* ------------------------------ 连接设置 ------------------------------ */

  function fillConnection(settings) {
    el('wd-url').value = settings.webdavUrl || '';
    el('wd-auth').value = settings.authType || 'basic';
    el('wd-user').value = settings.username || '';
    el('wd-pass').value = settings.password || '';
    el('wd-token').value = settings.token || '';
    el('wd-createdirs').checked = !!settings.createDirs;
    updateAuthVisibility();
  }

  function updateAuthVisibility() {
    const auth = el('wd-auth').value;
    document.querySelectorAll('[data-auth]').forEach((node) => {
      node.style.display = node.getAttribute('data-auth') === auth ? '' : 'none';
    });
  }

  function collectConnection() {
    return {
      webdavUrl: el('wd-url').value.trim(),
      authType: el('wd-auth').value,
      username: el('wd-user').value,
      password: el('wd-pass').value,
      token: el('wd-token').value.trim(),
      createDirs: el('wd-createdirs').checked,
    };
  }

  async function saveConnection() {
    const button = el('save-conn');
    const resultNode = el('conn-result');
    const payload = collectConnection();

    if (!payload.webdavUrl) {
      setResult(resultNode, '请填写 WebDAV 文件地址', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(payload.webdavUrl)) {
      setResult(resultNode, '地址必须以 http:// 或 https:// 开头', 'error');
      return;
    }

    // 填成目录（或以 / 结尾）时自动补成 …/vault.json，避免 GET 拿到目录列表网页
    const normalized = Webdav.normalizeUrl(payload.webdavUrl);
    if (normalized !== payload.webdavUrl) {
      payload.webdavUrl = normalized;
      el('wd-url').value = normalized;
      setResult(resultNode, '已自动补全为文件地址：' + normalized);
    }

    button.disabled = true;
    setResult(resultNode, '正在申请访问该地址的权限…');
    const permission = requestOriginPermission(payload.webdavUrl);
    await permission;

    state.settings = await Store.saveSettings(payload);
    await sendMessage({ type: 'settings:changed' });

    setResult(resultNode, '正在测试连接…');
    const res = await sendMessage({ type: 'vault:test', settings: state.settings });
    button.disabled = false;

    if (res && res.ok) {
      const extra = res.bytes ? '（文件约 ' + formatBytes(res.bytes) + '）' : '';
      const etagNote = res.etagWeak
        ? ' · 服务器返回弱 ETag（W/ 开头），若同步报 412 请勾选下方「兼容模式」'
        : '';
      setResult(resultNode, (res.message || '连接成功') + extra + etagNote, res.etagWeak ? 'warn' : 'ok');
      await refreshVault();
    } else {
      setResult(resultNode, '连接失败：' + ((res && res.error) || '未知错误'), 'error');
    }
  }

  /* ------------------------------ 行为设置 ------------------------------ */

  function fillBehavior(settings) {
    el('opt-autosave').checked = !!settings.autoSave;
    el('opt-autoprompt').checked = !!settings.autoPrompt;
    el('opt-autoopen').checked = !!settings.autoOpenPanel;
    el('opt-autofill').checked = !!settings.autoFillSingle;
    el('opt-confirm-change').checked = !!settings.confirmPasswordChange;
    el('opt-interval').value = settings.syncIntervalMin || 15;
    el('opt-noifmatch').checked = !!settings.noIfMatch;
    el('enc-remember-chk').checked = (Number(settings.rememberDeviceDays) || 0) > 0;
  }

  function collectBehavior() {
    return {
      autoSave: el('opt-autosave').checked,
      autoPrompt: el('opt-autoprompt').checked,
      autoOpenPanel: el('opt-autoopen').checked,
      autoFillSingle: el('opt-autofill').checked,
      confirmPasswordChange: el('opt-confirm-change').checked,
      syncIntervalMin: Number(el('opt-interval').value) || 15,
      noIfMatch: el('opt-noifmatch').checked,
    };
  }

  const saveBehavior = async () => {
    state.settings = await Store.saveSettings(collectBehavior());
    await sendMessage({ type: 'settings:changed' });
    const hint = el('behavior-hint');
    hint.textContent = '已保存 · ' + new Date().toLocaleTimeString();
  };

  /* ------------------------------ 主密码加密 ------------------------------ */

  /** 后台发现加密参数丢失之类的严重问题时会留一条提示 */
  function renderNotice(text) {
    const bar = el('notice-bar');
    if (!text) {
      bar.hidden = true;
      el('notice-text').textContent = '';
      return;
    }
    el('notice-text').textContent = text;
    bar.dataset.state = 'error';
    bar.hidden = false;
  }

  async function dismissNotice() {
    const res = await sendMessage({ type: 'vault:clearNotice' });
    if (res && res.ok) renderNotice('');
  }

  function renderEncryption(status) {
    const encrypted = !!status.encrypted;
    const locked = !!status.locked;
    const node = el('enc-status');

    el('enc-enable').hidden = encrypted;
    el('enc-unlock').hidden = !(encrypted && locked);
    el('enc-manage').hidden = !(encrypted && !locked);
    el('enc-remember').hidden = !encrypted;

    if (!encrypted) {
      setResult(node, '当前未启用加密：密码库以明文 JSON 保存。', 'warn');
    } else if (locked) {
      setResult(node, '已启用加密，当前处于锁定状态。解锁后才能填充与同步。', 'ok');
    } else {
      const bits = ['已启用加密（PBKDF2 ' + (status.kdfIterations || 0) + ' 次 + AES-GCM）'];
      bits.push('会话内已解锁');
      setResult(node, bits.join(' · '), 'ok');
    }
  }

  function setMsg(id, text, stateName) {
    setResult(el(id), text || '', stateName);
  }

  async function enableEncryption() {
    const pass1 = el('enc-pass1').value;
    const pass2 = el('enc-pass2').value;
    if (pass1.length < 8) {
      setMsg('enc-enable-msg', '主密码至少 8 位', 'error');
      return;
    }
    if (pass1 !== pass2) {
      setMsg('enc-enable-msg', '两次输入的主密码不一致', 'error');
      return;
    }
    if (!window.confirm('启用后，WebDAV 上的文件会立即被加密覆盖；主密码丢失将无法恢复。继续？')) return;

    const btn = el('enc-enable-btn');
    btn.disabled = true;
    setMsg('enc-enable-msg', '正在派生密钥并加密上传…');
    const res = await sendMessage({ type: 'vault:enableEncryption', password: pass1 });
    btn.disabled = false;
    el('enc-pass1').value = '';
    el('enc-pass2').value = '';
    if (res && res.ok) {
      setMsg('enc-enable-msg', '已启用加密 · ' + (res.entries || 0) + ' 个账号', 'ok');
      await refreshAll();
    } else {
      setMsg('enc-enable-msg', (res && res.error) || '启用失败', 'error');
      await refreshVault({ keepStatus: true });
    }
  }

  async function unlockEncryption() {
    const input = el('enc-unlock-pass');
    const password = input.value;
    if (!password) {
      setMsg('enc-unlock-msg', '请输入主密码', 'error');
      return;
    }
    const btn = el('enc-unlock-btn');
    btn.disabled = true;
    setMsg('enc-unlock-msg', '正在解锁…');
    const res = await sendMessage({ type: 'vault:unlock', password });
    btn.disabled = false;
    if (res && res.ok) {
      input.value = '';
      setMsg('enc-unlock-msg', '已解锁', 'ok');
      await refreshAll();
    } else {
      setMsg('enc-unlock-msg', (res && res.error) || '解锁失败', 'error');
    }
  }

  async function lockEncryption() {
    const res = await sendMessage({ type: 'vault:lock' });
    if (res && res.ok) await refreshAll();
    else setResult(el('sync-status'), (res && res.error) || '锁定失败', 'error');
  }

  async function disableEncryption() {
    const ok = window.confirm(
      '关闭加密后，WebDAV 上的密码库会变回明文 JSON，任何能访问该文件的人都能看到密码。确定继续？'
    );
    if (!ok) return;
    const res = await sendMessage({ type: 'vault:disableEncryption' });
    if (res && res.ok) {
      setMsg('enc-status', '已关闭加密，密码库现在是明文。', 'warn');
      await refreshAll();
    } else {
      setResult(el('sync-status'), (res && res.error) || '关闭加密失败', 'error');
      await refreshVault({ keepStatus: true });
    }
  }

  async function changeMasterPassword() {
    const oldPassword = el('enc-old').value;
    const newPassword = el('enc-new').value;
    if (newPassword.length < 8) {
      setMsg('enc-change-msg', '新主密码至少 8 位', 'error');
      return;
    }
    const btn = el('enc-change-btn');
    btn.disabled = true;
    setMsg('enc-change-msg', '正在用新密钥重新加密上传…');
    const res = await sendMessage({ type: 'vault:changeMasterPassword', oldPassword, newPassword });
    btn.disabled = false;
    if (res && res.ok) {
      el('enc-old').value = '';
      el('enc-new').value = '';
      setMsg('enc-change-msg', '主密码已修改', 'ok');
      await refreshAll();
    } else {
      setMsg('enc-change-msg', (res && res.error) || '修改失败', 'error');
    }
  }

  /* ------------------------------ 同步 / 导入导出 ------------------------------ */

  async function syncNow() {
    const button = el('btn-sync');
    button.disabled = true;
    setResult(el('sync-status'), '正在同步…');
    const res = await sendMessage({ type: 'vault:sync' });
    button.disabled = false;
    if (!res) {
      setResult(el('sync-status'), '后台未响应，请重新加载扩展', 'error');
      return;
    }
    if (res.ok) {
      setResult(el('sync-status'), '同步完成 · 共 ' + (res.entries || 0) + ' 个账号', 'ok');
    } else {
      setResult(el('sync-status'), '同步失败：' + (res.error || '未知错误'), 'error');
    }
    await refreshVault({ keepStatus: true });
  }

  async function pullRemote() {
    const ok = window.confirm('将用 WebDAV 上的文件覆盖本地缓存，未上传的本地改动会丢失。继续？');
    if (!ok) return;
    setResult(el('sync-status'), '正在从 WebDAV 拉取…');
    const res = await sendMessage({ type: 'vault:pull' });
    if (res && res.ok) setResult(el('sync-status'), '已从 WebDAV 重新拉取', 'ok');
    else setResult(el('sync-status'), '拉取失败：' + ((res && res.error) || '未知错误'), 'error');
    await refreshVault({ keepStatus: true });
  }

  async function exportVault() {
    if (state.encryption && state.encryption.encrypted) {
      const ok = window.confirm('导出的备份是明文 JSON（包含全部密码），请存放在安全的地方。继续导出？');
      if (!ok) return;
    }
    const res = await sendMessage({ type: 'vault:export' });
    if (!res || !res.ok) {
      setResult(el('sync-status'), (res && res.error) || '导出失败', 'error');
      return;
    }
    const blob = new Blob([res.text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pwdmg-vault-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setResult(el('sync-status'), '已导出 ' + res.entries + ' 个账号', 'ok');
    state.settings = await Store.getSettings();
    renderExportHint();
  }

  function looksLikeCsv(file, text) {
    if (/\.csv$/i.test(file.name || '')) return true;
    const head = String(text || '').trimStart().slice(0, 200);
    if (head.startsWith('{') || head.startsWith('[')) return false;
    return !!(Csv && Csv.looksLikeHeader(Csv.parseRows(head)[0] || []));
  }

  async function importVault(file) {
    if (state.encryption && state.encryption.locked) {
      setResult(el('sync-status'), '请先解锁再导入', 'error');
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (err) {
      setResult(el('sync-status'), '读取文件失败', 'error');
      return;
    }
    if (looksLikeCsv(file, text)) return importCsv(text, file.name);
    return importJson(text);
  }

  async function importCsv(text, fileName) {
    const parsed = Csv.parse(text);
    const stats = parsed.stats;
    if (!parsed.entries.length) {
      setResult(el('sync-status'), '没有解析出可导入的账号：' + (parsed.error || '格式不支持'), 'error');
      return;
    }
    const parts = [
      '从「' + (fileName || 'CSV') + '」识别出 ' + parsed.entries.length + ' 个账号',
      '（原文件 ' + stats.rows + ' 行',
    ];
    if (stats.merged) parts.push('，合并 ' + stats.merged + ' 条重复');
    if (stats.skippedAndroid) parts.push('，跳过 ' + stats.skippedAndroid + ' 条 Android 应用');
    if (stats.skippedNoPassword) parts.push('，跳过 ' + stats.skippedNoPassword + ' 条无密码');
    if (stats.skippedNoHost) parts.push('，跳过 ' + stats.skippedNoHost + ' 条无网址');
    if (stats.skippedOther) parts.push('，跳过 ' + stats.skippedOther + ' 条非网页地址');
    parts.push('）');
    const overwrite = el('import-overwrite').checked;
    const prompt =
      parts.join('') +
      '。\n\n' +
      (overwrite
        ? '已存在的账号：密码不同会被覆盖。'
        : '已存在的账号：会跳过，不覆盖（勾选「导入时覆盖已有密码」可以替换）。') +
      '\n\n导入后会立即同步到 WebDAV，继续？';
    if (!window.confirm(prompt)) return;

    setResult(el('sync-status'), '正在导入 ' + parsed.entries.length + ' 个账号…');
    const res = await sendMessage({
      type: 'vault:importEntries',
      entries: parsed.entries,
      overwrite,
    });
    if (!res || !res.ok) {
      setResult(el('sync-status'), '导入失败：' + ((res && res.error) || '未知错误'), 'error');
      return;
    }
    const bits = ['新增 ' + res.added];
    if (res.updated) bits.push('覆盖 ' + res.updated);
    if (res.conflicts) bits.push('跳过已存在 ' + res.conflicts);
    if (res.unchanged) bits.push('未变 ' + res.unchanged);
    if (res.invalid) bits.push('无效 ' + res.invalid);
    const syncNote = res.sync ? (res.sync.ok ? ' · 已同步' : ' · 待同步') : '';
    const truncated = res.truncated
      ? ' · 本次只处理前 5000 条，还剩 ' + res.skipped + ' 条请分批导入'
      : '';
    setResult(
      el('sync-status'),
      '导入完成：' + bits.join(' · ') + syncNote + truncated,
      res.truncated ? 'warn' : 'ok'
    );
    await refreshVault({ keepStatus: true });
  }

  async function importJson(text) {
    let parsed;
    try {
      parsed = Vault.parse(text);
    } catch (err) {
      setResult(el('sync-status'), '导入失败：' + err.message, 'error');
      return;
    }
    const ok = window.confirm('将把 ' + parsed.entries.length + ' 个账号合并进当前密码库并同步到 WebDAV，继续？');
    if (!ok) return;
    const res = await sendMessage({ type: 'vault:import', text });
    if (res && res.ok) {
      setResult(el('sync-status'), '已导入 ' + res.imported + ' 个账号', 'ok');
    } else {
      setResult(el('sync-status'), '导入失败：' + ((res && res.error) || '未知错误'), 'error');
    }
    await refreshVault({ keepStatus: true });
  }

  /* ------------------------------ 备份与恢复 ------------------------------ */

  const KIND_LABEL = {
    remote: '覆盖远端前的快照',
    'before-import': '导入前的本地快照',
    'before-delete': '删除前的本地快照',
    'before-pull': '覆盖本地前的快照',
    'before-restore': '恢复前的快照',
  };

  function renderExportHint() {
    const node = el('export-hint');
    const last = state.settings && state.settings.lastExportAt;
    if (!last) {
      setResult(node, '还没有导出过备份。建议定期「导出 JSON」存一份离线副本。', 'warn');
      return;
    }
    const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    const when = '上次导出：' + U.formatRelativeTime(last);
    setResult(
      node,
      days >= 7 ? when + ' · 已经超过一周，建议再导出一份。' : when,
      days >= 7 ? 'warn' : 'ok'
    );
  }

  async function refreshHistory() {
    const res = await sendMessage({ type: 'vault:history' });
    const items = (res && res.items) || [];
    const list = el('history-list');
    list.textContent = '';
    el('history-empty').hidden = items.length > 0;

    for (const item of items) {
      const li = document.createElement('li');
      const meta = document.createElement('span');
      meta.className = 'meta';

      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = U.formatRelativeTime(item.at);

      const kind = document.createElement('span');
      kind.className = 'kind';
      const bits = [KIND_LABEL[item.kind] || item.kind];
      bits.push(formatBytes(item.bytes || 0));
      if (item.entries != null) bits.push(item.entries + ' 个账号');
      if (item.encrypted) bits.push('密文');
      kind.textContent = bits.join(' · ');

      meta.append(when, kind);

      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn ghost';
      restore.textContent = '恢复';
      restore.addEventListener('click', () => restoreHistory(item));

      li.append(meta, restore);
      list.appendChild(li);
    }
  }

  async function restoreHistory(item) {
    const ok = window.confirm(
      '用这份快照覆盖当前密码库并同步到 WebDAV？\n\n快照时间：' +
        U.formatRelativeTime(item.at) +
        '\n当前内容会先被自动留存一份，可以再恢复回来。'
    );
    if (!ok) return;
    setResult(el('sync-status'), '正在恢复快照…');
    const res = await sendMessage({ type: 'vault:restoreHistory', at: item.at });
    if (res && res.ok) {
      const syncNote = res.sync ? (res.sync.ok ? ' · 已同步' : ' · 待同步') : '';
      setResult(el('sync-status'), '已恢复到 ' + res.entries + ' 个账号' + syncNote, 'ok');
      await refreshVault({ keepStatus: true });
      await refreshHistory();
    } else {
      setResult(el('sync-status'), '恢复失败：' + ((res && res.error) || '未知错误'), 'error');
    }
  }

  async function pushLocal() {
    const ok = window.confirm(
      '把本地的密码库整体覆盖到 WebDAV？\n\n远端当前的改动会被丢弃（覆盖前会自动留一份快照）。' +
        '远端文件损坏时用这个按钮修复。'
    );
    if (!ok) return;
    setResult(el('sync-status'), '正在上传本地密码库…');
    const res = await sendMessage({ type: 'vault:push' });
    if (res && res.ok) {
      setResult(el('sync-status'), '已用本地覆盖远端（' + res.entries + ' 个账号）', 'ok');
      await refreshVault({ keepStatus: true });
      await refreshHistory();
    } else {
      setResult(el('sync-status'), '覆盖失败：' + ((res && res.error) || '未知错误'), 'error');
    }
  }

  async function clearHistory() {
    if (!window.confirm('清空所有本地快照？清空后就没法再用它们恢复旧版本了。')) return;
    const res = await sendMessage({ type: 'vault:clearHistory' });
    if (res && res.ok) {
      setResult(el('sync-status'), '已清空本地快照', 'ok');
      await refreshHistory();
    }
  }

  /* ------------------------------ 密码库列表 ------------------------------ */

  function matchesFilter(entry) {
    const q = state.filter.trim().toLowerCase();
    if (!q) return true;
    return [entry.host, entry.username, entry.title, entry.notes]
      .join(' ')
      .toLowerCase()
      .includes(q);
  }

  function renderVault() {
    const list = el('vault-list');
    list.textContent = '';
    const entries = state.vault.entries.filter(matchesFilter);
    const total = state.vault.entries.length;
    el('vault-count').textContent = String(total);
    el('vault-empty').hidden = total > 0;
    el('vault-empty').textContent = state.filter
      ? '没有匹配「' + state.filter + '」的账号。'
      : '密码库里还没有账号。去网站上登录一次，或在弹窗里手动添加。';

    for (const entry of entries) list.appendChild(renderRow(entry));
  }

  function renderRow(entry) {
    const li = document.createElement('li');

    const who = document.createElement('div');
    who.className = 'who';
    const host = document.createElement('div');
    host.className = 'host';
    host.textContent = U.prettyHost(entry.host);
    const user = document.createElement('div');
    user.className = 'user';
    user.textContent = entry.username || '(无用户名)';
    who.append(host, user);

    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(
      miniButton('显示', (btn) => {
        const secret = li.querySelector('.secret');
        if (!secret) return;
        const show = secret.hidden;
        secret.hidden = !show;
        secret.textContent = show ? entry.password || '(空)' : '';
        btn.textContent = show ? '隐藏' : '显示';
      }),
      miniButton('复制', async () => {
        const ok = await copyText(entry.password || '');
        setResult(el('sync-status'), ok ? '密码已复制' : '复制失败', ok ? 'ok' : 'error');
      }),
      miniButton('编辑', () => beginEdit(li, entry)),
      miniButton('删除', (btn) => confirmDelete(btn, li, entry), 'danger')
    );

    const secret = document.createElement('div');
    secret.className = 'secret';
    secret.hidden = true;

    li.append(who, acts, secret);
    return li;
  }

  function miniButton(label, onClick, extra) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini' + (extra ? ' ' + extra : '');
    btn.textContent = label;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  function confirmDelete(btn, li, entry) {
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = '确认删除';
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.dataset.confirm = '';
        btn.textContent = '删除';
      }, 3000);
      return;
    }
    deleteEntry(entry.id);
  }

  async function deleteEntry(id) {
    const res = await sendMessage({ type: 'vault:deleteEntry', id });
    if (res && res.ok) {
      setResult(el('sync-status'), '已删除', 'ok');
      await refreshVault({ keepStatus: true });
    } else {
      setResult(el('sync-status'), '删除失败：' + ((res && res.error) || '未知错误'), 'error');
    }
  }

  function beginEdit(li, entry) {
    li.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'editpanel';
    panel.style.flexBasis = '100%';
    panel.style.width = '100%';

    const urlLabel = document.createElement('label');
    urlLabel.className = 'span2';
    urlLabel.innerHTML = '<span>网站地址</span>';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = entry.url || 'https://' + entry.host;
    urlLabel.appendChild(urlInput);

    const userLabel = document.createElement('label');
    userLabel.innerHTML = '<span>用户名</span>';
    const userInput = document.createElement('input');
    userInput.type = 'text';
    userInput.value = entry.username || '';
    userLabel.appendChild(userInput);

    const passLabel = document.createElement('label');
    passLabel.innerHTML = '<span>密码</span>';
    const passInput = document.createElement('input');
    passInput.type = 'text';
    passInput.value = entry.password || '';
    passLabel.appendChild(passInput);

    const row = document.createElement('div');
    row.className = 'row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn ghost';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => refreshVault());
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn primary';
    save.textContent = '保存';
    save.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      const host = U.normalizeHost(url);
      if (!host) {
        setResult(el('sync-status'), '网站地址不合法', 'error');
        return;
      }
      const payload = Object.assign({}, entry, {
        url: /^https?:\/\//i.test(url) ? url : 'https://' + host,
        host,
        username: userInput.value.trim(),
        password: passInput.value,
      });
      const res = await sendMessage({ type: 'vault:saveEntry', entry: payload });
      if (res && res.ok) {
        setResult(el('sync-status'), '已保存修改', 'ok');
        await refreshVault({ keepStatus: true });
      } else {
        setResult(el('sync-status'), '保存失败：' + ((res && res.error) || '未知错误'), 'error');
      }
    });
    row.append(cancel, save);

    panel.append(urlLabel, userLabel, passLabel, row);
    li.appendChild(panel);
    urlInput.focus();
  }

  /* ------------------------------ 加载 ------------------------------ */

  async function refreshVault(options) {
    const res = await sendMessage({ type: 'vault:list' });
    if (!res || !res.ok) {
      setResult(el('sync-status'), '后台未响应，请重新加载扩展', 'error');
      return;
    }
    state.vault = Vault.normalize(res.vault);
    renderNotice(res.notice);
    state.encryption = { encrypted: !!res.encrypted, locked: !!res.locked, kdfIterations: res.kdfIterations };
    renderEncryption(state.encryption);
    renderVault();
    renderExportHint();

    const meta = el('vault-meta');
    const bits = ['共 ' + state.vault.entries.length + ' 个账号'];
    bits.push(res.lastSyncAt ? '上次同步 ' + U.formatRelativeTime(res.lastSyncAt) : '尚未同步');
    if (res.dirty) bits.push('有改动待上传');
    meta.textContent = bits.join(' · ');

    if (!options || !options.keepStatus) {
      if (res.locked) {
        setResult(el('sync-status'), '密码库已加密并处于锁定状态，解锁后才会同步。', 'error');
      } else if (!res.configured) {
        setResult(el('sync-status'), '尚未配置 WebDAV，账号目前只保存在本地缓存。', 'error');
      } else if (res.lastError) {
        setResult(el('sync-status'), '同步失败：' + res.lastError, 'error');
      } else {
        setResult(el('sync-status'), '同步正常', 'ok');
      }
    }
  }

  async function refreshAll() {
    state.settings = await Store.getSettings();
    fillBehavior(state.settings);
    await refreshVault();
  }

  async function init() {
    state.settings = await Store.getSettings();
    fillConnection(state.settings);
    fillBehavior(state.settings);
    await refreshVault();
    await refreshHistory();

    if (!state.settings.webdavUrl) {
      el('wd-url').focus();
      setResult(el('conn-result'), '首次使用：请先填写 WebDAV 文件地址。');
    }
  }

  /* ------------------------------ 事件 ------------------------------ */

  el('wd-auth').addEventListener('change', updateAuthVisibility);
  el('notice-dismiss').addEventListener('click', dismissNotice);
  el('btn-push').addEventListener('click', pushLocal);
  el('btn-history').addEventListener('click', refreshHistory);
  el('btn-clear-history').addEventListener('click', clearHistory);
  el('enc-enable-btn').addEventListener('click', enableEncryption);
  el('enc-unlock-btn').addEventListener('click', unlockEncryption);
  el('enc-remember-chk').addEventListener('change', async () => {
    const remember = !!el('enc-remember-chk').checked;
    const res = await sendMessage({ type: 'vault:rememberDevice', remember, days: remember ? 7 : 0 });
    if (res && res.ok) {
      state.settings = res.settings;
      setMsg('enc-remember-msg', remember ? '已开启：本机 7 天内免输入主密码' : '已关闭：下次打开就得重新输入主密码', 'ok');
    } else {
      setMsg('enc-remember-msg', (res && res.error) || '保存失败', 'error');
    }
  });
  el('enc-lock-btn').addEventListener('click', lockEncryption);
  el('enc-disable-btn').addEventListener('click', disableEncryption);
  el('enc-change-btn').addEventListener('click', changeMasterPassword);
  el('enc-unlock-pass').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      unlockEncryption();
    }
  });
  el('save-conn').addEventListener('click', saveConnection);
  el('btn-sync').addEventListener('click', syncNow);
  el('btn-pull').addEventListener('click', pullRemote);
  el('btn-export').addEventListener('click', exportVault);
  el('file-import').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (file) await importVault(file);
  });

  ['opt-autosave', 'opt-autoprompt', 'opt-autoopen', 'opt-autofill', 'opt-confirm-change'].forEach((id) => {
    el(id).addEventListener('change', saveBehavior);
  });
  el('opt-interval').addEventListener('change', saveBehavior);

  const onSearch = U.debounce(() => {
    state.filter = el('search').value;
    renderVault();
  }, 120);
  el('search').addEventListener('input', onSearch);

  init().catch((err) => {
    setResult(el('conn-result'), '初始化失败：' + (err && err.message ? err.message : err), 'error');
  });
})();
