// 角色池：全局共享的角色库
// ------------------------------------------------------------------
// ★ 认知前提：本项目里 **bot 就是写手**（创作者），不是角色。
//   角色是写手笔下的人物，集中存在这里，所有写手共用同一个池子。
//
// 存储位置：config.json 的顶层 `characters` 数组（全局共享，用户已确认）。
//   选它而不是单独开 characters.json，是为了复用 config 已有的「整份覆盖 +
//   基线探针 + 原子写入」机制，一致性更有保障。
//
// 版本档：用户决策「写手可以改角色卡，但必须可回滚」→ 每次改写前把当前版本
//   推进 history[]（不覆盖、只追加），回滚就是把某个历史版本重新应用。
//
// ★★ 经历与计数器（用户决策 2026-10-04，详见《经历与计数器机制.md》）：
//   经历的产生地在**写手**，落点在**角色卡**，中间必须过一道「用户确认」。
//   · counters    —— 当前值，按「名字」平铺。全体写手共用这张表。
//   · experiences —— 沉淀下来的经历条目（追加式），记「为什么变成这样」。
//   · 规则（范围/初始值/何时增减）**不在这里** —— 它写在写手的「写手设定」里。
//   · ★ 同名共享、异名不引用：两位写手都声明「好感度」→ 读写同一个值；
//     写手只看得见/动得了**自己声明过**的名字（见 declaredView / filterDeclared）。
//   · ★ counters / experiences **不进 history**：版本档的语义是「设定改过几版」，
//     塞进流水会立刻冲垮（MAX_HISTORY=20），语义也乱。
// ------------------------------------------------------------------
'use strict';
const crypto = require('node:crypto');

// 角色 id 前缀（与 bot 的 BOT1/BOT2 区分开，避免将来混用）
const ID_PREFIX = 'CHR';
// 每个角色最多保留的历史版本数（防止 config.json 无限膨胀）
const MAX_HISTORY = 20;
// 每个角色最多保留的经历条目数。
// ★ 超出丢最老的不会丢数据 —— 经历的源头在写手的 events.jsonl，
//   角色卡上这份只是「摘要」，不是唯一副本。
const MAX_EXPERIENCES = 100;
// 每位角色最多允许的计数器个数 / 名字长度
const MAX_COUNTERS = 50;
const MAX_COUNTER_NAME = 32;
const MAX_EXP_TEXT = 500;

function newId() {
  return ID_PREFIX + crypto.randomBytes(5).toString('hex');
}

function newExpId() {
  return 'EXP' + crypto.randomBytes(4).toString('hex');
}

// 角色的可编辑字段（白名单）—— 与 server.js 的工具白名单必须同步
const EDITABLE_FIELDS = ['name', 'persona', 'traits', 'age', 'appearance', 'background', 'tags', 'avatar'];

// ---------- 计数器 / 经历 的归一化 ----------

// 计数器表：{ 名称: 数值 }。丢掉非数字、超长名、超量条目。
function normalizeCounters(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_COUNTERS) break;
    const name = String(k).trim().slice(0, MAX_COUNTER_NAME);
    if (!name) continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue;   // 设计上「计数器只允许数值」
    out[name] = num;
    n++;
  }
  return out;
}

// 经历条目：[{ id, ts, text, by, counters }]。空文本丢弃，超量丢最老。
function normalizeExperiences(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const text = String(e.text ?? '').trim().slice(0, MAX_EXP_TEXT);
    if (!text) continue;
    let id = String(e.id || '').trim();
    if (!id || seen.has(id)) id = newExpId();
    seen.add(id);
    out.push({
      id,
      ts: Number(e.ts) || Date.now(),
      text,
      by: String(e.by || '').slice(0, 40),
      counters: normalizeCounters(e.counters),
    });
  }
  return out.slice(-MAX_EXPERIENCES);
}

// 把任意输入归一化成合法的角色对象；非法返回 null
function normalizeCharacter(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  const out = { id, ts: Number(raw.ts) || now || Date.now() };
  for (const k of EDITABLE_FIELDS) {
    if (k === 'tags') {
      out.tags = Array.isArray(raw.tags)
        ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
        : [];
      continue;
    }
    out[k] = String(raw[k] ?? '');
  }
  out.name = out.name || '未命名角色';
  // 迁移来源（如 'BOT2/WORLDS.md'）—— 保留以便追溯归属
  if (raw.source) out.source = String(raw.source);
  // 经历与计数器（不进版本档，见文件头说明）
  out.counters = normalizeCounters(raw.counters);
  out.experiences = normalizeExperiences(raw.experiences);
  // 版本档
  out.history = Array.isArray(raw.history) ? raw.history.filter((h) => h && typeof h === 'object').slice(-MAX_HISTORY) : [];
  return out;
}

