// 出站连通性诊断：把「对话失败」的根因从「应用代码」里摘出去
//
// 本机已知问题（2026-10-04 实测）：Agnes 两个端点的 IPv4 路径被中间设备劫持
//   （自签证书 SAN=localhost/127.0.0.1，签发者 CN=redirect-cnzz），只有 IPv6 干净。
// server.js 靠 `dns.setDefaultResultOrder('ipv6first')` + 关掉并发试探来绕开。
//
// 这个脚本做的事：
//   ① 解析每个模型端点的 A / AAAA 记录（有没有 IPv6 可用，一眼看出）
//   ② 对**每个解析出的地址**做 TCP 连通性测试（区分「不通」还是「通了但 TLS 被换证」）
//   ③ 按 server.js 的同一套设置发起一次真实 HTTPS 请求，取自签证书的 subject/issuer
//
// 全程零费用：只请求 `/v1/models`（列模型，不产生推理计费），且失败也只是记录。
//
// 用法：node scripts/probe-reach.mjs

import dns from 'node:dns';
import net from 'node:net';
import https from 'node:https';

// 与 server.js 完全一致的出站偏好设置
dns.setDefaultResultOrder('ipv6first');
if (typeof net.setDefaultAutoSelectFamily === 'function') net.setDefaultAutoSelectFamily(false);

const HOSTS = [
  'apihub.agnes-ai.com',      // Agnes（ARC1 写手当前绑定的就是它）
  'api.agnes-ai.cn',          // Agnes 国内站
  'api.deepseek.com',         // 鲸鱼
  'api.siliconflow.cn',       // 硅基流动
];

const lookupAll = (host) => new Promise((res) => {
  dns.lookup(host, { all: true }, (e, addrs) => res(e ? { err: e.message } : { addrs }));
});

const tcpTest = (host, addr, family, ms = 6000) => new Promise((res) => {
  const t0 = Date.now();
  const s = net.connect({ host: addr, port: 443, family }, () => {
    const t = Date.now() - t0;
    s.destroy();
    res({ ok: true, ms: t });
  });
  s.setTimeout(ms);
  s.on('timeout', () => { s.destroy(); res({ ok: false, ms: Date.now() - t0, why: '超时' }); });
  s.on('error', (err) => res({ ok: false, ms: Date.now() - t0, why: err.code || err.message }));
});

// 按 server.js 的设置发一次真实请求，并取回证书信息
const httpsProbe = (host, path = '/v1/models', ms = 12000) => new Promise((res) => {
  const t0 = Date.now();
  const req = https.request({
    host, port: 443, path, method: 'GET',
    headers: { 'User-Agent': 'reach-probe' },
    timeout: ms,
  }, (r) => {
    let n = 0;
    r.on('data', (c) => { n += c.length; });
    r.on('end', () => res({
      ok: true, status: r.statusCode, ms: Date.now() - t0, bytes: n,
      cert: req.socket?.getPeerCertificate?.() ? {
        subject: req.socket.getPeerCertificate().subject,
        issuer: req.socket.getPeerCertificate().issuer,
        san: req.socket.getPeerCertificate().subjectaltname,
      } : null,
    }));
  });
  req.on('timeout', () => { req.destroy(); res({ ok: false, why: '超时', ms: Date.now() - t0 }); });
  req.on('error', (err) => res({ ok: false, why: err.code || err.message, ms: Date.now() - t0 }));
  req.end();
});

// ★ 强制把域名解析到**指定地址**再发请求 —— 用来证明「同一个域名、同一时刻，
//   换一个地址就通」，从而把「轮换池里部分地址坏」与「整个端点挂了」区分开。
const httpsProbeAddr = (host, addr, family, path = '/v1/models', ms = 12000) => new Promise((res) => {
  const t0 = Date.now();
  const req = https.request({
    host, port: 443, path, method: 'GET',
    headers: { 'User-Agent': 'reach-probe' },
    timeout: ms,
    // 关键：覆盖 DNS 解析，强制走这一个地址（Node 会按这里给的 family 连）
    lookup: (_h, _o, cb) => cb(null, addr, family),
  }, (r) => {
    let n = 0;
    r.on('data', (c) => { n += c.length; });
    r.on('end', () => {
      const cert = req.socket?.getPeerCertificate?.();
      res({
        ok: true, status: r.statusCode, ms: Date.now() - t0, bytes: n,
        issuer: cert && (cert.issuer?.CN || cert.issuer?.O) || '',
        san: cert && cert.subjectaltname || '',
      });
    });
  });
  req.on('timeout', () => { req.destroy(); res({ ok: false, why: '超时', ms: Date.now() - t0 }); });
  req.on('error', (err) => res({ ok: false, why: err.code || err.message, ms: Date.now() - t0 }));
  req.end();
});

