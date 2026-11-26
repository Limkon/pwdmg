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
      sharedMode: false,
      autoLockMinutes: 5,
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
    lastPanelToggleAt: 0,
    toastTimer: null,
    locked: false,
    lockedHintShown: false,
    pendingUpdate: null,
    declinedChanges: [],
  };

  let overlay = null; // { host, root, panel, panelList, panelSite, panelHint, toastEl }

  /* ------------------------------------------------------------------ *
   * 按下事件隔离（解决「点填充后登录框直接消失」）
   *
   * 覆盖层挂在 <html> 下，对页面来说它就是「登录弹层之外的元素」。
   * 大量站点（Radix / MUI / Bootstrap 的 Modal，以及各种自研登录弹层）会在
   * document 上监听 pointerdown / mousedown / click，判断 target 不在弹层里就关掉弹层；
   * 有的还监听 focusout，一失焦就关。
   *
   * 结果是：点「填充」→ 页面先把登录弹层关掉 → 密码框从 DOM 里消失 → 填充落空。
   * 表现就是「点填充后密码框消失，但没有填入密码」。
   *
   * 这里在 window 的捕获阶段（比页面注册在 document 上的监听器都早）把落进覆盖层的
   * 事件拦下来：页面完全收不到这次点击，弹层就不会被关；动作在按下瞬间执行，
   * 此时目标输入框一定还在，而且防止默认行为后焦点也不会离开密码框。
   * ------------------------------------------------------------------ */

  const pressAction = new WeakMap(); // Element -> fn(ev)
  const pressAt = new WeakMap(); // Element -> 由按下触发的时间戳
  const PRESS_DEDUPE = 800;
  const PRESS_TYPES = ['pointerdown', 'mousedown', 'touchstart', 'click'];

  function bindPress(el, action) {
    pressAction.set(el, action);
    return el;
  }

  function eventPath(ev) {
    if (typeof ev.composedPath === 'function') {
      const path = ev.composedPath();
      if (path && path.length) return path;
    }
    return [];
  }

  /** 事件是否落在扩展覆盖层里（穿透 shadow DOM 判断） */
  function eventFromOverlay(ev) {
    if (!overlay || !overlay.host) return false;
    const path = eventPath(ev);
    if (path.length) return path.indexOf(overlay.host) >= 0;
    return ev.target === overlay.host;
  }

  /** 取路径里最内层的可交互元素（先命中的是「填充」按钮，而不是外层行） */
  function pressableFrom(ev) {
    for (const node of eventPath(ev)) {
      if (node && pressAction.has(node)) return node;
    }
    return null;
  }

  function activatePress(target, ev) {
    const action = pressAction.get(target);
    if (!action) return;
    pressAt.set(target, Date.now());
    try {
      action(ev);
    } catch (err) {
      /* 单个动作出错不应该影响其它交互 */
    }
  }

  function installPressGuard() {
    const guard = (ev) => {
      if (!eventFromOverlay(ev)) return;

      // 关键一步：页面注册在 window/document 上的「点外面就关」监听器
      // 一个都收不到这次事件，登录弹层因此不会被关闭
      ev.stopPropagation();

      const target = pressableFrom(ev);
      const last = target ? pressAt.get(target) || 0 : 0;
      const justPressed = Date.now() - last < PRESS_DEDUPE;

      // 面板 / 确认卡片内部：input 还是让它们正常同步；其它一律按点击控件处理
      if (!target) {
        const inner = eventPath(ev)[0];
        const tag = inner && inner.tagName;
        const editable = tag === 'INPUT' || tag === 'TEXTAREA';
        if (!editable && ev.type !== 'touchstart') ev.preventDefault();
        return;
      }

      if (ev.type === 'click') {
        ev.preventDefault();
        if (justPressed) return; // 按下阶段已经执行过，别填两次
        activatePress(target, ev); // 键盘 Enter / 空格产生的 click
        return;
      }

      if (ev.type === 'touchstart') {
        // 不 preventDefault：手指按下还不能判断是点击还是滚动列表，
        // 真正的动作交给随后的 click（action 未执行，pressAt 仍为旧值）
        return;
      }

      if (ev.type === 'pointerdown' && ev.pointerType === 'touch') return;

      // 鼠标按下：先执行动作（此时输入框一定还在），并阻止焦点离开密码框
      ev.preventDefault();
      if (!justPressed) activatePress(target, ev);
    };

    for (const type of PRESS_TYPES) {
      window.addEventListener(type, guard, true);
    }
    // 页面监听的是 document 时，window 捕获阶段就能先拦下来（见上面的守卫）
    if (window !== window.top) return;
    window.addEventListener(
      'focusin',
      (ev) => {
        if (eventFromOverlay(ev)) ev.stopPropagation();
      },
      true
    );
  }

  /* ------------------------------------------------------------------ *
   * 样式注入
   * ------------------------------------------------------------------ */

  /**
   * 严格 CSP 的站点（GitHub、部分银行 / 企业后台）会拦截内容脚本插入的 <style>
   * 标签（constructable stylesheet 的 replaceSync 也一样会被拦），于是面板/图标
   * 全是没有样式的裸元素，看起来就像「插件坏了」。
   *
   * 这里优先用不会触发 CSP 的 adoptedStyleSheets；失败时退回 <style>，
   * 再失败就把关键样式直接写成行内样式，保证遮罩层、定位、层级这些仍然成立。
   */
  function installStyles(root) {
    const setCss = (target, text) => {
      try {
        target.style.cssText = text;
        return true;
      } catch (err) {
        return false;
      }
    };

    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) {
        const sheet = new CSSStyleSheet({ baseURL: location.href });
        sheet.replaceSync(STYLE);
        root.adoptedStyleSheets = root.adoptedStyleSheets.concat([sheet]);
        return;
      }
    } catch (err) {
      /* 落到 <style> */
    }

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    // 判断样式是否真的生效：被 CSP 拦掉的 <style> 在 shadow root 里不会产出规则
    const check = () => {
      try {
        if (style.sheet && style.sheet.cssRules && style.sheet.cssRules.length) return;
      } catch (err) {
        /* 被拦截时读 cssRules 会抛错，继续兜底 */
      }
      setCss(root.host, 'all: initial; display: block; width: 0; height: 0; overflow: visible;');
    };
    check();
  }

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
    installStyles(root);

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
    bindPress(close, (ev) => {
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
    bindPress(manage, (ev) => {
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
    bindPress(askDeny, (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      declinePendingUpdate();
    });
    const askAgree = document.createElement('button');
    askAgree.type = 'button';
    askAgree.className = 'agree';
    askAgree.textContent = '更新密码';
    bindPress(askAgree, (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      confirmPendingUpdate();
    });
    askBtns.append(askDeny, askAgree);
    ask.append(askTitle, askText, askBtns);
    // 卡片弹出时不要把焦点从密码框抢走：有的站点监听 focusout 就关登录弹层
    ask.addEventListener('mousedown', (ev) => ev.preventDefault());
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

  /* ------------------------------------------------------------------ *
   * 智能识别（站点自适应）
   *
   * 每个网站的登录框长得都不一样，通用猜法总会漏。这里做三件事：
   *  1. 记住每个站点上次成功填充的输入框选择器，下次直接命中（命中不了再退回猜法）；
   *  2. 记住页面状态关键词（“登录 / Login / 密码登录…”），页面上有多个表单时
   *     优先选与当前界面文案一致的那个（避免把「注册」当成登录）；
   *  3. 页面上已经填了账号时，自动挑与之匹配的那条记录。
   * 选择器与关键词只存在本机，不含任何账号密码。
   * ------------------------------------------------------------------ */

  const siteMemory = {
    host: '',
    user: '',
    pass: '',
    markers: [],
    loaded: false,
    learnedAt: 0,
    learned: '', // 上次学到的内容签名，避免重复写存储
  };

  /** 为一个输入框生成尽量稳定的选择器（优先 id / name / autocomplete） */
  function selectorFor(el, kind) {
    if (!el || el.tagName !== 'INPUT') return '';
    const esc = (value) => String(value).replace(/["\\]/g, '\\$&');
    const id = el.getAttribute('id');
    if (id && id.length <= 60 && /^[\w:-]+$/.test(id)) {
      // 带数字后缀的 id 往往是每次渲染都变的，不适合当锚点
      if (!/\d{3,}/.test(id)) return '#' + id;
    }
    const name = el.getAttribute('name');
    if (name && /^[\w:.-]+$/.test(name)) return 'input[name="' + esc(name) + '"]';
    const ac = autoCompleteOf(el);
    if (ac === 'username' || ac === 'email' || ac === 'current-password') {
      return 'input[autocomplete="' + esc(ac) + '"]';
    }
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return 'input[type="password"]';
    if (kind === 'user' && (type === 'email' || type === 'text')) {
      return 'input[type="' + esc(type) + '"]';
    }
    return '';
  }

  /** 按选择器找回输入框（穿透 shadow DOM，失败返回 null） */
  function findBySelector(selector) {
    if (!selector) return null;
    try {
      for (const el of walkElements(document)) {
        if (el.tagName !== 'INPUT') continue;
        if (el.matches(selector) && isVisible(el)) return el;
      }
    } catch (err) {
      /* 选择器写坏了就当没记住 */
    }
    return null;
  }

  /** 页面文案里的状态关键词（登录 / 注册 / 下一步…） */
  function pageMarkers() {
    const body = document.body;
    let text = String((body && body.innerText) || '').slice(0, 4000);
    if (!text && body) {
      // jsdom 等环境没有 innerText，用 textContent 兜底
      text = String(body.textContent || '').slice(0, 4000);
    }
    text = text.toLowerCase();
    const markers = [];
    if (/登录|登入|登陆|sign\s?in|log\s?in/.test(text)) markers.push('login');
    if (/注册|sign\s?up|create account/.test(text)) markers.push('signup');
    if (/忘记密码|forgot/.test(text)) markers.push('forgot');
    if (/密码登录|password login|账号密码/.test(text)) markers.push('password-login');
    return markers;
  }

  const MARKER_TEXT = {
    login: /登录|登入|登陆|sign\s?in|log\s?in/i,
    signup: /注册|sign\s?up|create account/i,
    forgot: /忘记密码|forgot/i,
    'password-login': /密码登录|password login|账号密码/i,
  };

  /**
   * 容器与当前页面状态的吻合程度。
   *
   * 只看 <form> 自己的文字往往不够：标题（“登录 / 注册”）通常在表单外面的卡片里。
   * 所以往上多看几层，但离表单越远的文字权重越低，避免整页的「登录」把一切都拉平。
   */
  function markerScore(container, markers) {
    if (!markers || !markers.length || !container) return 0;
    const texts = [];
    let node = container;
    for (let depth = 0; node && depth < 4; depth += 1) {
      texts.push({ text: String(node.textContent || '').slice(0, 1200).toLowerCase(), weight: 1 / (depth + 1) });
      node = node.parentElement;
    }
    let score = 0;
    for (const marker of markers) {
      const re = MARKER_TEXT[marker];
      if (!re) continue;
      let best = 0;
      for (const item of texts) {
        if (re.test(item.text)) best = Math.max(best, item.weight);
      }
      score += best;
    }
    return score;
  }

  function loadSiteMemory() {
    const host = U.normalizeHost(location.hostname);
    if (!host || siteMemory.host === host) return;
    siteMemory.host = host;
    siteMemory.loaded = false;
    siteMemory.user = '';
    siteMemory.pass = '';
    siteMemory.markers = [];
    sendMessage({ type: 'site:memory', host }).then((res) => {
      if (!res || !res.ok || !res.memory) {
        siteMemory.loaded = true;
        return;
      }
      if (siteMemory.host !== host) return; // 期间已经换了站点
      siteMemory.user = res.memory.user || '';
      siteMemory.pass = res.memory.pass || '';
      siteMemory.markers = Array.isArray(res.memory.markers) ? res.memory.markers : [];
      siteMemory.loaded = true;
      // 拿到线索后立刻重新识别一次（首屏可能已经错过）
      syncButtons();
      maybeAutoPrompt();
    });
  }

  /**
   * 把「这次识别到的字段」写回站点记忆。只在真的识别出用户名字段或
   * 页面状态明确时才写，避免把错误选择器学进去。
   */
  function learnSite(form) {
    if (!form || !form.passEl) return;
    const host = U.normalizeHost(location.hostname);
    if (!host) return;
    const user = selectorFor(form.userEl, 'user');
    const pass = selectorFor(form.passEl, 'pass');
    const markers = pageMarkers().slice(0, 4);
    const signature = [user, pass, markers.join(',')].join('|');
    if (!user && !markers.length) return; // 只认得出一个密码框（多半是分步登录的第二步），线索不可靠
    if (signature === siteMemory.learned && Date.now() - siteMemory.learnedAt < 60000) return;
    siteMemory.learned = signature;
    siteMemory.learnedAt = Date.now();
    siteMemory.user = user;
    siteMemory.pass = pass;
    siteMemory.markers = markers;
    sendMessage({ type: 'site:learn', host, memory: { user, pass, markers } });
  }

  /**
   * 是不是一个「密码输入框」。
   *
   * 除了标准的 type="password"，还有一批站点自己实现：
   *  - 把真实密码框设成 type="text"，靠 -webkit-text-security / text-security 掩码
   *    （Chrome / Safari 支持），以便绕开浏览器自己的密码管理器；
   *  - 用 class 标记 role（如 class="password-input"）。
   * 这些框如果认不出来，页面上就永远不会有图标与面板。
   */
  const passwordGuess = new WeakMap(); // el -> { sig, result }（避免每秒对整页文本框刷 getComputedStyle）

  function isPasswordInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const type = String(el.type || '').toLowerCase();
    if (type === 'password') return true;
    if (type && type !== 'text') return false;

    const ac = autoCompleteOf(el);
    const hint = [el.name, el.id, el.className, el.getAttribute('data-type'), el.getAttribute('placeholder')]
      .join(' ')
      .toLowerCase();
    const sig = type + '|' + ac + '|' + hint;
    const cached = passwordGuess.get(el);
    if (cached && cached.sig === sig) return cached.result;

    const hintSays = /password|passwd|pwd|密码/.test(hint) && !/username|account|e-?mail|用户|账号/.test(hint);
    let result = hintSays || ac === 'current-password';
    if (!result) {
      try {
        const style = window.getComputedStyle(el);
        const security = style && (style.webkitTextSecurity || style.getPropertyValue('-webkit-text-security'));
        result = !!security && String(security).trim() !== '' && String(security).trim() !== 'none';
      } catch (err) {
        result = false;
      }
    }
    passwordGuess.set(el, { sig, result });
    return result;
  }

  function isVisible(el) {
    if (!el || el.disabled) return false;
    if (el.type === 'hidden') return false;
    if (el.readOnly) return false; // 只读框不接受写入，页面通常用它做展示/占位
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
      if (isPasswordInput(el) && isVisible(el)) {
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

  /** 本页「记住的」密码框（用于多表单时优先选它） */
  function rememberedPasswordInput() {
    if (!siteMemory.loaded || !siteMemory.pass) return null;
    return findBySelector(siteMemory.pass);
  }

  function analyzeForm(container, passEl) {
    if (!container) return null;
    const passes = passwordFieldsIn(container);
    if (!passes.length || !passes.includes(passEl)) return null;
    const isNew = passes.length > 1 || passes.some((el) => autoCompleteOf(el) === 'new-password');

    // 记住的选择器优先：同一站点下次渲染出的登录框直接命中
    let userEl = null;
    if (!isNew && siteMemory.loaded && siteMemory.user) {
      const remembered = findBySelector(siteMemory.user);
      if (remembered && container.contains(remembered) && !isPasswordInput(remembered)) userEl = remembered;
    }
    if (!userEl) userEl = isNew ? null : findUsernameInput(passEl, container);

    return {
      formEl: container,
      passEl,
      userEl,
      isNew,
      newPassEl: isNew ? findNewPasswordInput(container, passes) : null,
      btn: null,
      lastFill: null,
      markerScore: markerScore(container, siteMemory.markers),
    };
  }

  function scanForms() {
    const result = [];
    const seen = new Set();
    const all = [];
    for (const el of walkElements(document)) {
      if (isPasswordInput(el) && isVisible(el)) all.push(el);
    }

    // 记住的密码框排在前面：同一容器里有多个密码框时，以学到的那个为准
    const remembered = rememberedPasswordInput();
    if (remembered) {
      const idx = all.indexOf(remembered);
      if (idx > 0) {
        all.splice(idx, 1);
        all.unshift(remembered);
      }
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

  /** 整体重排列：让最像登录的那个排在最前（按页面状态关键词） */
  function rankForms(forms) {
    if (!forms.length) return forms;
    const preferred = siteMemory.markers.length ? siteMemory.markers : ['login'];
    const scored = forms.map((form, index) => {
      const login = markerScore(form.formEl, ['login']);
      const signup = markerScore(form.formEl, ['signup']);
      const forgot = markerScore(form.formEl, ['forgot']);
      return {
        form,
        index,
        score:
          (form.isNew ? -1 : 1) * 2 +
          markerScore(form.formEl, preferred) +
          login -
          signup * 1.5 -
          forgot,
      };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.map((item) => item.form);
  }

  function formFromEvent(ev) {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const nodes = path.length ? path : [ev.target];
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      for (const form of state.forms) {
        if (node === form.passEl || node === form.userEl) return form;
        if (form.formEl && form.formEl.contains(node)) return form;
        if (
          form.passEl &&
          typeof form.passEl.compareDocumentPosition === 'function' &&
          node === form.passEl.parentElement
        ) {
          return form;
        }
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
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) return null;
    // 多个登录框（同一页面既有「登录」又有「注册 / 忘记密码」）时，
    // 按页面状态关键词与实际文案挑最像登录的那个，而不是干脆不认
    let best = null;
    let bestScore = -Infinity;
    for (const form of candidates) {
      const score = markerScore(form.formEl, siteMemory.markers.length ? siteMemory.markers : ['login']);
      if (score > bestScore) {
        bestScore = score;
        best = form;
      }
    }
    return bestScore > 0 ? best : null;
  }

  /** 页面上已经输入的用户名（含分步登录的「账号已确认」页） */
  function pageUsernameHint() {
    for (const form of state.forms) {
      if (form.userEl && form.userEl.value && String(form.userEl.value).trim()) {
        return String(form.userEl.value).trim().toLowerCase();
      }
    }
    // 分步登录的第二步：页面上只剩密码框，账号显示在某处文本里
    const text = String((document.body && document.body.innerText) || '').slice(0, 3000).toLowerCase();
    for (const entry of state.entries) {
      const user = String(entry.username || '').trim().toLowerCase();
      if (user && user.length >= 3 && text.indexOf(user) >= 0) return user;
    }
    return '';
  }

  /** 让与页面已输入账号一致的那条记录排在最前（下拉面板与自动填充都用这个顺序） */
  function rankEntriesForPage(entries) {
    const hint = pageUsernameHint();
    if (!hint || entries.length < 2) return entries;
    const match = entries.filter((entry) => String(entry.username || '').trim().toLowerCase() === hint);
    if (!match.length) return entries;
    return match.concat(entries.filter((entry) => match.indexOf(entry) < 0));
  }

  /* ------------------------------------------------------------------ *
   * 图标按钮
   * ------------------------------------------------------------------ */

  function syncButtons() {
    const forms = rankForms(scanForms());
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
      // 按下即打开：登录弹层常见的「点外面先关闭」发生在 click 之前，
      // 等 click 再处理时密码框已经被页面移走了
      bindPress(btn, (ev) => {
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
    bindPress(fillBtn, (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      doFill(entry, false);
    });

    const loginBtn = document.createElement('button');
    loginBtn.className = 'mini icon';
    loginBtn.type = 'button';
    loginBtn.title = '填充并提交';
    loginBtn.textContent = '↵';
    bindPress(loginBtn, (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      doFill(entry, true);
    });

    acts.append(fillBtn, loginBtn);
    row.append(avatar, meta, acts);

    // 整行也是「按下即填充」：先命中按钮时按钮优先（见 pressableFrom）
    bindPress(row, (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      doFill(entry, false);
    });
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        ev.stopPropagation();
        doFill(entry, false);
      }
    });
    return row;
  }

  function renderPanel() {
    if (!overlay) return;
    const ui = overlay;
    // 面板打开时按当下页面上已输入的账号重新排序（用户可能刚改了用户名）
    state.entries = rankEntriesForPage(state.entries);
    ui.panelList.textContent = '';
    for (const entry of state.entries) ui.panelList.appendChild(buildRow(entry));
    ui.panelSite.textContent = U.prettyHost(state.host || location.hostname);
    ui.panelHint.textContent = state.entries.length + ' 个账号';
  }

  function openPanel(form) {
    if (!form || !state.entries.length) return;
    state.lastPanelToggleAt = Date.now();
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
    state.lastPanelToggleAt = Date.now();
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

  /** 把值写进输入框，并让页面自己的 state 感知到（React / Vue 的受控组件） */
  function writeValue(el, value) {
    setNativeValue(el, value);
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    } catch (err) {
      /* 老浏览器没有 InputEvent，上面的 input 事件已经够了 */
    }
  }

  /**
   * 按内容重新认领当前登录框。
   *
   * 覆盖层挂在 <html> 下，页面一旦重渲染（React 重新挂载、弹层被关掉再打开），
   * 输入框会换成新节点；扫描兜底最多要等 1 秒，这段时间里拿旧节点写值等于白写。
   * 这里在填充的每一拍重新扫描，只认「同一个密码框」（同一个节点，或者仍然可见的
   * 同类登录框），宁可放弃也不糊到别的表单里。
   */
  function reacquireForm(form) {
    if (!form) return null;
    if (form.passEl && form.passEl.isConnected && isVisible(form.passEl)) return form;
    let forms = [];
    try {
      forms = scanForms();
    } catch (err) {
      forms = [];
    }
    const sameNode = forms.find((f) => f.passEl === form.passEl);
    if (sameNode) return sameNode;
    const loginForms = forms.filter((f) => !f.isNew);
    if (loginForms.length === 1) return loginForms[0];
    return null;
  }

  const FILL_ROUNDS = 10;
  const FILL_INTERVAL = 140;
  const FILL_STABLE = 2; // 连续几拍读到同一个值才算真的填进去了
  const fillTimers = new Set();

  /**
   * 填充 + 校验。
   *
   * 有些站点在密码框上挂自己的监听器，写到一半就把值回滚、或者干脆把整个弹层重建，
   * 所以填完要核对一次；没生效就在 1.4 秒内重试几拍，避免「填充了但密码框是空的」。
   */
  function fillForm(form, entry, submit) {
    if (!form) return;
    const password = String(entry.password == null ? '' : entry.password);
    const username = String(entry.username == null ? '' : entry.username);

    state.dismissed = true;
    state.lastFillAt = Date.now();
    closePanel();

    let attempts = 0;
    let stableReads = 0;
    let usedSent = false;
    let lastForm = form;

    const tick = () => {
      const target = reacquireForm(lastForm);
      if (!target) {
        // 页面正在重建：等下一拍再认领，别直接放弃
        const timer = setTimeout(tick, FILL_INTERVAL);
        fillTimers.add(timer);
        return;
      }
      lastForm = target;
      attempts += 1;

      if (target.userEl && username) writeValue(target.userEl, username);
      writeValue(target.passEl, password);
      target.lastFill = { username, password, at: Date.now(), entryId: entry.id };

      try {
        target.passEl.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
      try {
        target.passEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
      } catch (err) {
        /* ignore */
      }

      // 只看「写进去的值还在」不够：页面有时下一拍才把值回滚或重挂节点，
      // 所以要求连续几拍都读到同一个值才收手
      stableReads = String(target.passEl.value || '') === password ? stableReads + 1 : 0;
      // 值一旦写进去就记账（页面可能立刻跳转，等不到「稳定」）
      if (stableReads >= 1 && entry.id && !usedSent) {
        usedSent = true;
        sendMessage({ type: 'credential:used', id: entry.id });
      }
      if (stableReads >= FILL_STABLE || attempts >= FILL_ROUNDS) return;
      const timer = setTimeout(tick, FILL_INTERVAL);
      fillTimers.add(timer);
    };

    tick();
    learnSite(form);

    if (submit) {
      setTimeout(() => {
        const target = reacquireForm(lastForm) || lastForm;
        if (String(target.passEl && target.passEl.value) === password) submitForm(target);
      }, 80);
    }
  }

  /* ------------------------------------------------------------------ *
   * 自动提示 / 自动填充
   * ------------------------------------------------------------------ */

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  const AUTO_FILL_DELAY = 150;
  let pendingAutoFill = null;

  function maybeAutoPrompt() {
    if (!state.settings.autoPrompt || !state.entries.length) return;
    if (state.autoOpened || state.dismissed) return;
    const form = state.forms.find((f) => !f.isNew && isVisible(f.passEl));
    if (!form) return;
    state.autoOpened = true;

    const canAutofill =
      state.settings.autoFillSingle && state.entries.length === 1 && !form.passEl.value && !(form.userEl && form.userEl.value);
    if (canAutofill) {
      if (pendingAutoFill) clearTimeout(pendingAutoFill);
      if (form.btn) form.btn.setAttribute('data-hint', '1');
      // 稍等一拍再填：登录弹层往往刚渲染完还会再重排一次节点，
      // 立刻写值容易被页面自己的初始化覆盖掉
      pendingAutoFill = setTimeout(() => {
        pendingAutoFill = null;
        if (state.dismissed) return;
        const target = reacquireForm(form);
        if (!target) return;
        learnSite(target);
        fillForm(target, state.entries[0], false);
      }, AUTO_FILL_DELAY);
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
      // 刚点过图标 / 刚关掉面板就别立刻又弹回来，否则会一直挡着密码框
      if (Date.now() - state.lastPanelToggleAt < 1500) return;
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
    // 共享电脑模式在后台已强制关闭自动暴露，前端再兜底一次，避免缓存或旧设置残留
    if (state.settings.sharedMode) {
      state.settings.autoPrompt = false;
      state.settings.autoOpenPanel = false;
      state.settings.autoFillSingle = false;
    }
    state.entries = Array.isArray(res.entries) ? res.entries : [];
    // 页面上已经填了账号（比如「先输账号 → 下一步」）时，把对应记录排到最前
    state.entries = rankEntriesForPage(state.entries);
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
    // 上一次填充的重试计时器不该跨页继续跑（否则会往新页面的框里写旧账号）
    for (const timer of fillTimers) clearTimeout(timer);
    fillTimers.clear();
    siteMemory.host = '';
    siteMemory.learned = '';
    loadSiteMemory();
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
    // 页面弹层自己内部滚动（不冒泡到 window）时图标/面板也要跟上
    window.addEventListener('wheel', schedulePosition, { capture: true, passive: true });
    window.addEventListener('touchmove', schedulePosition, { capture: true, passive: true });

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

  installPressGuard();
  registerCaptureHooks();
  watchNavigation();
  loadSiteMemory();
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
