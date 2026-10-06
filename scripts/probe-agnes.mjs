// Agnes 专项体检：抓对面到底是谁（证书主体 / SAN / 签发者），并分别试 IPv4-only 与 IPv6
import tls from 'node:tls';
import dns from 'node:dns';
import https from 'node:https';

const HOSTS = ['api.agnes-ai.cn', 'apihub.agnes-ai.com'];

function grab(host, family) {
  return new Promise((resolve) => {
    const s = tls.connect({
      host, port: 443, servername: host,
      rejectUnauthorized: false,
      family: family || undefined,
    });
    const t = setTimeout(() => { try { s.destroy(); } catch {} resolve({ err: 'timeout' }); }, 8000);
    s.on('secureConnect', () => {
      clearTimeout(t);
      const c = s.getPeerCertificate(true);
      try { s.destroy(); } catch {}
      resolve({
        authorized: s.authorized, authErr: String(s.authorizationError || ''),
        subject: (c && c.subject && (c.subject.CN || '')) || '?',
        san: (c && c.subjectaltname ? c.subjectaltname.split(', ').slice(0, 8) : []),
        issuer: (c && c.issuer && (c.issuer.CN || c.issuer.O)) || '?',
        notAfter: (c && c.valid_to) || '?',
        ipv6Addr: (s.remoteAddress || ''),
      });
    });
    s.on('error', (e) => { clearTimeout(t); resolve({ err: e.code || e.message }); });
  });
}

async function httpProbe(urlStr) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = https.request({ host: u.host, path: u.pathname + (u.search || ''), method: 'GET', rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, snippet: body.slice(0, 200).replace(/\s+/g, ' ') }));
    });
    req.on('error', (e) => resolve({ err: e.code || e.message }));
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); resolve({ err: 'timeout' }); });
    req.end();
  });
}

for (const h of HOSTS) {
  console.log('\n══════════ ' + h + ' ══════════');
  const addrs = await new Promise((r) => dns.lookup(h, { all: true }, (e, a) => r(e ? [] : a)));
  console.log('  DNS：' + addrs.map((x) => 'v' + x.family + ' ' + x.address).join('  '));

  for (const fam of [0, 4, 6]) {
    const r = await grab(h, fam);
    const tag = fam === 0 ? '自动' : ('IPv' + fam);
    if (r.err) { console.log('  TLS ' + tag + '：❌ ' + r.err); continue; }
    console.log('  TLS ' + tag + '：' + (r.authorized ? '✅ 证书可信' : '⚠️ 证书不可信 (' + r.authErr + ')') + '  对端IP=' + r.ipv6Addr);
    console.log('        证书主体 CN = ' + r.subject);
    console.log('        SAN        = ' + (r.san || []).join(' | '));
    console.log('        签发者     = ' + r.issuer + '   有效期至 ' + r.notAfter);
  }
  const root = await httpProbe('https://' + h + '/');
  console.log('  GET /  ：' + (root.err ? '❌ ' + root.err : 'HTTP ' + root.status + '  ' + root.snippet));
}
process.exit(0);