// 逐地址强制测试：把「哪一个地址能用」一次问清楚
async function perAddress(host) {
  const { addrs } = await lookupAll(host);
  if (!addrs) return;
  console.log(`\n  ── 逐地址强制测试 ${host}（绕过 DNS 轮换，直接指定）──`);
  for (const a of addrs) {
    const r = await httpsProbeAddr(host, a.address, a.family);
    const fam = a.family === 6 ? 'IPv6' : 'IPv4';
    if (r.ok) {
      const bad = /redirect|localhost/i.test(r.issuer + r.san);
      console.log(`  ${fam} ${a.address} → HTTP ${r.status}（${r.ms}ms）签发者=${r.issuer || '?'}${bad ? ' ⚠️ 疑似中间设备证书' : ''}`);
    } else {
      console.log(`  ${fam} ${a.address} → 失败 ${r.why}（${r.ms}ms）`);
    }
  }
}

async function main() {
  for (const host of HOSTS) {
    console.log('\n' + '='.repeat(64));
    console.log('主机:', host);
    const { err, addrs } = await lookupAll(host);
    if (err) { console.log('  DNS 解析失败:', err); continue; }
    const v4 = addrs.filter((a) => a.family === 4).map((a) => a.address);
    const v6 = addrs.filter((a) => a.family === 6).map((a) => a.address);
    console.log('  A   :', v4.length ? v4.join(', ') : '（无）');
    console.log('  AAAA:', v6.length ? v6.join(', ') : '（无）');
    // ★ 按 dns 的排序结果逐个 TCP 测（第一个就是 server.js 会优先连的那个）
    for (const a of addrs.slice(0, 4)) {
      const r = await tcpTest(host, a.address, a.family);
      console.log(`  TCP [${a.family === 6 ? 'IPv6' : 'IPv4'}] ${a.address} → ${r.ok ? '通 ' + r.ms + 'ms' : '失败 ' + r.why}`);
    }
    const h = await httpsProbe(host);
    if (h.ok) {
      console.log(`  HTTPS → HTTP ${h.status}（${h.ms}ms, ${h.bytes}B）`);
      if (h.cert) {
        const iss = h.cert.issuer && (h.cert.issuer.CN || h.cert.issuer.O) || '?';
        console.log(`        证书签发者: ${iss}　SAN: ${h.cert.san || '（无）'}`);
        // ★ 自签 / CN=redirect-cnzz 是「被透明代理 MITM」的铁证
        if (/redirect|localhost/i.test(iss + (h.cert.san || ''))) {
          console.log('        ⚠️ 这是**中间设备换的证书**，不是真端点 —— 该地址族的路径被劫持');
        }
      }
    } else {
      console.log(`  HTTPS → 失败: ${h.why}（${h.ms}ms）`);
    }
  }

  // ★ 关键一步：对 Agnes 两个端点逐地址强制测试。
  //   如果「某些地址通、某些地址挂」，那问题就是**地址级**的（轮换池里有坏节点），
  //   而不是端点整体不可用 —— 修法是「逐个试到握手成功」，不是「换个端点」。
  console.log('\n' + '='.repeat(64));
  console.log('逐地址强制测试（回答「是某些 IP 坏，还是整个端点坏了」）');
  for (const host of ['apihub.agnes-ai.com', 'api.agnes-ai.cn']) {
    await perAddress(host);
  }

  console.log('\n' + '='.repeat(64));
  console.log('提示：若某端点 IPv6 通、IPv4 失败/换证，说明它就是记忆里那个「只有 IPv6 能通」的端点；');
  console.log('     此时对话失败应归因于网络（而非应用代码），server.js 顶部的 ipv6first 就是为此而设。');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
