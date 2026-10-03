// 静态资源与跨域：MIME 表、CORS 放行、预检拦截、面板与头像文件服务
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// ---- 桌面壳（Tauri）跨域放行 ----
// 浏览器直连面板时是「同源」，不需要 CORS；但 Tauri 壳把前端从
// http://tauri.localhost 加载，再调 http://127.0.0.1:<port> 的 API 就成了跨域。
// WebView2 和浏览器一样会执行同源策略，服务端不放行就会得到无信息的
// "Failed to fetch"。这里只放行已知的本地壳来源，不开放通配。
// 注意各平台 origin 不同：Windows/Android 是 http(s)://tauri.localhost，
// macOS/Linux 是 tauri://localhost。
const CORS_ORIGINS = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
  'http://localhost:1420',   // Vite 开发服务器（tauri dev）
  'http://127.0.0.1:1420',
]);

// 跨域放行（桌面壳）：先挂响应头，再拦截预检
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// 预检请求：返回 true 表示已应答
function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204);
  res.end();
  return true;
}

// 面板静态资源与头像文件；返回 true 表示已应答（含 404）
function serveStatic(req, res, p, dirs) {
  const { PUBLIC_DIR, AVATAR_DIR } = dirs;

  // ---- 头像静态资源（/avatars/*） ----
  if (p.startsWith('/avatars/')) {
    const full = path.join(AVATAR_DIR, path.basename(p));
    if (!full.startsWith(AVATAR_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return true;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(full).pipe(res);
    return true;
  }

  // ---- 静态面板 ----
  const file = p === '/' ? 'index.html' : p.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return true;
  }
  const ext = path.extname(full).toLowerCase();
  // 面板页面/脚本/样式不做缓存，保证改版后刷新即可看到最新界面
  const noCache = ['.html', '.js', '.css'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ...(noCache ? { 'Cache-Control': 'no-cache' } : {}),
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

module.exports = { MIME, CORS_ORIGINS, applyCors, handlePreflight, serveStatic };
