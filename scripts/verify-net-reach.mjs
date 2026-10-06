// 验证 lib/net-reach.js：连接失败时能否自动找到可用地址并恢复
//
// ── 为什么要做这个测试 ──
// 用户报的现象是「对话失败」。排查下来根因在**网络层**，而且这个网络层是**善变**的：
//   · 2026-10-04：Agnes 的 IPv4 被中间设备劫持（换来一张自签证书），IPv6 干净；
//   · 2026-10-05：同一域名换了一批解析结果 —— A 记录是 9 个握手全失败的地址，
//                 AAAA 才是真实可用的 Cloudflare 地址；而几个小时前那批恰好相反。
// 两次都说明：**「哪个地址能用」无法预测，也不能按地址族猜**。
//
// 所以 net-reach 的做法是「解析全部候选 → 逐个做完整 TLS 握手 → 谁通用谁」，
// 并在连接层失败时清缓存、重新探测、重试一次。
//
// ── 这个脚本怎么验证它 ──
// ★★ 关键：**不能只测「现在能连上」** —— 那是网络的功劳，换个时刻就复现不了，
//    而且「兜底路径」根本没被走到（首次就成功 = 兜底是死代码）。
//    做法是**主动投毒**：往缓存里塞一个必然连不上的地址（127.0.0.1），
//    于是请求一定失败 → 必然触发兜底 → 断言它纠正了缓存并且重试成功。
//    这样无论当前网络是什么状态，测的都是**同一件事**，不会 flaky。
//
// ★ 零费用：只请求 `/v1/models`（列模型，不产生推理计费）。
// ★ 打真实网络（被测对象就是它），所以不走沙箱 —— 沙箱会把 baseURL 指向假端点。
//
// 用法：node scripts/verify-net-reach.mjs [host]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const HOST = process.argv[2] || 'apihub.agnes-ai.com';

const reach = require('../lib/net-reach.js');

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : ' —— ' + detail}`);
  if (!ok) fails.push(name);
};

const keyOf = (host) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
    const m = (cfg.models || []).find((x) => String(x.baseURL || '').includes(host));
    return (m && m.apiKey) || '';
  } catch { return ''; }
};

const get = (url, key) => reach.fetchReachable(url, key ? { headers: { Authorization: 'Bearer ' + key } } : {});

async function main() {
  const url = `https://${HOST}/v1/models`;
  const key = keyOf(HOST);
  console.log(`[目标] ${HOST}`);
  console.log(`[Key] ${key ? '已取到（用于把 401 变成 200）' : '未取到 —— 验证到 401 也足以证明连上了'}\n`);

  // ── ① 候选地址 + 逐个地址的完整 TLS 握手（信息性）──
  const addrs = await reach.lookupAll(HOST);
  console.log('[候选地址与握手结果]');
  const results = [];
  if (!addrs.length) {
    console.log('  （DNS 一个地址都没解析出来 —— 网络层完全不通，后面的测试会跳过）');
  }
  for (const a of addrs) {
    const ok = await reach.tlsHandshake(HOST, a.address, 443, 6000);
    results.push({ ...a, ok });
    console.log(`  ${a.family === 6 ? 'IPv6' : 'IPv4'}  ${String(a.address).padEnd(28)} ${ok ? '握手成功' : '不可用'}`);
  }
  const usable = results.filter((r) => r.ok);
  console.log(`  → 可用 ${usable.length} / ${results.length}\n`);

  if (!usable.length) {
    console.log('⚠️ 当前环境下一个可用地址都没有 —— 跳过投毒测试。');
    console.log('   （这种情况下任何实现都无法工作：请求发不出去，探测也救不回来。）');
    console.log('   等网络恢复后重跑即可。');
    process.exitCode = 0;
    return;
  }

  // ── ② ★★ 投毒测试（必须是**对这个 host 的第一次 fetch**）──
  //
  // ★ 为什么顺序这么讲究：undici 有连接池。如果先发过一次成功请求，
  //   后面再投毒也不会生效 —— 请求会**复用那条已建立的连接**，压根不查 DNS。
  //   第一版脚本就是踩了这个：基线跑在投毒之前，于是投毒后仍 HTTP 200、
  //   缓存也没被纠正，看着像「兜底失效」，实际是**测试自己无效**。
  //   所以投毒必须发生在任何成功请求之前。
  const bad = results.find((r) => !r.ok);
  const poisonAddr = bad ? bad.address : '127.0.0.1';
  const poisonFam = bad ? bad.family : 4;
  console.log(`── ② 投毒：把缓存指向 ${poisonAddr}（IPv${poisonFam}）──`);
  console.log(bad ? '  （用的是本次解析里**真实握手失败**的地址，最贴近真实故障）'
    : '  （本次没有坏地址可投，改用 127.0.0.1 —— 必然 ECONNREFUSED）');
  reach.remember(HOST, poisonAddr, poisonFam);
  console.log(`  投毒后缓存：${JSON.stringify(reach.cached(HOST))}`);

  let r1 = null;
  let e1 = '';
  const t1 = Date.now();
  try {
    const r = await get(url, key);
    r1 = r.status;
  } catch (e) {
    e1 = String((e.cause && e.cause.code) || e.message);
  }
  const after = reach.cached(HOST);
  console.log(`  fetchReachable → ${r1 !== null ? 'HTTP ' + r1 : '失败 ' + e1}（${Date.now() - t1}ms）`);
  console.log(`  纠正后缓存：${JSON.stringify(after)}`);

  check('★★ 投毒后仍然拿到了响应（兜底真的把请求救回来了）', r1 !== null, e1);
  check('★★ 缓存被纠正掉了坏地址', !!after && after.address !== poisonAddr, JSON.stringify(after));
  check('★ 纠正后的地址**确实**是握手能成功的那个',
    !!after && usable.some((u) => u.address === after.address), JSON.stringify(after));

  // ── ③ 基线（未投毒）── 信息性：确认常规路径也通
  console.log('\n── ③ 基线（已纠正，正常路径）──');
  let base = null;
  try {
    const r = await get(url, key);
    base = r.status;
    console.log(`  fetchReachable → HTTP ${base}`);
  } catch (e) {
    console.log(`  失败：${(e.cause && e.cause.code) || e.message}`);
  }
  check('基线能拿到响应（HTTP 200/401 都算连上）', base !== null, String(base));

  console.log(`\n结果：${fails.length ? '❌ ' + fails.length + ' 项失败' : '✅ 全部通过'}`);
  if (fails.length) console.log('失败项：', fails.join('、'));
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
