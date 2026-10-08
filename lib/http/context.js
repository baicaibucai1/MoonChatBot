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
  //
  // ★★ 必须「先收字节、最后一次性解码」，绝不能 `body += chunk`。
  //    `body += chunk` 里 chunk 是 Buffer，会隐式调用 Buffer.prototype.toString()，
  //    也就是**对每一个网络分片单独解码一次**；它等价于 TextDecoder.decode(chunk)，
  //    不带 { stream: true } —— 一个多字节字符（中文 3 字节、emoji 4 字节）只要
  //    恰好被切在分片边界上，两半各自都解不出合法字符，于是**各变成一个 U+FFFD**
  //    （EF BF BD）。前端字体栈把它画成 ♦，看着就像乱码符号。
  //
  //    分片边界由内核/网络决定，同一份请求这次坏、下次不坏 —— 所以这类 bug
  //    在短消息上几乎碰不到，只有长正文（几十 KB）才会稳定复现。它一旦发生
  //    就**已经写进数据里**，事后无法还原（见 tests/http-body.test.mjs）。
  //
  //    正确做法与 lib/models.js / server.js 的流式解码一致：Buffer 一路拼到底，
  //    只在最后 Buffer.concat(...).toString('utf8') 解一次，多字节字符永远完整。
  //
  //    注意体积上限改按**字节**计（原来 body.length 是 UTF-16 码元数）：
  //    这是内存守卫，按字节才是它的本意，中文请求下新阈值更严格也更准。
  const readBody = (cb) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; }
    });
    req.on('end', () => {
      if (tooBig) return send(413, { ok: false, err: '请求体过大（超过 8MB）' });
      const body = Buffer.concat(chunks).toString('utf8');
      try { cb(JSON.parse(body || '{}')); } catch { send(400, { ok: false, err: 'JSON 解析失败' }); }
    });
  };

  return { req, res, p, method: req.method, send, readBody };
}

module.exports = { createContext, MAX_BODY };