// 归一化整个角色池
function normalizePool(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const c = normalizeCharacter(item);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

// ---------- 池的增删改查（纯函数，不碰盘；由调用方负责保存 config） ----------

function list(pool) {
  return Array.isArray(pool) ? pool : [];
}

function find(pool, id) {
  return list(pool).find((c) => c.id === id) || null;
}

// 取角色用于注入 prompt 的设定文本（给写手看的）
// ★ 去重很关键：迁移时 persona 存的是原文全文，traits 是从中抽出的「性格特点」段，
//   若两个都原样输出，同一段性格会在 prompt 里出现两遍（实测确认过），
//   既浪费 token 又可能让模型以为角色性格有两层。
//   策略：traits 的内容若已包含在 persona 里，就不再单独输出。
function brief(c, opts = {}) {
  if (!c) return '';
  const parts = [];
  if (opts.withName !== false) parts.push(`【${c.name}】`);
  if (c.age) parts.push(`年龄：${c.age}`);
  if (c.persona) parts.push(c.persona);
  const traits = String(c.traits || '').trim();
  const persona = String(c.persona || '');
  // 只有当 traits 提供了 persona 里没有的信息时才输出
  if (traits && !persona.includes(traits)) parts.push(`性格：${traits}`);
  if (c.appearance && opts.full) parts.push(`外表：${c.appearance}`);
  if (c.background && opts.full) parts.push(`背景：${c.background}`);
  return parts.join('\n');
}

// ---------- ★★ 同名共享 / 异名不引用 ----------
//
// 角色卡上平铺着**全体写手**的计数器。一位写手只能看见/改动**自己声明过**的名字。
// 声明从哪来：写手的「写手设定」(memory/<botId>/persona.md) 里的小节，见 parseDeclaredCounters。

// 某位写手视角下的计数器：只含它声明的名字（未设过的按 0 显示）。
function declaredView(c, declared) {
  const out = {};
  for (const raw of Array.isArray(declared) ? declared : []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    out[name] = Number(c && c.counters && c.counters[name]) || 0;
  }
  return out;
}

// 只保留写手声明过的计数器名 —— 过滤掉越权的、别家私有的。
// 返回「增量」形式：{ 名称: 变化量 }。
function filterDeclared(patch, declared) {
  const allow = new Set((Array.isArray(declared) ? declared : []).map((x) => String(x).trim()));
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const name = String(k).trim();
    if (!allow.has(name)) continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    out[name] = num;
  }
  return out;
}

