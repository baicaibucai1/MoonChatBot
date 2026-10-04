// 端点连通性体检：DNS → TCP → TLS → 一次极小 chat/completions（含可选项：走 HTTP_PROXY）
// 用法：node scripts/probe-endpoints.mjs
import fs from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const keyOf = (m) => m.apiKey || process.env[m.apiKeyEnv || ''] || '';

const line = (s) => console.log(s);

for (const m of cfg.models || []) {
  const host = new URL((m.baseURL || '').replace(/\/?$/, '/')).host;
  line('\n══════ ' + m.id + '  ' + m.name + ' ══════');
  line('  baseURL : ' + m.baseURL);
  line('  model   : ' + m.model);
  line('  key     : ' + (keyOf(m) ? String(keyOf(m)).slice(0, 6) + '…' : '❌ 未提供'));
  line('  proxy   : ' + (process.env.HTTPS_PROXY || '(无)'));

  // 1) DNS
  const addrs = await new Promise((r) => dns.lookup(host, { all: true }, (e, a) => r(e ? null : a)));
  line('  ① DNS   : ' + (addrs ? addrs.map((x) => x.address).join(' ') : '❌ 失败'));

  // 2) TCP:443
  const tcp = await new Promise((r) => {
    const s = net.createConnection({ host, port: 443 });
    const t = setTimeout(() => { try { s.destroy(); } catch {} r('timeout'); }, 6000);
    s.on('connect', () => { clearTimeout(t); s.destroy(); r('ok'); });
    s.on('error', (e) => { clearTimeout(t); r(e.code); });
  });
  line('  ② TCP   : ' + tcp + (tcp === 'ok' ? '' : '  ← 直连失败'));

  // 3) TLS 握手（含证书链）
  const tlsR = await new Promise((r) => {
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true });
    const t = setTimeout(() => { try { s.destroy(); } catch {} r('timeout'); }, 8000);
    s.on('secureConnect', () => { clearTimeout(t); const c = s.getPeerCertificate(true); s.destroy(); r('ok sni=' + host + ' issuer=' + ((c && c.issuer && c.issuer.O) || '?')); });
    s.on('error', (e) => { clearTimeout(t); r(e.code || e.message); });
  });
  line('  ③ TLS   : ' + tlsR);

  // 4) 真实请求（极小）
  const t0 = Date.now();
  let out;
  try {
    const r = await fetch((m.baseURL || '').replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + keyOf(m) },
      body: JSON.stringify({ model: m.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(20000),
    });
    const txt = await r.text();
    out = 'HTTP ' + r.status + '  ' + txt.slice(0, 220).replace(/\s+/g, ' ');
  } catch (e) {
    out = '❌ ' + e.name + ': ' + e.message + (e.cause ? ' / cause=' + e.cause.code : '');
  }
  line('  ④ 调用  : ' + out + '   (' + (Date.now() - t0) + 'ms)');
}
process.exit(0);
