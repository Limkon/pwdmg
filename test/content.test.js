'use strict';

/**
 * 内容脚本的 DOM 级测试（依赖 jsdom）。
 * 未安装 jsdom 时自动跳过：npm install --no-save jsdom
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch (err) {
  JSDOM = null;
}
const skip = JSDOM ? false : '未安装 jsdom，跳过内容脚本测试';

const ROOT = path.resolve(__dirname, '..');
const readScript = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SHARED_API = readScript('src/shared/api.js');
const SHARED_UTIL = readScript('src/shared/util.js');
const CONTENT = readScript('src/content/content.js');

const DEFAULT_SETTINGS = {
  autoSave: true,
  autoPrompt: true,
  autoOpenPanel: false,
  autoFillSingle: false,
};

function stateResponse(overrides) {
  return Object.assign(
    {
      ok: true,
      host: 'example.com',
      configured: true,
      pending: false,
      settings: DEFAULT_SETTINGS,
      entries: [
        { id: 'e1', host: 'example.com', title: 'example.com', username: 'alice', password: 'pw-alice' },
      ],
    },
    overrides || {}
  );
}

function createPage(t, html, options) {
  const opts = options || {};
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', {
    url: opts.url || 'https://example.com/login',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  if (t && typeof t.after === 'function') t.after(() => dom.window.close());

  // jsdom 没有布局引擎，给一个稳定的大小让 isVisible() 通过
  window.Element.prototype.getBoundingClientRect = function () {
    const isInput = this.tagName === 'INPUT';
    const width = isInput ? 240 : 0;
    const height = isInput ? 32 : 0;
    return {
      width,
      height,
      top: 120,
      left: 80,
      right: 80 + width,
      bottom: 120 + height,
      x: 80,
      y: 120,
      toJSON() {},
    };
  };

  const calls = {
    capture: [],
    used: [],
    deleted: [],
    resolve: [],
    state: 0,
    learned: [],
    messageListeners: [],
  };
  const siteMemory = opts.siteMemory || null;
  const getState = opts.getState || stateResponse();
  const captureResponse = opts.captureResponse || null;

  window.chrome = {
    runtime: {
      id: 'pwdmg-test',
      lastError: null,
      getManifest: () => ({ version: '1.0.0' }),
      sendMessage: async (message) => {
        switch (message && message.type) {
          case 'content:getState':
            calls.state += 1;
            return typeof getState === 'function' ? getState() : getState;
          case 'credential:capture':
            calls.capture.push(message);
            if (typeof captureResponse === 'function') return captureResponse(message);
            if (captureResponse) return captureResponse;
            return {
              ok: true,
              saved: true,
              action: 'created',
              host: 'example.com',
              entry: { id: 'captured-1', host: 'example.com', username: message.username },
            };
          case 'credential:pending':
            return { ok: true, pending: opts.pendingChange || null };
          case 'credential:resolvePending':
            calls.resolve.push(message);
            if (typeof opts.resolveResponse === 'function') return opts.resolveResponse(message);
            return opts.resolveResponse || { ok: true, accepted: message.accept, saved: message.accept };
          case 'credential:used':
            calls.used.push(message);
            return { ok: true };
          case 'credential:delete':
            calls.deleted.push(message);
            return { ok: true };
          case 'site:memory':
            return { ok: true, host: message.host, memory: siteMemory };
          case 'site:learn':
            calls.learned.push(message);
            return { ok: true, memory: message.memory };
          default:
            return { ok: true };
        }
      },
      onMessage: {
        addListener: (fn) => {
          calls.messageListeners.push(fn);
        },
      },
    },
    storage: { onChanged: { addListener: () => undefined } },
  };
  window.browser = undefined;

  window.eval(SHARED_API);
  window.eval(SHARED_UTIL);
  window.eval(CONTENT);

  /** 模拟“扩展页 / 后台”给内容脚本发消息 */
  function deliver(message) {
    return new Promise((resolve) => {
      let settled = false;
      const sendResponse = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      for (const fn of calls.messageListeners) {
        if (fn(message, {}, sendResponse) === false) sendResponse(null);
      }
      setTimeout(() => sendResponse(null), 1500);
    });
  }

  return { dom, window, calls, deliver };
}

function overlayOf(window) {
  const host = window.document.querySelector('[data-pwdmg="overlay"]');
  return host && host.shadowRoot ? host.shadowRoot : null;
}

