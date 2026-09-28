// 对话线程：一个角色（botId）下多条并列的对话流
// ------------------------------------------------------------------
// 存储布局
//   memory/<botId>/threads/index.json         线程索引（含 lastTs 计数器）
//   memory/<botId>/threads/<threadId>.jsonl   线程内容，每行一条 {role, content, ts}
//
// 为什么要有 lastTs：ts 必须「每个角色全局唯一」。旧实现只有一个 sessions.jsonl，
// 同一毫秒连写时靠「与最后一条比大小」顺延；拆成多文件后若各文件各自顺延，
// 不同线程就可能撞 ts —— 而 deleteSession 是按 ts 定位的，一撞就一次删掉两条。
// 所以把取号器提到索引层：append 时统一取号，O(1) 且跨线程唯一。
//
// 一次性迁移（幂等 · 不删老文件）
//   memory/<botId>/sessions.jsonl            → threads/<首条 ts>.jsonl   origin:'migrated'
//   memory/<botId>/branches/<ts>.jsonl       → threads/<ts>.jsonl        origin:'fork'
//   memory/<botId>/branches/main-<ts>.jsonl  → threads/<ts>.jsonl        origin:'fork'
// 老文件保留原地、不再写入，仅作回溯依据；branches/ 仍由 listBranchFiles 只读展示。
//
// ⚠️ 读语义分两类，不要一刀切
//   · readThreadMessages / getThreadSessions —— 单线程读，**对话上下文**用，只看当前线程
//   · readAllRecent                          —— 跨线程归并，**蒸馏 / 摘要 / 心跳 /
//                                               精彩时刻 / 管理员总结**用（角色视角：不管在
//                                               哪条线程聊的，都算这个角色的经历）
//
// 本模块不 require('./memory')（会形成循环依赖），路径推导自带一份；
// 批 3 抽 memory/store.js 时再统一收口。
// ------------------------------------------------------------------
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ID_CLASS } = require('../ids');

const ROOT = path.join(__dirname, '..', '..');
const MEMORY_DIR = path.join(ROOT, 'memory');
const INDEX_VERSION = 1;
const TITLE_MAX = 20;
const DEFAULT_TITLE = '新对话';
const TID_RE = /^\d{1,20}$/;
// 与路由字符类同源（不另写一份），但**不设 64 长度上限** ——
// memory 域的 :id 在路由层本就没有长度上限，这里若收得更紧，
// 超长 id 会在本模块抛错、凭空多出一条 500 路径。
const BOT_ID_RE = new RegExp('^' + ID_CLASS + '{1,200}$');

// ---------- 路径 ----------

function botDir(botId) {
  return path.join(MEMORY_DIR, botId);
}
function threadsDir(botId) {
  return path.join(botDir(botId), 'threads');
}
function indexPath(botId) {
  return path.join(threadsDir(botId), 'index.json');
}
function threadPath(botId, tid) {
  return path.join(threadsDir(botId), String(tid) + '.jsonl');
}

// ---------- 校验 ----------
// 路由层已用字符类限制过 id，这里再兜一层，防止越权路径拼出 MEMORY_DIR 之外的位置

function assertBotId(botId) {
  const id = String(botId == null ? '' : botId);
  if (!BOT_ID_RE.test(id)) throw new Error('非法角色 id: ' + botId);
  return id;
}
function assertTid(tid) {
  const id = String(tid == null ? '' : tid);
  if (!TID_RE.test(id)) throw new Error('非法线程 id: ' + tid);
  return id;
}

// ---------- 低层读写 ----------

function normalizeMsg(m) {
  if (!m || typeof m !== 'object') return null;
  const ts = Number(m.ts);
  if (!Number.isFinite(ts)) return null;
  return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content == null ? '' : m.content), ts };
}

function readLinesFrom(file) {
  if (!fs.existsSync(file)) return [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return raw.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return normalizeMsg(JSON.parse(l)); } catch { return null; } })
    .filter(Boolean);
}

