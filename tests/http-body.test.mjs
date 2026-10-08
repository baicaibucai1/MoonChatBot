// 回归测试：HTTP 请求体必须**按字节收齐、最后一次性解码**，不能按分片各自解码。
//
// 为什么值得单独一个文件：
//   lib/http/context.js 的 readBody 原来写的是 `body += chunk`。chunk 是 Buffer，
//   `+=` 会隐式调用 Buffer.prototype.toString()，也就是**对每一个网络分片单独解码一次**
//   —— 等价于 TextDecoder.decode(chunk)，不带 { stream: true }。一个中文字（3 字节）
//   只要恰好被切在分片边界上，两半各自都解不出合法字符，于是各变成一个 U+FFFD
//   （EF BF BD）。前端字体栈把它画成 ♦，看着就是一串莫名其妙的符号。
//
//   这个缺陷有两点让它极难被抓到，所以必须专门钉住：
//     ① 分片边界由内核/网络决定 —— 同一份请求这次坏、下次不坏，「跑一遍看看」测不出来；
//     ② 短消息几乎碰不到，只有长正文（几十 KB，必然被切进多个 TCP 段）才稳定复现。
//   而它一旦发生就**已经写进数据里**（memory/BOT4 下实测 291 处），事后无法还原 ——
//   属于「错一次就是永久损坏」的那一类，值得两条腿一起守：
//     ① 假请求：分片边界 100% 由测试决定（逐字节切），任何多字节字符都必然跨片；
//     ② 真 HTTP：逐字节走 chunked 传输，让真实解析器吐出成百上千个分片。
//
// 相关（同一个坑的其它落点，勿在新代码里重犯）：
//   lib/models.js:188 / server.js:2479 / public/app.js:4204 都写对了 ——
//   dec.decode(chunk, { stream: true }) + 最后 dec.decode() 冲刷。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createContext, MAX_BODY } from '../lib/http/context.js';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox } from '../scripts/lib/sandbox.mjs';

const REPLACEMENT = '\uFFFD';

// ---------- 分片边界可控的假请求 ----------
// 每次 _read 只吐一片（而不是把写入合并），所以「分片怎么切」完全由测试决定。
// 用下标游标而非 shift()：大正文会切成几万片，shift() 在大数组上是 O(n)。
class ChunkedReq extends Readable {
  constructor(chunks) {
    super();
    this._q = chunks;
    this._i = 0;
  }

  _read() {
    this.push(this._i < this._q.length ? this._q[this._i++] : null);
  }
}

/**
 * 把字节分片喂给真实的 readBody。
 * 成功时返回 { status: 200, parsed }；被 readBody 自己挡下时返回 { status: 413|400 }。
 */
function readBodyWith(chunks) {
  return new Promise((resolve) => {
    const req = new ChunkedReq(chunks);
    const res = {
      status: 0,
      writeHead(code) { this.status = code; },
      end() { resolve({ status: this.status, parsed: undefined }); },
    };
    const ctx = createContext(req, res, '/api/probe');
    ctx.readBody((parsed) => resolve({ status: 200, parsed }));
  });
}

/** 每个字节自成一片 —— 任何多字节字符都必然跨片，是最苛刻的切法。 */
const oneByteEach = (buf) => Array.from({ length: buf.length }, (_, i) => buf.subarray(i, i + 1));

// 混入 1/3/4 字节三种宽度：中文 3 字节、emoji 4 字节、ASCII 1 字节。
// 4 字节字符内部有 3 个可切点，正好覆盖「一个字符被切成两半 / 三半」两种形态。
const MIXED = '银说：炤炤，快来吧 🎈 𝄞 《测试》 汉字 abc 123';

// ---------- ① 单元层：切点可控 ----------

test('逐字节分片：混合宽度文本一字不差，且不产生 U+FFFD', async () => {
  const buf = Buffer.from(JSON.stringify({ text: MIXED }), 'utf8');
  const { status, parsed } = await readBodyWith(oneByteEach(buf));
  assert.equal(status, 200);
  assert.equal(parsed.text, MIXED);
  assert.ok(!parsed.text.includes(REPLACEMENT), '解码后混进了替换字符：' + parsed.text);
});

