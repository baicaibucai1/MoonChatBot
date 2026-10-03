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
// ------------------------------------------------------------------
'use strict';
const crypto = require('node:crypto');

// 角色 id 前缀（与 bot 的 BOT1/BOT2 区分开，避免将来混用）
const ID_PREFIX = 'CHR';
// 每个角色最多保留的历史版本数（防止 config.json 无限膨胀）
const MAX_HISTORY = 20;

function newId() {
  return ID_PREFIX + crypto.randomBytes(5).toString('hex');
}

// 角色的可编辑字段（白名单）—— 与 server.js 的工具白名单必须同步
const EDITABLE_FIELDS = ['name', 'persona', 'traits', 'age', 'appearance', 'background', 'tags', 'avatar'];

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
function brief(c, opts = {}) {
  if (!c) return '';
  const parts = [];
  if (opts.withName !== false) parts.push(`【${c.name}】`);
  if (c.age) parts.push(`年龄：${c.age}`);
  if (c.persona) parts.push(c.persona);
  if (c.traits) parts.push(`性格：${c.traits}`);
  if (c.appearance && opts.full) parts.push(`外表：${c.appearance}`);
  if (c.background && opts.full) parts.push(`背景：${c.background}`);
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
function snapshot(c, by, ts) {
  const snap = { by: by || 'user', ts: ts || Date.now() };
  for (const k of EDITABLE_FIELDS) snap[k] = c[k];
  return snap;
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
  newId,
  normalizeCharacter,
  normalizePool,
  list,
  find,
  brief,
  create,
  update,
  rollback,
  remove,
  snapshot,
  pruneReferences,
  sanitizeReferences,
};
