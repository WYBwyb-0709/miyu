#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════
   static-server.mjs · 静态站点与 PWA 本地服务器
   仅用于分享 / 安装 PWA / 自动化测试，不参与聊天协议。
   ══════════════════════════════════════════════════════════ */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function lanAddresses(port) {
  const out = [];
  for (const rows of Object.values(networkInterfaces())) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || row.internal) continue;
      if (row.family !== 'IPv4' && row.family !== 4) continue;
      if (!row.address || row.address.startsWith('169.254.')) continue;
      out.push(`http://${row.address}:${port}`);
    }
  }
  return out;
}

export function startStaticServer(options = {}) {
  const root = resolve(options.root || 'app/www');
  const host = options.host || '127.0.0.1';
  const port = Number.isFinite(options.port) ? options.port : 8080;

  const server = createServer((req, res) => {
    const headers = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400, headers);
      res.end('Bad Request');
      return;
    }

    if (pathname === '/health') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, app: 'miyu', time: Math.floor(Date.now() / 1000) }));
      return;
    }

    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403, headers);
      res.end('Forbidden');
      return;
    }

    let target = file;
    let stat = null;
    try {
      stat = statSync(target);
      if (stat.isDirectory()) {
        target = resolve(target, 'index.html');
        stat = statSync(target);
      }
    } catch {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      ...headers,
      'Content-Type': type,
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target).on('error', () => {
      try { res.destroy(); } catch { /* 忽略 */ }
    }).pipe(res);
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const actual = address && typeof address === 'object' ? address.port : port;
      resolvePromise({
        server,
        port: actual,
        host,
        url: `http://127.0.0.1:${actual}`,
        lanUrls: host === '0.0.0.0' ? lanAddresses(actual) : [],
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const root = resolve(process.env.APP_ROOT || 'app/www');
  const port = Number(process.env.PORT || 8080);
  const lan = process.env.LAN === '1';
  const instance = await startStaticServer({
    root,
    port,
    host: lan ? '0.0.0.0' : '127.0.0.1',
  });
  console.log('密语静态服务器已启动');
  console.log(`  本机：${instance.url}`);
  if (lan) {
    const urls = instance.lanUrls;
    console.log(urls.length ? `  局域网：${urls.join('  ')}` : '  局域网：未检测到 IPv4 地址');
    console.log('  提示：Android Chrome 打开局域网地址后，可“添加到主屏幕”安装 PWA。');
  } else {
    console.log('  局域网：未开启（设置 LAN=1 开启）');
  }
  const stop = async () => {
    try { await instance.close(); } catch { /* 忽略 */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