function keyButtonOf(window) {
  const root = overlayOf(window);
  return root ? root.querySelector('.pm-key') : null;
}

function panelOf(window) {
  const root = overlayOf(window);
  return root ? root.querySelector('.panel') : null;
}

async function until(predicate, label, timeout) {
  const limit = timeout || 2000;
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待超时：' + (label || '条件未满足'));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('识别登录框并在只有 1 个账号时自动填充', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input name="username" type="text"><input name="password" type="password"><button type="submit">登录</button></form>',
    { getState: stateResponse({ settings: Object.assign({}, DEFAULT_SETTINGS, { autoFillSingle: true }) }) }
  );

  const { window, calls } = page;
  await until(() => window.document.querySelector('input[name="username"]').value === 'alice', '自动填充用户名');
  assert.equal(window.document.querySelector('input[name="password"]').value, 'pw-alice');
  assert.equal(calls.used.length >= 1, true, '应记录一次使用');
  await until(() => keyButtonOf(window), '图标按钮已注入');
  assert.ok(keyButtonOf(window));
  page.dom.window.close();
});

test('点击图标打开面板，选择账号后填入正确的用户名和密码', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input name="email" type="email"><input name="password" type="password"></form>',
    {
      getState: stateResponse({
        entries: [
          { id: 'e1', host: 'example.com', title: 'example.com', username: 'alice', password: 'pw-alice' },
          { id: 'e2', host: 'example.com', title: 'example.com', username: 'bob', password: 'pw-bob' },
        ],
      }),
    }
  );

  const { window } = page;
  await until(() => keyButtonOf(window), '图标按钮已注入');
  keyButtonOf(window).click();

  await until(() => panelOf(window) && panelOf(window).hidden === false, '面板已打开');
  const rows = overlayOf(window).querySelectorAll('.row');
  assert.equal(rows.length, 2);

  rows[1].click();
  assert.equal(window.document.querySelector('input[name="email"]').value, 'bob');
  assert.equal(window.document.querySelector('input[name="password"]').value, 'pw-bob');
  assert.equal(panelOf(window).hidden, true, '填充后面板关闭');
  page.dom.window.close();
});

test('提交表单时把新凭据交给后台记录', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input name="email" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>',
    { getState: stateResponse({ entries: [] }) }
  );
  const { window, calls } = page;

  const email = window.document.querySelector('input[name="email"]');
  const password = window.document.querySelector('input[name="password"]');
  email.value = 'me@example.com';
  password.value = 'my-secret';

  const form = window.document.getElementById('login');
  form.dispatchEvent(new window.Event('submit', { bubbles: true }));

  await until(() => calls.capture.length === 1, '捕获到提交');
  assert.equal(calls.capture[0].username, 'me@example.com');
  assert.equal(calls.capture[0].password, 'my-secret');
  assert.equal(calls.capture[0].url, 'https://example.com/login');
  page.dom.window.close();
});

test('注册 / 改密表单（多个密码框）既不填充也不记录', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="signup"><input name="email" type="email"><input name="password" type="password" autocomplete="new-password"><input name="confirm" type="password" autocomplete="new-password"></form>',
    { getState: stateResponse({ settings: Object.assign({}, DEFAULT_SETTINGS, { autoFillSingle: true }) }) }
  );
  const { window, calls } = page;

  await wait(250);
  assert.equal(window.document.querySelector('input[name="password"]').value, '', '不应自动填充注册表单');
  assert.equal(keyButtonOf(window), null, '注册表单不应显示图标');

  window.document.querySelector('input[name="password"]').value = 'new-secret';
  window.document.querySelector('input[name="email"]').value = 'new@example.com';
  window.document
    .getElementById('signup')
    .dispatchEvent(new window.Event('submit', { bubbles: true }));
  await wait(120);
  assert.equal(calls.capture.length, 0, '注册表单不应被记录');
  page.dom.window.close();
});

test('刚填充过的凭据再次提交不会重复记录', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input name="username" type="text"><input name="password" type="password"><button type="submit">登录</button></form>',
    {
      getState: stateResponse({
        settings: Object.assign({}, DEFAULT_SETTINGS, { autoFillSingle: false }),
        entries: [
          { id: 'e1', host: 'example.com', title: 'example.com', username: 'alice', password: 'pw-alice' },
        ],
      }),
    }
  );
  const { window, calls } = page;

  await until(() => keyButtonOf(window), '图标按钮已注入');
  keyButtonOf(window).click();
  await until(() => panelOf(window) && panelOf(window).hidden === false, '面板已打开');
  overlayOf(window).querySelector('.row').click();

  window.document
    .getElementById('login')
    .dispatchEvent(new window.Event('submit', { bubbles: true }));
  await wait(120);
  assert.equal(calls.capture.length, 0);
  page.dom.window.close();
});

