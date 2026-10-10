// 「拉起测试」用的真机冒烟测试：对正在跑的面板打**一次真实的流式对话**，
// 走完整链路（面板路由 → chatWithBot → models.chatStreamCollect → reach.fetchReachable
// → 真模型 SSE → 逐帧 text → 落库），跑完再把自己产生的那两条记录删掉。
//
// 为什么必须有一次真对话：其余验证都在打桩 ——
//   · tests/stream.test.mjs 用的是本地假模型（节奏可控，但不碰真网络）；
//   · /api/models/:id/test 走的是**非流式** models.chat，证明不了流式那条路。
// 而「面板能不能真的跟模型说上话」恰恰是用户唯一在意的事，也是它最容易坏的地方
// （2026-10-09 就真实发生过：bot 绑的 Agnes 端点 TLS 握手全失败，聊天一律
//  UND_ERR_CONNECT_TIMEOUT，而所有离线测试全绿）。
//
// 用法：
//   node scripts/smoke-chat-live.mjs            # 跑完把测试记录删掉（默认）
//   node scripts/smoke-chat-live.mjs --keep     # 留着，好在面板里亲眼看
//   PANEL=http://127.0.0.1:4357 node scripts/smoke-chat-live.mjs
const BASE = process.env.PANEL || 'http://127.0.0.1:4357';
const KEEP = process.argv.includes('--keep');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   -', name, extra ? '｜' + extra : ''); }
  else { fail++; console.log('  FAIL -', name, extra ? '｜' + extra : ''); }
};

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};

const st = await api('/api/state');
const bot = (st.bots || [])[0];
if (!bot) { console.log('面板里没有写手，无法冒烟'); process.exit(1); }
const ID = encodeURIComponent(bot.id);
const threads = await api(`/api/memory/${ID}/threads`);
const tid = threads.defaultThreadId || (threads.threads || [])[0]?.id || '';
console.log(`面板 ${BASE}　写手：${bot.name || bot.id}　模型：${bot.modelId || '(未绑定)'}　线程：${tid}`);

const sessionsOf = async () => {
  const r = await api(`/api/memory/${ID}/sessions`);
  return (r.sessions || []).map((s) => ({ ts: s.ts, role: s.role, len: String(s.content || '').length }));
};

const before = await sessionsOf();
console.log(`对话前：${before.length} 条记录`);

console.log('\n== 一、真流式对话 ==');
const PROMPT = '（连通性自检，请只回四个字）收到收到';
const t0 = Date.now();
let res;
try {
  res = await fetch(`${BASE}/api/bots/${ID}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ content: PROMPT, ...(tid ? { threadId: tid } : {}) }),
    signal: AbortSignal.timeout(120000),
  });
} catch (e) {
  ok(false, '流式接口连得上', String(e && e.message));
  console.log('\n✗ 面板连不上，后面的都不用测了');
  process.exit(1);
}
ok(res.status === 200, '流式接口返回 200', 'HTTP ' + res.status);
ok(/text\/event-stream/.test(res.headers.get('content-type') || ''), '响应是 SSE',
  res.headers.get('content-type') || '');

const dec = new TextDecoder();
let raw = '';
let firstTextMs = null;
const seen = new Set();
let doneEv = null, errEv = null;
for await (const chunk of res.body) {
  raw += dec.decode(chunk, { stream: true });
  // 边收边解析：要记下「首字时间」，等整轮收完再解析就量不到了
  let i;
  while ((i = raw.indexOf('\n\n')) >= 0) {
    const one = raw.slice(0, i); raw = raw.slice(i + 2);
    try {
      const ev = JSON.parse(one.replace(/^data:\s*/, ''));
      seen.add(ev.type);
      if (ev.type === 'text' && firstTextMs === null) firstTextMs = Date.now() - t0;
      if (ev.type === 'done') doneEv = ev;
      if (ev.type === 'err') errEv = ev;
    } catch { /* 非 JSON 帧（如 [DONE]）忽略 */ }
  }
}
const totalMs = Date.now() - t0;

ok(!errEv, '模型没有报错', errEv ? errEv.err : '');
ok(!!doneEv, '收到 done 帧（这一轮真的写完了）');
ok(seen.has('text'), '收到 text 帧（流式逐字）', [...seen].join(','));
const reply = doneEv?.reply || '';
ok(reply.length > 0, '回复非空', `${reply.length} 字`);
console.log(`  首字 ${firstTextMs === null ? '(无)' : firstTextMs + 'ms'}　整轮 ${totalMs}ms　回复：${JSON.stringify(reply.slice(0, 60))}`);

console.log('\n== 二、落库 ==');
const after = await sessionsOf();
const added = after.slice(before.length);
ok(added.length === 2, '本轮新增 2 条记录（user + assistant）', `实际 ${added.length} 条：${added.map((x) => x.role).join(',')}`);
ok(added.some((x) => x.role === 'user' && x.len === PROMPT.length), 'user 那条就是刚发的内容');
ok(added.some((x) => x.role === 'assistant' && x.len === reply.length), 'assistant 那条与 done 帧的 reply 一致');

if (KEEP) {
  console.log('\n（--keep：保留这两条记录，方便在面板里亲眼看）');
} else {
  console.log('\n== 三、清理（把冒烟产生的记录删掉，别脏了正文）==');
  let deleted = 0;
  for (const s of added) {
    const r = await api(`/api/memory/${ID}/sessions/${s.ts}`, 'DELETE');
    if (r.ok) deleted++;
  }
  const final = await sessionsOf();
  ok(deleted === added.length, `删掉本轮新增的 ${added.length} 条`, `成功 ${deleted}`);
  ok(final.length === before.length, '记录数回到冒烟之前', `${before.length} → ${final.length}`);
}

console.log(fail ? `\n✗ ${fail} 项失败（${pass} 项通过）` : `\n✓ 全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
