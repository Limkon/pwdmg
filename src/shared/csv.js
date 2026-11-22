/*!
 * pwdmg · 密码 CSV 解析（Chrome / Edge / Firefox / Bitwarden / LastPass）
 *
 * 只做纯函数解析，不接触存储：把文件文本变成密码库条目，交给 background 合并。
 * 挂载为 globalThis.PwdmgCsv，同时支持 Node require（用于单元测试）。
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = mod;
  if (root) root.PwdmgCsv = mod;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  /** 表头别名（全部小写，去空格） */
  const COLUMNS = {
    url: ['url', 'login_uri', 'uri', 'website', 'site', 'link'],
    username: ['username', 'login_username', 'user', 'login', 'account', 'email'],
    password: ['password', 'login_password', 'pass', 'secret'],
    title: ['name', 'title', 'title_hint', 'label'],
    notes: ['note', 'notes', 'extra', 'comment', 'comments'],
  };

  /** Chrome / Edge 默认列序：name,url,username,password,note */
  const CHROME_ORDER = ['title', 'url', 'username', 'password', 'notes'];

  /**
   * 解析 CSV 文本为二维数组（RFC 4180：引号内的逗号、换行、"" 转义）。
   */
  function parseRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        if (src[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
    row.push(field);
    rows.push(row);

    // 丢掉完全空白的行
    return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
  }

  function normalizeKey(value) {
    return String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .replace(/^\uFEFF/, '');
  }

  function looksLikeHeader(cells) {
    const keys = cells.map(normalizeKey);
    const known = Object.keys(COLUMNS);
    return known.some((name) => keys.some((key) => COLUMNS[name].includes(key)));
  }

  /** 根据表头建立「字段 → 列下标」映射；没有表头就按 Chrome 的列序 */
  function buildMapping(headerCells) {
    const keys = headerCells.map(normalizeKey);
    const index = {};
    for (const name of Object.keys(COLUMNS)) {
      const aliases = COLUMNS[name];
      const at = keys.findIndex((key) => aliases.includes(key));
      if (at >= 0) index[name] = at;
    }
    return index;
  }

  function positionalMapping() {
    const index = {};
    CHROME_ORDER.forEach((name, at) => {
      index[name] = at;
    });
    return index;
  }

  /** 从 URL 里取出主机名 / origin；非 http(s) 返回 null */
  function locationOf(rawUrl) {
    const value = String(rawUrl == null ? '' : rawUrl).trim();
    if (!value) return null;
    let url;
    try {
      url = new URL(value);
    } catch (err) {
      if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(value)) {
        try {
          url = new URL('https://' + value);
        } catch (err2) {
          return null;
        }
      } else {
        return null;
      }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    const port = url.port ? ':' + url.port : '';
    return { host, origin: url.protocol + '//' + host + port, url: url.toString() };
  }

  function normalizeHost(host) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  }

  /**
   * 解析密码 CSV。
   * @param {string} text 文件内容
   * @returns {{ ok: boolean, entries: Array<object>, stats: object, format: string }}
   */
  function parse(text) {
    const rows = parseRows(text);
    const stats = {
      rows: 0,
      usable: 0,
      merged: 0,
      skippedAndroid: 0,
      skippedOther: 0,
      skippedNoPassword: 0,
      skippedNoHost: 0,
    };
    const entries = [];
    if (!rows.length) {
      return { ok: false, entries, stats, format: 'unknown', error: '文件是空的' };
    }

    const hasHeader = looksLikeHeader(rows[0]);
    const index = hasHeader ? buildMapping(rows[0]) : positionalMapping();
    const body = hasHeader ? rows.slice(1) : rows;

    if (index.url === undefined || index.password === undefined) {
      return {
        ok: false,
        entries,
        stats,
        format: 'unknown',
        error: '没有找到 url / password 列，可能不是密码 CSV',
      };
    }

    const format = hasHeader ? headerFormat(rows[0]) : 'chrome';
    const seen = new Map();

    for (const cells of body) {
      stats.rows += 1;
      const pick = (name) => (index[name] === undefined ? '' : String(cells[index[name]] == null ? '' : cells[index[name]]));
      const rawUrl = pick('url').trim();
      const password = pick('password');
      const username = pick('username').trim();
      const title = pick('title').trim();
      const notes = pick('notes').trim();

      if (/^android:\/\//i.test(rawUrl)) {
        stats.skippedAndroid += 1;
        continue;
      }
      if (!password) {
        stats.skippedNoPassword += 1;
        continue;
      }
      const location = locationOf(rawUrl);
      if (!location) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) stats.skippedOther += 1;
        else stats.skippedNoHost += 1;
        continue;
      }

      const entry = {
        url: location.url,
        host: normalizeHost(location.host),
        origin: location.origin,
        username,
        password,
        title: title || normalizeHost(location.host),
        notes,
      };

      // 同一站点同一账号出现多次：保留最后一条
      const key = entry.host + '\u0000' + username.toLowerCase();
      if (seen.has(key)) {
        stats.merged += 1;
        entries[seen.get(key)] = entry;
      } else {
        seen.set(key, entries.length);
        entries.push(entry);
      }
    }

    stats.usable = entries.length;
    if (!entries.length) {
      return {
        ok: false,
        entries,
        stats,
        format,
        error: '没有解析出可用的账号（可能不是密码 CSV，或缺少 url / password 列）',
      };
    }
    return { ok: true, entries, stats, format };
  }

  function headerFormat(headerCells) {
    const keys = headerCells.map(normalizeKey);
    if (keys.includes('login_uri') || keys.includes('login_password')) return 'bitwarden';
    if (keys.includes('httprealm') || keys.includes('formactionorigin')) return 'firefox';
    if (keys.includes('grouping') || keys.includes('totp')) return 'lastpass';
    if (keys.includes('name') && keys.includes('url')) return 'chrome';
    return 'csv';
  }

  return { parse, parseRows, looksLikeHeader, locationOf, normalizeHost, COLUMNS };
});
