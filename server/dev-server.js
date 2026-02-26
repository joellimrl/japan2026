// Minimal local dev server for Japan 2026 site
// - Serves the static site from the repo root
// - Proxies /api/* to https://streetbot.fly.dev/* so the browser avoids CORS locally
//
// Usage (Node 18+):
//   node server/dev-server.js
// Optional env:
//   PORT=8787
//   TARGET=https://streetbot.fly.dev

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');

const PORT = Number.parseInt(process.env.PORT || '5500', 10);
const TARGET = String(process.env.TARGET || 'https://streetbot.fly.dev').replace(/\/$/, '');

const ROOT_DIR = path.resolve(__dirname, '..');

let reqSeq = 0;

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  // eslint-disable-next-line no-console
  console.log(`[${nowIso()}] ${line}`);
}

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function formatReq(req, url) {
  const method = String(req.method || 'GET').toUpperCase();
  const pathAndQuery = url ? `${url.pathname}${url.search}` : String(req.url || '/');
  return `${method} ${pathAndQuery}`;
}

function isLocalhost(req) {
  const host = String(req.headers.host || '');
  return host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host === 'localhost' || host === '127.0.0.1';
}

function safeJoin(root, urlPathname) {
  const cleaned = urlPathname.split('?')[0].split('#')[0];
  const rel = cleaned.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root)) {
    return null;
  }
  return abs;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function filterRequestHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();

    // Hop-by-hop / proxy-managed headers
    if (
      key === 'host' ||
      key === 'connection' ||
      key === 'keep-alive' ||
      key === 'proxy-authenticate' ||
      key === 'proxy-authorization' ||
      key === 'te' ||
      key === 'trailer' ||
      key === 'transfer-encoding' ||
      key === 'upgrade'
    ) {
      continue;
    }

    // Avoid compressed upstream responses complicating header passthrough.
    if (key === 'accept-encoding') {
      continue;
    }

    // Origin is irrelevant for server-to-server.
    if (key === 'origin') {
      continue;
    }

    out[key] = v;
  }
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    const key = String(k).toLowerCase();

    // Hop-by-hop headers
    if (key === 'connection' || key === 'transfer-encoding' || key === 'keep-alive' || key === 'upgrade') {
      continue;
    }

    // If Node fetch transparently decompresses, forwarding these can be wrong.
    if (key === 'content-encoding') {
      continue;
    }

    out[key] = v;
  }
  return out;
}

async function handleProxy(req, res) {
  const start = Date.now();
  if (typeof fetch !== 'function') {
    send(res, 500, 'This dev server requires Node 18+ (global fetch).');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) {
    send(res, 404, 'Not found');
    return;
  }

  const upstreamPath = url.pathname.replace(/^\/api/, '');
  const upstreamUrl = `${TARGET}${upstreamPath}${url.search}`;

  const method = String(req.method || 'GET').toUpperCase();
  const headers = filterRequestHeaders(req.headers);

  const hasAuthHeader = Object.prototype.hasOwnProperty.call(headers, 'x-auth');
  log(`[#${req.__id}] proxy -> ${method} ${upstreamUrl} (x-auth: ${hasAuthHeader ? 'present' : 'absent'})`);

  const init = {
    method,
    headers
  };

  if (method !== 'GET' && method !== 'HEAD') {
    const body = await readBody(req);
    log(`[#${req.__id}] proxy body bytes=${body.length}`);
    if (body.length) {
      init.body = body;
    }
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[#${req.__id}] proxy upstream fetch failed: ${msg}`);
    send(res, 502, `Upstream fetch failed: ${msg}`);
    return;
  }

  log(`[#${req.__id}] proxy upstream status=${upstreamRes.status} (${Date.now() - start}ms)`);

  const resHeaders = filterResponseHeaders(upstreamRes.headers);
  let bodyBuf = null;
  try {
    const ab = await upstreamRes.arrayBuffer();
    bodyBuf = Buffer.from(ab);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[#${req.__id}] proxy failed reading upstream body: ${msg}`);
    bodyBuf = Buffer.from('');
  }

  log(`[#${req.__id}] proxy upstream bytes=${bodyBuf.length} (${Date.now() - start}ms)`);

  res.writeHead(upstreamRes.status, {
    ...resHeaders,
    'cache-control': 'no-store',
    'content-length': String(bodyBuf.length)
  });
  res.end(bodyBuf);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;

  if (pathname === '/') {
    pathname = '/index.html';
  }

  const abs = safeJoin(ROOT_DIR, pathname);
  if (!abs) {
    log(`[#${req.__id}] static blocked path=${pathname}`);
    send(res, 400, 'Bad request');
    return;
  }

  let data;
  try {
    data = await fs.readFile(abs);
  } catch {
    log(`[#${req.__id}] static 404 ${pathname}`);
    send(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';

  log(`[#${req.__id}] static 200 ${pathname} (${contentType})`);

  send(res, 200, data, {
    'content-type': contentType
  });
}

const server = http.createServer(async (req, res) => {
  reqSeq += 1;
  req.__id = reqSeq;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    log(`[#${req.__id}] <- ${formatReq(req, url)}`);

    // Local-only guard (very small safety net).
    if (!isLocalhost(req)) {
      log(`[#${req.__id}] blocked non-local host=${String(req.headers.host || '')}`);
      send(res, 403, 'Forbidden');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await handleProxy(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[#${req.__id}] handler error: ${msg}`);
    send(res, 500, `Dev server error: ${msg}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`Dev server running: http://127.0.0.1:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Proxying /api/* -> ${TARGET}/*`);
});
