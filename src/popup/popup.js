/*!
 * pwdmg · 工具栏弹窗
 */
(function () {
  'use strict';

  const { api, sendMessage } = window.PwdmgApi;
  const U = window.PwdmgUtil;
  const Vault = window.PwdmgVault;

  const el = (id) => document.getElementById(id);

  const state = {
    tab: null,
    url: '',
    host: '',
    entries: [],
    configured: true,
    encrypted: false,
    locked: false,
    editingId: null,
    lastStatus: '',
    statusTimer: null,
  };

  /* ------------------------------ 基础工具 ------------------------------ */

  function setStatus(text, options) {
    const target = el('status');
    target.textContent = text;
    target.dataset.state = options && options.error ? 'error' : 'ok';
    state.lastStatus = text;
    if (state.statusTimer) clearTimeout(state.statusTimer);
    state.statusTimer = null;
    if (options && options.transient) {
      state.statusTimer = setTimeout(() => {
        target.textContent = state.lastStatusPersistent || '';
        target.dataset.state = 'ok';
      }, 3000);
    }
  }

  function setPersistentStatus(text, isError) {
    state.lastStatusPersistent = text;
    setStatus(text, { error: isError });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      /* 回退方案 */
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

  function normalizeUrlInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^[^\s/]+\.[^\s/]{2,}/.test(raw)) return 'https://' + raw;
    return raw;
  }

  async function getActiveTab() {
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0] ? tabs[0] : null;
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------ 数据加载 ------------------------------ */

  async function load() {
    state.tab = await getActiveTab();
    state.url = (state.tab && state.tab.url) || '';
    state.host = U.hostOf(state.url);
    const isWeb = U.isWebUrl(state.url);

    el('site-host').textContent = isWeb ? U.prettyHost(state.host) : '当前页面不可用';
    el('site-sub').textContent = isWeb ? (state.tab && state.tab.title ? state.tab.title : '') : '浏览器内置页面无法自动填充';

    const res = await sendMessage({ type: 'vault:list' });
    if (!res || !res.ok) {
      setPersistentStatus('后台未响应，请重新加载扩展', true);
      return;
    }

    state.configured = !!res.configured;
    state.encrypted = !!res.encrypted;
    state.locked = !!res.locked;
    state.entries = !state.locked && isWeb && res.vault ? Vault.find(res.vault, state.url) : [];

    renderEncryption(res);
    renderEntries();
    renderBanner(res);
    renderStatus(res);
  }

  function renderEncryption(res) {
    const locked = !!res.locked;
    el('lock-box').hidden = !locked;
    el('lock-badge').hidden = !res.encrypted;
    el('lock-btn').hidden = !(res.encrypted && !locked);
    el('site-card').hidden = locked;
    if (locked) {
      el('add-form').hidden = true;
      el('add-toggle').hidden = true;
      el('lock-error').hidden = true;
      setTimeout(() => el('unlock-password').focus(), 30);
    } else {
      // 表单展开时按钮本来就该隐藏
      el('add-toggle').hidden = !el('add-form').hidden;
    }
  }


  function renderBanner(res) {
    const banner = el('banner');
    const text = el('banner-text');
    const action = el('banner-action');

    if (!res.configured) {
      banner.hidden = false;
      text.textContent = '尚未配置 WebDAV，账号只保存在本机缓存里。';
      action.hidden = false;
      action.textContent = '前往设置';
      action.onclick = openOptions;
      return;
    }
    if (res.notice) {
      banner.hidden = false;
      text.textContent = res.notice;
      action.hidden = false;
      action.textContent = '打开设置';
      action.onclick = openOptions;
      return;
    }
    if (res.lastError) {
      banner.hidden = false;
      text.textContent = '同步失败：' + res.lastError;
      action.hidden = false;
      action.textContent = '打开设置';
      action.onclick = openOptions;
      return;
    }
    banner.hidden = true;
  }

  /** 「在本机记住」的一句话状态：让用户知道现在是免密状态、还剩几天 */
  function rememberText(remember) {
    const r = remember || {};
    if (!r.on) return '';
    if (r.expired) return '本机记住已过期';
    if (!r.active) return '本机记住待生效';
    if (!r.expiresAt) return '本机已记住（永久）';
    return '本机已记住 · 还剩 ' + U.formatRemaining(r.remainingMs);
  }

  function renderStatus(res) {
    const remembered = rememberText(res.remember);
    const tail = remembered ? ' · ' + remembered : '';
    if (res.locked) {
      setPersistentStatus('已加密 · 未解锁' + tail, false);
      return;
    }
    if (!res.configured) {
      setPersistentStatus('未配置 WebDAV · 仅本机保存' + tail, false);
      return;
    }
    if (res.lastError) {
      setPersistentStatus('同步失败：' + res.lastError + tail, true);
      return;
    }
    const parts = [];
    if (res.dirty) parts.push('有改动待上传');
    parts.push('上次同步 ' + U.formatRelativeTime(res.lastSyncAt));
    if (res.encrypted) parts.push('已加密');
    if (remembered) parts.push(remembered);
    setPersistentStatus(parts.join(' · '), false);
  }

  function renderEntries() {
    const list = el('entries');
    const count = el('count');
    list.textContent = '';

    count.hidden = !state.entries.length || state.locked;
    count.textContent = state.entries.length ? String(state.entries.length) : '';
    list.hidden = !state.entries.length;
    el('empty').hidden = !!state.entries.length || state.locked;

    if (!state.entries.length) {
      const first = el('empty').querySelector('p');
      first.textContent = U.isWebUrl(state.url) ? '这个站点还没有保存的账号。' : '当前页面无法使用自动填充。';
      return;
    }
    for (const entry of state.entries) list.appendChild(renderEntry(entry));
  }

  function renderEntry(entry) {
    const li = document.createElement('li');
    li.className = 'entry';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = U.firstLetter(entry.username || entry.title || '?');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const uname = document.createElement('div');
    uname.className = 'uname';
    uname.textContent = entry.username || '(无用户名)';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent =
      U.prettyHost(entry.host) +
      ' · ' +
      (entry.useCount ? '已用 ' + entry.useCount + ' 次' : '更新于 ' + U.formatRelativeTime(entry.updatedAt));
    meta.append(uname, sub);

    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(
      miniButton('填充', () => fillEntry(entry)),
      miniButton('显示', (btn) => togglePassword(btn, entry)),
      miniButton('复制', async () => {
        const ok = await copyText(entry.password || '');
        setStatus(ok ? '密码已复制' : '复制失败', { error: !ok, transient: true });
      }),
      miniButton('编辑', () => openEdit(entry)),
      miniButton('删除', (btn) => confirmDelete(btn, entry), 'danger')
    );

    const pwLine = document.createElement('div');
    pwLine.className = 'pw-line';
    pwLine.hidden = true;
    pwLine.textContent = '';

    li.append(avatar, meta, acts, pwLine);
    return li;
  }

  function miniButton(label, onClick, extraClass) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini' + (extraClass ? ' ' + extraClass : '');
    btn.textContent = label;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  function togglePassword(btn, entry) {
    const pwLine = btn.closest('.entry').querySelector('.pw-line');
    const show = pwLine.hidden;
    pwLine.hidden = !show;
    pwLine.textContent = show ? entry.password || '(空)' : '';
    btn.textContent = show ? '隐藏' : '显示';
  }

  function confirmDelete(btn, entry) {
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
    btn.dataset.confirm = '';
    btn.textContent = '删除';
    deleteEntry(entry.id);
  }

  /* ------------------------------ 操作 ------------------------------ */

  async function deleteEntry(id) {
    const res = await sendMessage({ type: 'vault:deleteEntry', id });
    if (res && res.ok) {
      await load();
      setStatus('已删除', { transient: true });
    } else {
      setStatus((res && res.error) || '删除失败', { error: true, transient: true });
    }
  }

  async function ensureContentScript(tabId) {
    const ping = await sendToTab(tabId, { type: 'content:ping' });
    if (ping && ping.ok) return true;
    try {
      await api.scripting.executeScript({
        target: { tabId },
        files: ['src/shared/api.js', 'src/shared/util.js', 'src/content/content.js'],
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  async function sendToTab(tabId, message, options) {
    try {
      const result = await api.tabs.sendMessage(tabId, message, options);
      return result === undefined ? null : result;
    } catch (err) {
      return null;
    }
  }

  async function fillEntry(entry) {
    if (!state.tab || !U.isWebUrl(state.url)) {
      setStatus('当前页面不支持自动填充', { error: true, transient: true });
      return;
    }
    const ready = await ensureContentScript(state.tab.id);
    if (!ready) {
      setStatus('无法注入填充脚本，请刷新页面后重试', { error: true, transient: true });
      return;
    }
    // 带上 id，页面里填完后才会记账（useCount / 最近使用排序）
    const payload = {
      type: 'content:fill',
      entry: { id: entry.id, username: entry.username, password: entry.password },
    };
    let result = await sendToTab(state.tab.id, payload, { frameId: 0 });
    if (!result || !result.ok) {
      const fallback = await sendToTab(state.tab.id, payload);
      if (fallback && fallback.ok) result = fallback;
    }
    if (result && result.ok) {
      window.close();
      return;
    }
    setStatus((result && result.error) || '没有找到可填写的登录框', { error: true, transient: true });
  }

  function resetForm() {
    state.editingId = null;
    el('f-url').value = U.isWebUrl(state.url) ? state.url.replace(/[?#].*$/, '') : '';
    el('f-username').value = '';
    el('f-password').value = '';
    el('add-error').hidden = true;
    el('add-form').querySelector('button[type="submit"]').textContent = '保存';
  }

  function openAdd() {
    resetForm();
    el('add-form').hidden = false;
    el('add-toggle').hidden = true;
    el('f-username').focus();
  }

  function openEdit(entry) {
    state.editingId = entry.id;
    el('f-url').value = entry.url || 'https://' + entry.host;
    el('f-username').value = entry.username || '';
    el('f-password').value = entry.password || '';
    el('add-error').hidden = true;
    el('add-form').querySelector('button[type="submit"]').textContent = '保存修改';
    el('add-form').hidden = false;
    el('add-toggle').hidden = true;
    el('f-username').focus();
  }

  function closeForm() {
    el('add-form').hidden = true;
    el('add-toggle').hidden = false;
    state.editingId = null;
  }

  async function saveForm(ev) {
    ev.preventDefault();
    const errorEl = el('add-error');
    errorEl.hidden = true;

    const url = normalizeUrlInput(el('f-url').value);
    const username = el('f-username').value.trim();
    const password = el('f-password').value;
    const host = U.normalizeHost(url);

    if (!U.isWebUrl(url) || !host) {
      errorEl.textContent = '请输入合法的地址，例如 https://example.com';
      errorEl.hidden = false;
      return;
    }
    if (!password) {
      errorEl.textContent = '密码不能为空';
      errorEl.hidden = false;
      return;
    }

    const entry = {
      id: state.editingId || U.uid(),
      url,
      host,
      username,
      password,
      title: U.prettyHost(host),
    };
    const res = await sendMessage({ type: 'vault:saveEntry', entry });
    if (!res || !res.ok) {
      errorEl.textContent = (res && res.error) || '保存失败';
      errorEl.hidden = false;
      return;
    }
    closeForm();
    await load();
    setStatus('已保存', { transient: true });
  }

  function setLockError(text) {
    const node = el('lock-error');
    node.textContent = text || '';
    node.hidden = !text;
  }

  async function unlockVault() {
    const input = el('unlock-password');
    const password = input.value;
    if (!password) {
      setLockError('请输入主密码');
      return;
    }
    const btn = el('unlock-btn');
    btn.disabled = true;
    btn.textContent = '解锁中…';
    setLockError('');
    const res = await sendMessage({ type: 'vault:unlock', password });
    btn.disabled = false;
    btn.textContent = '解锁';
    if (res && res.ok) {
      input.value = '';
      await load();
      setStatus('已解锁 · ' + (res.entries || 0) + ' 个账号', { transient: true });
    } else {
      setLockError((res && res.error) || '解锁失败');
    }
  }

  async function lockVault() {
    const res = await sendMessage({ type: 'vault:lock' });
    if (res && res.ok) {
      await load();
      setStatus('已锁定', { transient: true });
    } else {
      setStatus((res && res.error) || '锁定失败', { error: true, transient: true });
    }
  }

  async function syncNow() {
    if (!state.configured) {
      setStatus('请先在设置里配置 WebDAV', { error: true, transient: true });
      return;
    }
    const btn = el('sync-btn');
    btn.dataset.busy = '1';
    setStatus('正在同步…');
    const res = await sendMessage({ type: 'vault:sync' });
    btn.dataset.busy = '';
    if (!res) {
      setStatus('后台未响应', { error: true });
      return;
    }
    if (res.ok) {
      setStatus('同步完成 · ' + (res.entries || 0) + ' 个账号', { transient: true });
      await load();
    } else {
      setStatus('同步失败：' + (res.error || '未知错误'), { error: true });
    }
  }

  function openOptions() {
    sendMessage({ type: 'ui:openOptions' });
    window.close();
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  el('sync-btn').addEventListener('click', syncNow);
  el('unlock-btn').addEventListener('click', unlockVault);
  el('lock-btn').addEventListener('click', lockVault);
  el('unlock-password').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      unlockVault();
    }
  });
  el('options-btn').addEventListener('click', openOptions);
  el('add-toggle').addEventListener('click', openAdd);
  el('add-cancel').addEventListener('click', closeForm);
  el('add-form').addEventListener('submit', saveForm);

  load().catch((err) => {
    setPersistentStatus('加载失败：' + (err && err.message ? err.message : err), true);
  });
})();
