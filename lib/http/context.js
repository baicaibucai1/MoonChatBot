// HTTP 请求上下文 —— 每个请求都要用的响应/读体工具
// 拆分前这两个闭包写死在 server.js 的 handleApi 里，导致任何一条路由都无法脱离
// 那个 703 行的函数单独测试；提出来后路由处理器只依赖 ctx。
'use strict';

// 请求体上限 8MB，防超大请求耗尽内存
const MAX_BODY = 8 * 1024 * 1024;

function createContext(req, res, p) {
  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  // 读取 JSON 请求体（限制最大 8MB，防超大请求耗尽内存）
  const readBody = (cb) => {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY) { tooBig = true; body = ''; }
    });
    req.on('end', () => {
      if (tooBig) return send(413, { ok: false, err: '请求体过大（超过 8MB）' });
      try { cb(JSON.parse(body || '{}')); } catch { send(400, { ok: false, err: 'JSON 解析失败' }); }
    });
  };

  return { req, res, p, method: req.method, send, readBody };
}

module.exports = { createContext, MAX_BODY };
