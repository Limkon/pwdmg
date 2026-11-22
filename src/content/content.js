/*!
 * pwdmg · 内容脚本
 *
 * 1. 识别页面上的登录表单（用户名 + 密码）
 * 2. 在密码框右侧显示 pwdmg 图标，自动弹出/填充匹配的账号
 * 3. 监听提交动作，把新的账号密码交给后台记录
 *
 * 所有 UI 都放在 Shadow DOM 里，避免和网站样式互相污染。
 */
(function () {
  'use strict';

  if (window.__pwdmgContentLoaded) return;
  window.__pwdmgContentLoaded = true;

  const { api, sendMessage } = window.PwdmgApi;
  const U = window.PwdmgUtil;

  if (!api || !api.runtime || !U) return;
  if (!U.isWebUrl(location.href)) return;

  const isTopFrame = (() => {
    try {
      return window.top === window;
    } catch (err) {
      return false;
    }
  })();

  const Z = 2147483000;

  const KEY_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="7.5" cy="7.5" r="4"/><path d="M10.4 10.4L20 20"/><path d="M16.6 16.6l-2.2 2.2"/><path d="M19.4 19.4l-2.2 2.2"/></svg>';

  const STYLE = `
    :host { all: initial; }
    .pm-key, .panel, .ask, .toast { pointer-events: auto; box-sizing: border-box; }
    .pm-key {
      position: fixed; z-index: ${Z}; width: 22px; height: 22px; padding: 0; margin: 0;
      display: none; align-items: center; justify-content: center; border-radius: 6px;
      border: 1px solid rgba(15, 23, 42, .16); background: #fff; color: #2563eb;
      box-shadow: 0 1px 4px rgba(15, 23, 42, .18); cursor: pointer;
      transition: background .12s ease, transform .12s ease;
    }
    .pm-key:hover { background: #eff6ff; transform: scale(1.06); }
    .pm-key svg { width: 13px; height: 13px; display: block; }
    .pm-key[data-hint] { box-shadow: 0 0 0 3px rgba(37, 99, 235, .22), 0 1px 4px rgba(15, 23, 42, .18); }

    .panel {
      position: fixed; z-index: ${Z + 1}; width: 320px; max-width: calc(100vw - 16px);
      border-radius: 12px; border: 1px solid rgba(15, 23, 42, .12); background: #fff; color: #0f172a;
      box-shadow: 0 16px 40px rgba(15, 23, 42, .22); overflow: hidden;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .panel[hidden] { display: none; }
    .panel .ph {
      display: flex; align-items: center; gap: 6px; padding: 9px 10px;
      border-bottom: 1px solid rgba(15, 23, 42, .08); background: #f8fafc;
    }
    .panel .brand { font-weight: 700; font-size: 12px; letter-spacing: .2px; color: #1d4ed8; }
    .panel .site { color: #64748b; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .panel .close {
      border: 0; background: transparent; cursor: pointer; color: #64748b; font-size: 16px;
      line-height: 1; padding: 2px 4px; border-radius: 6px;
    }
    .panel .close:hover { background: rgba(15, 23, 42, .07); color: #0f172a; }
    .panel .list { max-height: 232px; overflow-y: auto; }
    .panel .row {
      display: flex; align-items: center; gap: 9px; padding: 8px 10px; cursor: pointer;
      border-bottom: 1px solid rgba(15, 23, 42, .05);
    }
    .panel .row:last-child { border-bottom: 0; }
    .panel .row:hover, .panel .row:focus-visible { background: #f1f5f9; outline: none; }
    .panel .avatar {
      flex: none; width: 26px; height: 26px; border-radius: 50%; background: #2563eb; color: #fff;
      display: grid; place-items: center; font-size: 12px; font-weight: 700;
    }
    .panel .meta { flex: 1; min-width: 0; }
    .panel .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .panel .sub { color: #64748b; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .panel .acts { display: flex; gap: 4px; flex: none; }
    .panel .mini {
      border: 1px solid rgba(15, 23, 42, .12); background: #fff; color: #1d4ed8; cursor: pointer;
      border-radius: 7px; font-size: 11px; padding: 3px 6px; line-height: 1.2; font-family: inherit;
    }
    .panel .mini:hover { background: #eff6ff; border-color: #93c5fd; }
    .panel .mini.icon { padding: 3px 5px; }
    .panel .pf {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 7px 10px; border-top: 1px solid rgba(15, 23, 42, .08); background: #f8fafc;
    }
    .panel .link {
      border: 0; background: transparent; color: #1d4ed8; cursor: pointer; font-size: 11px;
      padding: 2px 4px; border-radius: 6px; font-family: inherit;
    }
    .panel .link:hover { background: rgba(37, 99, 235, .1); }
    .panel .hint { color: #94a3b8; font-size: 10px; }

    .ask {
      position: fixed; z-index: ${Z + 3}; right: 16px; bottom: 16px; width: 300px; max-width: calc(100vw - 24px);
      padding: 12px; border-radius: 12px; background: #fff; color: #0f172a;
      border: 1px solid rgba(15, 23, 42, .12); box-shadow: 0 16px 40px rgba(15, 23, 42, .26);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .ask[hidden] { display: none; }
    .ask .ask-title { font-weight: 700; margin-bottom: 4px; }
    .ask .ask-title span { color: #1d4ed8; }
    .ask .ask-text { color: #64748b; font-size: 12px; margin-bottom: 10px; word-break: break-word; }
    .ask .ask-btns { display: flex; gap: 8px; justify-content: flex-end; }
    .ask button {
      font-family: inherit; font-size: 12px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
      border: 1px solid rgba(15, 23, 42, .12); background: #fff; color: #0f172a;
    }
    .ask button.agree { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
    .ask button.agree:hover { background: #1d4ed8; }
    .ask button.deny:hover { background: #f1f5f9; }

    .toast {
      position: fixed; z-index: ${Z + 2}; right: 16px; bottom: 16px; max-width: 320px;
      display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px;
      background: #0f172a; color: #f8fafc; box-shadow: 0 12px 32px rgba(15, 23, 42, .32);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .toast[hidden] { display: none; }
    .toast .tmeta { flex: 1; min-width: 0; }
    .toast .ttext { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toast .tsub { color: #94a3b8; font-size: 11px; }
    .toast .taction {
      border: 0; background: rgba(248, 250, 252, .14); color: #f8fafc; cursor: pointer;
      border-radius: 7px; padding: 4px 8px; font-size: 12px; font-family: inherit;
    }
    .toast .taction:hover { background: rgba(248, 250, 252, .26); }

    @media (prefers-color-scheme: dark) {
      .pm-key { background: #1e293b; border-color: rgba(148, 163, 184, .35); color: #93c5fd; }
      .pm-key:hover { background: #334155; }
      .panel { background: #0f172a; color: #e2e8f0; border-color: rgba(148, 163, 184, .28); }
      .panel .ph { background: #111c30; border-bottom-color: rgba(148, 163, 184, .18); }
      .panel .brand { color: #93c5fd; }
      .panel .row { border-bottom-color: rgba(148, 163, 184, .12); }
      .panel .row:hover, .panel .row:focus-visible { background: #1e293b; }
      .panel .sub, .panel .site { color: #94a3b8; }
      .panel .mini { background: #1e293b; border-color: rgba(148, 163, 184, .28); color: #93c5fd; }
      .panel .mini:hover { background: #334155; }
      .panel .pf { background: #111c30; border-top-color: rgba(148, 163, 184, .18); }
      .panel .link { color: #93c5fd; }
      .ask { background: #0f172a; color: #e2e8f0; border-color: rgba(148, 163, 184, .28); }
      .ask .ask-title span { color: #93c5fd; }
      .ask .ask-text { color: #94a3b8; }
      .ask button { background: #1e293b; color: #e2e8f0; border-color: rgba(148, 163, 184, .28); }
      .ask button.deny:hover { background: #334155; }
    }
  `;

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  const state = {
    settings: {
      autoSave: true,
      autoPrompt: true,
      autoOpenPanel: true,
      autoFillSingle: true,
      confirmPasswordChange: true,
    },
    entries: [],
    host: '',
    configured: false,
    forms: [],
    active: null,
    panelOpen: false,
    panelHost: '',
    autoOpened: false,
    dismissed: false,
    refreshCount: 0,
    lastCaptureKey: '',
    lastCaptureAt: 0,
    lastFillAt: 0,
    toastTimer: null,
    locked: false,
    lockedHintShown: false,
    pendingUpdate: null,
    declinedChanges: [],
  };

  let overlay = null; // { host, root, panel, panelList, panelSite, panelHint, toastEl }

  /* ------------------------------------------------------------------ *
   * DOM 注入
   * ------------------------------------------------------------------ */

  function ensureOverlay() {
    // 页面（SPA 路由切换 / 整体重渲染）可能把覆盖层元件移出 DOM，检测后重建，
    // 并把依赖旧覆盖层的面板状态重置，避免 key button / panel 失效
    if (overlay && overlay.host && overlay.host.isConnected) return overlay;
    if (overlay) {
      state.panelOpen = false;
      state.active = null;
    }
    overlay = null;
    const host = document.createElement('div');
    host.setAttribute('data-pwdmg', 'overlay');
    host.style.cssText =
      'all: initial !important; display: block !important; width: 0 !important; height: 0 !important; pointer-events: none !important;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '秦二密码 账号选择');

    const ph = document.createElement('div');
    ph.className = 'ph';
    const brand = document.createElement('span');
    brand.className = 'brand';
    brand.textContent = '秦二密码';
    const site = document.createElement('span');
    site.className = 'site';
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.title = '关闭';
    close.textContent = '×';
    close.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      state.dismissed = true;
      closePanel();
    });
    ph.append(brand, site, close);

    const list = document.createElement('div');
    list.className = 'list';
    list.setAttribute('role', 'listbox');

    const pf = document.createElement('div');
    pf.className = 'pf';
    const manage = document.createElement('button');
    manage.className = 'link';
    manage.type = 'button';
    manage.textContent = '管理密码库 / 同步设置';
    manage.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      sendMessage({ type: 'ui:openOptions' });
      closePanel();
    });
    const hint = document.createElement('span');
    hint.className = 'hint';
    pf.append(manage, hint);

    panel.append(ph, list, pf);
    root.appendChild(panel);

    const ask = document.createElement('div');
    ask.className = 'ask';
    ask.hidden = true;
    ask.setAttribute('role', 'alertdialog');
    const askTitle = document.createElement('div');
    askTitle.className = 'ask-title';
    const askHost = document.createElement('span');
    askTitle.append(document.createTextNode('更新 '), askHost, document.createTextNode(' 的密码？'));
    const askText = document.createElement('div');
    askText.className = 'ask-text';
    const askBtns = document.createElement('div');
    askBtns.className = 'ask-btns';
    const askDeny = document.createElement('button');
    askDeny.type = 'button';
    askDeny.className = 'deny';
    askDeny.textContent = '保留旧密码';
    askDeny.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      declinePendingUpdate();
    });
    const askAgree = document.createElement('button');
    askAgree.type = 'button';
    askAgree.className = 'agree';
    askAgree.textContent = '更新密码';
    askAgree.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      confirmPendingUpdate();
    });
    askBtns.append(askDeny, askAgree);
    ask.append(askTitle, askText, askBtns);
    root.appendChild(ask);

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.hidden = true;
    toast.setAttribute('role', 'status');
    const tmeta = document.createElement('div');
    tmeta.className = 'tmeta';
    const ttext = document.createElement('div');
    ttext.className = 'ttext';
    const tsub = document.createElement('div');
    tsub.className = 'tsub';
    tmeta.append(ttext, tsub);
    toast.appendChild(tmeta);
    root.appendChild(toast);

    (document.documentElement || document.body).appendChild(host);

    overlay = {
      host,
      root,
      panel,
      panelSite: site,
      panelList: list,
      panelHint: hint,
      toastEl: toast,
      toastText: ttext,
      toastSub: tsub,
      toastAction: null,
      askEl: ask,
      askHost,
      askText,
    };
    return overlay;
  }

  /* ------------------------------------------------------------------ *
   * 表单识别
   * ------------------------------------------------------------------ */

  function isVisible(el) {
    if (!el || el.disabled) return false;
    if (el.type === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 8) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
    return true;
  }

  function autoCompleteOf(el) {
    return String(el.getAttribute('autocomplete') || '').toLowerCase();
  }

  /**
   * 收集 scope 内的全部元素（穿透 open shadow DOM）。
   * mail.com 这类 SPA / web-component 页面把密码框渲染进 Shadow DOM：
   * document.querySelectorAll 看不见，MutationObserver 也不会报 shadow 内部的变更，
   * 所以全局查询全部走这个函数。closed shadow DOM 本质不可访问，不属于此处理范畴。
   */
  function* walkElements(scope) {
    if (!scope || !scope.querySelectorAll) return;
    for (const el of Array.from(scope.querySelectorAll('*'))) {
      yield el;
      if (el.shadowRoot) yield* walkElements(el.shadowRoot);
    }
  }

  function passwordFieldsIn(scope) {
    if (!scope || !scope.querySelectorAll) return [];
    const out = [];
    for (const el of walkElements(scope)) {
      if (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password' && isVisible(el)) {
        out.push(el);
      }
    }
    return out;
  }

  function scoreUsernameCandidate(el) {
    const type = String(el.type || 'text').toLowerCase();
    const rejected = [
      'password',
      'hidden',
      'checkbox',
      'radio',
      'submit',
      'button',
      'reset',
      'search',
      'file',
      'image',
      'color',
      'range',
      'date',
      'datetime-local',
      'month',
      'week',
      'time',
      'number',
    ];
    if (rejected.includes(type)) return -Infinity;

    const ac = autoCompleteOf(el);
    const hint = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), ac, el.className]
      .join(' ')
      .toLowerCase();

    let score = 0;
    if (type === 'email') score += 4;
    if (type === 'text' || type === 'tel' || type === '') score += 1;
    if (ac === 'username') score += 6;
    if (ac === 'email') score += 5;
    if (/username|user[-_ ]?name|login|account|email|mail|手机|邮箱|账号|用户名|用户/.test(hint)) score += 4;
    if (/search|query|keyword|搜索|验证码|captcha|otp|code/.test(hint)) score -= 6;
    return score;
  }

  function findUsernameInput(passEl, scope) {
    const inputs = [];
    for (const el of walkElements(scope)) {
      if (el.tagName !== 'INPUT') continue;
      if (el === passEl) continue;
      if (isVisible(el)) inputs.push(el);
    }
    const before = inputs.filter(
      (el) => el.compareDocumentPosition(passEl) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    const candidates = before.length ? before : inputs;
    let best = null;
    let bestScore = -Infinity;
    for (const el of candidates) {
      const score = scoreUsernameCandidate(el);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore >= 1 ? best : null;
  }

  function containerFor(passEl) {
    return passEl.form || passEl.closest('form') || passEl.parentElement?.parentElement || passEl.parentElement;
  }

  /** 在“修改密码”表单里找出新密码输入框（注册表单没有，返回 null） */
  function findNewPasswordInput(container, passes) {
    const autoNew = passes.filter((el) => autoCompleteOf(el) === 'new-password');
    if (autoNew.length) return autoNew[autoNew.length - 1];
    const hint = String(container.innerText || container.textContent || '').slice(0, 400);
    if (/新密码|新\s*密码|new password|修改密码|更改密码|change password|更新密码|reset password|重置密码/i.test(hint)) {
      return passes.length > 1 ? passes[passes.length - 1] : null;
    }
    return null;
  }

  function analyzeForm(container, passEl) {
    if (!container) return null;
    const passes = passwordFieldsIn(container);
    if (!passes.length || !passes.includes(passEl)) return null;
    const isNew = passes.length > 1 || passes.some((el) => autoCompleteOf(el) === 'new-password');
    return {
      formEl: container,
      passEl,
      userEl: isNew ? null : findUsernameInput(passEl, container),
      isNew,
      newPassEl: isNew ? findNewPasswordInput(container, passes) : null,
      btn: null,
      lastFill: null,
    };
  }

  function scanForms() {
    const result = [];
    const seen = new Set();
    const all = [];
    for (const el of walkElements(document)) {
      if (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password' && isVisible(el)) all.push(el);
    }
    for (const passEl of all) {
      const container = containerFor(passEl);
      if (!container || seen.has(container)) continue;
      seen.add(container);
      const form = analyzeForm(container, passEl);
      if (form) result.push(form);
    }
    return result;
  }

  function formFromEvent(ev) {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const nodes = path.length ? path : [ev.target];
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      for (const form of state.forms) {
        if (node === form.passEl || node === form.userEl) return form;
        if (form.formEl && form.formEl.contains(node)) return form;
      }
      const closestForm = node.closest ? node.closest('form') : null;
      if (closestForm) {
        const match = state.forms.find((form) => form.formEl === closestForm);
        if (match) return match;
      }
    }
    return null;
  }

  function soleLoginForm() {
    const candidates = state.forms.filter((form) => !form.isNew && isVisible(form.passEl));
    return candidates.length === 1 ? candidates[0] : null;
  }

  /* ------------------------------------------------------------------ *
   * 图标按钮
   * ------------------------------------------------------------------ */

  function syncButtons() {
    const forms = scanForms();
    const reusedButtons = new Set();
    // 沿用旧对象上的按钮和“上一次填充”信息，避免重复记录
    for (const next of forms) {
      const prev = state.forms.find((old) => old.formEl === next.formEl && old.passEl === next.passEl);
      if (prev) {
        next.btn = prev.btn;
        next.lastFill = prev.lastFill;
        if (prev.btn) reusedButtons.add(prev.btn);
      }
    }

    for (const old of state.forms) {
      if (old.btn && !reusedButtons.has(old.btn)) old.btn.remove();
    }
    state.forms = forms;

    if (!state.entries.length) {
      for (const form of state.forms) {
        if (form.btn) {
          form.btn.remove();
          form.btn = null;
        }
      }
      if (state.panelOpen) closePanel();
      return;
    }

    const ui = ensureOverlay();
    for (const form of state.forms) {
      // 覆盖层重建后旧按钮在 detached 的 shadow root 里，视为未挂载
      if (form.btn && !form.btn.isConnected) {
        form.btn = null;
      }
    }
    for (const form of state.forms) {
      if (form.btn || form.isNew) continue; // 注册 / 修改密码表单不挂图标
      const btn = document.createElement('button');
      btn.className = 'pm-key';
      btn.type = 'button';
      btn.title = '秦二密码：填充已保存的账号';
      btn.setAttribute('aria-label', '秦二密码 填充账号');
      btn.innerHTML = KEY_SVG;
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        state.dismissed = false;
        openPanel(form);
      });
      ui.root.appendChild(btn);
      form.btn = btn;
    }
    schedulePosition();
  }

  function positionAll() {
    for (const form of state.forms) {
      if (!form.btn) continue;
      if (!isVisible(form.passEl)) {
        form.btn.style.display = 'none';
        continue;
      }
      const rect = form.passEl.getBoundingClientRect();
      form.btn.style.display = 'flex';
      form.btn.style.left = Math.round(U.clamp(rect.right - 26, 4, Math.max(4, window.innerWidth - 26))) + 'px';
      form.btn.style.top = Math.round(rect.top + (rect.height - 22) / 2) + 'px';
    }
    positionPanel();
  }

  let rafId = 0;
  function schedulePosition() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      positionAll();
    });
  }

  /* ------------------------------------------------------------------ *
   * 面板
   * ------------------------------------------------------------------ */

  function panelWidth() {
    return Math.min(320, Math.max(200, window.innerWidth - 16));
  }

  function positionPanel() {
    if (!overlay || !state.panelOpen || !state.active) return;
    const panel = overlay.panel;
    const rect = state.active.passEl.getBoundingClientRect();
    const width = panelWidth();
    const height = panel.offsetHeight || 190;
    const left = U.clamp(rect.left + rect.width / 2 - width / 2, 8, Math.max(8, window.innerWidth - width - 8));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) {
      const above = rect.top - height - 8;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - height - 8);
    }
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  function buildRow(entry) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'option');
    row.tabIndex = 0;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = U.firstLetter(entry.username || entry.title || '?');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = entry.username || '(未保存用户名)';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = entry.title && entry.title !== entry.host ? entry.title + ' · ' + U.prettyHost(entry.host) : U.prettyHost(entry.host);
    meta.append(title, sub);

    const acts = document.createElement('div');
    acts.className = 'acts';

    const fillBtn = document.createElement('button');
    fillBtn.className = 'mini';
    fillBtn.type = 'button';
    fillBtn.textContent = '填充';
    fillBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      doFill(entry, false);
    });

    const loginBtn = document.createElement('button');
    loginBtn.className = 'mini icon';
    loginBtn.type = 'button';
    loginBtn.title = '填充并提交';
    loginBtn.textContent = '↵';
    loginBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      doFill(entry, true);
    });

    acts.append(fillBtn, loginBtn);
    row.append(avatar, meta, acts);

    row.addEventListener('click', () => doFill(entry, false));
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        doFill(entry, false);
      }
    });
    return row;
  }

  function renderPanel() {
    if (!overlay) return;
    const ui = overlay;
    ui.panelList.textContent = '';
    for (const entry of state.entries) ui.panelList.appendChild(buildRow(entry));
    ui.panelSite.textContent = U.prettyHost(state.host || location.hostname);
    ui.panelHint.textContent = state.entries.length + ' 个账号';
  }

  function openPanel(form) {
    if (!form || !state.entries.length) return;
    const ui = ensureOverlay();
    state.active = form;
    state.panelOpen = true;
    if (form.btn) form.btn.removeAttribute('data-hint');
    renderPanel();
    ui.panel.hidden = false;
    // 先定位一次拿到高度，再精确调整
    positionPanel();
    requestAnimationFrame(positionPanel);
    schedulePosition();
  }

  function closePanel() {
    if (!overlay || !state.panelOpen) return;
    overlay.panel.hidden = true;
    state.panelOpen = false;
    state.active = null;
  }

  /* ------------------------------------------------------------------ *
   * 填充
   * ------------------------------------------------------------------ */

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function submitForm(form) {
    const formEl = form.formEl;
    if (formEl && formEl.tagName === 'FORM') {
      const submitBtn = formEl.querySelector(
        'button[type="submit"], input[type="submit"], button:not([type])'
      );
      try {
        if (typeof formEl.requestSubmit === 'function') {
          formEl.requestSubmit(submitBtn || undefined);
          return;
        }
      } catch (err) {
        /* 继续尝试其它方式 */
      }
      try {
        formEl.submit();
        return;
      } catch (err) {
        /* 继续尝试其它方式 */
      }
    }
    const scope = form.formEl || document;
    const buttons = Array.from(scope.querySelectorAll('button, input[type="submit"], [role="button"]'));
    const button = buttons.find(
      (el) => isVisible(el) && /登录|登入|登陆|log\s?in|sign\s?in|submit|继续|next|下一步/i.test(el.textContent || el.value || '')
    );
    if (button) button.click();
  }

  function doFill(entry, submit) {
    const form = state.active || state.forms.find((f) => !f.isNew) || state.forms[0];
    if (!form) return;
    fillForm(form, entry, submit);
  }

  function fillForm(form, entry, submit) {
    if (!form) return;
    const password = String(entry.password == null ? '' : entry.password);
    const username = String(entry.username == null ? '' : entry.username);

    if (form.userEl && username) {
      setNativeValue(form.userEl, username);
    }
    setNativeValue(form.passEl, password);
    form.lastFill = { username, password, at: Date.now(), entryId: entry.id };
    state.dismissed = true;
    state.lastFillAt = Date.now();
    closePanel();

    try {
      form.passEl.focus({ preventScroll: true });
    } catch (err) {
      /* ignore */
    }
    try {
      form.passEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    } catch (err) {
      /* ignore */
    }
    if (entry.id) sendMessage({ type: 'credential:used', id: entry.id });
    if (submit) setTimeout(() => submitForm(form), 60);
  }

  /* ------------------------------------------------------------------ *
   * 自动提示 / 自动填充
   * ------------------------------------------------------------------ */

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  function maybeAutoPrompt() {
    if (!state.settings.autoPrompt || !state.entries.length) return;
    if (state.autoOpened || state.dismissed) return;
    const form = state.forms.find((f) => !f.isNew && isVisible(f.passEl));
    if (!form) return;
    state.autoOpened = true;

    const canAutofill =
      state.settings.autoFillSingle && state.entries.length === 1 && !form.passEl.value && !(form.userEl && form.userEl.value);
    if (canAutofill) {
      if (form.btn) form.btn.setAttribute('data-hint', '1');
      fillForm(form, state.entries[0], false);
      state.dismissed = false;
      return;
    }

    if (state.settings.autoOpenPanel && isTopFrame && !form.passEl.value && isInViewport(form.passEl)) {
      setTimeout(() => {
        if (state.dismissed || state.panelOpen) return;
        if (form.passEl.value) return;
        openPanel(form);
      }, 400);
    }
  }

  /* ------------------------------------------------------------------ *
   * 记录提交的账号
   * ------------------------------------------------------------------ */

  /** 同一站点同一用户名的密码与密码库不同：询问是否更新 */
  function isDeclinedChange(key) {
    return state.declinedChanges.indexOf(key) >= 0;
  }

  function rememberDeclinedChange(key) {
    state.declinedChanges.push(key);
    if (state.declinedChanges.length > 20) state.declinedChanges.shift();
  }

  function changeKeyFor(host, username, password) {
    return String(host || '') + '\u0000' + String(username || '') + '\u0000' + String(password || '');
  }

  function handleCaptureResult(res, context) {
    if (!res) return;
    if (res.saved) {
      showToast({
        text:
          '已记录 ' +
          U.prettyHost(res.host || U.hostOf(location.href)) +
          (res.entry && res.entry.username ? ' · ' + res.entry.username : ''),
        sub: '正在同步到 WebDAV',
        actionLabel: res.entry && res.entry.id ? '撤销' : '',
        onAction:
          res.entry && res.entry.id
            ? () => {
                sendMessage({ type: 'credential:delete', id: res.entry.id });
                hideToast();
              }
            : null,
        timeout: 6000,
      });
      return;
    }
    if (res.reason === 'locked') {
      maybeShowLockedHint(true);
      return;
    }
    if (res.reason === 'password-changed' && res.entry) {
      const host = res.entry.host || U.hostOf(location.href);
      const username = res.entry.username || '';
      const key = changeKeyFor(host, username, context.password);
      if (!state.settings.confirmPasswordChange || isDeclinedChange(key)) return;
      showPasswordChangePrompt({
        host,
        username,
        password: context.password,
        url: context.url || location.href,
        title: context.title || String(document.title || '').slice(0, 120),
      });
    }
  }

  function maybeCapture(form, reason) {
    if (!state.settings.autoSave || !form || form.isNew) return;
    if (!U.isWebUrl(location.href)) return;
    if (!isVisible(form.passEl)) return;

    const password = String(form.passEl.value || '');
    if (!password || password.length > 4096) return;
    const username = form.userEl ? String(form.userEl.value || '').trim() : '';

    if (form.lastFill) {
      const unchanged = form.lastFill.password === password && form.lastFill.username === username;
      if (unchanged && Date.now() - form.lastFill.at < 300000) return;
    }

    const key = location.hostname + '\u0000' + username + '\u0000' + password;
    const now = Date.now();
    if (state.lastCaptureKey === key && now - state.lastCaptureAt < 5000) return;
    state.lastCaptureKey = key;
    state.lastCaptureAt = now;

    const payload = {
      type: 'credential:capture',
      url: location.href,
      username,
      password,
      title: String(document.title || '').slice(0, 120),
      reason: reason || '',
      // 关闭“密码变化提示”时直接覆盖旧密码
      force: !state.settings.confirmPasswordChange,
    };

    sendMessage(payload).then((res) => handleCaptureResult(res, { password, username, url: location.href }));
  }

  /**
   * 修改密码表单提交：只更新已存在的账号（updateOnly），不会凭空新建条目。
   */
  function maybeCaptureUpdate(form) {
    if (!state.settings.autoSave || !form || !form.newPassEl) return;
    if (!U.isWebUrl(location.href)) return;
    const password = String(form.newPassEl.value || '');
    if (!password || password.length > 4096) return;
    const username = form.userEl ? String(form.userEl.value || '').trim() : '';

    sendMessage({
      type: 'credential:capture',
      url: location.href,
      username,
      password,
      title: String(document.title || '').slice(0, 120),
      reason: 'change-form',
      updateOnly: true,
      force: !state.settings.confirmPasswordChange,
    }).then((res) => handleCaptureResult(res, { password, username, url: location.href }));
  }

  /** 交给合适的处理器：登录表单记录、改密表单提示更新 */
  function dispatchCapture(form, reason) {
    if (!form) return;
    if (form.isNew) {
      if (form.newPassEl) maybeCaptureUpdate(form);
      return;
    }
    maybeCapture(form, reason);
  }

  /* ---------------------------- 密码更新确认 ---------------------------- */

  function showPasswordChangePrompt(pending) {
    const ui = ensureOverlay();
    state.pendingUpdate = pending;
    ui.askHost.textContent = U.prettyHost(pending.host || U.hostOf(location.href));
    ui.askText.textContent =
      (pending.username ? pending.username + ' · ' : '') +
      '检测到的密码与密码库中的不同，是否更新为这次输入的密码？';
    ui.askEl.hidden = false;
  }

  function hideAsk() {
    if (!overlay) return;
    overlay.askEl.hidden = true;
    state.pendingUpdate = null;
  }

  function declinePendingUpdate() {
    const pending = state.pendingUpdate;
    if (pending) {
      rememberDeclinedChange(changeKeyFor(pending.host, pending.username, pending.password));
    }
    hideAsk();
    sendMessage({ type: 'credential:resolvePending', accept: false });
  }

  async function confirmPendingUpdate() {
    const pending = state.pendingUpdate;
    if (!pending) return;
    hideAsk();
    // 真正的新密码存在后台的会话里（页面跳转也不会丢）
    const res = await sendMessage({ type: 'credential:resolvePending', accept: true });
    if (res && res.ok && res.saved) {
      showToast({
        text: '已更新 ' + U.prettyHost(pending.host) + (pending.username ? ' · ' + pending.username : '') + ' 的密码',
        sub: '正在同步到 WebDAV',
        timeout: 5000,
      });
    } else {
      showToast({ text: '更新失败', sub: (res && (res.error || res.reason)) || '请稍后重试', timeout: 5000 });
    }
  }

  /**
   * 页面跳转 / 刷新后恢复「待确认的密码变更」：
   * 后台把新密码存在会话里，这里按当前站点问一次。
   */
  let pendingCheckedFor = '';

  async function checkPendingChange() {
    const host = U.normalizeHost(location.hostname);
    if (!host || pendingCheckedFor === host) return;
    pendingCheckedFor = host;
    if (!state.settings.confirmPasswordChange) return;
    const res = await sendMessage({ type: 'credential:pending', host });
    const pending = res && res.pending;
    if (!pending || !pending.password) return;
    if (state.pendingUpdate) return;
    if (isDeclinedChange(changeKeyFor(pending.host, pending.username, pending.password))) return;
    showPasswordChangePrompt({
      host: pending.host || host,
      username: pending.username || '',
      password: pending.password,
      url: pending.url || location.href,
      title: pending.title || '',
      restored: true,
    });
  }

  function registerCaptureHooks() {
    document.addEventListener(
      'submit',
      (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLFormElement)) return;
        const form =
          state.forms.find((f) => f.formEl === target) ||
          (() => {
            const passEl = passwordFieldsIn(target)[0];
            return passEl ? analyzeForm(target, passEl) : null;
          })();
        if (form) dispatchCapture(form, 'submit');
      },
      true
    );

    document.addEventListener(
      'click',
      (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        const control = target.closest('button, input[type="submit"], input[type="image"], [role="button"], a');
        if (!control) return;

        const form = formFromEvent(ev);
        if (form) {
          if (looksLikeSubmitControl(control)) setTimeout(() => dispatchCapture(form, 'click'), 30);
          return;
        }
        // SPA 表单（没有 <form> 或按钮在容器之外）
        if (looksLikeSubmitControl(control)) {
          const sole = soleLoginForm();
          if (sole) setTimeout(() => dispatchCapture(sole, 'click-fallback'), 40);
        }
      },
      true
    );

    document.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== 'Enter') return;
        const el = ev.target;
        if (!(el instanceof HTMLInputElement)) return;
        const form =
          state.forms.find((f) => f.passEl === el) ||
          state.forms.find((f) => f.newPassEl === el) ||
          state.forms.find((f) => f.userEl === el) ||
          soleLoginForm();
        if (form) setTimeout(() => dispatchCapture(form, 'enter'), 40);
      },
      true
    );

    document.addEventListener('focusin', (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLInputElement)) return;
      const form = state.forms.find((f) => f.passEl === el);
      if (!form) return;
      if (!state.settings.autoPrompt || !state.entries.length || state.panelOpen) return;
      if (Date.now() - state.lastFillAt < 1200) return; // 刚填充完不要立刻再弹
      state.dismissed = false;
      openPanel(form);
    });
  }

  /** 点击的元素是否像“提交登录”的按钮 */
  function looksLikeSubmitControl(control) {
    const tag = control.tagName;
    if (tag === 'INPUT' && (control.type === 'submit' || control.type === 'image')) return true;
    if (tag === 'BUTTON' && control.type === 'submit') return true;
    const label = String(control.textContent || control.value || control.getAttribute('aria-label') || '').trim();
    if (/登录|登入|登陆|log\s?in|sign\s?in|submit|继续|next|下一步|确认|continue/i.test(label)) return true;
    const testid = String(control.getAttribute('data-testid') || '');
    if (/login|signin|sign-in|submit/i.test(testid)) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 锁定提示
   * ------------------------------------------------------------------ */

  function maybeShowLockedHint(force) {
    if (!isTopFrame) return;
    if (state.lockedHintShown && !force) return;
    if (!state.forms.some((form) => !form.isNew)) return;
    state.lockedHintShown = true;
    showToast({
      text: '秦二密码管理 已锁定',
      sub: '解锁后即可自动填充账号密码',
      actionLabel: '去解锁',
      onAction: () => sendMessage({ type: 'ui:openOptions' }),
      timeout: 9000,
    });
  }

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */

  function showToast(options) {
    const ui = ensureOverlay();
    const el = ui.toastEl;
    ui.toastText.textContent = options.text || '';
    ui.toastSub.textContent = options.sub || '';
    ui.toastSub.style.display = options.sub ? '' : 'none';
    el.hidden = false;

    if (ui.toastAction) {
      ui.toastAction.remove();
      ui.toastAction = null;
    }
    if (options.actionLabel && options.onAction) {
      const btn = document.createElement('button');
      btn.className = 'taction';
      btn.type = 'button';
      btn.textContent = options.actionLabel;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        options.onAction();
      });
      el.appendChild(btn);
      ui.toastAction = btn;
    }
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(hideToast, options.timeout || 6000);
  }

  function hideToast() {
    if (!overlay) return;
    overlay.toastEl.hidden = true;
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 数据刷新与导航监听
   * ------------------------------------------------------------------ */

  async function refresh() {
    if (!U.isWebUrl(location.href)) return;
    const res = await sendMessage({ type: 'content:getState', url: location.href });
    if (!res || !res.ok) return;

    state.settings = Object.assign({}, state.settings, res.settings || {});
    state.entries = Array.isArray(res.entries) ? res.entries : [];
    state.host = res.host || location.hostname;
    state.configured = !!res.configured;
    state.locked = !!res.locked;

    if (res.pending && state.refreshCount < 2) {
      state.refreshCount += 1;
      setTimeout(() => refresh(), 2500);
    }

    syncButtons();
    if (state.locked) {
      hideAsk();
      maybeShowLockedHint(false);
      return;
    }
    maybeAutoPrompt();
    checkPendingChange();
  }

  function onNavigate() {
    state.autoOpened = false;
    state.dismissed = false;
    state.refreshCount = 0;
    state.lockedHintShown = false;
    state.forms = [];
    pendingCheckedFor = '';
    hideAsk();
    if (state.panelOpen) closePanel();
    if (overlay) overlay.panelList.textContent = '';
    refresh();
  }

  function watchNavigation() {
    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      onNavigate();
    }, 800);

    const rescan = U.debounce(() => {
      syncButtons();
      if (!state.autoOpened) maybeAutoPrompt();
    }, 500);

    try {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.addedNodes && mutation.addedNodes.length) {
            rescan();
            return;
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (err) {
      /* ignore */
    }
    // 定时兜底：内容站点可能用同一个挂载点多次填充登录框（MutationObserver 不会报 shadow 内容的变更），
    // 这里按固定周期刷新，覆盖“弹层里的表单被改写/重建”这类场景
    setInterval(() => rescan(), 1000);

    window.addEventListener('scroll', schedulePosition, true);
    window.addEventListener('resize', schedulePosition, true);
    document.addEventListener('scroll', schedulePosition, true);

    // 面板打开时保持贴住输入框（有些站点会动态移动输入框）
    setInterval(() => {
      if (state.panelOpen) positionPanel();
    }, 1200);
  }

  /* ------------------------------------------------------------------ *
   * 来自 popup 的消息
   * ------------------------------------------------------------------ */

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message && message.type;

    if (type === 'content:ping') {
      sendResponse({ ok: true, host: location.hostname });
      return false;
    }

    if (type === 'content:fill') {
      (async () => {
        try {
          if (!state.forms.length) await refresh();
          let form = state.forms.find((f) => !f.isNew && isVisible(f.passEl));
          if (!form) form = state.forms.find((f) => isVisible(f.passEl));
          if (!form) {
            sendResponse({ ok: false, error: '当前页面没有可填写的密码框' });
            return;
          }
          fillForm(form, message.entry || {}, !!message.submit);
          sendResponse({ ok: true, host: location.hostname });
        } catch (err) {
          sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
        }
      })();
      return true;
    }

    if (type === 'content:rescan') {
      refresh().then(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  });

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  registerCaptureHooks();
  watchNavigation();
  refresh();

  // 记录后立即刷新条目（例如撤销后）
  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.vaultCache) {
        clearTimeout(window.__pwdmgRefreshTimer);
        window.__pwdmgRefreshTimer = setTimeout(() => refresh(), 400);
      }
    });
  }
})();
