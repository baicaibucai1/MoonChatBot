// 出站可达性：逐个候选地址试到**握手成功**，谁通用谁
// ------------------------------------------------------------------
// ★★ 为什么需要它（2026-10-05 实测，血的教训）：
//
// 这台机器上 Agnes 端点的地址可用性**会变**，而且变过两次、方向相反：
//   · 2026-10-04：IPv4 被中间设备劫持（握手换来一张自签证书，SAN=localhost/127.0.0.1），
//                 IPv6 干净 → 当时的对策是 `dns.setDefaultResultOrder('ipv6first')`。
//   · 2026-10-05：**反过来了** —— IPv4 完全正常，IPv6 两个地址一个超时、
//                 一个 CERT_HAS_EXPIRED。于是那道「修复」变成故障源：
//                 每次调模型都失败，用户看到的就是「对话失败」。
//
// 两次都栽在同一个思维上：**把「此刻哪条路能走」写死进代码**。
// 这类假设有保质期，而失效时的症状是「功能整体不可用」，极难联想到网络。
//
// 本模块换一种做法 —— **不做任何环境假设**：
//   ① 解析出该主机的**全部**候选地址（A + AAAA）；
//   ② 对每个地址做一次**完整 TLS 握手**（含证书校验），只有握手成功才算可用；
//   ③ 记住第一个可用地址，之后该主机的请求直接走它；
//   ④ 请求在**连接层**失败时，清缓存 → 重新探测 → 重试一次。
//
// 为什么必须做 TLS 握手而不是只测 TCP：
//   apihub 的 IPv6 `…2018::2` **TCP 是通的**（所以只看 TCP 会选中它），
//   但 TLS 阶段报 CERT_HAS_EXPIRED —— 只测 TCP 等于没测。
//
// 为什么用「覆写 dns.lookup」而不是给 fetch 传 dispatcher：
//   项目没有依赖 undici（`require('undici')` 是 MODULE_NOT_FOUND），
//   拿不到 Agent 类，也就没法给 fetch 指定连接地址。
//   而 Node 的 `net.connect` 在**运行时**读 `dns.lookup`（`options.lookup || dns.lookup`），
//   所以覆写它对 fetch 一样生效 —— 且我们只在**有缓存**时介入，其余完全透传，
//   对其它域名零影响。
//
// 重试安全吗：安全。触发条件是**连接层**错误（根本没能建立连接 / 握手失败），
//   此时请求字节还没发出去，不会造成「服务端收到两次」这种副作用。
//   这与「HTTP 已返回但解析失败」是两回事，后者绝不重试。
// ------------------------------------------------------------------
'use strict';
const dns = require('node:dns');
const tls = require('node:tls');

// 缓存存活时间。地址可用性会变，但不能每次请求都重新探测（探测最坏要 5s）。
const ADDR_TTL = 10 * 60 * 1000;
// 单个候选地址的握手超时。取 5s：够慢地址完成握手，又不至于让探测整体太久
//（候选是**并发**探测的，所以总耗时 ≈ 单个超时，不是累加）。
const PROBE_TIMEOUT = 5000;
const TLS_PORT = 443;

// host → { address, family, ts }
const cache = new Map();
let installed = false;

// ★★ 模块加载时就抓一份**原始** dns.lookup 的引用。
//   两个用途，缺一不可：
//     ① 钩子透传时用它 —— 否则会递归调用自己；
//     ② 本模块自己的探测（lookupAll）用它 —— 探测必须拿到**全部候选地址**，
//        不能吃我们自己的缓存，否则「逐个试」会退化成「只有一个候选可试」。
const nativeLookup = dns.lookup.bind(dns);

// ---------- 缓存 ----------

function remember(host, address, family) {
  const h = String(host || '').trim();
  if (!h || !address) return;
  cache.set(h, { address: String(address), family: Number(family) === 6 ? 6 : 4, ts: Date.now() });
}

function forget(host) {
  cache.delete(String(host || '').trim());
}