function writeLinesTo(file, msgs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, msgs.length ? msgs.map((m) => JSON.stringify(m)).join('\n') + '\n' : '', 'utf8');
}

function readIndex(botId) {
  let raw;
  try { raw = fs.readFileSync(indexPath(botId), 'utf8'); } catch { return null; }
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || !Array.isArray(j.threads)) return null;
  return {
    version: Number(j.version) || INDEX_VERSION,
    lastTs: Number(j.lastTs) || 0,
    // 显式记录「当前线程」，不能靠 updatedAt 取最大推断 —— 旧 fork 的 tail 时间戳晚于
    // 主会话，迁移后按 updatedAt 排会把分支误判成默认线程，对话上下文就跑到分支上去了。
    defaultThreadId: j.defaultThreadId || null,
    migratedFrom: j.migratedFrom || null,
    threads: j.threads.filter((t) => t && t.id),
  };
}

function writeIndex(botId, idx) {
  fs.mkdirSync(threadsDir(botId), { recursive: true });
  const live = new Set((idx.threads || []).map((t) => t.id));
  const out = {
    version: INDEX_VERSION,
    lastTs: Number(idx.lastTs) || 0,
    defaultThreadId: live.has(idx.defaultThreadId) ? idx.defaultThreadId : null,
    migratedFrom: idx.migratedFrom || null,
    threads: (idx.threads || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  };
  fs.writeFileSync(indexPath(botId), JSON.stringify(out, null, 2) + '\n', 'utf8');
}

// ---------- 迁移 ----------

function fmtStamp(ts) {
  try { return new Date(ts).toISOString().slice(0, 16).replace('T', ' '); } catch { return String(ts); }
}

// 从消息列表推标题：取首条 user 消息前 TITLE_MAX 字
function titleOf(msgs, fallback) {
  const first = msgs.find((m) => m.role === 'user');
  const text = String((first && first.content) || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback || DEFAULT_TITLE;
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) + '…' : text;
}

// 幂等：索引已存在就直接返回，绝不重复迁移
function migrateIfNeeded(botId) {
  if (readIndex(botId)) return { migrated: false, reason: 'index-exists' };

  const dir = botDir(botId);
  const srcSessions = path.join(dir, 'sessions.jsonl');
  const branchesDir = path.join(dir, 'branches');

  const sources = [];
  const sess = readLinesFrom(srcSessions);
  if (sess.length) sources.push({ id: String(sess[0].ts), msgs: sess, origin: 'migrated', title: titleOf(sess, '默认对话') });

  if (fs.existsSync(branchesDir)) {
    let names = [];
    try { names = fs.readdirSync(branchesDir); } catch { names = []; }
    for (const f of names.filter((x) => x.endsWith('.jsonl')).sort()) {
      const msgs = readLinesFrom(path.join(branchesDir, f));
      if (!msgs.length) continue;
      const base = f.slice(0, -6);
      const isMainBackup = base.startsWith('main-');
      const raw = isMainBackup ? base.slice(5) : base;
      const num = Number(raw);
      const id = Number.isFinite(num) && num > 0 ? String(Math.trunc(num)) : String(msgs[0].ts);
      sources.push({
        id,
        msgs,
        origin: 'fork',
        title: (isMainBackup ? '切分支备份 @ ' : '分支 @ ') + fmtStamp(Number(raw) || msgs[0].ts),
      });
    }
  }

  if (!sources.length) return { migrated: false, reason: 'nothing-to-migrate' };

  fs.mkdirSync(threadsDir(botId), { recursive: true });
  const used = new Set();
  const threads = [];
  let lastTs = 0;

  for (const s of sources) {
    // id 去重：候选被占用就向上取整找一个空位，保持纯数字形态（TID_RE 要求）
    let n = Number(s.id);
    if (!Number.isFinite(n) || n <= 0) n = s.msgs[0].ts;
    while (used.has(String(Math.trunc(n)))) n += 1;
    n = Math.trunc(n);
    used.add(String(n));

    const id = String(n);
    writeLinesTo(threadPath(botId, id), s.msgs);
    const firstTs = s.msgs[0].ts;
    const lastMsgTs = s.msgs[s.msgs.length - 1].ts;
    threads.push({
      id,
      title: s.title,
      channel: 'local',
      peer: 'local',
      createdAt: firstTs,
      updatedAt: lastMsgTs,
      msgCount: s.msgs.length,
      origin: s.origin,
    });
    for (const m of s.msgs) if (m.ts > lastTs) lastTs = m.ts;
  }

  // 默认线程 = 原主会话（origin:'migrated'）。若该角色只有分支文件没有 sessions.jsonl，
  // 才退化为取 updatedAt 最大的一条 —— 因为旧 fork 的 tail 时间戳必然晚于主会话，
  // 直接按 updatedAt 排序会把分支选成「当前对话」，上下文就串到分支去了。
  const main = threads.find((t) => t.origin === 'migrated');
  const fallback = threads.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  const defaultThreadId = (main || fallback).id;

  writeIndex(botId, {
    lastTs,
    defaultThreadId,
    migratedFrom: {
      at: new Date().toISOString(),
      sessionsFile: sess.length ? sess.length : 0,
      branchFiles: sources.filter((s) => s.origin === 'fork').length,
      threads: threads.length,
    },
    threads,
  });

  return { migrated: true, threads: threads.length, messages: threads.reduce((a, t) => a + t.msgCount, 0) };
}

// 读索引；不存在则先迁移，迁移后仍为空则给一个空索引（不落盘）
function ensureIndex(botId) {
  migrateIfNeeded(botId);
  return readIndex(botId) || { version: INDEX_VERSION, lastTs: 0, defaultThreadId: null, migratedFrom: null, threads: [] };
}

// ---------- 线程 CRUD ----------

function listThreads(botId) {
  const id = assertBotId(botId);
  const idx = ensureIndex(id);
  return idx.threads.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getThread(botId, tid) {
  const id = assertBotId(botId);
  const t = assertTid(tid);
  return ensureIndex(id).threads.find((x) => x.id === t) || null;
}

function createThread(botId, opts = {}) {
  const id = assertBotId(botId);
  const idx = ensureIndex(id);
  // 取号：与消息 ts 共用同一计数器，保证线程 id 不会和任何消息 ts 混淆
  let n = Date.now();
  if (idx.lastTs >= n) n = idx.lastTs + 1;
  idx.lastTs = n;

  const meta = {
    id: String(n),
    title: String(opts.title || DEFAULT_TITLE).slice(0, 80),
    channel: String(opts.channel || 'local'),
    peer: String(opts.peer || 'local'),
    createdAt: n,
    updatedAt: n,
    msgCount: 0,
    origin: String(opts.origin || 'new'),
  };
  fs.mkdirSync(threadsDir(id), { recursive: true });
  writeLinesTo(threadPath(id, meta.id), []);
  idx.threads.push(meta);
  idx.defaultThreadId = meta.id;   // 新建即视为「当前线程」
  writeIndex(id, idx);
  return meta;
}

function renameThread(botId, tid, title) {
  const id = assertBotId(botId);
  const t = assertTid(tid);
  const idx = ensureIndex(id);
  const meta = idx.threads.find((x) => x.id === t);
  if (!meta) return { ok: false, err: '线程不存在' };
  const clean = String(title == null ? '' : title).replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return { ok: false, err: '标题不能为空' };
  meta.title = clean.slice(0, 80);
  writeIndex(id, idx);
  return { ok: true, thread: meta };
}

function deleteThread(botId, tid) {
  const id = assertBotId(botId);
  const t = assertTid(tid);
  const idx = ensureIndex(id);
  const at = idx.threads.findIndex((x) => x.id === t);
  if (at < 0) return { ok: false, err: '线程不存在' };
  idx.threads.splice(at, 1);
  if (idx.defaultThreadId === t) idx.defaultThreadId = null;   // 失效后由 getDefaultThreadId 回退
  writeIndex(id, idx);
  try { fs.rmSync(threadPath(id, t), { force: true }); } catch { /* 文件已不在，忽略 */ }
  return { ok: true, deleted: t, remaining: idx.threads.length };
}

function getDefaultThreadId(botId) {
  const id = assertBotId(botId);
  const idx = ensureIndex(id);
  if (!idx.threads.length) return createThread(id, { title: DEFAULT_TITLE }).id;
  // 优先用索引里显式记录的当前线程；它失效（被删）时才回退到最近更新的一条
  if (idx.defaultThreadId && idx.threads.some((t) => t.id === idx.defaultThreadId)) return idx.defaultThreadId;
  return idx.threads.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].id;
}

// ---------- 消息读写 ----------

// 单线程读：对话上下文专用
function readThreadMessages(botId, tid, limit = 0) {
  const id = assertBotId(botId);
  const t = assertTid(tid);
  const msgs = readLinesFrom(threadPath(id, t));
  if (!limit || limit <= 0) return msgs;
  return msgs.slice(-limit);
}

function getThreadSessions(botId, tid, limit = 0) {
  return readThreadMessages(botId, tid, limit);
}

// 跨线程归并读：蒸馏 / 摘要 / 心跳 / 精彩时刻 / 管理员总结用
function readAllRecent(botId, limit = 10) {
  const id = assertBotId(botId);
  const idx = ensureIndex(id);
  if (!idx.threads.length) return [];
  const all = [];
  for (const t of idx.threads) for (const m of readLinesFrom(threadPath(id, t.id))) all.push(m);
  all.sort((a, b) => a.ts - b.ts);
  return limit > 0 ? all.slice(-limit) : all;
}

function appendMessage(botId, tid, role, content) {
  const id = assertBotId(botId);
  const t = assertTid(tid);
  const idx = ensureIndex(id);
  const meta = idx.threads.find((x) => x.id === t);
  if (!meta) throw new Error('线程不存在: ' + t);

  let ts = Date.now();
  if (idx.lastTs >= ts) ts = idx.lastTs + 1;
  idx.lastTs = ts;

  fs.mkdirSync(threadsDir(id), { recursive: true });
  const role2 = role === 'assistant' ? 'assistant' : 'user';
  fs.appendFileSync(threadPath(id, t), JSON.stringify({ role: role2, content: String(content == null ? '' : content), ts }) + '\n', 'utf8');

  meta.msgCount = (Number(meta.msgCount) || 0) + 1;
  meta.updatedAt = ts;
  idx.defaultThreadId = t;   // 在哪个线程说话，哪条就是「当前线程」
  // 首条 user 消息落到空标题的线程上时，顺手补一个可读标题
  if (role2 === 'user' && (!meta.title || meta.title === DEFAULT_TITLE)) meta.title = titleOf([{ role: 'user', content }], DEFAULT_TITLE);
  writeIndex(id, idx);
  return ts;
}

// 清空单条线程的内容，保留线程身份与标题
function clearThread(botId, tid) {
  const id = assertBotId(botId);
  const t = assertTid(tid);
  const idx = ensureIndex(id);
  const meta = idx.threads.find((x) => x.id === t);
  if (!meta) return { ok: false, err: '线程不存在' };
  writeLinesTo(threadPath(id, t), []);
  meta.msgCount = 0;
  meta.updatedAt = Date.now();
  writeIndex(id, idx);
  return { ok: true, cleared: t };
}

// 按 ts 删一条：ts 跨线程唯一，所以最多命中一条
function deleteMessageByTs(botId, ts) {
  const id = assertBotId(botId);
  const target = Number(ts);
  if (!Number.isFinite(target)) throw new Error('无效的时间戳');
  const idx = ensureIndex(id);
  for (const meta of idx.threads) {
    const msgs = readLinesFrom(threadPath(id, meta.id));
    const at = msgs.findIndex((m) => m.ts === target);
    if (at < 0) continue;
    msgs.splice(at, 1);
    writeLinesTo(threadPath(id, meta.id), msgs);
    meta.msgCount = msgs.length;
    if (msgs.length) meta.updatedAt = msgs[msgs.length - 1].ts;
    writeIndex(id, idx);
    return true;
  }
  return false;
}

// ---------- 非破坏性派生 ----------
// 语义：以 fromTs 为界，把「该点及其之前」复制成一条新线程，**原线程一条都不动**。
// 对照旧 forkSession：旧实现会把 source 截断到分叉点（破坏性），已按要求改为派生。
function forkThread(botId, fromTs, opts = {}) {
  const id = assertBotId(botId);
  const fts = Number(fromTs);
  if (!Number.isFinite(fts)) throw new Error('无效的时间戳');

  const sourceTid = opts.sourceTid ? assertTid(opts.sourceTid) : getDefaultThreadId(id);
  const srcMsgs = readLinesFrom(threadPath(id, sourceTid));
  const cut = srcMsgs.findIndex((m) => m.ts === fts);
  if (cut < 0) return { ok: false, err: '分叉点未找到' };

  const head = srcMsgs.slice(0, cut + 1);
  const source = getThread(id, sourceTid);
  const created = createThread(id, {
    title: String(opts.title || '').trim() || (source ? `${source.title} · 分支` : '分支'),
    origin: 'fork',
  });

  writeLinesTo(threadPath(id, created.id), head);
  const idx = readIndex(id);
  const meta = idx.threads.find((x) => x.id === created.id);
  meta.msgCount = head.length;
  meta.createdAt = head[0].ts;
  meta.updatedAt = head[head.length - 1].ts;
  for (const m of head) if (m.ts > idx.lastTs) idx.lastTs = m.ts;
  writeIndex(id, idx);

  return { ok: true, forkTs: fts, threadId: created.id, source: sourceTid, copied: head.length };
}

// ---------- 老分支文件的只读兼容 ----------
// C1 起 fork 不再写 branches/，这批文件成为 frozen 归档；C2 前端换成线程 UI 后即可下掉。

function listBranchFiles(botId) {
  const id = assertBotId(botId);
  const dir = path.join(botDir(id), 'branches');
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const ts = Number(f.slice(0, -6)) || 0;   // main-<ts>.jsonl → NaN → 0，与旧实现一致
      const lines = readLinesFrom(path.join(dir, f));
      return { fromTs: ts, count: lines.length, ts };
    })
    .sort((a, b) => b.fromTs - a.fromTs);
}