test('没有匹配账号时不注入任何 UI', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input name="username"><input name="password" type="password"></form>',
    { getState: stateResponse({ entries: [] }) }
  );
  await wait(200);
  assert.equal(overlayOf(page.window), null);
  page.dom.window.close();
});

test('看不到的密码框（隐藏）会被忽略', { skip }, async (t) => {
  const dom = new JSDOM(
    '<!doctype html><html><body><form><input name="u"><input name="p" type="password" style="display:none"></form><form><input name="u2"><input name="p2" type="password"></form></body></html>',
    { url: 'https://example.com/login', pretendToBeVisual: true, runScripts: 'outside-only' }
  );
  const { window } = dom;
  if (typeof t.after === 'function') t.after(() => dom.window.close());
  window.Element.prototype.getBoundingClientRect = function () {
    const isInput = this.tagName === 'INPUT';
    return {
      width: isInput ? 240 : 0,
      height: isInput ? 32 : 0,
      top: 100,
      left: 60,
      right: 300,
      bottom: 132,
      x: 60,
      y: 100,
      toJSON() {},
    };
  };
  const calls = { state: 0 };
  window.chrome = {
    runtime: {
      id: 'pwdmg-test',
      lastError: null,
      getManifest: () => ({ version: '1.0.0' }),
      sendMessage: async (msg) => {
        if (msg.type === 'content:getState') {
          calls.state += 1;
          return stateResponse({ settings: Object.assign({}, DEFAULT_SETTINGS, { autoFillSingle: true }) });
        }
        return { ok: true };
      },
      onMessage: { addListener: () => undefined },
    },
    storage: { onChanged: { addListener: () => undefined } },
  };
  window.browser = undefined;
  window.eval(SHARED_API);
  window.eval(SHARED_UTIL);
  window.eval(CONTENT);

  await until(() => window.document.querySelector('input[name="p2"]').value === 'pw-alice', '可见密码框被填充');
  assert.equal(window.document.querySelector('input[name="p"]').value, '', '隐藏密码框不应被填充');
  dom.window.close();
});

function askOf(window) {
  const root = overlayOf(window);
  return root ? root.querySelector('.ask') : null;
}

function toastOf(window) {
  const root = overlayOf(window);
  return root ? root.querySelector('.toast') : null;
}

test('密码变化时提示更新，确认后才带上 force 保存', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input name="username" type="text"><input name="password" type="password"><button type="submit">登录</button></form>',
    {
      getState: stateResponse({ entries: [] }),
      captureResponse: (message) =>
        message.force
          ? {
              ok: true,
              saved: true,
              action: 'updated',
              host: 'example.com',
              entry: { id: 'e1', host: 'example.com', username: 'alice' },
            }
          : {
              ok: true,
              saved: false,
              reason: 'password-changed',
              entry: { id: 'e1', host: 'example.com', username: 'alice' },
              host: 'example.com',
            },
    }
  );
  const { window, calls } = page;

  // 等初始状态就绪（entries 为空时不会注入图标，但 capture 钩子已生效）
  await until(() => calls.state >= 1, '初始状态加载');

  window.document.querySelector('input[name="username"]').value = 'alice';
  window.document.querySelector('input[name="password"]').value = 'brand-new-pw';
  window.document.getElementById('login').dispatchEvent(new window.Event('submit', { bubbles: true }));

  await until(() => calls.capture.length === 1, '首次捕获');
  assert.equal(calls.capture[0].force, false, '默认先询问，不直接覆盖');

  await until(() => askOf(window) && askOf(window).hidden === false, '弹出更新确认');
  assert.match(askOf(window).textContent, /更新/);
  assert.match(askOf(window).querySelector('.ask-text').textContent, /alice/);

  askOf(window).querySelector('.agree').click();
  await until(() => calls.resolve.length === 1, '确认更新');
  assert.equal(calls.resolve[0].accept, true, '确认后交给后台真正写入');
  assert.equal(calls.capture.length, 1, '不应该再从前端发一次 capture');
  await until(() => askOf(window).hidden === true, '确认后关闭卡片');
  await until(() => /已更新/.test(toastOf(window).textContent), '显示更新成功提示');
  page.dom.window.close();
});

