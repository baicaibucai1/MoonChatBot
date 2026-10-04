// Agnes 细查：IPv6 强制 + 各路请求组合，看复位到底发生在哪一步
import fs from 'node:fs';
import https from 'node:https';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const targets = cfg.models.filter((x) => /agnes/i.test(x.id) || /agnes/i.test(x.baseURL || ''));

function req(opts, body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = https.request(opts, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: s.slice(0, 200).replace(/\s+/g, ' '), ms: Date.now() - t0 }));
    });
    r.on('error', (e) => resolve({ err: e.code || e.message, ms: Date.now() - t0 }));
    r.setTimeout(timeoutMs, () => { r.destroy(new Error('timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

for (const m of targets) {
  const host = new URL(m.baseURL).host;
  console.log('\n══════ ' + m.id + '  ' + host + ' ══════');

  const getModels = await req({
    host, family: 6, path: '/v1/models', method: 'GET',
    headers: { Authorization: 'Bearer ' + m.apiKey, 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  console.log('  GET  /v1/models            ' + (getModels.err ? '❌ ' + getModels.err : '✅ ' + getModels.status + ' ' + getModels.body) + '  (' + getModels.ms + 'ms)');

  const payload = JSON.stringify({ model: m.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
  const postUA = await req({
    host, family: 6, path: '/v1/chat/completions', method: 'POST',
    headers: {
      Authorization: 'Bearer ' + m.apiKey, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Mozilla/5.0', Accept: 'application/json',
    },
  }, payload);
  console.log('  POST /v1/chat (带 UA)      ' + (postUA.err ? '❌ ' + postUA.err : '✅ ' + postUA.status + ' ' + postUA.body) + '  (' + postUA.ms + 'ms)');

  const postNoUA = await req({
    host, family: 6, path: '/v1/chat/completions', method: 'POST',
    headers: { Authorization: 'Bearer ' + m.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, payload);
  console.log('  POST /v1/chat (无 UA)      ' + (postNoUA.err ? '❌ ' + postNoUA.err : '✅ ' + postNoUA.status + ' ' + postNoUA.body) + '  (' + postNoUA.ms + 'ms)');
}
process.exit(0);