// 从「写手设定」正文里解析出该写手声明的计数器名。
// 约定：一个标题含「计数」的小节，下面是 `- 名字：说明` 列表。
// 解析不出来就返回空数组（写手就动不了任何计数器 —— 安全的一侧）。
function parseDeclaredCounters(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let inSection = false;
  for (const line of lines) {
    const s = line.trim();
    if (/^#{1,6}\s/.test(s)) {          // 标题行：切换小节
      inSection = /计数/.test(s);
      continue;
    }
    if (!inSection) continue;
    // `- 好感度：范围 0–100…` / `好感度：…` / `- 好感度`
    const m = /^[-*•]?\s*([^：:（(]{1,32}?)\s*(?:[：:]|$)/.exec(s);
    if (!m) continue;
    const name = m[1].trim().replace(/[「」『』"']/g, '');
    if (!name || name.length > MAX_COUNTER_NAME) continue;
    if (/^(计数器?|说明|备注|规则|范围)$/.test(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// 角色「当前状态」的可读文本（计数器 + 最近经历），给写手 prompt 用。
function stateBrief(c, declared, opts = {}) {
  const view = declaredView(c, declared);
  const names = Object.keys(view);
  const exps = (c.experiences || []).slice(-(opts.recent || 8));
  const parts = [];
  if (names.length) {
    parts.push('【计数器】' + names.map((n) => `${n} ${view[n]}`).join('、'));
  } else if (Object.keys(c.counters || {}).length) {
    // 声明列表为空但卡上确实有值 → 明确告诉它「这些不归你管」，避免它去猜
    parts.push('【计数器】本写手尚未在「写手设定」里声明任何计数器，因此不显示、也不改动计数。');
  }
  if (exps.length) {
    parts.push('【最近经历】');
    for (const e of exps) parts.push(`- ${e.text}`);
  }
  return parts.join('\n');
}

// 新建角色
function create(pool, data, by) {
  const now = Date.now();
  const c = normalizeCharacter({ ...data, id: data && data.id ? data.id : newId(), ts: now }, now);
  if (!c) return null;
  // 首版进历史档，便于「改坏了回到最初」
  c.history = [snapshot(c, by || 'user', now)];
  list(pool).push(c);
  return c;
}

// 给当前状态拍一份快照（只含可编辑字段）
// ★ 有意**不含** counters / experiences —— 它们不进版本档（见文件头说明）。
function snapshot(c, by, ts) {
  const snap = { by: by || 'user', ts: ts || Date.now() };
  for (const k of EDITABLE_FIELDS) snap[k] = c[k];
  return snap;
}

// ★ 把「写手工具的参数」收敛成合法的 patch。
//   抽成纯函数的原因：这是接线上最容易出错的一环 ——
//   ① 白名单外的键（id / history / source）必须丢掉，否则写手能伪造版本档；
//   ② avatar 不在此阶段开放（图片属「形象库」范畴），要显式剔除；
//   ③ 一个字段都没给时必须能被上层识别出来并回绝，而不是生成一条空建议让用户去点。
function buildEditPatch(args, opts = {}) {
  const deny = new Set(opts.deny || ['avatar']);
  const patch = {};
  for (const k of EDITABLE_FIELDS) {
    if (deny.has(k)) continue;
    if (args && args[k] !== undefined && args[k] !== null) patch[k] = args[k];
  }
  return patch;
}

// ★ 改写角色 —— 用户决策 2：可以改，但必须可回滚。
// 写入前把「当前版本」推进 history（注意：推的是改之前的状态，不是改之后）。
function update(pool, id, patch, by) {
  const c = find(pool, id);
  if (!c) return { ok: false, err: '角色不存在' };
  const now = Date.now();
  const before = snapshot(c, by || 'user', now);
  const changed = [];
  for (const k of EDITABLE_FIELDS) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (k === 'tags') {
      v = Array.isArray(v) ? v.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
    } else {
      v = String(v ?? '');
    }
    const oldVal = k === 'tags' ? JSON.stringify(c[k] || []) : String(c[k] ?? '');
    const newVal = k === 'tags' ? JSON.stringify(v) : v;
    if (oldVal === newVal) continue;
    c[k] = v;
    changed.push(k);
  }
  if (!changed.length) return { ok: true, character: c, changed: [] };
  if (c.name.trim() === '') c.name = '未命名角色';
  before.changed = changed;
  c.history = [...(c.history || []), before].slice(-MAX_HISTORY);
  return { ok: true, character: c, changed };
}

// 回滚到某个历史版本（history 的索引）
function rollback(pool, id, index, by) {
  const c = find(pool, id);
  if (!c) return { ok: false, err: '角色不存在' };
  const hist = c.history || [];
  const snap = hist[Number(index)];
  if (!snap) return { ok: false, err: '历史版本不存在' };
  const now = Date.now();
  // 回滚本身也是一次修改 → 先把当前状态存档，才能「回滚的回滚」
  const before = snapshot(c, by || 'user', now);
  before.changed = ['rollback'];
  for (const k of EDITABLE_FIELDS) {
    if (snap[k] !== undefined) c[k] = snap[k];
  }
  c.history = [...hist, before].slice(-MAX_HISTORY);
  return { ok: true, character: c, restored: snap.ts };
}

// ---------- 经历的沉淀与计数器的读写 ----------

// ★ 沉淀一次经历：**增量**更新计数器 + 追加一条经历条目。
//   这是「用户确认后写入角色卡」那一步的落点。
//   counters 是**增量**（好感度 +5 就传 5）；要设绝对值请用 setCounter。
function commitExperience(pool, id, data = {}) {
  const c = find(pool, id);
  if (!c) return { ok: false, err: '角色不存在' };
  const deltas = normalizeCounters(data.counters);
  const text = String(data.text ?? '').trim().slice(0, MAX_EXP_TEXT);
  if (!text && !Object.keys(deltas).length) return { ok: false, err: '经历内容与计数器变化不能都为空' };
  const now = Date.now();
  if (!c.counters) c.counters = {};
  for (const [k, v] of Object.entries(deltas)) {
    c.counters[k] = (Number(c.counters[k]) || 0) + v;
  }
  let entry = null;
  if (text) {
    entry = { id: newExpId(), ts: now, text, by: String(data.by || '').slice(0, 40), counters: deltas };
    c.experiences = [...(c.experiences || []), entry].slice(-MAX_EXPERIENCES);
  }
  return { ok: true, character: c, applied: deltas, entry };
}

// 直接设置某个计数器的值（绝对值）—— 管理员/用户在面板上改用。
function setCounter(pool, id, name, value) {
  const c = find(pool, id);
  if (!c) return { ok: false, err: '角色不存在' };
  const n = String(name || '').trim().slice(0, MAX_COUNTER_NAME);
  if (!n) return { ok: false, err: '计数器名不能为空' };
  const num = Number(value);
  if (!Number.isFinite(num)) return { ok: false, err: '计数器的值必须是数字' };
  if (!c.counters) c.counters = {};
  if (!(n in c.counters) && Object.keys(c.counters).length >= MAX_COUNTERS) {
    return { ok: false, err: `计数器数量已达上限（${MAX_COUNTERS}）` };
  }
  const before = Number(c.counters[n]) || 0;
  c.counters[n] = num;
  return { ok: true, character: c, name: n, before, after: num };
}

// 删除一个计数器（管理员/用户）。
function removeCounter(pool, id, name) {
  const c = find(pool, id);
  if (!c) return { ok: false, err: '角色不存在' };
  const n = String(name || '').trim();
  if (!c.counters || !(n in c.counters)) return { ok: false, err: '这个计数器不存在' };
  const before = c.counters[n];
  delete c.counters[n];
  return { ok: true, character: c, name: n, before };
}

// 追加一条经历（不动计数器）—— 管理员用。
function appendExperience(pool, id, data = {}) {
  const c = find(pool, id);
  if (!c) return { ok: false, err: '角色不存在' };
  const text = String(data.text ?? '').trim().slice(0, MAX_EXP_TEXT);
  if (!text) return { ok: false, err: '经历内容不能为空' };
  const entry = { id: newExpId(), ts: Date.now(), text, by: String(data.by || '').slice(0, 40), counters: {} };
  c.experiences = [...(c.experiences || []), entry].slice(-MAX_EXPERIENCES);
  return { ok: true, character: c, entry };
}

// 删除一条经历（按 id —— 用 ts 会在同毫秒内撞车）。
function removeExperience(pool, id, expId) {
  const c = find(pool, id);
  if (!c) return { ok: false, err: '角色不存在' };
  const want = String(expId || '').trim();
  const arr = c.experiences || [];
  const kept = arr.filter((e) => e.id !== want);
  if (kept.length === arr.length) return { ok: false, err: '没找到这条经历' };
  c.experiences = kept;
  return { ok: true, character: c, removed: arr.length - kept.length };
}

// 删除角色（调用方需自行清理写手的 activeCharacterIds 引用）
function remove(pool, id) {
  const arr = list(pool);
  const i = arr.findIndex((c) => c.id === id);
  if (i < 0) return { ok: false, err: '角色不存在' };
  const [c] = arr.splice(i, 1);
  return { ok: true, character: c };
}

// ★ 删除角色后清理所有写手的引用（连根拔：不留悬空 id）
function pruneReferences(bots, removedId) {
  let touched = 0;
  for (const b of Array.isArray(bots) ? bots : []) {
    if (!Array.isArray(b.activeCharacterIds)) continue;
    const before = b.activeCharacterIds.length;
    b.activeCharacterIds = b.activeCharacterIds.filter((x) => x !== removedId);
    if (b.activeCharacterIds.length !== before) touched++;
  }
  return touched;
}

// 过滤掉指向不存在角色的引用（启动时自愈）
function sanitizeReferences(bots, pool) {
  const valid = new Set(list(pool).map((c) => c.id));
  for (const b of Array.isArray(bots) ? bots : []) {
    if (!Array.isArray(b.activeCharacterIds)) { b.activeCharacterIds = []; continue; }
    b.activeCharacterIds = b.activeCharacterIds.filter((x) => valid.has(x));
  }
}

module.exports = {
  ID_PREFIX,
  EDITABLE_FIELDS,
  MAX_HISTORY,
  MAX_EXPERIENCES,
  MAX_COUNTERS,
  MAX_COUNTER_NAME,
  newId,
  newExpId,
  normalizeCharacter,
  normalizePool,
  normalizeCounters,
  normalizeExperiences,
  list,
  find,
  brief,
  stateBrief,
  declaredView,
  filterDeclared,
  parseDeclaredCounters,
  create,
  update,
  rollback,
  remove,
  snapshot,
  buildEditPatch,
  commitExperience,
  setCounter,
  removeCounter,
  appendExperience,
  removeExperience,
  pruneReferences,
  sanitizeReferences,
};