test('选择“保留旧密码”后同一密码不再反复询问', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input name="username" type="text"><input name="password" type="password"></form>',
    {
      getState: stateResponse({ entries: [] }),
      captureResponse: {
        ok: true,
        saved: false,
        reason: 'password-changed',
        entry: { id: 'e1', host: 'example.com', username: 'alice' },
        host: 'example.com',
      },
    }
  );
  const { window, calls } = page;
  await until(() => calls.state >= 1, '初始状态加载');

  const submit = (password) => {
    window.document.querySelector('input[name="username"]').value = 'alice';
    window.document.querySelector('input[name="password"]').value = password;
    window.document.getElementById('login').dispatchEvent(new window.Event('submit', { bubbles: true }));
  };

  submit('same-new-pw');
  await until(() => askOf(window) && askOf(window).hidden === false, '第一次提示');
  askOf(window).querySelector('.deny').click();
  assert.equal(askOf(window).hidden, true);
  assert.equal(calls.resolve.length, 1, '拒绝也要清掉后台的待确认状态');
  assert.equal(calls.resolve[0].accept, false);

  // 换一个密码值可以再次提示（同一密码值不再骚扰）
  submit('another-pw');
  await until(() => askOf(window) && askOf(window).hidden === false, '新密码再次提示');
  page.dom.window.close();
});

test('修改密码表单：以 updateOnly 提交新密码', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="change"><div>修改密码</div><input name="username"><input type="password" name="current" autocomplete="current-password"><input type="password" name="new" autocomplete="new-password"><button type="submit">保存</button></form>',
    {
      getState: stateResponse({ entries: [] }),
      captureResponse: { ok: false, saved: false, reason: 'no-entry' },
    }
  );
  const { window, calls } = page;
  await until(() => calls.state >= 1, '初始状态加载');

  window.document.querySelector('input[name="new"]').value = 'fresh-password';
  window.document.getElementById('change').dispatchEvent(new window.Event('submit', { bubbles: true }));

  await until(() => calls.capture.length === 1, '捕获改密提交');
  assert.equal(calls.capture[0].updateOnly, true, '不应新建随机条目');
  assert.equal(calls.capture[0].password, 'fresh-password');
  assert.equal(calls.capture[0].force, false);
  // 没有已存账号 -> 不提示更新
  assert.ok(!askOf(window) || askOf(window).hidden);
  page.dom.window.close();
});

test('锁定状态：不注入图标，提示去解锁', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input name="username"><input name="password" type="password"></form>',
    { getState: stateResponse({ locked: true, entries: [] }) }
  );
  const { window } = page;

  await until(() => toastOf(window) && toastOf(window).hidden === false, '显示锁定提示');
  assert.match(toastOf(window).textContent, /已锁定/);
  assert.equal(keyButtonOf(window), null);
  assert.equal(window.document.querySelector('input[name="password"]').value, '');
  page.dom.window.close();
});

test('叠加层：所有可交互元素都必须声明 pointer-events: auto', () => {
  // 宿主是 pointer-events: none，子元素不显式声明 auto 就会“点不动且穿透到网页”。
  // jsdom 不做命中测试，所以这里守规则本身。
  const rule = CONTENT.match(/\.pm-key[^{]*\{[^}]*pointer-events:\s*auto[^}]*\}/);
  assert.ok(rule, '找不到 pointer-events: auto 的规则');
  for (const cls of ['.pm-key', '.panel', '.ask', '.toast']) {
    assert.ok(rule[0].includes(cls), cls + ' 必须写进 pointer-events: auto 的选择器里');
  }
});

test('页面加载后恢复待确认的密码变更', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input name="username" type="text"><input name="password" type="password"></form>',
    {
      getState: stateResponse({ entries: [] }),
      pendingChange: {
        host: 'example.com',
        username: 'alice',
        password: 'pending-pw',
        url: 'https://example.com/login',
        title: '',
        at: Date.now(),
      },
      resolveResponse: { ok: true, accepted: true, saved: true, action: 'updated' },
    }
  );
  const { window, calls } = page;

  // 没有提交动作，仅凭后台的待确认状态就应该弹出卡片
  await until(() => askOf(window) && askOf(window).hidden === false, '恢复更新提示');
  assert.match(askOf(window).querySelector('.ask-text').textContent, /alice/);

  askOf(window).querySelector('.agree').click();
  await until(() => calls.resolve.length === 1, '确认更新');
  assert.equal(calls.resolve[0].accept, true);
  await until(() => /已更新/.test(toastOf(window).textContent), '显示更新成功提示');
  assert.equal(calls.capture.length, 0, '恢复的变更不需要前端再发 capture');
});