test('遍历每一个字节边界：所有切法都能完整还原', async () => {
  const obj = { t: MIXED };
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const broken = [];
  for (let i = 1; i < buf.length; i++) {
    const { parsed } = await readBodyWith([buf.subarray(0, i), buf.subarray(i)]);
    if (!parsed || parsed.t !== obj.t) broken.push(i);
  }
  assert.deepEqual(broken, [], `这些切点损坏了内容：${broken.join(',')}`);
});

test('大正文（约 2 万字中文，逐字节分片）完整还原', async () => {
  const text = '银站在廊下，看着雪落。炤炤从身后走来：「今天很冷。」🎈\n'.repeat(600);
  const buf = Buffer.from(JSON.stringify({ text }), 'utf8');
  const { status, parsed } = await readBodyWith(oneByteEach(buf));
  assert.equal(status, 200);
  assert.equal(parsed.text, text);
  assert.ok(!parsed.text.includes(REPLACEMENT), '大正文里出现了 U+FFFD');
});

test('体积守卫：超过 8MB 返回 413；坏 JSON 返回 400；空体按 {} 处理', async () => {
  assert.equal((await readBodyWith([Buffer.alloc(MAX_BODY + 1024, 0x61)])).status, 413);
  // 分片累加也要能触发（不是只看单片）
  assert.equal((await readBodyWith([Buffer.alloc(MAX_BODY, 0x61), Buffer.from('x')])).status, 413);
  assert.equal((await readBodyWith([Buffer.from('{"a":')])).status, 400);
  assert.deepEqual((await readBodyWith([])).parsed, {});
});

// ---------- ② 真 HTTP 层：走真实解析器与真实落盘 ----------

let dir = null;
let srv = null;
let poolId = '';

before(async () => {
  dir = makeSandbox();
  const { port } = await patchSandboxConfig(dir);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  // 取沙箱夹具里第一个池的 id：夹具改了名字也不会让本测试碎掉
  poolId = String((cfg.characterPools || [])[0]?.id || '');
  srv = await startServer(dir, port);
});

after(() => {
  stopServer(srv?.child);
  if (dir) removeSandbox(dir);
});

/** 把 body 逐字节写出去。1 字节 = 1 个 chunked 分块，服务端解析器会吐出上千个分片。 */
function postByteWise(url, buf) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject);
    for (let i = 0; i < buf.length; i++) req.write(buf.subarray(i, i + 1));
    req.end();
  });
}

test('端到端：真 HTTP 逐字节写入，大段中文正文一字不差地落盘', async () => {
  assert.ok(poolId, '沙箱夹具里没有角色池，测试无法进行');
  // 约 1.2 万字 ≈ 36KB：逐字节写出后每个字都被切在分片边界上。
  // 旧实现下这里必然出现成片的 ♦，而且是**写进 config.json** 的那种损坏。
  const persona = '银站在廊下，看着雪落。炤炤从身后走来，说了一句：「今天很冷。」🎈\n'.repeat(300);
  const payload = Buffer.from(JSON.stringify({ name: 'U+FFFD 回归探针', persona }), 'utf8');

  const res = await postByteWise(`${srv.base}/api/pools/${poolId}/characters`, payload);
  assert.equal(res.status, 200, '新建角色失败：' + res.text.slice(0, 300));
  const body = JSON.parse(res.text);
  assert.ok(body.ok, '接口未返回 ok：' + res.text.slice(0, 300));

  // ① 响应体里的正文一字不差
  assert.equal(body.character.persona, persona, '响应体里的正文被改写了');
  assert.ok(!body.character.persona.includes(REPLACEMENT), '响应体里出现了 U+FFFD');

  // ② 真正落盘的数据也一字不差（响应对了不等于存对了）
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const stored = (cfg.characterPools || [])
    .flatMap((p) => p.characters || [])
    .find((c) => c.id === body.character.id);
  assert.ok(stored, '落盘的 config.json 里找不到刚建的角色');
  assert.equal(stored.persona, persona, '落盘的正文被改写了');
  assert.ok(!stored.persona.includes(REPLACEMENT), '落盘数据里出现了 U+FFFD');
});
