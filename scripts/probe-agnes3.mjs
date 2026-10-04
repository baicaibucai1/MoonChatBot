// 逐个 IP 握手：确认 apihub.agnes-ai.com 到底哪几个节点证书过期
import tls from 'node:tls';
import dns from 'node:dns';

const HOST = process.argv[2] || 'apihub.agnes-ai.com';
const addrs = await new Promise((r) => dns.lookup(HOST, { all: true }, (e, a) => r(e ? [] : a)));
console.log(HOST + ' 共 ' + addrs.length + ' 个地址，逐个 TLS 握手（SNI=' + HOST + '）：');

for (const a of addrs) {
  const r = await new Promise((resolve) => {
    const s = tls.connect({ host: a.address, port: 443, servername: HOST, rejectUnauthorized: true, family: a.family });
    const t = setTimeout(() => { try { s.destroy(); } catch {} resolve({ err: 'timeout' }); }, 8000);
    s.on('secureConnect', () => {
      clearTimeout(t);
      const c = s.getPeerCertificate(true);
      try { s.destroy(); } catch {}
      resolve({
        ok: s.authorized, authErr: String(s.authorizationError || ''),
        cn: (c && c.subject && c.subject.CN) || '?',
        issuer: (c && c.issuer && (c.issuer.CN || c.issuer.O)) || '?',
        to: (c && c.valid_to) || '?',
      });
    });
    s.on('error', (e) => { clearTimeout(t); resolve({ err: e.code || e.message }); });
  });
  const tag = ('v' + a.family + ' ' + a.address).padEnd(26);
  if (r.err) { console.log('  ' + tag + ' ❌ ' + r.err); continue; }
  console.log('  ' + tag + (r.ok ? ' ✅ 可信 ' : ' ⚠️ ' + r.authErr + ' ') + '| CN=' + r.cn + ' | 签发=' + r.issuer + ' | 有效期至 ' + r.to);
}
process.exit(0);