test('没有 <form> 的 SPA 登录：点按钮后仍能记录', { skip }, async (t) => {
  const page = createPage(
    t,
    `<div class="login">
       <input id="u" type="text" name="username" />
       <input id="p" type="password" name="password" />
       <button id="go" type="button">登录</button>
     </div>`
  );
  const { window, calls } = page;
  await until(() => keyButtonOf(window), '注入图标');

  window.document.getElementById('u').value = 'alice';
  window.document.getElementById('p').value = 'typed-password';
  window.document.getElementById('go').click();

  await until(() => calls.capture.length === 1, '记录点击提交的凭据');
  assert.equal(calls.capture[0].username, 'alice');
  assert.equal(calls.capture[0].password, 'typed-password');
});

test('弹窗请求填充：填入密码并把条目 id 记回后台（用于“最近使用”排序）', { skip }, async (t) => {
  const page = createPage(
    t,
    `<form><input id="u" type="text" name="username" /><input id="p" type="password" name="password" /><button type="submit">登录</button></form>`
  );
  const { window, calls, deliver } = page;
  await until(() => keyButtonOf(window), '注入图标');

  const res = await deliver({
    type: 'content:fill',
    entry: { id: 'e1', username: 'alice', password: 'pw-alice' },
  });
  assert.equal(res.ok, true);
  assert.equal(window.document.getElementById('p').value, 'pw-alice');
  assert.equal(calls.used.length, 1);
  assert.equal(calls.used[0].id, 'e1');

  // 刚填充过，再次提交同样的值不应该重复记录
  window.document.querySelector('button[type="submit"]').click();
  await wait(120);
  assert.equal(calls.capture.length, 0);
});

test('登录框在按钮点击后才出现：注入按钮与面板', { skip }, async (t) => {
  const page = createPage(
    t,
    '<button id="loginBtn">登录</button>',
    { getState: stateResponse({ settings: Object.assign({}, DEFAULT_SETTINGS, { autoOpenPanel: true }) }) }
  );
  const { window } = page;

  // 页面初始没有登录框，不挂图标、也不展示面板
  await wait(600);
  assert.equal(keyButtonOf(window), null);

  // 用户点击登录按钮，页面动态弹出登录框
  window.document.getElementById('loginBtn').click();
  const modal = window.document.createElement('div');
  modal.id = 'modal';
  modal.innerHTML =
    '<form id="login"><input id="u" name="username" type="text" /><input id="p" name="password" type="password" /><button type="submit">登录</button></form>';
  window.document.body.appendChild(modal);

  // 内容脚本应检测到动态登录框并注入图标 + 弹出面板
  await until(() => keyButtonOf(window), '弹出登录框后注入图标', 3000);
  await until(() => panelOf(window) && panelOf(window).hidden === false, '弹出登录框后打开面板', 3000);

  const panel = panelOf(window);
  assert.equal(panel.querySelectorAll('.row').length, 1);
  assert.match(panel.querySelector('.panel-site, .site').textContent, /example\.com/);
});

test('登录框弹在 open shadow DOM 里：注入按钮与面板', { skip }, async (t) => {
  const page = createPage(
    t,
    '<button id="loginBtn">登录</button>',
    { getState: stateResponse({ settings: Object.assign({}, DEFAULT_SETTINGS, { autoOpenPanel: true }) }) }
  );
  const { window } = page;

  await wait(600);
  assert.equal(keyButtonOf(window), null);

  // 用户点击登录按钮，页面弹出一个影子 DOM 里的登录框（mail.com 这类结构）
  window.document.getElementById('loginBtn').click();
  const host = window.document.createElement('div');
  host.id = 'login-modal';
  window.document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<form id="login"><input id="u" name="username" type="text" /><input id="p" name="password" type="password" /><button type="submit">登录</button></form>';

  await until(() => keyButtonOf(window), 'shadow-DOM 登录框注入图标', 4000);
  await until(() => panelOf(window) && panelOf(window).hidden === false, 'shadow-DOM 登录框打开面板', 4000);

  const panel = panelOf(window);
  assert.equal(panel.querySelectorAll('.row').length, 1);
  const pass = shadow.querySelector('input[type="password"]');
  assert.ok(pass);
  assert.equal(pass.tagName, 'INPUT');
});

