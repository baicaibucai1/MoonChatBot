// lib/net-reach.js 的纯逻辑单测（不建真实连接、不打网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const reach = require('../lib/net-reach.js');

// ---------- isConnError：决定「能不能重试」的判据 ----------
//
// 这条判据是整个模块**最危险**的一处：判宽了会在「服务端已收到请求」时重试，
// 造成重复副作用（比如同一批工具跑两遍）；判窄了则明明能救的连接失败却不救。

test('isConnError：连接 / 握手层的错误码都算（含被中间设备换证、证书过期）', () => {
  const codes = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
    'EAI_AGAIN', 'ERR_SOCKET_CONNECTION_TIMEOUT',
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'UND_ERR_CONNECT_TIMEOUT',
  ];
  for (const code of codes) {
    assert.equal(reach.isConnError(Object.assign(new Error('x'), { code })), true, '顶层 code: ' + code);
    assert.equal(reach.isConnError(Object.assign(new Error('fetch failed'), { cause: { code } })), true, 'cause.code: ' + code);
  }
});

test('★ isConnError：HTTP 层错误**不算** —— 此时请求已被服务端收到，重试会造成重复副作用', () => {
  assert.equal(reach.isConnError(null), false);
  assert.equal(reach.isConnError(undefined), false);
  assert.equal(reach.isConnError(new Error('模型调用失败: 402 余额不足')), false);
  const withStatus = Object.assign(new Error('模型调用失败: 400'), { status: 400 });
  assert.equal(reach.isConnError(withStatus), false);
  const with500 = Object.assign(new Error('模型调用失败: 500'), { status: 500 });
  assert.equal(reach.isConnError(with500), false, '5xx 也不归这里管（上层 withRetry 负责）');
});

test('isConnError：message 像 fetch failed 但**没有 cause** → 不算（避免误判自己抛的错）', () => {
  assert.equal(reach.isConnError(new Error('fetch failed')), false);
  // 有 cause（Undici 的典型表征）才算
  const e = new Error('fetch failed');
  e.cause = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
  assert.equal(reach.isConnError(e), true);
});

// ---------- hostOf ----------

test('hostOf：从 URL 取主机名（IPv6 方括号要剥掉）', () => {
  assert.equal(reach.hostOf('https://api.example.com/v1/chat/completions'), 'api.example.com');
  assert.equal(reach.hostOf('https://[::1]:8080/x'), '::1');
  assert.equal(reach.hostOf('not a url'), '');
  assert.equal(reach.hostOf(''), '');
  assert.equal(reach.hostOf(null), '');
});

// ---------- 缓存 ----------

test('缓存：remember / cached / forget，family 只认 6 与 4', () => {
  reach.remember('unit-a.test', '1.2.3.4', 4);
  assert.equal(reach.cached('unit-a.test').address, '1.2.3.4');
  assert.equal(reach.cached('unit-a.test').family, 4);

  reach.remember('unit-b.test', '2606:4700::1', 6);
  assert.equal(reach.cached('unit-b.test').family, 6);
  // 传别的值一律当 IPv4（避免把 '6' 字符串/undefined 误当 IPv6）
  reach.remember('unit-c.test', '5.6.7.8', 'x');
  assert.equal(reach.cached('unit-c.test').family, 4);

  reach.forget('unit-a.test');
  assert.equal(reach.cached('unit-a.test'), null);

  // 空 host / 空地址不写入
  reach.remember('', '1.1.1.1', 4);
  reach.remember('unit-d.test', '', 4);
  assert.equal(reach.cached('unit-d.test'), null);
});

test('snapshot：能看到当前记住了什么（诊断用）', () => {
  reach.remember('unit-e.test', '9.9.9.9', 4);
  const snap = reach.snapshot();
  assert.equal(snap['unit-e.test'].address, '9.9.9.9');
});

// ---------- dns.lookup 钩子 ----------
//
// ★ 这组测试最关键的一点：钩子**只在有缓存时介入**。
//   介入过宽会让所有域名的解析都被改写（灾难）；介入过窄则探测结果白算。

test('★ dns.lookup 钩子：有缓存的 host → 直接返回缓存地址（不再真的查 DNS）', async () => {
  // 用一个必然不存在的域名：如果钩子没生效，dns 会报 ENOTFOUND
  reach.remember('hooked-not-exist.test', '10.9.9.9', 4);
  const got = await new Promise((res, rej) => {
    dns.lookup('hooked-not-exist.test', (e, address, family) => (e ? rej(e) : res({ address, family })));
  });
  assert.equal(got.address, '10.9.9.9');
  assert.equal(got.family, 4);
});

test('★ dns.lookup 钩子：没有缓存的 host → 完全透传（会正常报 ENOTFOUND）', async () => {
  await assert.rejects(
    new Promise((res, rej) => dns.lookup('no-cache-at-all.test', (e, a) => (e ? rej(e) : res(a)))),
    (e) => e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN',
  );
});

test('★★ dns.lookup 钩子：all:true **也必须介入**，返回只含可用地址的数组', async () => {
  // 为什么这条断言这么重要（踩过的坑）：
  //   Node 20+ 默认开 autoSelectFamily（Happy Eyeballs）时，net 内部用的是
  //   `dns.lookup(host, { all: true })` —— 一次性拿全部地址再自己轮换。
  //   第一版钩子为了「不打扰要全集的调用方」在 all:true 时透传，
  //   结果**等于把自己整个绕开了**：实测往缓存投毒成 127.0.0.1，
  //   fetch 依旧 HTTP 200（它根本没看缓存）。
  //   现在 all:true 返回「只含那一个握手成功地址」的数组，
  //   语义正好是我们想要的：别再让 undici 去试那一堆坏地址。
  reach.remember('all-wanted.test', '10.9.9.9', 4);
  const arr = await new Promise((res, rej) => {
    dns.lookup('all-wanted.test', { all: true }, (e, a) => (e ? rej(e) : res(a)));
  });
  assert.equal(arr.length, 1, '只喂那一个可用地址');
  assert.equal(arr[0].address, '10.9.9.9');
  assert.equal(arr[0].family, 4);
});

test('★ lookupAll 不吃自己的缓存（否则「逐个试」会退化成只剩一个候选可试）', async () => {
  reach.remember('bypass-cache.test', '10.9.9.9', 4);
  // 假域名 + 走 nativeLookup → 真实解析必然失败 → 空数组（而不是返回缓存里那一个）
  const addrs = await reach.lookupAll('bypass-cache.test');
  assert.deepEqual(addrs, [], 'lookupAll 必须拿到真实全集，不能被自己的钩子截断');
});

test('dns.lookup 钩子：显式指定了不匹配的 family → 透传', async () => {
  reach.remember('fam-mismatch.test', '10.9.9.9', 4);   // 缓存是 IPv4
  await assert.rejects(
    new Promise((res, rej) => dns.lookup('fam-mismatch.test', { family: 6 }, (e, a) => (e ? rej(e) : res(a)))),
    (e) => e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN',
  );
});

// ---------- 常量 ----------

test('探测超时与缓存 TTL 是有限值（别写成 0 或 Infinity）', () => {
  assert.ok(reach.PROBE_TIMEOUT > 0 && reach.PROBE_TIMEOUT <= 30000, String(reach.PROBE_TIMEOUT));
  assert.ok(reach.ADDR_TTL > 0 && reach.ADDR_TTL <= 3600000, String(reach.ADDR_TTL));
});
