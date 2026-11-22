/*!
 * pwdmg · 极简 WebDAV 客户端
 *
 * 只用 GET / PUT / MKCOL / PROPFIND 四个动词，兼容 Nextcloud、坚果云、
 * Synology、Apache mod_dav、rclone serve webdav 等常见实现。
 * 挂载为 globalThis.PwdmgWebdav，同时支持 Node require（用于单元测试）。
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = mod;
  if (root) root.PwdmgWebdav = mod;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const DEFAULT_TIMEOUT = 20000;

  /** 地址填成目录时自动补上的默认文件名 */
  const DEFAULT_FILE_NAME = 'vault.json';

  /** 地址指向网页（目录列表 / 登录页 / 反向代理）时的提示 */
  const HTML_HINT =
    '这个地址返回的是网页，不是密码库文件。请检查：① 地址要精确到文件（例如 …/pwdmg/vault.json），不要只填目录；' +
    '② DAV 路径是否正确（Nextcloud 用 /remote.php/dav/files/<用户名>/，坚果云用 /dav/）；' +
    '③ 是否被登录页、反向代理或 Cloudflare Access 之类拦截。';

  class WebDavError extends Error {
    constructor(message, options) {
      super(message);
      this.name = 'WebDavError';
      const opts = options || {};
      this.code = opts.code || 'error';
      this.status = opts.status || 0;
      this.detail = opts.detail || '';
    }
  }

  function base64Utf8(text) {
    const bytes = new TextEncoder().encode(String(text));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === 'function') return btoa(binary);
    return Buffer.from(binary, 'binary').toString('base64');
  }

  /**
   * 归一化 WebDAV 地址：
   *  - 去掉首尾空白、去掉 #hash
   *  - 以 / 结尾（填的是目录）时自动补上 vault.json
   * @param {string} input
   * @returns {string} 空输入返回空串
   */
  function normalizeUrl(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return '';
    let url;
    try {
      url = new URL(raw);
    } catch (err) {
      throw new WebDavError('WebDAV 地址格式不正确：' + raw, { code: 'config' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new WebDavError('WebDAV 地址必须以 http:// 或 https:// 开头（建议使用 HTTPS）', {
        code: 'config',
      });
    }
    url.hash = '';
    // 指向目录（以 / 结尾）、或者最后一段不像文件名（没有扩展名）时，补上 vault.json
    const segments = url.pathname.split('/').filter(Boolean);
    const lastSegment = segments.length ? segments[segments.length - 1] : '';
    const looksLikeFile = lastSegment.includes('.');
    if (!looksLikeFile) {
      url.pathname = url.pathname.replace(/\/+$/, '') + '/' + DEFAULT_FILE_NAME;
    }
    return url.toString();
  }

  /** 判断响应体是不是网页 / XML 之类（不是密码库 JSON） */
  function looksLikeHtml(text, contentType) {
    const type = String(contentType || '').toLowerCase();
    if (type.includes('text/html') || type.includes('application/xhtml')) return true;
    const head = String(text || '').trimStart().slice(0, 200).toLowerCase();
    if (!head.startsWith('<')) return false;
    return /^<(?:!doctype|html|head|body|title|meta|h1|p|div|\?xml)/.test(head);
  }

  /**
   * 把 ETag 变成可以放进 If-Match 的强校验符。
   *
   * RFC 7232 规定 If-Match 必须用强比较，所以 `W/"abc"` 这种弱校验符
   * 在严格的服务器上永远匹配不上（每次写都 412）。服务器做 gzip 压缩时
   * 很常见把强 ETag 降级成弱 ETag，这里去掉 W/ 再发。
   */
  function strongTag(etag) {
    const raw = String(etag == null ? '' : etag).trim();
    if (!raw) return '';
    return raw.replace(/^W\//i, '');
  }

  /** 是否是弱校验符（W/ 开头） */
  function isWeakTag(etag) {
    return /^W\//i.test(String(etag == null ? '' : etag).trim());
  }

  function dirChain(href) {
    let url;
    try {
      url = new URL(href);
    } catch (err) {
      throw new WebDavError('WebDAV 地址格式不正确：' + href, { code: 'config' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new WebDavError('WebDAV 地址必须以 http:// 或 https:// 开头', { code: 'config' });
    }
    const path = url.pathname;
    const cut = path.lastIndexOf('/');
    const dirPath = cut >= 0 ? path.slice(0, cut + 1) : '/';
    const dirs = [];
    let acc = '';
    for (const seg of dirPath.split('/').filter(Boolean)) {
      acc += '/' + seg;
      dirs.push(url.origin + acc + '/');
    }
    return dirs;
  }

  function describeStatus(status, what) {
    const map = {
      400: '请求格式错误',
      401: '认证失败（用户名 / 密码 / 令牌不正确）',
      403: '没有权限访问该路径',
      404: '文件不存在',
      405: '服务器不支持该操作（地址可能是个目录）',
      409: '父目录不存在',
      412: '文件已被其他设备修改',
      423: '文件被锁定',
      507: 'WebDAV 空间不足',
    };
    return (what ? what + '：' : '') + (map[status] || 'HTTP ' + status);
  }

  class WebDavClient {
    /**
     * 兼容两种参数命名：{ url } 或设置对象 { webdavUrl }。
     * @param {{url?:string, webdavUrl?:string, username?:string, password?:string,
     *          authType?:'basic'|'bearer'|'none', token?:string, timeout?:number}} options
     */
    constructor(options) {
      const opts = options || {};
      const raw = String(opts.url || opts.webdavUrl || '').trim();
      if (!raw) throw new WebDavError('尚未填写 WebDAV 文件地址', { code: 'config' });
      this.url = normalizeUrl(raw);
      this.authType = opts.authType || 'basic';
      this.timeout = opts.timeout || DEFAULT_TIMEOUT;
      this.headers = {};

      if (this.authType === 'bearer') {
        const token = String(opts.token || '').trim();
        if (token) this.headers.Authorization = 'Bearer ' + token;
      } else if (this.authType !== 'none') {
        const username = String(opts.username || '');
        const password = String(opts.password || '');
        if (username || password) {
          this.headers.Authorization = 'Basic ' + base64Utf8(username + ':' + password);
        }
      }
    }

    async request(method, url, init) {
      const options = init || {};
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller
        ? setTimeout(() => controller.abort(), this.timeout)
        : null;
      const headers = Object.assign({}, this.headers, options.headers || {});
      try {
        return await fetch(url, {
          method,
          headers,
          body: options.body,
          signal: controller ? controller.signal : undefined,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'follow',
        });
      } catch (err) {
        const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
        throw new WebDavError(
          aborted ? '请求超时（' + this.timeout + 'ms）' : '网络请求失败：' + (err && err.message ? err.message : err),
          { code: 'network' }
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    /** 读取文件；不存在时返回 exists:false */
    async read() {
      const res = await this.request('GET', this.url, {
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      if (res.status === 404 || res.status === 410) {
        return { exists: false, text: '', etag: null, etagWeak: false, lastModified: null };
      }
      if (!res.ok) {
        throw new WebDavError(describeStatus(res.status, '读取失败'), {
          code: res.status === 401 || res.status === 403 ? 'auth' : 'http',
          status: res.status,
          detail: await safeText(res),
        });
      }
      const text = await res.text();
      const contentType = res.headers.get('content-type');
      if (looksLikeHtml(text, contentType)) {
        throw new WebDavError(HTML_HINT, {
          code: 'html',
          status: res.status,
          detail: text.trim().slice(0, 200),
        });
      }
      const etag = res.headers.get('etag');
      return {
        exists: true,
        text,
        etag,
        etagWeak: isWeakTag(etag),
        lastModified: res.headers.get('last-modified'),
      };
    }

    /**
     * 写入文件。
     * - 默认带 If-Match 做乐观锁（冲突抛 code=conflict）
     * - `conditional: false` 时不带 If-Match，直接覆盖（服务器 ETag 不可靠时用）
     */
    async write(text, options) {
      const opts = options || {};
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      const conditional = opts.conditional !== false && !!opts.etag;
      if (conditional) headers['If-Match'] = strongTag(opts.etag);
      if (opts.createDirs) await this.ensureDirs();
      const res = await this.request('PUT', this.url, { headers, body: text });
      if (res.status === 412) {
        const err = new WebDavError(
          '服务器拒绝了条件写入（HTTP 412）：远端可能刚被其他设备改过，或这台服务器不支持 If-Match',
          { code: 'conflict', status: 412 }
        );
        err.weakEtag = isWeakTag(opts.etag);
        err.wasConditional = conditional;
        throw err;
      }
      if (!res.ok) {
        throw new WebDavError(describeStatus(res.status, '保存失败'), {
          code: res.status === 401 || res.status === 403 ? 'auth' : 'http',
          status: res.status,
          detail: await safeText(res),
        });
      }
      return {
        etag: res.headers.get('etag') || null,
        status: res.status,
        lastModified: res.headers.get('last-modified'),
      };
    }

    /** 客户端逐级创建目录（已存在时服务器返回 405，视为成功） */
    async ensureDirs() {
      const dirs = dirChain(this.url);
      for (const dir of dirs) {
        let res;
        try {
          res = await this.request('MKCOL', dir);
        } catch (err) {
          if (err.code === 'network') throw err;
          continue;
        }
        if (res.status === 401) {
          throw new WebDavError('认证失败，无法创建目录', { code: 'auth', status: 401 });
        }
        // 201 创建成功；405 已存在；其它状态（403/409/301…）忽略，交给 PUT 报错
      }
    }

    /** 用 PROPFIND 判断文件是否存在并返回大小 / 修改时间 */
    async stat() {
      const res = await this.request('PROPFIND', this.url, {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body:
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<d:propfind xmlns:d="DAV:"><d:prop>' +
          '<d:getcontentlength/><d:getlastmodified/><d:getetag/>' +
          '</d:prop></d:propfind>',
      });
      if (res.status === 404) return { exists: false };
      if (!res.ok && res.status !== 207) {
        throw new WebDavError(describeStatus(res.status, '探测文件失败'), {
          code: res.status === 401 || res.status === 403 ? 'auth' : 'http',
          status: res.status,
        });
      }
      const xml = await safeText(res);
      const sizeMatch = xml.match(/<[^>]*getcontentlength[^>]*>(\d+)</i);
      const dateMatch = xml.match(/<[^>]*getlastmodified[^>]*>([^<]+)</i);
      return {
        exists: true,
        size: sizeMatch ? Number(sizeMatch[1]) : null,
        lastModified: dateMatch ? dateMatch[1] : null,
      };
    }

    /** 连通性测试：只读不写，绝不影响远端文件 */
    async testConnection() {
      const result = await this.read();
      let stat = null;
      try {
        stat = await this.stat();
      } catch (err) {
        stat = null;
      }
      return {
        ok: true,
        exists: result.exists,
        bytes: result.exists ? new TextEncoder().encode(result.text).length : 0,
        stat,
        etag: result.etag || null,
        etagWeak: !!result.etagWeak,
        message: result.exists
          ? '连接成功，已找到远端文件'
          : '连接成功，远端文件尚不存在（首次保存时会自动创建）',
      };
    }
  }

  async function safeText(res) {
    try {
      const text = await res.text();
      return text.slice(0, 500);
    } catch (err) {
      return '';
    }
  }

  function createClient(options) {
    return new WebDavClient(options);
  }

  return {
    WebDavClient,
    WebDavError,
    createClient,
    normalizeUrl,
    looksLikeHtml,
    strongTag,
    isWeakTag,
    dirChain,
    base64Utf8,
    describeStatus,
    DEFAULT_FILE_NAME,
  };
});