test('覆盖层被页面重渲染移除后，自动重建并重新挂载图标', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form><input id="u" type="text" name="username" /><input id="p" type="password" name="password" /><button type="submit">登录</button></form>',
    { getState: stateResponse({ settings: Object.assign({}, DEFAULT_SETTINGS, { autoOpenPanel: false }) }) }
  );
  const { window } = page;
  await until(() => keyButtonOf(window), '初始图标注入', 3000);

  // 模拟 SPA 页面整体重渲染，把覆盖层宿主移出 DOM
  const host = window.document.querySelector('[data-pwdmg="overlay"]');
  assert.ok(host, 'overlay 存在');
  host.parentElement.removeChild(host);
  await wait(300);

  // 定时兜底扫描后，覆盖层重建并重新挂载图标
  await until(() => keyButtonOf(window), 'overlay 重建后图标恢复', 5000);
  const panel = panelOf(window);
  assert.ok(panel === null || panel.hidden !== false, '无面板状态');

  // 面板/图标所在宿主仍在 <html> 下
  const hostAfter = window.document.querySelector('[data-pwdmg="overlay"]');
  assert.ok(hostAfter);
});

/* ------------------------------------------------------------------ *
 * 回归：点「填充」后页面把登录弹层关掉，密码框消失 → 密码根本没填进去
 * ------------------------------------------------------------------ */

/**
 * 造一个「点外面就关」的登录弹层：
 * 页面在 document 上监听 pointerdown / mousedown / click，target 不在弹层里
 * 就销毁弹层（Radix / MUI / Bootstrap Modal 以及各种自研弹层的常见做法）。
 */
function createDismissableModalPage(t, options) {
  const opts = options || {};
  const page = createPage(t, '<button id="openLogin">登录</button>', {
    getState: stateResponse(
      Object.assign(
        {
          settings: Object.assign({}, DEFAULT_SETTINGS, { autoOpenPanel: false, autoFillSingle: false }),
          entries: [
            { id: 'e1', host: 'example.com', title: 'example.com', username: 'alice', password: 'pw-alice' },
          ],
        },
        opts.state || {}
      )
    ),
  });
  const { window } = page;
  const stats = { closedByPage: 0 };

  const open = () => {
    const modal = window.document.createElement('div');
    modal.id = 'login-modal';
    modal.innerHTML =
      '<form id="modal-login"><input id="mu" name="username" type="text" />' +
      '<input id="mp" name="password" type="password" /><button type="submit">登录</button></form>';
    window.document.body.appendChild(modal);
    return modal;
  };

  const dismissIfOutside = (ev) => {
    const modal = window.document.getElementById('login-modal');
    if (!modal) return;
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
    if (path.indexOf(modal) >= 0) return;
    if (path.some((node) => node && node.id === 'openLogin')) return; // 打开弹层的按钮不算「外面」
    stats.closedByPage += 1;
    modal.remove(); // 密码框从 DOM 里消失
  };
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    window.document.addEventListener(type, dismissIfOutside);
  }

  window.document.getElementById('openLogin').addEventListener('click', open);
  return { page, window, stats, open };
}

test('登录弹层「点外面就关」：点图标和填充都不该把弹层关掉', { skip }, async (t) => {
  const { window, stats, open } = createDismissableModalPage(t);
  await until(() => window.document.title !== undefined, '页面就绪');

  window.document.getElementById('openLogin').click();
  const modal = window.document.getElementById('login-modal');
  assert.ok(modal, '登录弹层已打开');

  // 等扩展扫描到这个动态弹层
  await until(() => keyButtonOf(window), '动态登录弹层注入图标', 4000);

  const keyBtn = keyButtonOf(window);
  keyBtn.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, composed: true }));
  keyBtn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, composed: true }));
  keyBtn.click();

  assert.equal(stats.closedByPage, 0, '点扩展图标不应被页面当成「点在外面」');
  await until(() => panelOf(window) && panelOf(window).hidden === false, '面板已打开');

  // 点「填充」
  const fillBtn = overlayOf(window).querySelector('.row .mini');
  fillBtn.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, composed: true }));
  fillBtn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, composed: true }));
  fillBtn.click();

  assert.equal(stats.closedByPage, 0, '点填充后登录弹层必须还在');
  assert.ok(window.document.getElementById('login-modal'), '弹层仍在 DOM 里');
  assert.equal(window.document.getElementById('mp').value, 'pw-alice', '密码已填入');
  assert.equal(window.document.getElementById('mu').value, 'alice', '用户名已填入');

  // 弹层重新打开后仍能再填充（状态没有卡死）
  open();
  await until(() => keyButtonOf(window), '重新打开后图标恢复', 4000);
});