function cached(host) {
  const h = String(host || '').trim();
  const hit = cache.get(h);
  if (!hit) return null;
  if (Date.now() - hit.ts > ADDR_TTL) { cache.delete(h); return null; }
  return hit;
}

// 供诊断/测试用：看当前记住了什么
function snapshot() {
  return Object.fromEntries([...cache.entries()].map(([k, v]) => [k, { ...v }]));
}

// ---------- 探测 ----------

// 解析该主机的全部候选地址（A + AAAA）。失败返回空数组。
// ★ 用 nativeLookup（绕过本模块的钩子）：探测要的是**真实的全集**，
//   吃了缓存就只剩一个候选，「逐个试」这个前提就没了。
function lookupAll(host) {
  return new Promise((resolve) => {
    nativeLookup(host, { all: true }, (err, addrs) => {
      if (err || !Array.isArray(addrs)) return resolve([]);
      resolve(addrs.map((a) => ({ address: a.address, family: a.family })));
    });
  });
}

// 对一个地址做**完整** TLS 握手。成功（含证书校验通过）返回 true。
function tlsHandshake(host, address, port = TLS_PORT, timeoutMs = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    let settled = false;
    let sock = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* 已关闭 */ }
      resolve(ok);
    };
    try {
      sock = tls.connect({
        host: address,
        port,
        // ★ SNI 必须填**域名**：填 IP 会让服务端按「无 SNI」处理，证书也可能对不上
        servername: host,
        // ★ 必须校验证书：证书过期 / 被中间设备换证，都要判成「此地址不可用」
        rejectUnauthorized: true,
      }, () => done(true));
    } catch { return done(false); }
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('error', () => done(false));
  });
}

// 探测出该主机**第一个握手成功**的地址。
// ★ 并发探测 + 按解析顺序取第一个成功者：
//   并发是为了让总耗时 ≈ 单个超时（而不是把每个坏地址的超时累加上去），
//   保序是为了让结果**确定**（不受响应先后影响，同一个网络环境下每次选到同一个）。
async function probeHost(host, port = TLS_PORT) {
  const addrs = await lookupAll(host);
  if (!addrs.length) return null;
  const results = await Promise.all(addrs.map((a) => tlsHandshake(host, a.address, port)));
  const i = results.findIndex(Boolean);
  return i >= 0 ? addrs[i] : null;
}

// ---------- dns.lookup 钩子 ----------

// 覆写 dns.lookup：**只在该主机有可用地址缓存时**介入，其余一律透传。
// 这样即使探测出问题，也只影响「探测过的那些主机」，不会波及别的域名。
// 覆写 dns.lookup：**只在该主机有可用地址缓存时**介入，其余一律透传。
// 这样即使探测出问题，也只影响「探测过的那些主机」，不会波及别的域名。
//
// ★★ 为什么必须连 `{ all: true }` 也一起接管（踩过的坑，务必看清）：
//   Node 20+ 默认开启 autoSelectFamily（Happy Eyeballs），走到那条路径时
//   `net` 内部是用 **`dns.lookup(host, { all: true })`** 一次性拿**全部**地址，
//   然后自己去并发/轮换尝试。
//   第一版钩子为了「不打扰明确要全集的调用方」，在 all:true 时直接透传 ——
//   结果**等于把自己整个绕开了**：实测往缓存里投毒成 127.0.0.1，
//   `fetch` 依旧返回 HTTP 200（它根本没走缓存，而是自己拿到真实地址去连了）。
//   现在 all:true 时也介入，返回**只含那一个可用地址**的数组 ——
//   这正是我们想要的语义：探测已经确认它可用，就别再让 undici 去试那堆坏地址了。
function installDnsHook() {
  if (installed) return;
  installed = true;
  dns.lookup = function lookup(hostname, options, callback) {
    // 归一化签名：lookup(host, cb) / lookup(host, opts, cb) / lookup(host, family, cb)
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') return nativeLookup(hostname, options, callback);

    const hit = cached(hostname);
    if (hit) {
      const opts = (options && typeof options === 'object') ? options : null;
      const wantFam = opts ? opts.family : options;   // 数字形式（4/6）也在这一支
      if (!wantFam || Number(wantFam) === hit.family) {
        if (opts && opts.all === true) {
          process.nextTick(() => callback(null, [{ address: hit.address, family: hit.family }]));
          return;
        }
        process.nextTick(() => callback(null, hit.address, hit.family));
        return;
      }
    }
    return nativeLookup(hostname, options, callback);
  };
}

