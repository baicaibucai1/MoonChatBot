// 记忆中心：每个机器人一套多文件记忆库（独立目录 memory/<botId>/）
// ------------------------------------------------------------------
// 分层记忆（重写版）：所有用户文件（预设/上传/自定义）一律通用处理，无固定特权
//   用户文件   <key>.md                      —— 按三级层级注入：tier1 强制全文 / tier2 摘要索引 / tier3 冷记忆按需查询
//   L0 核心卡  persona_core.json             —— 用户文件 + 近期经历 + 近期对话蒸馏而成，每轮注入（小而稳）
//   L1 事件流  events.jsonl                  —— 结构化经历事件（重要性过滤 + 滚动压缩）
//              events_summary.md             —— 老事件压缩摘要（常驻注入）
//              events_archive.md             —— 压缩前的原始事件归档（不注入）
//   L3 摘要    <key>_summary.json            —— 全部 tier2 文件的分段摘要
//   会话记录   sessions.jsonl（独立读写区）
// 旧版 key_events.md 首次访问时自动迁移进 events.jsonl（migrateLegacy）。
// ------------------------------------------------------------------
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// 对话线程层（多线程改造 C1）：会话读写已由它承载，本文件保留同名包装以维持对外签名不变
const threads = require('./memory/threads');

const ROOT = path.join(__dirname, '..');
const MEMORY_DIR = path.join(ROOT, 'memory');

// 记忆文件定义（顺序即面板列表顺序；全部为通用用户文件，层级由用户在面板中决定）
const FILE_TYPES = [
  { key: 'persona',     name: '人格',      desc: '人格设定：同时作为人格核心卡的蒸馏种子' },
  { key: 'plot',        name: '剧情',      desc: '剧情背景/世界观' },
  { key: 'content',     name: '内容',      desc: '知识/资料储备' },
  { key: 'traits',      name: '特征',      desc: '性格特征设定' },
];

// 已被新机制接管/迁移、不再展示与注入的旧记忆文件 key
const MIGRATED_KEYS = new Set(['user', 'key_events']);

// 分层记忆接管的生成物 key（buildSystemPrompt 单独处理，不走通用文件注入）
const GENERATED_KEYS = new Set(['events_summary', 'events_archive']);

const DEFAULTS = {
  persona: `# 人格

## 基本信息
- 名字：（给机器人起个名字）

## 性格特点
-

## 说话风格
-
`,
  plot: `# 剧情

## 剧情背景
-

## 世界观设定
-

## 当前所处阶段
-
`,
  content: `# 内容

## 知识储备
-

## 参考资料
-

## 需要输出/展示的内容
-
`,
  traits: `# 特征

## 外貌特征
-

## 能力特长
-

## 喜好与习惯
-
`,
};

function botDir(botId) {
  const dir = path.join(MEMORY_DIR, botId);
  fs.mkdirSync(dir, { recursive: true });
  // 预设记忆文件自创建：不存在时按模板重建（首次初始化与「删除=清理」共用同一逻辑；
  // 自定义文件不受影响，删除即真正消失）
  for (const t of FILE_TYPES) {
    const f = path.join(dir, `${t.key}.md`);
    if (!fs.existsSync(f) && DEFAULTS[t.key] !== undefined) {
      fs.writeFileSync(f, DEFAULTS[t.key], 'utf8');
    }
  }
  return dir;
}

function filePath(botId, key) {
  return path.join(botDir(botId), `${key}.md`);
}

function memoryDir(botId) {
  return botDir(botId);
}

// ---------- 文件启用/禁用状态（存于 _meta.json，不占 .md 空间） ----------
function metaFile(botId) {
  return path.join(botDir(botId), '_meta.json');
}

function getMeta(botId) {
  try {
    const f = metaFile(botId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) || { files: {} };
  } catch {}
  return { files: {} };
}

function saveMeta(botId, meta) {
  fs.writeFileSync(metaFile(botId), JSON.stringify(meta, null, 2), 'utf8');
}

function getFileEnabled(botId, key) {
  const meta = getMeta(botId);
  return meta.files[key]?.enabled !== false; // 默认启用
}

function setFileEnabled(botId, key, enabled) {
  assertSafeKey(key);
  const meta = getMeta(botId);
  meta.files[key] = { ...(meta.files[key] || {}), enabled: enabled !== false };
  saveMeta(botId, meta);
  return true;
}

// 修改记忆文件备注（存于 _meta.json，供面板展示说明用，不影响 AI 读取内容）
function setFileDesc(botId, key, desc) {
  assertSafeKey(key);
  const meta = getMeta(botId);
  meta.files[key] = { ...(meta.files[key] || {}), desc: String(desc || '').slice(0, 80) };
  saveMeta(botId, meta);
  return true;
}

// ---------- 文件记忆层级（面板拖拽到层级桶） ----------
// 1 = 无条件强制注入：全文进入每轮 system prompt，绝不裁剪
// 2 = 摘要索引：蒸馏为分段摘要后注入；摘要未生成时小文件回退全文
// 3 = 冷记忆：默认不注入，AI 需要时通过 recall_memory 工具自行读取
// 所有文件（预设/上传/自定义）一律通用处理，无固定文件特权；默认 tier2
function defaultTier(key) {
  return 2;
}
function getFileTier(botId, key) {
  const meta = getMeta(botId);
  const t = Number(meta.files[key]?.tier);
  return [1, 2, 3].includes(t) ? t : defaultTier(key);
}
function setFileTier(botId, key, tier) {
  assertSafeKey(key);
  const t = Number(tier);
  if (![1, 2, 3].includes(t)) throw new Error('无效的记忆层级');
  const meta = getMeta(botId);
  meta.files[key] = { ...(meta.files[key] || {}), tier: t };
  saveMeta(botId, meta);
  return true;
}
// 用户文件清单（启用、非系统生成、按重要性排序）——分层记忆的统一数据源
function getUserFiles(botId) {
  const meta = getMeta(botId);
  return getFileOrder(botId)
    .filter((k) => !MIGRATED_KEYS.has(k) && !GENERATED_KEYS.has(k))
    .filter((k) => getFileEnabled(botId, k))
    .map((k) => {
      const preset = FILE_TYPES.find((f) => f.key === k);
      return { key: k, name: preset ? preset.name : k, tier: getFileTier(botId, k) };
    });
}

// 冷记忆文件清单（启用的 tier3 且有实际内容——空文件/纯模板不进索引，供 system 索引与 recall_memory 工具）
function getColdFiles(botId) {
  const meta = getMeta(botId);
  return getUserFiles(botId)
    .filter((f) => f.tier === 3)
    .filter((f) => !isEmptyContent(f.key, readMemoryFile(botId, f.key)))
    .map((f) => ({ key: f.key, name: f.name, desc: meta.files[f.key]?.desc || '' }));
}
// 读取冷记忆文件（仅 tier3 且启用；供 recall_memory 工具返回给模型）
function readColdFile(botId, key) {
  assertSafeKey(key);
  if (getFileTier(botId, key) !== 3 || !getFileEnabled(botId, key)) return '';
  const preset = FILE_TYPES.find((f) => f.key === key);
  const meta = getMeta(botId);
  const name = preset ? preset.name : key;
  const desc = meta.files[key]?.desc || '';
  let content = '';
  try { content = fs.readFileSync(filePath(botId, key), 'utf8').trim(); } catch {}
  if (isEmptyContent(key, content)) return '';
  const head = `【冷记忆·${name}】${desc ? `（${desc}）` : ''}`;
  return `${head}\n${content.slice(0, 6000)}`;
}