test('填充瞬间页面重建了密码框：重试后仍然填进新节点', { skip }, async (t) => {
  const page = createPage(
    t,
    '<div id="modal"><form id="login"><input id="u" name="username" type="text" />' +
      '<input id="p" name="password" type="password" /><button type="submit">登录</button></form></div>',
    {
      getState: stateResponse({
        entries: [{ id: 'e1', host: 'example.com', title: 'example.com', username: 'alice', password: 'pw-alice' }],
      }),
    }
  );
  const { window } = page;
  await until(() => keyButtonOf(window), '注入图标');

  // 页面在收到第一次 input 时把整个登录框重挂一次（受控组件重新挂载）
  let rebuilt = 0;
  window.document.addEventListener('input', () => {
    const modal = window.document.getElementById('modal');
    if (!modal || rebuilt) return;
    rebuilt += 1;
    modal.innerHTML =
      '<form id="login"><input id="u2" name="username" type="text" />' +
      '<input id="p2" name="password" type="password" /><button type="submit">登录</button></form>';
  });

  keyButtonOf(window).click();
  await until(() => panelOf(window) && panelOf(window).hidden === false, '面板已打开');

  const fillBtn = overlayOf(window).querySelector('.row .mini');
  fillBtn.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, composed: true }));
  fillBtn.click();

  await until(() => rebuilt >= 1, '页面确实重建过密码框', 2000);
  await until(() => {
    const pass = window.document.getElementById('p2');
    return pass && pass.value === 'pw-alice';
  }, '新密码框最终被填上', 3000);
  assert.equal(window.document.getElementById('u2').value, 'alice');
});

test('非标准密码框：type="text" + -webkit-text-security 也要能认出并填充', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input id="u" name="username" type="text" />' +
      '<input id="p" name="password" type="text" class="password-input" />' +
      '<button type="submit">登录</button></form>',
    {
      getState: stateResponse({
        settings: Object.assign({}, DEFAULT_SETTINGS, { autoFillSingle: true }),
        entries: [{ id: 'e1', host: 'example.com', title: 'example.com', username: 'alice', password: 'pw-alice' }],
      }),
    }
  );
  const { window } = page;

  await until(() => window.document.getElementById('p').value === 'pw-alice', '掩码密码框被自动填充', 3000);
  assert.equal(window.document.getElementById('u').value, 'alice');
  assert.ok(keyButtonOf(window), '图标也要注入');
});

test('只读 / 禁用的密码框不算登录框', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form><input name="username" type="text" />' +
      '<input id="ro" name="password" type="password" readonly /></form>' +
      '<form><input name="username2" type="text" />' +
      '<input id="dis" name="password2" type="password" disabled /></form>',
    { getState: stateResponse({ entries: [] }) }
  );
  const { window } = page;
  await wait(300);
  assert.equal(keyButtonOf(window), null);
  assert.equal(window.document.getElementById('ro').value, '');
});

test('样式走 adoptedStyleSheets（严格 CSP 站点不会因为没有样式而“隐形”）', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form><input name="username" type="text" /><input name="password" type="password" /></form>',
    { getState: stateResponse() }
  );
  const { window } = page;
  await until(() => keyButtonOf(window), '注入图标');

  const root = overlayOf(window);
  if ('adoptedStyleSheets' in root && typeof window.CSSStyleSheet === 'function') {
    assert.ok(root.adoptedStyleSheets && root.adoptedStyleSheets.length >= 1, '应使用 adoptedStyleSheets');
    const css = root.adoptedStyleSheets[0].cssRules ? root.adoptedStyleSheets[0].cssRules : [];
    assert.ok(css.length > 0, '样式表里有规则');
  } else {
    assert.ok(root.querySelector('style'), '退回到 <style>');
  }
  // 无论走哪条路，<style> 都不应该被重复塞很多份
  assert.ok(root.querySelectorAll('style').length <= 1);
});