// ---------- 连接层错误的判据 ----------

// 这些码都代表「连接/握手阶段就没成」—— 请求字节尚未发出，重试是安全的。
const CONN_CODES = new Set([
  // TCP / DNS 层
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ENETDOWN',
  // TLS 层（含被中间设备换证 / 证书过期 / 域名不匹配）
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  // undici 自己包装的
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

function isConnError(err) {
  if (!err) return false;
  // ★ 主动中断不是「连不上」（2026-10-09）：用户点「停止」时 fetch 会抛 AbortError，
  //   它跟连接层错误的表征很像（都是 fetch 失败、没有 HTTP 状态码），
  //   若被误判成连接错误，这里会**清缓存 + 重新探测 + 再发一次请求** ——
  //   用户点了停止，服务端却偷偷又起了一个模型调用。必须在最前面挡掉。
  if (err.name === 'AbortError' || (err.cause && err.cause.name === 'AbortError')) return false;
  const c = err.cause || err;
  const code = String((c && c.code) || '');
  if (code === 'ABORT_ERR') return false;
  if (CONN_CODES.has(code)) return true;
  // fetch 的失败会被包成 TypeError('fetch failed')，真因在 cause 里。
  // 有 cause 且不像 HTTP 错误 → 按连接层处理（这正是 Undici 的表征）。
  return /fetch failed/i.test(String(err.message || '')) && !!err.cause;
}

// ---------- 对外：带可达性兜底的 fetch ----------

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; }
}

// ★ 连接层失败 → 探测该主机 → 记住可用地址 → 重试一次。
//   成功路径**零额外开销**（不预探测、不加延迟）；只有真失败过一次才付出探测代价，
//   之后 10 分钟内该主机都直接命中缓存。
async function fetchReachable(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isConnError(err)) throw err;
    const host = hostOf(url);
    if (!host) throw err;
    // 缓存里那个地址可能已失效（地址可用性会变）→ 清掉重新探测
    forget(host);
    let best = null;
    try { best = await probeHost(host); } catch { best = null; }
    if (!best) throw err;   // 一个候选都不通：原样抛出，交给上层的重试/报错
    remember(host, best.address, best.family);
    console.log(`[net] ${host} 连接失败，已切换到可用地址 ${best.address}（IPv${best.family}）并重试`);
    return fetch(url, init);   // 重试：这次 dns.lookup 会命中缓存
  }
}

// 预热：启动时对若干主机做一次探测并缓存，避免「第一次对话先失败一次再重试」。
// 刻意**不阻塞启动**：失败/超时都只是没预热成功，后面照样靠 fetchReachable 兜底。
async function warmup(hosts = []) {
  const uniq = [...new Set((hosts || []).map((h) => String(h || '').trim()).filter(Boolean))];
  for (const host of uniq) {
    if (cached(host)) continue;
    try {
      const best = await probeHost(host);
      if (best) {
        remember(host, best.address, best.family);
        console.log(`[net] 预热 ${host} → ${best.address}（IPv${best.family}）`);
      } else {
        console.log(`[net] 预热 ${host} → 没有可用地址（该端点的所有 IP 都握手失败）`);
      }
    } catch { /* 预热失败不影响任何事 */ }
  }
}

module.exports = {
  installDnsHook,
  fetchReachable,
  probeHost,
  warmup,
  remember,
  forget,
  cached,
  snapshot,
  isConnError,
  lookupAll,
  tlsHandshake,
  hostOf,
  ADDR_TTL,
  PROBE_TIMEOUT,
};

// 模块加载即安装钩子（幂等）：这样任何 require 到本模块的入口都自动生效，
// 不用记得在每个入口里手动调一次。
installDnsHook();
