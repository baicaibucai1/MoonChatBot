// 走本地 HTTP 代理（CONNECT 隧道）测一次 chat/completions，对比「直连」
// 用法：node scripts/probe-via-proxy.mjs [模型id]
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const PROXY = new URL(process.env.HTTPS_PROXY || 'http://127.0.0.1:65459');
const want = process.argv[2] ? String(process.argv[2]) : '';

// 用 CONNECT 建立代理隧道，返回一个可用的 net.Socket
function tunnel(host, port, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY.hostname, port: Number(PROXY.port), method: 'CONNECT', path: host + ':' + port,
      headers: { Host: host + ':' + port },
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('代理 CONNECT 超时')); });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('代理返回 ' + res.statusCode));
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

async function callViaProxy(m, key) {
  const host = new URL(m.baseURL).host;
  const socket = await tunnel(host, 443);
  const t0 = Date.now();
  const body = JSON.stringify({ model: m.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
  return new Promise((resolve) => {
    const req = https.request({
      servername: host, host, path: '/v1/chat/completions', method: 'POST',
      socket, agent: false,
      headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body), Host: host,
      },
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: s.slice(0, 200), ms: Date.now() - t0 }));
    });
    req.on('error', (e) => resolve({ ok: false, err: e.message, ms: Date.now() - t0 }));
    req.setTimeout(25000, () => { req.destroy(new Error('请求超时')); });
    req.write(body);
    req.end();
  });
}

for (const m of cfg.models || []) {
  if (want && m.id !== want) continue;
  const key = m.apiKey || process.env[m.apiKeyEnv || ''] || '';
  if (!key) { console.log('\n' + m.id + ' —— 无 Key，跳过'); continue; }
  console.log('\n══════ ' + m.id + '（' + new URL(m.baseURL).host + '）走代理 ' + PROXY.host + ' ══════');
  const r = await callViaProxy(m, key);
  if (r.ok) console.log('  ✅ HTTP ' + r.status + '  ' + r.body.replace(/\s+/g, ' ') + '  (' + r.ms + 'ms)');
  else console.log('  ❌ ' + r.err + '  (' + r.ms + 'ms)');
}
process.exit(0);