// 把归档分支恢复成一条可继续对话的线程（旧实现是写回 sessions.jsonl，新模型下已无意义）
function restoreBranchAsThread(botId, fromTs) {
  const id = assertBotId(botId);
  const fts = Number(fromTs);
  if (!Number.isFinite(fts)) throw new Error('无效的时间戳');
  const bfile = path.join(botDir(id), 'branches', `${fts}.jsonl`);
  if (!fs.existsSync(bfile)) return { ok: false, err: '分支不存在' };
  const msgs = readLinesFrom(bfile);
  if (!msgs.length) return { ok: false, err: '分支为空' };

  const created = createThread(id, { title: '恢复的分支 @ ' + fmtStamp(fts), origin: 'fork' });
  writeLinesTo(threadPath(id, created.id), msgs);
  const idx = readIndex(id);
  const meta = idx.threads.find((x) => x.id === created.id);
  meta.msgCount = msgs.length;
  meta.createdAt = msgs[0].ts;
  meta.updatedAt = msgs[msgs.length - 1].ts;
  for (const m of msgs) if (m.ts > idx.lastTs) idx.lastTs = m.ts;
  writeIndex(id, idx);

  return { ok: true, restoredFrom: fts, threadId: created.id, count: msgs.length };
}

module.exports = {
  MEMORY_DIR,
  DEFAULT_TITLE,
  migrateIfNeeded,
  listThreads,
  getThread,
  createThread,
  renameThread,
  deleteThread,
  getDefaultThreadId,
  readThreadMessages,
  getThreadSessions,
  readAllRecent,
  appendMessage,
  clearThread,
  deleteMessageByTs,
  forkThread,
  listBranchFiles,
  restoreBranchAsThread,
};
