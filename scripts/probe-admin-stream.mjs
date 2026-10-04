// 直连探针：把 /api/admin/chat/stream 的 SSE 事件一帧帧打出来，看管理员链路到底停在哪
const content = process.argv[2] || '你好，先告诉我面板现在有几个写手';
const t0 = Date.now();
const r = await fetch('http://127.0.0.1:4358/api/admin/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({ content }),
});
console.log('HTTP', r.status, r.headers.get('content-type'));
const dec = new TextDecoder();
let buf = '';
let n = 0;
const reader = r.body.getReader();
const to = setTimeout(() => { console.log('!! 45s 未收尾'); reader.cancel().catch(() => {}); }, 45000);
outer: while (true) {
  const rd = await reader.read().catch((e) => ({ done: true, value: null, err: e }));
  if (rd.err) { console.log('!! read err', rd.err.message); break; }
  if (rd.done) { console.log('!! 流被服务端关闭'); break; }
  buf += dec.decode(rd.value, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') { console.log('[' + (Date.now() - t0) + 'ms] ' + d); continue; }
    let ev; try { ev = JSON.parse(d); } catch { console.log('unparsed:', d.slice(0, 120)); continue; }
    n++;
    const t = ev.type;
    const stamp = '[' + (Date.now() - t0) + 'ms #' + n + '] ';
    if (t === 'text') console.log(stamp + 'TEXT ' + JSON.stringify(ev.d));
    else if (t === 'tool') console.log(stamp + 'TOOL ' + ev.name + ' ok=' + ev.ok + ' ' + JSON.stringify(ev.summary || '').slice(0, 90));
    else if (t === 'note') console.log(stamp + 'NOTE ' + ev.d);
    else if (t === 'pending') console.log(stamp + 'PENDING ' + JSON.stringify(ev.edit).slice(0, 150));
    else console.log(stamp + t.toUpperCase() + ' ' + JSON.stringify(ev).slice(0, 500));
    if (t === 'done' || t === 'err') break outer;
  }
}
clearTimeout(to);
console.log('--- 事件数 ' + n + '，总耗时 ' + (Date.now() - t0) + 'ms');
process.exit(0);