// 校验记忆文件 key 只允许安全字符（字母/数字/下划线/中文/连字符，防止路径穿越）
const KEY_RE = /^[\w\u4e00-\u9fa5-]{1,64}$/;
function assertSafeKey(key) {
  if (!KEY_RE.test(key)) throw new Error(`非法的记忆文件名: ${key}`);
}

// 读取记忆文件（不存在返回空字符串；不再自动创建模板，删除后即真正消失）
function readMemoryFile(botId, key) {
  assertSafeKey(key);
  const file = filePath(botId, key);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function saveMemoryFile(botId, key, content) {
  assertSafeKey(key);
  fs.writeFileSync(filePath(botId, key), content ?? '', 'utf8');
  return true;
}

// 删除记忆文件（删除即清理：预设文件会在下次访问时按模板自动重建，相当于清空重置；
// 自定义文件真正消失。同时清理 _meta.json 中的层级/启用状态）
function deleteMemoryFile(botId, key) {
  assertSafeKey(key);
  const file = filePath(botId, key);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const meta = getMeta(botId);
  if (meta.files && meta.files[key]) {
    delete meta.files[key];
    saveMeta(botId, meta);
  }
  return true;
}

// ---------- 文件重要性排序（面板拖动调整；越靠前越重要） ----------
// 排序存于 _meta.json 的 order 字段（有序 key 数组）。规则：
//   - 注入顺序：自定义文件按用户排序进入 system prompt（靠前者更靠前，模型注意力权重更高）
//   - 裁剪顺序：上下文超预算时，从尾部（最不重要）开始裁剪
function getFileOrder(botId) {
  const meta = getMeta(botId);
  const dir = botDir(botId);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch {}
  names = names.filter((n) => !MIGRATED_KEYS.has(n));
  const saved = (Array.isArray(meta.order) ? meta.order : []).filter((k) => typeof k === 'string' && names.includes(k));
  const rest = names
    .filter((n) => !saved.includes(n))
    .sort((a, b) => {
      const ia = FILE_TYPES.findIndex((f) => f.key === a);
      const ib = FILE_TYPES.findIndex((f) => f.key === b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b, 'zh-CN');
    });
  return [...saved, ...rest];
}

// 保存用户拖动后的排序（去重 + 安全校验；未列出的文件自动排在末尾）
function setFileOrder(botId, keys) {
  if (!Array.isArray(keys)) throw new Error('keys 必须为数组');
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    const s = String(k);
    assertSafeKey(s);
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  const meta = getMeta(botId);
  meta.order = out;
  saveMeta(botId, meta);
  return true;
}

// 系统生成文件的说明（面板展示 & 与用户自建文件区分）
const GENERATED_DESCS = {
  events_summary: '系统生成的经历压缩摘要（自动注入对话，可清空后重建）',
  events_archive: '系统归档的历史事件原文（不注入对话，仅供查阅）',
};

// 扫描目录下全部 .md 记忆文件（按用户重要性排序返回；支持用户自定义命名）
// 返回 [{ key, name, desc, content, enabled, tier, sys }]
function getMemoryFiles(botId) {
  const dir = botDir(botId);
  const meta = getMeta(botId);
  return getFileOrder(botId).map((key) => {
    const preset = FILE_TYPES.find((f) => f.key === key);
    return {
      key,
      name: preset ? preset.name : key,
      // 备注优先使用面板中自定义的，其次系统生成说明，否则用预设描述/默认文案
      desc: meta.files[key]?.desc || GENERATED_DESCS[key]
        || (preset ? preset.desc : '自定义记忆文件（内容将随 system prompt 提供给 AI）'),
      content: fs.readFileSync(path.join(dir, `${key}.md`), 'utf8'),
      enabled: getFileEnabled(botId, key),
      tier: getFileTier(botId, key),
      sys: GENERATED_KEYS.has(key), // 系统自动生成的文件（面板标注「系统」）
    };
  });
}

// 追加内容到记忆文件（AI 自动归档时使用）
function appendMemoryFile(botId, key, content) {
  assertSafeKey(key);
  const text = content.trim();
  if (!text) return false;
  const file = filePath(botId, key);
  const prefix = fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() ? '\n' : '';
  fs.appendFileSync(file, prefix + text + '\n', 'utf8');
  return true;
}

// 旧版接口：追加关键剧情（保留签名兼容旧调用方，内部写入结构化事件流）
function appendKeyEvent(botId, event) {
  return appendEvent(botId, { event, importance: 3, source: 'mark' });
}

// =========================================================
// 分层记忆
// =========================================================
// 预算与阈值
const EVENT_THRESHOLD = 30;       // 事件超过该条数触发滚动压缩
const EVENT_COMPACT_OLD = 20;     // 每次压缩的最旧条数
const EVENT_INJECT_RECENT = 10;   // system 注入的最近事件条数
const DISTILL_EVERY_ROUNDS = 50;  // 每累计 N 轮对话重新蒸馏核心卡
const SYSTEM_BUDGET_TOKENS = 3000;// system prompt 组装预算（超出按层裁剪）
const IMPORTANCE_FLOOR = 3;       // 自动提炼事件的入库门槛

// ---------- 小工具 ----------
function md5(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

// 粗略 token 估算（与 models.js 同规则：ASCII≈4字符/token，中文≈1字/token）
function estTokens(s) {
  let n = 0;
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    n += c < 128 ? 0.25 : (c >= 0x4e00 && c <= 0x9fff ? 1 : 0.5);
  }
  return Math.max(1, Math.ceil(n));
}

function fmtTs(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 宽松 JSON 解析：优先直解，失败时做括号配对提取第一个对象（模型输出容错）
function parseLooseJson(text) {
  const s = String(text || '').replace(/```(?:json)?/g, '').trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { try { return JSON.parse(s.slice(start, j + 1)); } catch { return null; } } }
  }
  return null;
}

// ---------- L1 情节记忆：events.jsonl ----------
function eventsFile(botId) { return path.join(botDir(botId), 'events.jsonl'); }
function eventsSummaryFile(botId) { return path.join(botDir(botId), 'events_summary.md'); }
function eventsArchiveFile(botId) { return path.join(botDir(botId), 'events_archive.md'); }

// 旧版 key_events.md → events.jsonl 一次性迁移（幂等：条目迁移后改写为占位说明）
function migrateLegacy(botId) {
  const legacy = filePath(botId, 'key_events');
  if (!fs.existsSync(legacy)) return;
  let lines = [];
  try { lines = fs.readFileSync(legacy, 'utf8').split('\n').filter((l) => /^- \[/.test(l)); } catch {}
  if (!lines.length) return;
  const rows = lines.map((l, i) => {
    const m = /^- \[(.+?)\]\s*([\s\S]*)$/.exec(l);
    const t = m ? Date.parse(m[1]) : NaN;
    return {
      ts: Number.isFinite(t) ? t : Date.now() + i,
      actors: [],
      event: (m ? m[2] : l).trim().slice(0, 300),
      emotion: '',
      importance: 3,
      source: 'mark',
    };
  }).filter((r) => r.event);
  if (rows.length) {
    fs.appendFileSync(eventsFile(botId), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    console.log(`[memory:${botId}] 已迁移 key_events ${rows.length} 条 → events.jsonl`);
  }
  fs.writeFileSync(legacy, '# 关键剧情记录\n\n（已迁移为分层事件流 events.jsonl，本文件不再使用）\n', 'utf8');
}

function readEvents(botId) {
  migrateLegacy(botId);
  const f = eventsFile(botId);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// 追加一条结构化事件。ev: { event, importance(1-5, 默认3), actors[], emotion, source }
function appendEvent(botId, ev) {
  const text = String(ev && ev.event || '').trim();
  if (!text) return null;
  migrateLegacy(botId);
  const row = {
    ts: Date.now(),
    actors: Array.isArray(ev.actors) ? ev.actors.map(String).slice(0, 5) : [],
    event: text.slice(0, 300),
    emotion: String(ev.emotion || '').slice(0, 30),
    importance: Math.max(1, Math.min(5, Math.round(Number(ev.importance) || 3))),
    source: ['auto', 'mark', 'manual'].includes(ev.source) ? ev.source : 'auto',
  };
  fs.appendFileSync(eventsFile(botId), JSON.stringify(row) + '\n', 'utf8');
  return row;
}

function getRecentEvents(botId, limit = EVENT_INJECT_RECENT) {
  return readEvents(botId).slice(-limit);
}

// 事件管理：按 ts 删除单条 / 清空事件流 / 清空经历摘要（归档不受影响）
function deleteEvent(botId, ts) {
  const f = eventsFile(botId);
  if (!fs.existsSync(f)) return false;
  const t = Number(ts);
  if (!Number.isFinite(t)) throw new Error('无效的时间戳');
  const rows = readEvents(botId);
  const kept = rows.filter((r) => r.ts !== t);
  if (kept.length === rows.length) return false;
  fs.writeFileSync(f, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return true;
}

function clearEvents(botId) {
  fs.writeFileSync(eventsFile(botId), '', 'utf8');
  return true;
}

function clearEventsSummary(botId) {
  fs.writeFileSync(eventsSummaryFile(botId), '', 'utf8');
  return true;
}

// 老事件压缩摘要（常驻注入）与归档（不注入）
function readEventsSummary(botId) {
  const f = eventsSummaryFile(botId);
  if (!fs.existsSync(f)) return '';
  return fs.readFileSync(f, 'utf8').trim();
}

const _compacting = new Set();
// 事件滚动压缩：超过阈值时把最旧 EVENT_COMPACT_OLD 条压缩成摘要段，原文移入归档
// force=true（用户手动点击生成）：忽略阈值，把当前全部事件压缩为摘要并归档；无事件则创建空摘要文件
async function compactEventsIfNeeded(botId, chatFn, force = false) {
  if (!chatFn || _compacting.has(botId)) return { ok: true, skipped: true };
  const rows = readEvents(botId);
  if (rows.length === 0) {
    if (!force) return { ok: true, skipped: true };
    if (!fs.existsSync(eventsSummaryFile(botId))) fs.writeFileSync(eventsSummaryFile(botId), '', 'utf8');
    console.log(`[memory:${botId}] 无经历事件，已创建空经历摘要文件`);
    return { ok: true, created: true };
  }
  if (!force && rows.length <= EVENT_THRESHOLD) return { ok: true, skipped: true };
  _compacting.add(botId);
  try {
    const take = Math.min(rows.length, force ? 50 : EVENT_COMPACT_OLD);
    const old = rows.slice(0, take);
    const out = await chatFn([
      { role: 'system', content: '你是记忆压缩器。把多条带时间的经历条目合并成按时间排序的一段连贯摘要（不超过300字），保留人物、事件经过、关系变化与结果。只输出一个 JSON 对象：{"summary":"..."}，不要多余文字。' },
      { role: 'user', content: old.map((r) => `[${fmtTs(r.ts)}] ${r.event}`).join('\n') },
    ], { maxTokens: 500, temperature: 0.3, jsonMode: true });
    const j = parseLooseJson(out);
    const summary = j && typeof j.summary === 'string' ? j.summary.trim() : '';
    if (!summary) return { ok: false, err: '压缩摘要为空，保留原事件' };
    fs.appendFileSync(eventsSummaryFile(botId), summary + '\n\n', 'utf8');
    fs.appendFileSync(eventsArchiveFile(botId),
      old.map((r) => `- [${fmtTs(r.ts)}] (P${r.importance}) ${r.event}`).join('\n') + '\n', 'utf8');
    fs.writeFileSync(eventsFile(botId), rows.slice(take).map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    console.log(`[memory:${botId}] 事件压缩：${old.length} 条 → 摘要，剩 ${rows.length - old.length} 条`);
    return { ok: true, compacted: old.length };
  } finally {
    _compacting.delete(botId);
  }
}

// ---------- L0 人格核心卡：persona_core.json ----------
function personaCoreFile(botId) { return path.join(botDir(botId), 'persona_core.json'); }

function readPersonaCore(botId) {
  try {
    const f = personaCoreFile(botId);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8')) || null;
  } catch { return null; }
}

// 种子指纹：任意用户文件（按层级优先排序拼接）变更即核心卡过期
function seedHash(botId) {
  return md5(collectSeed(botId));
}

// 内容是否为空/未填写的默认模板（视为无内容，不注入不参与蒸馏）
function isEmptyContent(key, raw) {
  const r = String(raw || '').trim();
  return !r || r === (DEFAULTS[key] || '').trim();
}

// 收集蒸馏源：优先 tier1（强制注入）用户文件全文，其次其他用户文件（截断）；
// 全部为空时返回 ''（此时核心卡完全从对话内容中生成）
function collectSeed(botId) {
  const parts = [];
  for (const f of getUserFiles(botId)) {
    const raw = readMemoryFile(botId, f.key).trim();
    if (isEmptyContent(f.key, raw)) continue;
    const cap = f.tier === 1 ? 4000 : 800;
    parts.push(`【${f.name}】\n${raw.slice(0, cap)}`);
  }
  return parts.join('\n\n');
}

// 用户文件是否全部为空/模板（此时人格完全从对话内容中生成）
function hasUserContent(botId) {
  return collectSeed(botId).length > 0;
}
function isSeedEmpty(botId) { return !hasUserContent(botId); } // 兼容别名

function isCoreFresh(botId) {
  const c = readPersonaCore(botId);
  return !!c && c.seedHash === seedHash(botId);
}

function formatCore(core) {
  const keys = ['identity', 'tone', 'boundaries', 'relationship_state', 'evolved_notes'];
  const names = ['身份', '语气', '边界', '关系现状', '演化备注'];
  return keys.map((k, i) => `${names[i]}：${String(core && core[k] || '').trim() || '-'}`).join('\n');
}

// 蒸馏人格核心卡：用户文件(优先 tier1) + 近期事件 + 近期对话 → 固定 schema 的小核心卡
// 用户文件全空时，完全依据对话内容生成（从对话中归纳人格）
async function distillPersonaCore(botId, chatFn) {
  if (!chatFn) return { ok: false, err: '无可用模型' };
  const seed = collectSeed(botId);
  const evs = getRecentEvents(botId, 20).map((r) => `[${fmtTs(r.ts)}] ${r.event}`).join('\n');
  const dial = getRecentSessions(botId, 30).slice(-16)
    .map((s) => `${s.role === 'assistant' ? '角色' : '用户'}: ${String(s.content || '').slice(0, 200)}`)
    .join('\n');
  const sys = '你是人格蒸馏器。依据「用户设定文件」（若有）与「近期经历」（关键事件与对话摘录），' +
    '提炼一份精简、稳定、可直接指导对话的人格核心卡。字段要求（全部为字符串）：' +
    'identity 身份与基调（≤80字）；tone 说话风格，用指令式描述（≤80字）；boundaries 不会做/禁忌/底线（≤60字）；' +
    'relationship_state 当前与用户的关系阶段（≤60字）；evolved_notes 设定文件之外从经历中沉淀的性格演化，没有写"暂无"（≤80字）。' +
    '只输出一个 JSON 对象，不要多余文字。';
  const user = `【用户设定文件】\n${seed ? seed.slice(0, 4000) : '（无——请完全依据近期经历与对话归纳该角色的人格）'}\n\n【近期关键事件】\n${evs || '（暂无）'}\n\n【近期对话摘录】\n${dial || '（暂无）'}`;
  const out = await chatFn([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { maxTokens: 500, temperature: 0.4, jsonMode: true });
  const j = parseLooseJson(out);
  if (!j || typeof j !== 'object') return { ok: false, err: '蒸馏结果解析失败' };
  const data = {
    ts: Date.now(),
    seedHash: seedHash(botId),
    core: {
      identity: String(j.identity || '').trim().slice(0, 200),
      tone: String(j.tone || '').trim().slice(0, 200),
      boundaries: String(j.boundaries || '').trim().slice(0, 150),
      relationship_state: String(j.relationship_state || '').trim().slice(0, 150),
      evolved_notes: String(j.evolved_notes || '').trim().slice(0, 200) || '暂无',
    },
  };
  fs.writeFileSync(personaCoreFile(botId), JSON.stringify(data, null, 2), 'utf8');
  console.log(`[memory:${botId}] 人格核心卡已蒸馏（种子指纹 ${data.seedHash.slice(0, 8)}）`);
  return { ok: true };
}

// 写入核心卡（用户/管理员手动编辑）：manual 标记抑制周期性自动重蒸馏
// 用户文件变更仍会触发重蒸馏并覆盖手动编辑——用户文件是人格的最终权威
function writePersonaCore(botId, core) {
  const c = {
    identity: String(core.identity || '').trim().slice(0, 200),
    tone: String(core.tone || '').trim().slice(0, 200),
    boundaries: String(core.boundaries || '').trim().slice(0, 150),
    relationship_state: String(core.relationship_state || '').trim().slice(0, 150),
    evolved_notes: String(core.evolved_notes || '').trim().slice(0, 200) || '暂无',
  };
  if (!c.identity && !c.tone) throw new Error('核心卡至少需要填写「身份」或「语气」');
  const data = { ts: Date.now(), seedHash: seedHash(botId), core: c, manual: true };
  fs.writeFileSync(personaCoreFile(botId), JSON.stringify(data, null, 2), 'utf8');
  console.log(`[memory:${botId}] 人格核心卡已手动编辑（种子指纹 ${data.seedHash.slice(0, 8)}）`);
  return true;
}

// 从核心卡反向生成种子（persona.md）：种子丢失/为空时一键恢复
// 生成后种子指纹变化 → 核心卡转为「待蒸馏」，下次对话或手动蒸馏会基于新种子刷新核心卡
function seedFromCore(botId) {
  const core = readPersonaCore(botId);
  if (!core || !core.core) return { ok: false, err: '尚无人格核心卡，无法生成种子' };
  const c = core.core;
  const md = `# 人格

## 基本信息
- ${c.identity || '（未提供）'}

## 性格特点
- ${c.evolved_notes && c.evolved_notes !== '暂无' ? c.evolved_notes : '（沿用核心卡设定）'}

## 说话风格
- ${c.tone || '（未提供）'}

## 行为边界
- ${c.boundaries || '（未提供）'}

## 与用户的关系
- ${c.relationship_state || '（未提供）'}
`;
  fs.writeFileSync(filePath(botId, 'persona'), md, 'utf8');
  console.log(`[memory:${botId}] 已从人格核心卡反向生成 persona.md 种子`);
  return { ok: true };
}

// ---------- L3 大文件分段摘要：plot/content → *_summary.json ----------
function summaryJsonFile(botId, key) { return path.join(botDir(botId), `${key}_summary.json`); }

function readSummary(botId, key) {
  try {
    const f = summaryJsonFile(botId, key);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || !Array.isArray(j.sections)) return null; // sections 可为空数组（源为空的占位摘要）
    return j;
  } catch { return null; }
}

function isSummaryFresh(botId, key) {
  const s = readSummary(botId, key);
  return !!s && s.srcHash === md5(readMemoryFile(botId, key));
}

// 把某个种子大文件压缩成分段摘要（每段一个主题、≤200字），srcHash 用于过期检测
// force=true（用户手动点击生成）时：源为空/模板也创建摘要文件（标注源为空），不再跳过
async function summarizeSource(botId, key, chatFn, force = false) {
  if (!chatFn) return { ok: false, err: '无可用模型' };
  const raw = readMemoryFile(botId, key);
  const src = raw.trim();
  const isEmpty = !src || src === (DEFAULTS[key] || '').trim();
  if (isEmpty) {
    if (!force) return { ok: false, skipped: true, err: `${key} 为空，跳过` };
    fs.writeFileSync(summaryJsonFile(botId, key),
      JSON.stringify({ ts: Date.now(), srcHash: md5(raw), sections: [], empty: true }, null, 2), 'utf8');
    console.log(`[memory:${botId}] ${key}.md 源为空，已创建空摘要文件`);
    return { ok: true, empty: true };
  }
  const sys = '你是设定压缩器。把给定设定文本压缩为分段摘要：每段一个主题、每段不超过200字，' +
    '保留全部关键设定、事实与数值，按原文顺序排列。只输出一个 JSON 对象：{"sections":["段1","段2"]}，不要多余文字。';
  const out = await chatFn([
    { role: 'system', content: sys },
    { role: 'user', content: src.slice(0, 12000) },
  ], { maxTokens: 800, temperature: 0.3, jsonMode: true });
  const j = parseLooseJson(out);
  const sections = j && Array.isArray(j.sections)
    ? j.sections.map((s) => String(s).trim()).filter(Boolean).slice(0, 12) : [];
  if (!sections.length) return { ok: false, err: '摘要解析失败，保留原注入方式' };
  fs.writeFileSync(summaryJsonFile(botId, key),
    JSON.stringify({ ts: Date.now(), srcHash: md5(readMemoryFile(botId, key)), sections }, null, 2), 'utf8');
  console.log(`[memory:${botId}] ${key}.md 已生成分段摘要（${sections.length} 段）`);
  return { ok: true, sections: sections.length };
}

// ---------- 记忆维护编排（服务端每轮对话后 fire-and-forget 调用） ----------
const _maintaining = new Set();

function bumpRounds(botId) {
  const meta = getMeta(botId);
  meta.distill = { ...(meta.distill || {}), since: ((meta.distill && meta.distill.since) || 0) + 1 };
  saveMeta(botId, meta);
}

// 单轮对话异步提炼：值得记的才入库（importance ≥ IMPORTANCE_FLOOR）
async function extractRoundEvents(botId, chatFn, round) {
  if (!round || !round.assistant) return;
  const convo = `用户：${String(round.user || '').slice(0, 1200)}\n角色：${String(round.assistant).slice(0, 1500)}`;
  const known = getRecentEvents(botId, 5).map((r) => `- ${r.event}`).join('\n');
  const sys = '你是记忆提炼器。判断这段对话是否包含值得长期记住的内容（关键剧情、关系变化、重要决定、重要新信息）。' +
    '日常寒暄/闲聊不要记录；内容与「已有事件」重复或仅是同一事件的延续感叹，不要重复记录。' +
    '只输出一个 JSON 对象：' +
    '{"record":false} 或 {"record":true,"events":[{"actors":["人物"],"event":"事件简述(≤80字)","emotion":"情绪","importance":1到5}]}' +
    `。importance 含义：3=值得记住，4=重要转折，5=重大事件；低于 ${IMPORTANCE_FLOOR} 的会被丢弃。` +
    'event 与 emotion 必须使用简体中文，不得混入英文单词。';
  const out = await chatFn([
    { role: 'system', content: sys },
    { role: 'user', content: `${convo}\n\n【已有事件】\n${known || '（暂无）'}` },
  ], { maxTokens: 300, temperature: 0.2, jsonMode: true });
  const j = parseLooseJson(out);
  if (!j || j.record !== true || !Array.isArray(j.events)) return;
  let n = 0;
  for (const ev of j.events.slice(0, 3)) {
    const imp = Math.round(Number(ev && ev.importance) || 0);
    if (imp < IMPORTANCE_FLOOR) continue;
    if (appendEvent(botId, { actors: ev.actors, event: ev.event, emotion: ev.emotion, importance: imp, source: 'auto' })) n++;
  }
  if (n) console.log(`[memory:${botId}] 本轮自动记录 ${n} 条事件`);
}

// 核心卡按需蒸馏：种子变更必蒸；未变更时若核心卡被手动编辑过则不自动覆盖，仅按周期重蒸
// 无任何素材（无用户文件、无事件、无会话）时跳过，避免凭空虚构人格
async function maybeDistill(botId, chatFn) {
  if (isSeedEmpty(botId) && !getRecentEvents(botId, 1).length && !getRecentSessions(botId, 1).length) {
    return { ok: false, skipped: true };
  }
  const core = readPersonaCore(botId);
  const stale = !core || core.seedHash !== seedHash(botId);
  const since = (getMeta(botId).distill || {}).since || 0;
  if (!stale && since < DISTILL_EVERY_ROUNDS) return { ok: true, skipped: true };
  if (!stale && core.manual) return { ok: true, skipped: true }; // 手动编辑版优先，不被周期蒸馏覆盖
  const r = await distillPersonaCore(botId, chatFn);
  if (r.ok) {
    const meta = getMeta(botId);
    meta.distill = { ...(meta.distill || {}), since: 0 };
    saveMeta(botId, meta);
  }
  return r;
}

// 对全部 tier2（摘要索引）启用文件生成/更新分段摘要（所有用户文件通用，含 persona/traits）
// force=true（用户手动点击蒸馏）：空源也创建占位摘要文件；false（自动维护）：空源跳过
async function summarizeAllSources(botId, chatFn, force = false) {
  const out = {};
  for (const key of getFileOrder(botId)) {
    if (MIGRATED_KEYS.has(key) || GENERATED_KEYS.has(key)) continue;
    if (!getFileEnabled(botId, key)) continue;
    if (getFileTier(botId, key) !== 2) continue;
    if (!force && isSummaryFresh(botId, key)) continue; // 自动维护：已同步的跳过
    const preset = FILE_TYPES.find((f) => f.key === key);
    try {
      out[key] = { name: preset ? preset.name : key, ...(await summarizeSource(botId, key, chatFn, force)) };
    } catch (e) {
      out[key] = { name: preset ? preset.name : key, ok: false, err: e.message };
    }
  }
  return out;
}

// 摘要按需生成：全部 tier2 启用文件（种子变更后自动重生成）
async function ensureSummaries(botId, chatFn) {
  return summarizeAllSources(botId, chatFn, false);
}

// 统一入口：提炼 → 压缩 → 蒸馏 → 摘要。同机器人串行防重叠，任何一步失败不影响其余。
async function maintain(botId, chatFn, round) {
  if (!chatFn || _maintaining.has(botId)) return;
  _maintaining.add(botId);
  try {
    if (round) {
      try { await extractRoundEvents(botId, chatFn, round); }
      catch (e) { console.warn(`[memory:${botId}] 事件提炼失败: ${e.message}`); }
      bumpRounds(botId);
    }
    try { await compactEventsIfNeeded(botId, chatFn); }
    catch (e) { console.warn(`[memory:${botId}] 事件压缩失败: ${e.message}`); }
    try { await maybeDistill(botId, chatFn); }
    catch (e) { console.warn(`[memory:${botId}] 核心卡蒸馏失败: ${e.message}`); }
    try { await ensureSummaries(botId, chatFn); }
    catch (e) { console.warn(`[memory:${botId}] 摘要生成失败: ${e.message}`); }
  } finally {
    _maintaining.delete(botId);
  }
}

// 面板状态：核心卡 / 事件流 / 摘要 的完整快照
function getMemState(botId) {
  migrateLegacy(botId);
  const core = readPersonaCore(botId);
  const evs = readEvents(botId);
  let archiveCount = 0;
  const af = eventsArchiveFile(botId);
  if (fs.existsSync(af)) archiveCount = fs.readFileSync(af, 'utf8').split('\n').filter((l) => /^- \[/.test(l)).length;
  return {
    core: core ? { ts: core.ts, core: core.core, manual: !!core.manual } : null,
    coreFresh: isCoreFresh(botId),
    seedEmpty: isSeedEmpty(botId),
    roundsSinceDistill: (getMeta(botId).distill || {}).since || 0,
    events: evs.slice(-200),
    eventCount: evs.length,
    archiveCount,
    summary: readEventsSummary(botId),
    summaryFileExists: fs.existsSync(eventsSummaryFile(botId)),
    // 全部 tier2 文件的摘要状态（含未创建的，供面板逐个展示/生成；所有用户文件通用）
    summaries: Object.fromEntries(getFileOrder(botId)
      .filter((k) => !MIGRATED_KEYS.has(k) && !GENERATED_KEYS.has(k))
      .filter((k) => getFileEnabled(botId, k) && getFileTier(botId, k) === 2)
      .map((k) => {
        const s = readSummary(botId, k);
        const preset = FILE_TYPES.find((f) => f.key === k);
        return [k, {
          name: preset ? preset.name : k,
          exists: !!s,
          empty: s ? s.sections.length === 0 : false,
          fresh: s ? s.srcHash === md5(readMemoryFile(botId, k)) : false,
          sections: s ? s.sections : [],
        }];
      })),
  };
}

// 组装 system prompt（分层记忆版）
  // 结构与裁剪优先级（超预算时从后往前裁）：
  //   头部  全局设定 + L0 人格核心卡（从用户文件+对话蒸馏）+ tier1 文件全文 —— 永不裁剪
  //   中层  tier2 文件：分段摘要优先注入，摘要缺失时小文件（≤1500 token）回退全文
  //   尾部  冷记忆索引（tier3，供 AI 经 recall_memory 按需读取）+ L1 经历摘要 + 近期事件
  // 所有用户文件通用处理，无固定文件特权；人格核心卡从「用户文件+对话内容」蒸馏
  function buildSystemPrompt(botId, opts = {}) {
    const head = [], mid = [], tail = [];
    if (opts.useGlobal !== false) {
      for (const gf of getGlobalFiles()) {
        if (!gf.enabled) continue;
        const gc = gf.content.trim();
        if (!gc) continue;
        head.push(`【全局·${gf.name}】\n${gc}`);
      }
    }
    migrateLegacy(botId);
    const order = getFileOrder(botId); // 用户拖动的重要性排序（越靠前越重要），同层内注入顺序跟随
    const dir = botDir(botId);
    const readFile = (key) => {
      try { return fs.readFileSync(path.join(dir, `${key}.md`), 'utf8'); } catch { return ''; }
    };
    // L0 人格核心卡（若已蒸馏且未过期）
    const core = readPersonaCore(botId);
    if (core && isCoreFresh(botId)) {
      head.push('【人格核心】\n' + formatCore(core.core));
    }
    // 中层（tier2）+ 头部（tier1）：全部用户文件通用处理
    for (const key of order) {
      if (MIGRATED_KEYS.has(key) || GENERATED_KEYS.has(key)) continue;
      if (!getFileEnabled(botId, key)) continue;
      const tier = getFileTier(botId, key);
      const preset = FILE_TYPES.find((f) => f.key === key);
      const label = preset ? preset.name : key;
      if (tier === 1) {
        const c = readFile(key).trim();
        if (!isEmptyContent(key, c)) head.push(`【${label}】\n${c}`);
        continue;
      }
      if (tier === 3) continue; // 冷记忆不注入，仅进索引
      // tier2：摘要优先；缺失时小文件（≤1500 token）回退全文，否则等蒸馏
      const s = readSummary(botId, key);
      if (s && s.srcHash === md5(readFile(key))) {
        const text = s.sections.map((x) => String(x).trim()).filter(Boolean).join('\n\n');
        if (text) { mid.push(`【${label}摘要】\n${text}`); continue; }
      }
      const c = readFile(key).trim();
      if (!isEmptyContent(key, c) && estTokens(c) <= 1500) mid.push(`【${label}】\n${c}`);
    }
  // 尾部：冷记忆索引 + L1 事件流（老事件摘要 + 最近 N 条）
  const coldFiles = getColdFiles(botId);
  if (coldFiles.length) {
    tail.push('【冷记忆索引】以下记忆档案未注入对话，需要相关背景时可调用 recall_memory 工具读取：\n'
      + coldFiles.map((f) => `- ${f.key}（${f.name}${f.desc ? '：' + f.desc : ''}）`).join('\n'));
  }
  const evSummary = readEventsSummary(botId);
  if (evSummary) tail.push('【经历摘要】\n' + evSummary);
  const recent = getRecentEvents(botId, EVENT_INJECT_RECENT);
  if (recent.length) tail.push('【近期经历】\n' + recent.map((r) => `- ${r.event}`).join('\n'));
  // 预算裁剪：尾部事件逐个丢弃 → 近期经历减半 → 冷记忆索引最后保留
  const cost = (arr) => arr.reduce((n, s) => n + estTokens(s), 0);
  let total = cost(head) + cost(mid) + cost(tail);
  const dropAll = (arr) => {
    while (arr.length && total > SYSTEM_BUDGET_TOKENS) {
      total -= estTokens(arr.pop());
    }
  };
  const evIdx = () => tail.findIndex((s) => s.startsWith('【近期经历】'));
  if (total > SYSTEM_BUDGET_TOKENS && evIdx() >= 0) {
    const lines = tail[evIdx()].split('\n');
    const half = ['【近期经历】', ...lines.slice(1).slice(0, Math.ceil((lines.length - 1) / 2))].join('\n');
    total -= estTokens(tail[evIdx()]) - estTokens(half);
    tail[evIdx()] = half;
  }
  // 超预算：先丢事件块（保留冷记忆索引），再裁中层 tier2 文件；头部永不裁剪
  if (total > SYSTEM_BUDGET_TOKENS) {
    for (let i = tail.length - 1; i >= 0 && total > SYSTEM_BUDGET_TOKENS; i--) {
      if (tail[i].startsWith('【近期经历】') || tail[i].startsWith('【经历摘要】')) {
        total -= estTokens(tail[i]);
        tail.splice(i, 1);
      }
    }
  }
  if (total > SYSTEM_BUDGET_TOKENS) dropAll(mid);
  if (total > SYSTEM_BUDGET_TOKENS) {
    console.warn(`[memory:${botId}] system prompt 仍超预算（≈${total} tokens），仅保留头部强制注入内容`);
  }
  return [...head, ...mid, ...tail].join('\n\n');
}

// 会话记录：追加一条 {role, content, ts} 到「默认线程」
// ts 唯一性由 threads 索引层的 lastTs 取号器保证 —— 提到索引层是因为拆成多线程后，
// 若各文件各自顺延，不同线程会撞 ts，而按 ts 删除时就会一次删掉两条。
function appendSession(botId, role, content) {
  return threads.appendMessage(botId, threads.getDefaultThreadId(botId), role, content);
}

// ---------- 全局设定（设置页管理：多文件 + 开关，存于 memory/global/） ----------
const GLOBAL_DIR = path.join(MEMORY_DIR, 'global');

// 全局预设文件定义（顺序即 system prompt 组装顺序）
const GLOBAL_TYPES = [
  { key: 'user',   name: '用户设定',   desc: '告知 AI 用户情况 / 角色扮演身份' },
  { key: 'prompt', name: '全局提示词', desc: '所有机器人默认遵循的提示词' },
];
const GLOBAL_DEFAULTS = {
  user: `# 用户设定

## 用户身份
-

## 对话偏好
-

## 角色扮演：用户扮演的角色
-
`,
  prompt: `# 全局提示词

这里是所有机器人都默认遵循的提示词（如通用回复风格、禁忌等）。
`,
};

// 迁移旧版单文件全局设定（memory/global_user.md、global_prompt.md → memory/global/user.md、prompt.md）
function migrateGlobalFile(oldName, key) {
  const old = path.join(MEMORY_DIR, oldName);
  const target = path.join(GLOBAL_DIR, `${key}.md`);
  if (!fs.existsSync(target) && fs.existsSync(old)) {
    try {
      fs.copyFileSync(old, target);
      fs.unlinkSync(old);
      console.log(`[memory] 已迁移全局文件 ${oldName} → global/${key}.md`);
    } catch (e) { console.log('[memory] 全局文件迁移失败:', e.message); }
  }
}

function globalDir() {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  migrateGlobalFile('global_user.md', 'user');
  migrateGlobalFile('global_prompt.md', 'prompt');
  return GLOBAL_DIR;
}

function globalMetaFile() {
  return path.join(GLOBAL_DIR, '_meta.json');
}
function getGlobalMeta() {
  try {
    const f = globalMetaFile();
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) || { files: {} };
  } catch {}
  return { files: {} };
}
function saveGlobalMeta(meta) {
  fs.writeFileSync(globalMetaFile(), JSON.stringify(meta, null, 2), 'utf8');
}
function getGlobalFileEnabled(key) {
  const meta = getGlobalMeta();
  return meta.files[key]?.enabled !== false; // 默认启用
}
function setGlobalFileEnabled(key, enabled) {
  assertSafeKey(key);
  const meta = getGlobalMeta();
  meta.files[key] = { ...(meta.files[key] || {}), enabled: enabled !== false };
  saveGlobalMeta(meta);
  return true;
}

// 读取全局文件（不存在则初始化默认模板）
function readGlobalFile(key) {
  assertSafeKey(key);
  const def = GLOBAL_DEFAULTS[key];
  const file = path.join(GLOBAL_DIR, `${key}.md`);
  if (!fs.existsSync(file) && def !== undefined) fs.writeFileSync(file, def, 'utf8');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}
function saveGlobalFile(key, content) {
  assertSafeKey(key);
  fs.writeFileSync(path.join(GLOBAL_DIR, `${key}.md`), content ?? '', 'utf8');
  return true;
}
function deleteGlobalFile(key) {
  assertSafeKey(key);
  const file = path.join(GLOBAL_DIR, `${key}.md`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}

// 列出全部全局文件（预设在前，自定义按名称），含启用状态与内容
function getGlobalFiles() {
  const dir = globalDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch {}
  for (const f of GLOBAL_TYPES) if (!names.includes(f.key)) readGlobalFile(f.key);
  names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  names.sort((a, b) => {
    const ia = GLOBAL_TYPES.findIndex((f) => f.key === a);
    const ib = GLOBAL_TYPES.findIndex((f) => f.key === b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b, 'zh-CN');
  });
  return names.map((key) => {
    const preset = GLOBAL_TYPES.find((f) => f.key === key);
    return {
      key,
      name: preset ? preset.name : key,
      desc: preset ? preset.desc : '自定义全局文件（勾选「采用全局设定」的机器人将一并读取）',
      content: fs.readFileSync(path.join(dir, `${key}.md`), 'utf8'),
      enabled: getGlobalFileEnabled(key),
    };
  });
}

// ---------- Token 用量统计 ----------
const USAGE_FILE = path.join(MEMORY_DIR, 'usage.jsonl');

// 记录一次模型调用用量。任何调用都会记录一条（含失败的），保证调用次数与消耗接近实际。
// info: { usage(模型返回的精确用量，可能为 null), promptTokens(本地估算兜底), ok(是否成功) }
// 优先使用模型返回的精确 usage；失败或缺失时用本地估算兜底。
function recordUsage(botId, modelId, info = {}) {
  const usage = info.usage || {};
  const norm = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
  const prompt = norm(usage.prompt_tokens) || norm(info.promptTokens);
  const completion = norm(usage.completion_tokens);
  const total = norm(usage.total_tokens) || (prompt + completion);
  fs.appendFileSync(USAGE_FILE, JSON.stringify({
    ts: Date.now(),
    botId: String(botId || '未知'),
    modelId: String(modelId || '未知'),
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    ok: info.ok !== false,
  }) + '\n', 'utf8');
}

// 汇总统计：累计 / 今日 / 按机器人 / 按模型 / 近 14 天
function getUsageStats() {
  const rows = [];
  if (fs.existsSync(USAGE_FILE)) {
    for (const l of fs.readFileSync(USAGE_FILE, 'utf8').split('\n')) {
      const t = l.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch {}
    }
  }
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();
  const add = (o, r) => {
    o.calls++;
    if (r.ok === false) o.failed++;
    else o.ok++;
    o.prompt += r.promptTokens || 0; o.completion += r.completionTokens || 0; o.total += r.totalTokens || 0;
  };
  const total = { calls: 0, ok: 0, failed: 0, prompt: 0, completion: 0, total: 0 };
  const today = { calls: 0, ok: 0, failed: 0, prompt: 0, completion: 0, total: 0 };
  const byBot = new Map();
  const byModel = new Map();
  const byDay = new Map();
  for (const r of rows) {
    add(total, r);
    if (r.ts >= todayTs) add(today, r);
    const b = byBot.get(r.botId) || { botId: r.botId, calls: 0, ok: 0, failed: 0, prompt: 0, completion: 0, total: 0 };
    add(b, r); byBot.set(r.botId, b);
    const m = byModel.get(r.modelId) || { modelId: r.modelId, calls: 0, ok: 0, failed: 0, prompt: 0, completion: 0, total: 0 };
    add(m, r); byModel.set(r.modelId, m);
    const d = new Date(r.ts);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const day = byDay.get(dateStr) || { date: dateStr, total: 0 };
    day.total += r.totalTokens || 0; byDay.set(dateStr, day);
  }
  // 近 14 天补零
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push(byDay.get(dateStr) || { date: dateStr, total: 0 });
  }
  const sortDesc = (a, b) => b.total - a.total;
  return {
    total,
    today,
    byBot: [...byBot.values()].sort(sortDesc),
    byModel: [...byModel.values()].sort(sortDesc),
    byDay: days,
  };
}

// 读取最近 N 条会话 —— **跨线程归并**（角色视角）
// 刻意不限定线程：蒸馏 / 摘要 / 心跳 / 精彩时刻 / 管理员总结都走这条，它们要看到的是
// 「这个角色的全部经历」，而不是某一条对话线程。对话上下文请用
// threads.getThreadSessions(botId, tid, limit)。
function getRecentSessions(botId, limit = 10) {
  return threads.readAllRecent(botId, limit);
}

// 清空会话 —— 只清「默认线程」（保守：破坏性操作不跨线程，避免误删其它对话）
function clearSessions(botId) {
  threads.clearThread(botId, threads.getDefaultThreadId(botId));
  return true;
}

// 按 ts 删除一条会话记录（AI 将不再读到它，用于清除拒答/答偏的历史）
// ts 跨线程唯一，故最多命中一条；跨线程搜索是为兼容「不指定线程」的老调用。
function deleteSession(botId, ts) {
  return threads.deleteMessageByTs(botId, ts);
}

// 对话分支 → 已改为「非破坏性派生」：以 fromTs 为界，把该点及其之前复制成一条新线程，
// **原线程一条都不动**（旧实现会把主会话截断到分叉点，属破坏性，按方案要求换掉）。
// 派生出的线程 origin:'fork'，与普通新建线程在索引里可区分。
function forkSession(botId, fromTs, opts) {
  return threads.forkThread(botId, fromTs, opts);
}

// 读取老分支文件元信息（frozen 归档，只读）
// C1 起 fork 不再写 branches/，这批文件保留作回溯依据；C2 前端换成线程 UI 后即可下掉。
function listBranches(botId) {
  return threads.listBranchFiles(botId);
}

// 恢复归档分支：不再写回 sessions.jsonl（新模型下已无意义），改为恢复成一条可继续对话的线程
function restoreBranch(botId, fromTs) {
  return threads.restoreBranchAsThread(botId, fromTs);
}

// 记录最近一个与机器人对话的用户 openid（方便面板主动发消息）
function saveLastSender(botId, sender) {
  if (!sender) return;
  fs.writeFileSync(path.join(botDir(botId), 'last_sender.json'), JSON.stringify({ sender, ts: Date.now() }), 'utf8');
}

function getLastSender(botId) {
  const file = path.join(botDir(botId), 'last_sender.json');
  try {
    if (!fs.existsSync(file)) return '';
    return JSON.parse(fs.readFileSync(file, 'utf8')).sender || '';
  } catch { return ''; }
}

// 主 ID：机器人与用户的第一个对话者 openid（只记录第一次，不覆盖）
function saveMasterSender(botId, sender) {
  if (!sender) return;
  if (getMasterSender(botId)) return; // 已有主 ID 则保持不变
  fs.writeFileSync(path.join(botDir(botId), 'master_sender.json'), JSON.stringify({ sender, ts: Date.now() }), 'utf8');
}

function getMasterSender(botId) {
  const file = path.join(botDir(botId), 'master_sender.json');
  try {
    if (!fs.existsSync(file)) return '';
    return JSON.parse(fs.readFileSync(file, 'utf8')).sender || '';
  } catch { return ''; }
}

// ---------- 面板管理员会话记录（Agent 长期记忆） ----------
// 存储：memory/admin/sessions.jsonl（每行一条 {id, ts, role, content}）
const ADMIN_DIR = path.join(MEMORY_DIR, 'admin');
const ADMIN_FILE = path.join(ADMIN_DIR, 'sessions.jsonl');
const ADMIN_ID_RE = /^[\w-]{1,40}$/;

function ensureAdminDir() {
  fs.mkdirSync(ADMIN_DIR, { recursive: true });
}

// 记录一条管理员对话消息（user/assistant）；自动创建会话
function recordAdminSession(id, role, content) {
  if (!ADMIN_ID_RE.test(String(id || ''))) return false;
  if (!['user', 'assistant'].includes(role)) return false;
  const text = String(content || '').trim();
  if (!text) return false;
  ensureAdminDir();
  fs.appendFileSync(ADMIN_FILE, JSON.stringify({ id: String(id), ts: Date.now(), role, content: text.slice(0, 8000) }) + '\n', 'utf8');
  return true;
}

// 会话列表（按最近活动倒序）：{ id, title, count, updatedAt }
function listAdminSessions() {
  ensureAdminDir();
  if (!fs.existsSync(ADMIN_FILE)) return [];
  const map = new Map();
  for (const l of fs.readFileSync(ADMIN_FILE, 'utf8').split('\n')) {
    const t = l.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (!ADMIN_ID_RE.test(String(row.id || ''))) continue;
      const s = map.get(row.id) || { id: row.id, count: 0, title: '新对话', updatedAt: 0 };
      if (!s.title || s.title === '新对话') {
        const first = row.content.replace(/\s+/g, ' ').trim();
        if (first) s.title = first.slice(0, 20);
      }
      s.count++;
      if (row.ts > s.updatedAt) s.updatedAt = row.ts;
      map.set(row.id, s);
    } catch {}
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// 读取某会话全部消息 [{ role, content, ts }]
function getAdminSession(id) {
  if (!ADMIN_ID_RE.test(String(id || ''))) return [];
  ensureAdminDir();
  if (!fs.existsSync(ADMIN_FILE)) return [];
  const rows = [];
  for (const l of fs.readFileSync(ADMIN_FILE, 'utf8').split('\n')) {
    const t = l.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row.id === String(id) && (row.role === 'user' || row.role === 'assistant')) rows.push({ role: row.role, content: row.content, ts: row.ts });
    } catch {}
  }
  return rows;
}

// 删除一个会话
function deleteAdminSession(id) {
  if (!ADMIN_ID_RE.test(String(id || ''))) return false;
  ensureAdminDir();
  if (!fs.existsSync(ADMIN_FILE)) return false;
  const kept = fs.readFileSync(ADMIN_FILE, 'utf8').split('\n')
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      try { return JSON.parse(t).id !== String(id); } catch { return true; }
    });
  fs.writeFileSync(ADMIN_FILE, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  return true;
}

module.exports = {
  FILE_TYPES, memoryDir, getMemoryFiles, readMemoryFile, saveMemoryFile, deleteMemoryFile, appendMemoryFile, appendKeyEvent,
  getFileEnabled, setFileEnabled, setFileDesc, buildSystemPrompt,
  getFileOrder, setFileOrder,
  // 记忆层级
  getFileTier, setFileTier, getColdFiles, readColdFile,
  // 摘要生成
  summarizeAllSources,
  // 核心卡编辑
  writePersonaCore, formatCore, seedFromCore,
  // 事件管理
  deleteEvent, clearEvents, clearEventsSummary,
  // 分层记忆
  appendEvent, readEvents, getRecentEvents, compactEventsIfNeeded,
  readPersonaCore, isCoreFresh, distillPersonaCore, maybeDistill,
  summarizeSource, readSummary, isSummaryFresh, maintain, getMemState,
  appendSession, getRecentSessions, clearSessions, deleteSession, forkSession, listBranches, restoreBranch,
  // 对话线程层（多线程改造 C1）：threads.getThreadSessions 走单线程、threads.readAllRecent 走跨线程，
  // 线程 CRUD 与一次性迁移都在这里，详见 lib/memory/threads.js
  threads,
  getGlobalFiles, readGlobalFile, saveGlobalFile, deleteGlobalFile, getGlobalFileEnabled, setGlobalFileEnabled,
  recordUsage, getUsageStats,
  saveLastSender, getLastSender, saveMasterSender, getMasterSender,
  recordAdminSession, listAdminSessions, getAdminSession, deleteAdminSession,
};