/* ------------------------------------------------------------------ *
 * 智能识别：站点自适应
 * ------------------------------------------------------------------ */

test('智能识别：学会的字段选择器会写回本机（只含选择器与状态，不含密码）', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input id="account" name="login_id" type="text" />' +
      '<input id="secret" name="login_pw" type="password" /><button type="submit">登录</button></form>',
    {
      getState: stateResponse({
        entries: [{ id: 'e1', host: 'example.com', title: 'example.com', username: 'alice', password: 'pw-alice' }],
      }),
    }
  );
  const { window, calls } = page;
  await until(() => keyButtonOf(window), '注入图标');
  keyButtonOf(window).click();
  await until(() => panelOf(window) && panelOf(window).hidden === false, '面板已打开');
  overlayOf(window).querySelector('.row .mini').click();

  await until(() => calls.learned.length >= 1, '学习到站点线索', 4000);
  const learned = calls.learned[0];
  assert.equal(learned.host, 'example.com');
  assert.equal(learned.memory.user, '#account');
  assert.equal(learned.memory.pass, '#secret');
  assert.ok(learned.memory.markers.includes('login'), '记住页面是登录界面');
  assert.equal(JSON.stringify(learned.memory).includes('pw-alice'), false, '不能把密码写进线索');
});

test('智能识别：命中记住的选择器时优先用它，而不是分数更高的文本框', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login">' +
      '<input id="q" name="search" type="search" placeholder="搜索" />' +
      '<input id="mail" name="email" type="email" placeholder="邮箱" />' +
      '<input id="secret" name="login_pw" type="password" />' +
      '<button type="submit">登录</button></form>',
    {
      getState: stateResponse({
        settings: Object.assign({}, DEFAULT_SETTINGS, { autoFillSingle: true }),
        entries: [{ id: 'e1', host: 'example.com', title: 'example.com', username: 'alice', password: 'pw-alice' }],
      }),
      siteMemory: { user: '#q', pass: '#secret', markers: ['login'] },
    }
  );
  const { window } = page;

  await until(() => window.document.getElementById('secret').value === 'pw-alice', '自动填充', 4000);
  assert.equal(window.document.getElementById('q').value, 'alice', '按记住的选择器写入用户名字段');
  assert.equal(window.document.getElementById('mail').value, '');
});

test('智能识别：同一页面有多个表单时，按页面文案挑登录框而不是注册框', { skip }, async (t) => {
  const page = createPage(
    t,
    '<div id="signup-box"><h2>注册新账号</h2>' +
      '<form><input id="su" name="username" type="text" />' +
      '<input id="sp" name="password" type="password" /></form></div>' +
      '<div id="login-box"><h2>登录</h2>' +
      '<form><input id="lu" name="username" type="text" />' +
      '<input id="lp" name="password" type="password" /></form></div>',
    { getState: stateResponse({ settings: Object.assign({}, DEFAULT_SETTINGS, { autoOpenPanel: true }) }) }
  );
  const { window } = page;

  await until(() => panelOf(window) && panelOf(window).hidden === false, '面板已打开', 4000);
  overlayOf(window).querySelector('.row .mini').click();
  await until(() => window.document.getElementById('lp').value === 'pw-alice', '填进登录框', 3000);
  assert.equal(window.document.getElementById('sp').value, '', '注册框不应被填');
});

test('智能识别：页面上已输入的账号决定首选记录', { skip }, async (t) => {
  const page = createPage(
    t,
    '<form id="login"><input id="u" name="username" type="text" />' +
      '<input id="p" name="password" type="password" /></form>',
    {
      getState: stateResponse({
        entries: [
          { id: 'e1', host: 'example.com', title: 'example.com', username: 'alice', password: 'pw-alice' },
          { id: 'e2', host: 'example.com', title: 'example.com', username: 'bob', password: 'pw-bob' },
        ],
      }),
    }
  );
  const { window } = page;
  await until(() => keyButtonOf(window), '注入图标');

  // 用户在页面上先输入了 bob
  const user = window.document.getElementById('u');
  user.value = 'bob';
  user.dispatchEvent(new window.Event('input', { bubbles: true }));

  keyButtonOf(window).click();
  await until(() => panelOf(window) && panelOf(window).hidden === false, '面板已打开');
  const firstRow = overlayOf(window).querySelector('.row .title');
  assert.equal(firstRow.textContent, 'bob', '与已输入账号匹配的记录排在最前');
});
