'use strict';

/**
 * 测试用的极简 WebDAV 服务器（内存存储）。
 * 支持 GET / PUT / MKCOL / PROPFIND，可选 Basic 认证、If-Match 乐观锁。
 *
 * 还能模拟几种「ETag 不好用」的真实服务器：
 *  - weakEtag：返回 W/"..."，但接受去掉 W/ 的强形式（Apache 做 gzip 时的常见行为）
 *  - rotatingEtag：每次请求 ETag 都变（ETag 不是稳定校验符）
 *  - rejectIfMatch：只要带 If-Match 就 412（完全不支持条件写入）
 */
const http = require('node:http');

async function startWebDavServer(options) {
  const opts = options || {};
  const auth = opts.auth || null;
  const putDelayMs = opts.putDelayMs || 0;
  const weakEtag = !!opts.weakEtag;
  const rotatingEtag = !!opts.rotatingEtag;
  const rejectIfMatch = !!opts.rejectIfMatch;
  let etagNonce = 0;

  function etagOf(file) {
    const base = '"' + file.version + (rotatingEtag ? '-' + (etagNonce += 1) : '') + '"';
    return weakEtag ? 'W/' + base : base;
  }
  // 某些路径返回 200 + HTML（模拟「地址指向目录 / 登录页」的真实情况）
  const htmlPages = opts.htmlPages || null;
  const files = new Map();
  const dirs = new Set(['/']);
  const calls = [];
  let version = 0;

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const method = req.method;
    const pathname = decodeURIComponent(parsed.pathname);
    calls.push({
      method,
      path: pathname,
      ifMatch: req.headers['if-match'] || null,
    });

    if (auth) {
      const expected =
        'Basic ' + Buffer.from(auth.username + ':' + auth.password, 'utf8').toString('base64');
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="pwdmg-test"' });
        res.end('unauthorized');
        return;
      }
    }

    if (method === 'GET') {
      if (htmlPages && Object.prototype.hasOwnProperty.call(htmlPages, pathname)) {
        const body = htmlPages[pathname];
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      const file = files.get(pathname);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ETag: etagOf(file),
        'Content-Length': Buffer.byteLength(file.content),
      });
      res.end(file.content);
      return;
    }

    if (method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      const commit = () => {
        const current = files.get(pathname);
        const ifMatch = req.headers['if-match'];
        if (ifMatch) {
          let matched = false;
          if (!rejectIfMatch && current) {
            const expected = etagOf(current);
            matched = ifMatch === expected || ifMatch === expected.replace(/^W\//i, '');
          }
          if (!matched) {
            res.writeHead(412, { 'Content-Type': 'text/plain' });
            res.end('precondition failed');
            return;
          }
        }
        const parent = pathname.replace(/[^/]+\/?$/, '');
        if (!dirs.has(parent)) {
          res.writeHead(409, { 'Content-Type': 'text/plain' });
          res.end('conflict');
          return;
        }
        version += 1;
        files.set(pathname, { content: body, version });
        res.writeHead(current ? 204 : 201, { ETag: etagOf(files.get(pathname)) });
        res.end();
      };

      req.on('end', () => {
        if (putDelayMs > 0) setTimeout(commit, putDelayMs);
        else commit();
      });
      return;
    }

    if (method === 'MKCOL') {
      const dir = pathname.endsWith('/') ? pathname : pathname + '/';
      if (dirs.has(dir)) {
        res.writeHead(405);
        res.end();
        return;
      }
      const parent = dir.replace(/[^/]+\/$/, '');
      if (!dirs.has(parent)) {
        res.writeHead(409);
        res.end();
        return;
      }
      dirs.add(dir);
      res.writeHead(201);
      res.end();
      return;
    }

    if (method === 'PROPFIND') {
      const file = files.get(pathname);
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      const xml =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>' +
        '<d:getcontentlength>' +
        Buffer.byteLength(file.content) +
        '</d:getcontentlength>' +
        '<d:getlastmodified>' +
        new Date().toUTCString() +
        '</d:getlastmodified>' +
        '<d:getetag>' +
        etagOf(file) +
        '</d:getetag>' +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(xml);
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    baseUrl: 'http://127.0.0.1:' + port,
    files,
    dirs,
    calls,
    /** 测试里直接放一个文件，模拟“远端已有数据” */
    seed(filePath, content) {
      version += 1;
      files.set(filePath, { content, version });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startWebDavServer };
