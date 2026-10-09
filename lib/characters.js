// 角色池：可以有**多个**池子，角色分组存放，写手整池批量取用
// ------------------------------------------------------------------
// ★ 认知前提：本项目里 **bot 就是写手**（创作者），不是角色。
//   角色是写手笔下的人物。角色不堆在一个大池子里 —— 按作品 / 世界观 / 分组
//   拆成多个「角色池」，写手拿到自己池内所有角色。
//
// 存储位置：config.json 顶层 `characterPools` 数组
//   [{ id, name, desc, ts, botId, characters: [...] }]
//   · 角色**唯一归属**：一位角色只在一个池里，换池 = 移动（不是复制）。
//   · 选 config 而不是单独开文件，是为了复用已有的「整份覆盖 + 基线探针 +
//     原子写入」机制，一致性更有保障。
//   · 旧字段 `characters`（单一全局池）由 ensurePools() 迁移成「默认池」，只跑一次。
//
// ★★ 池 ↔ 写手 = **1:1**（2026-10-08 用户决策：「角色池对应写手」）
//   · 一位写手**最多一个**专属池；一个池**只归一位**写手。所有者记在 `pool.botId`。
//     `botId` 为 '' 表示无主（历史遗留 / 写手已删）—— 无主池没人看得见，但**角色一个不删**。
//   · ★ 写手**可以没有池**（用户 2026-10-08 追加决策：「删除角色池 → 删了就真没了」）：
//     池是用户能自由增删的资源，删掉不会「自动长回来」。没有池的写手看不见任何角色，
//     面板显示「未分配角色池」，可以「新建一个空池」或认领一个无主池。
//     唯一的自动建池路径是**按需**的 ensurePoolForBot（给它的池建第一个角色时触发），
//     不是每次同步都补齐 —— 那样一删就被补回来，用户会觉得按钮坏了。
//   · ★ 写手**看不见池外**的角色：名字、id、计数器一律不出现。别用 allOf(cfg) 当写手视野，
//     那是全局名单（旧实现就是这么把别家写手笔下的人物交出去的）。
//     写手的视野 = `charactersOfBot(cfg, bot)`。
//   · 写手**可以写入自己的池**：用 propose_character_create 提议建的人物，
//     用户确认后直接落进它的专属池。
//
// ★★ 派生字段（别直接写！）
//   · bot.poolIds            —— 恒等于 [自己的池 id]（没有池就是 []）
//   · bot.activeCharacterIds —— 恒等于自己池内角色的 id 列表（顺序同池内）
//   · bot.poolCharacterIds   —— 同上，保留只是为了 config 的形状契约不漂移
//   三个都由 syncPoolCharacters() 重算，权威只有一处：`pool.botId`。
//   ★ 为什么不把 activeCharacterIds 退役：server.js 里有十几处读它，让同步把结果写进去，
//     旧读取点一行都不用改（这是最省的落法）。但**任何地方都别直接写它**来表达归属 ——
//     下一次同步就会覆盖掉，而且覆盖得静默。
//
// 版本档：用户决策「写手可以改角色卡，但必须可回滚」→ 每次改写前把当前版本
//   推进 history[]（不覆盖、只追加），回滚就是把某个历史版本重新应用。
//
// ★★ 经历与计数器（用户决策 2026-10-04，详见《经历与计数器机制.md》）：
//   经历的产生地在**写手**，落点在**角色卡**，中间必须过一道「用户确认」。
//   · counters    —— 当前值，按「名字」平铺。全体写手共用这张表。
//   · experiences —— 沉淀下来的经历条目（追加式），记「为什么变成这样」。
//   · 规则（范围/初始值/何时增减）写在两处并集里：角色卡正文 `##Counter：` 与
//     写手的「标准要求」（见 counterNamesFor）。
//   · ★ 同名共享、异名不引用：两位写手都声明「好感度」→ 读写同一个值；
//     写手只看得见/动得了**自己有权**的名字（见 declaredView / filterDeclared /
//     counterNamesFor）。1:1 之后「池外角色」这个概念对写手已经不存在了。
//   · ★ counters / experiences **不进 history**：版本档的语义是「设定改过几版」，
//     塞进流水会立刻冲垮（MAX_HISTORY=20），语义也乱。
// ------------------------------------------------------------------
'use strict';
const crypto = require('node:crypto');

// 角色 id 前缀（与 bot 的 BOT1/BOT2 区分开，避免将来混用）
const ID_PREFIX = 'CHR';

// ★ 角色卡模板（用户在「设置 → 角色卡」里改，存在 config.json 的 characterTemplate）。
//   角色卡是**纯文本**：新建 / 编辑只有一整份 Markdown 正文，不拆「性格 / 年龄 / 外表 /
//   背景」这类分类框。模板就是这份正文的默认骨架，套进弹窗的文本框里给用户改。
//   图片不进正文，只以链接挂在角色卡上（avatar 字段，弹窗的「形象链接」）。
//   模板里 `##Counter：名字[范围]` 那一行会被引擎读（见 parseCounterSpecs）——
//   所以默认模板里就带一条，用户不用记语法。
//   `{{名字}}` 是占位，新建时会换成实际角色名（没有占位就不动）。
//
// ★★ 模板里**只放骨架，不放说明文字**。曾经在「形象」下面写过一行括号提示
//    「角色设定是纯文本，图片不进正文……」，结果它跟着模板进了**每一张**新建角色卡的
//    正文，写手读到的设定里就混着一句编辑器自己的说明。要提示用户，写在设置页 / 弹窗的
//    说明文案里，别写进模板。
const DEFAULT_CHAR_TEMPLATE = [
  '# {{名字}}',
  '',
  '## 形象',
  '- 外表：',
  '- 气质：',
  '',
  '## 基本设定',
  '- 身份：',
  '- 年龄：',
  '- 性格：',
  '- 说话方式：',
  '',
  '## 背景',
  '- 来自：',
  '- 经历：',
  '',
  '## 与他人的关系',
  '-',
  '',
  '##Counter：好感度[0,100]',
  '',
].join('\n');

// 套用模板：替换 `{{名字}}` / `{{name}}` 占位。模板为空就返回空（不强行塞默认）。
function applyCharTemplate(tpl, name) {
  const src = String(tpl || '').slice(0, 8000);
  if (!src.trim()) return '';
  const n = String(name || '').trim();
  return src.replace(/\{\{\s*(?:名字|name)\s*\}\}/gi, n);
}
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
// 取「允许的名字」集合里那些计数器在当前卡上的值（没记过就是 0 —— 也就是「还没被创建」）。
// 第二参传的是**允许集合**，不再等同于「写手声明过的名字」：见 counterNamesFor。
function declaredView(c, declared) {
  const out = {};
  for (const raw of Array.isArray(declared) ? declared : []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    out[name] = Number(c && c.counters && c.counters[name]) || 0;
  }
  return out;
}

// 只保留允许集合里的计数器名 —— 过滤掉越权的、别家私有的。
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

// ★★ 一位角色身上「这位写手有权看、有权改」的计数器名 = 两处的**并集**：
//      ① 角色卡正文里的 `##Counter：名字[范围]`  —— 计数器是**角色的**财产，
//         卡上白纸黑字写着「我有好感度」，那就是角色的声明，跟着角色走；
//      ② 写手在「标准要求 / 写手设定」里声明的名字 —— 留着这条是因为写手可能
//         先声明、还没落到任何一张卡上（老配置也全在这里）。
//
//   为什么①必须算权限（2026-10-08 用户指出）：此前角色卡只被用来**定范围**，
//   权限却只认②。于是「卡上写了 `##Counter：好感度[0,100]`、写手没再声明一遍」时，
//   写手既看不见这个计数器、提议也会被静默丢掉 —— 卡上的声明等于一句死话。
//   而角色卡的默认模板里**本来就带一行 `##Counter：好感度[0,100]`**，
//   所以每张新建的卡都会踩到这个坑。
//
//   顺序与去重：角色卡在前（范围与存在性以卡为准），写手的补充在后。
//   ⚠️ 只对「这位写手写得着的角色」调用（activeCharacterIds 里的），
//      别拿它去放开别人的角色 —— 「异名不引用」那条隔离仍然成立。
function counterNamesFor(ch, declared) {
  const out = [];
  const seen = new Set();
  const push = (n) => {
    const s = String(n || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const spec of characterCounterSpecs(ch)) push(spec.name);
  for (const n of Array.isArray(declared) ? declared : []) push(n);
  return out;
}

// ---------- ★★ 计数器声明语法：`##Counter：名字[范围]` ----------
//
// 用户决策 2026-10-05：角色卡是纯文本（设定本身是文字，图片只是挂在卡上的链接），
// 计数器直接写在正文里，一行一个：
//
//   ##Counter：好感度[0,100]
//   ##Counter：理智[0,100]        低于 20 会失控
//   ##Counter：秘密[]             不填范围 = 不做限制
//   ##Counter：羁绊               连方括号都不写 = 不做限制
//
// · `[]` 内是**数字范围**，写法宽容：`0,100` / `0~100` / `0-100` / `0，100` / `-10~10`。
// · **单值**（`[100]`）按**上限**处理（下限不限）。
// · **留空或不写** → 不做限制（这是默认，也是「我不想管边界」的表达）。
//
// ★ 旧写法继续认：写手「标准要求 / 写手设定」里「## 计数器」小节下的
//   `- 名字：范围 0–100…` 列表（见 parseDeclaredCounters 的回退分支）。
//   新语法优先 —— 同一份文本里两种都有时，以 `##Counter：` 为准。
const COUNTER_HEAD_RE = /^\s{0,3}#{1,6}\s*Counter\s*[：:]\s*(\S.*?)\s*$/i;

// 解析 `[...]` 里的范围文本 → { min, max }（null = 不限）
function parseCounterRange(inner) {
  const s = String(inner || '').trim();
  if (!s) return { min: null, max: null };
  // 先统一分隔符：波浪线/破折号/省略号 → `-`，中文逗号等 → `,`
  const norm = s.replace(/[～~–—−]/g, '-').replace(/[、，;；/|]/g, ',').replace(/\.\.+/g, '-');
  let parts;
  if (norm.includes(',')) {
    parts = norm.split(',');
  } else if (/(?<=\d)\s*-\s*(?=-?\d)/.test(norm)) {
    // 形如 `0-100` / `-10-10`：只切**数字之间**的连字符，数字前导的负号要留下
    parts = norm.split(/(?<=\d)\s*-\s*(?=-?\d)/);
  } else {
    parts = [norm];
  }
  const nums = parts.map((p) => Number(String(p).trim())).filter((n) => Number.isFinite(n));
  if (!nums.length) return { min: null, max: null };
  if (nums.length >= 2) {
    let a = nums[0];
    let b = nums[1];
    if (a > b) { const t = a; a = b; b = t; }   // 写反了自动纠正，不报错
    return { min: a, max: b };
  }
  return { min: null, max: nums[0] };           // 只有一个数 → 当作上限
}

// 解析 `##Counter：名字[范围] 说明` 这一行的**标题之后**的部分
function parseCounterSpecBody(rest) {
  let s = String(rest || '').trim();
  if (!s) return null;
  let before = s;
  let after = '';
  let range = { min: null, max: null };
  const rb = s.indexOf('[');
  if (rb >= 0) {
    const re = s.indexOf(']', rb);
    if (re > rb) {
      // ★ 先取出方括号里的内容再改写 s —— 拼完之后中括号就没了，回头找会找不到
      range = parseCounterRange(s.slice(rb + 1, re));
      before = s.slice(0, rb);
      after = s.slice(re + 1);
      s = `${before} ${after}`;
    }
  }
  // 名字取第一段连续非空白（「好感度」「Trust_Level」），其余当说明
  const seg = String(before || '').trim().split(/\s+/).filter(Boolean);
  let name = seg.shift() || '';
  const desc = [...seg, ...String(after || '').trim().split(/\s+/).filter(Boolean)].join(' ').trim();
  name = String(name).replace(/[「」『』"']/g, '').trim();
  if (!name || name.length > MAX_COUNTER_NAME) return null;
  if (/^(计数器?|说明|备注|规则|范围)$/.test(name)) return null;
  const spec = { name, min: range.min, max: range.max };
  if (desc) spec.desc = desc.slice(0, 200);
  return spec;
}

// 从任意正文里扫出所有 `##Counter：…` 声明 → [{ name, min, max, desc? }]
function parseCounterSpecs(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    const m = COUNTER_HEAD_RE.exec(raw);
    if (!m) continue;
    const spec = parseCounterSpecBody(m[1]);
    if (!spec) continue;
    if (seen.has(spec.name)) continue;
    seen.add(spec.name);
    out.push(spec);
  }
  return out;
}

// 角色卡自身声明的计数器规格：扫它全部正文字段。
// ★ 角色卡是纯文本，`##Counter：` 可以写在 persona / 背景 / 外表 任意一处，
//   所以这里拼起来扫一遍 —— 用户不用记「必须写在哪一栏」。
function characterCounterSpecs(c) {
  if (!c || typeof c !== 'object') return [];
  const text = ['persona', 'background', 'appearance', 'traits']
    .map((k) => String(c[k] || ''))
    .join('\n');
  return parseCounterSpecs(text);
}

// 按名字找规格（找不到 = 不限）
function findCounterSpec(specs, name) {
  const want = String(name || '').trim();
  if (!want) return null;
  for (const s of Array.isArray(specs) ? specs : []) {
    if (s && String(s.name).trim() === want) return s;
  }
  return null;
}

// ★ 引擎侧的边界保证：把值压回范围里。
//   返回 { value, clamped, min, max } —— clamped=true 时上层要在回执里说清楚，
//   否则模型以为自己加了 20，实际只加了 5，下一轮会基于错误的前提继续写。
function clampCounterValue(spec, value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return { value: 0, clamped: false, min: null, max: null };
  let v = num;
  let clamped = false;
  if (spec) {
    if (Number.isFinite(spec.min) && v < spec.min) { v = spec.min; clamped = true; }
    if (Number.isFinite(spec.max) && v > spec.max) { v = spec.max; clamped = true; }
  }
  return {
    value: v,
    clamped,
    min: spec && Number.isFinite(spec.min) ? spec.min : null,
    max: spec && Number.isFinite(spec.max) ? spec.max : null,
  };
}

// ★ 把「当前值 + 增量」投影成「应有的增量」，范围越界就收敛到边界。
//   抽成纯函数的理由：**提议阶段**（模型还没落盘，要告诉用户会变成多少）与
//   **落盘阶段**（commitExperience）必须用同一套算法，否则预览说 +5、实际写 +3。
//   返回 { applied: {名: 实际增量}, clamped: [{name, want, value, min, max}] }
function projectCounters(current, deltas, specs) {
  const cur = current && typeof current === 'object' ? current : {};
  const applied = {};
  const clamped = [];
  for (const [k, v] of Object.entries(deltas || {})) {
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    const base = Number(cur[k]) || 0;
    const want = base + num;
    const r = clampCounterValue(findCounterSpec(specs, k), want);
    applied[k] = r.value - base;
    if (r.clamped) clamped.push({ name: k, want, value: r.value, min: r.min, max: r.max });
  }
  return { applied, clamped };
}

// 范围的简短形式：`0~100` / `≤100` / `≥0` / `不限`
function describeCounterRange(spec) {
  if (!spec) return '不限';
  const hasMin = Number.isFinite(spec.min);
  const hasMax = Number.isFinite(spec.max);
  if (hasMin && hasMax) return `${spec.min}~${spec.max}`;
  if (hasMax) return `≤${spec.max}`;
  if (hasMin) return `≥${spec.min}`;
  return '不限';
}

// 规格的可读形式，给提示词/回执用：`好感度（0~100）` / `秘密（不限）`
function describeCounterSpec(spec) {
  const name = String(spec && spec.name || '').trim();
  if (!name) return '';
  return `${name}（${describeCounterRange(spec)}）`;
}

// 从「写手设定 / 标准要求」正文里解析出该写手声明的计数器名。
// ★ 新语法优先：有 `##Counter：` 行就用它；否则退回旧约定 ——
//   一个标题含「计数」的小节，下面是 `- 名字：说明` 列表。
// 解析不出来就返回空数组（写手就动不了任何计数器 —— 安全的一侧）。
function parseDeclaredCounters(text) {
  const specs = parseCounterSpecs(text);
  if (specs.length) return specs.map((s) => s.name);
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
    // ★ 带上范围：写手得知道边界在哪，才不会写出「好感度 120」这种越界的数
    parts.push('【计数器】' + names.map((n) => {
      const sp = findCounterSpec(opts.specs, n);
      return sp ? `${n} ${view[n]}（${describeCounterRange(sp)}）` : `${n} ${view[n]}`;
    }).join('、'));
  } else if (Object.keys(c.counters || {}).length) {
    // 名单为空但卡上确实存着值 → 这些名字**哪儿都没声明**（角色卡正文里没写 `##Counter：`，
    // 本写手也没声明过），明确告诉它「不归你管」，避免它去猜或硬改。
    parts.push('【计数器】这张卡上存着计数器，但名字既没写在角色卡正文的 `##Counter：` 里、'
      + '本写手也没声明过，因此不显示、也不改动计数。要启用它，把 `##Counter：名字[范围]` 写进角色卡正文即可。');
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
//
// ★ specs（可选）：角色卡上 `##Counter：名字[范围]` 声明的规格。
//   给了就会把结果**压回范围里**（引擎侧保证，不靠模型自觉），
//   并把「被收敛了哪些」通过 clamped 返回给上层去写进回执。
function commitExperience(pool, id, data = {}, specs = null) {
  const c = find(pool, id);
  if (!c) return { ok: false, err: '角色不存在' };
  const deltas = normalizeCounters(data.counters);
  const text = String(data.text ?? '').trim().slice(0, MAX_EXP_TEXT);
  if (!text && !Object.keys(deltas).length) return { ok: false, err: '经历内容与计数器变化不能都为空' };
  const now = Date.now();
  if (!c.counters) c.counters = {};
  // ★ 与「提议阶段」共用 projectCounters —— 只有一份收敛逻辑，不会两处漂移
  const { applied, clamped } = projectCounters(c.counters, deltas, specs);
  for (const [k, v] of Object.entries(applied)) c.counters[k] = (Number(c.counters[k]) || 0) + v;
  let entry = null;
  if (text) {
    entry = { id: newExpId(), ts: now, text, by: String(data.by || '').slice(0, 40), counters: applied };
    c.experiences = [...(c.experiences || []), entry].slice(-MAX_EXPERIENCES);
  }
  return { ok: true, character: c, applied, clamped, entry };
}

// 直接设置某个计数器的值（绝对值）—— 管理员/用户在面板上改用。
// specs 同 commitExperience：有范围就压回范围里。
function setCounter(pool, id, name, value, specs = null) {
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
  const r = clampCounterValue(findCounterSpec(specs, n), num);
  c.counters[n] = r.value;
  return {
    ok: true,
    character: c,
    name: n,
    before,
    after: r.value,
    clamped: r.clamped ? [{ name: n, want: num, value: r.value, min: r.min, max: r.max }] : [],
  };
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

// ==================== 角色池（多池）====================
//
// 这一层只管「池」与「角色归哪个池」，角色本身的增删改仍走上面的
// create / update / remove —— 它们签名是 f(poolArray, ...)，
// 传 `pool.characters` 进去即可，所以核心逻辑一行没动。

const POOL_PREFIX = 'POOL';
const DEFAULT_POOL_NAME = '默认池';
// 从旧版单池迁移出来的「默认池」用**固定 id**，不用随机 id。
// ★ 为什么必须是固定的：store.getConfig() 每次调用都重新读盘（见 lib/store.js），
//   所以任何「只改内存、没落盘」的路径都会被下一次读盘抹掉。随机 id 会让
//   ensurePools 每被读一次就换一个池 id —— 绑池的写手瞬间指向不存在的池，
//   而且现象是「一会儿好一会儿坏」，极难定位。固定 id 让这条路径退化成幂等操作：
//   即使某次忘了落盘，读到的 id 也是同一个。
const DEFAULT_POOL_ID = POOL_PREFIX + 'default';

function newPoolId() {
  return POOL_PREFIX + crypto.randomBytes(6).toString('hex');
}

// ★★ 池的**所有者**（2026-10-08 用户决策：「角色池对应写手」）
//   · 一位写手**恰好一个**专属池；一个池**只归一位**写手。关系记在池这一侧（`botId`），
//     因为「池归谁」是池的属性，而且这样能表示「无主池」（历史遗留 / 写手已删），
//     无主池只是没人看得见，池里的角色一个不丢。
//   · bot.poolIds / activeCharacterIds 都成了**派生镜像**，由 syncPoolCharacters 重算。
//     ★ 为什么不把这些字段退役：它们出现在 config 的形状契约里（见 scripts/lib/sandbox.mjs
//       的 fixture 注释），删掉就是一次「消失 N 项」的形状漂移；而且 server.js 里有十几处
//       读 activeCharacterIds，让同步把结果写进去，旧读取点一行都不用改。
//   · ★ 权威只有一处：`pool.botId`。任何地方都别直接写 bot.activeCharacterIds 来表达归属。
function normalizePoolObj(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const ts = now || Date.now();
  return {
    id: String(raw.id || '').trim() || newPoolId(),
    name: String(raw.name || '').trim().slice(0, 40) || DEFAULT_POOL_NAME,
    desc: String(raw.desc || '').slice(0, 200),
    ts: Number(raw.ts) || ts,
    // 所有者写手 id；'' = 无主（旧数据 / 写手已删）。写入方见 syncPoolCharacters。
    botId: String(raw.botId || '').trim().slice(0, 64),
    characters: normalizePool(raw.characters),
  };
}

// ★ 保证 characterPools 就绪。三件事，都幂等：
//   ① 完全没有池 → 把旧的单一 characters 收进「默认池」
//   ② 已有池 → 结构自愈（丢坏条目、同 id 去重）；并**收编残留的旧字段**
//   ③ 池数组为空（例如被整份 PUT /api/config 写成 []）→ 补一个默认池，
//      维持「至少有一个池」这条不变量
//   返回值 { migrated, created, orphans }：
//     migrated = 从旧 characters 搬进默认池的角色数（走 ① 那条路时的总数）
//     created  = 本次新建了池（含 ③）—— 调用方据此判断「配置被改了，该落盘」
//     orphans  = 从**残留**旧字段里收编回来的角色数（走 ② 那条路时）
function ensurePools(cfg, now) {
  const ts = now || Date.now();

  // ① 完全没有池：整份（连同旧字段里的角色）搬进默认池
  if (!Array.isArray(cfg.characterPools)) {
    const legacy = Array.isArray(cfg.characters) ? cfg.characters : [];
    cfg.characterPools = [normalizePoolObj({
      id: DEFAULT_POOL_ID, name: DEFAULT_POOL_NAME, ts, characters: legacy,
    }, ts)];
    delete cfg.characters; // 旧字段退役，避免与新池重复
    return { migrated: legacy.length, created: true, orphans: 0 };
  }

  // ★★ 残留的旧字段：characterPools 已存在时，cfg.characters 本来是**被静默忽略**的。
  //    2026-10-08 就是栽在这上面 —— 4 个探针直接往 cfg.characters 里塞角色/改 persona，
  //    服务器只读池、没人读旧字段，于是报出来的是「池外角色不见了 / 计数器不收敛 /
  //    提议帧不下发」，指向的功能和真实原因完全无关，而且**没有任何报错**。
  //    所以这里先摘下来，等下并进默认池：宁可归属可疑，也不能静默丢掉数据。
  const stray = Array.isArray(cfg.characters) ? cfg.characters : null;
  if (stray) delete cfg.characters;

  // ② 结构自愈：丢掉坏条目、同 id 去重
  const seen = new Set();
  const pools = cfg.characterPools
    .map((p) => normalizePoolObj(p, ts))
    .filter((p) => (p && !seen.has(p.id) ? (seen.add(p.id), true) : false));

  // ③ 「至少有一个池」：否则整份 PUT /api/config 传 [] 就能把角色体系清空。
  //    removePool 已经守着这条，但那只覆盖「删」这一条路，写配置这条路也得守。
  let created = false;
  if (!pools.length) {
    pools.push(normalizePoolObj({ id: DEFAULT_POOL_ID, name: DEFAULT_POOL_NAME, ts }, ts));
    created = true;
  }

  // 收编残留角色：进默认池（没有默认池就进第一个）。池里已有同 id 的视为重复，丢旧的。
  let orphans = 0;
  if (stray && stray.length) {
    const target = pools.find((p) => p.id === DEFAULT_POOL_ID) || pools[0];
    const have = new Set(target.characters.map((c) => c.id));
    for (const raw of stray) {
      const c = normalizeCharacter(raw);
      if (!c || have.has(c.id)) continue;
      have.add(c.id);
      target.characters.push(c);
      orphans++;
    }
    if (orphans) warnStrayOnce(target.name, orphans);
  }

  cfg.characterPools = pools;
  return { migrated: 0, created, orphans };
}

// 只告警一次（配置每次读盘都是新对象，逐次告警会把日志刷爆）。
// 这条日志的价值在于：让「往退役字段写」这类静默失效**第一次就出声**。
let _strayWarned = false;
function warnStrayOnce(poolName, n) {
  if (_strayWarned) return;
  _strayWarned = true;
  console.warn(
    `[角色池] 顶层 characters 是已退役字段，已把其中 ${n} 位角色收编进「${poolName}」。\n` +
    '          写入方应改用 characterPools（角色住在 characterPools[i].characters）。',
  );
}

function listPools(cfg) {
  if (!Array.isArray(cfg.characterPools)) ensurePools(cfg);
  return cfg.characterPools;
}

function findPool(cfg, id) {
  return listPools(cfg).find((p) => p.id === id) || null;
}

// 全部角色（跨池扁平），给校验 / 注入 / 去重这类全局场景用
function allOf(cfg) {
  const out = [];
  for (const p of listPools(cfg)) out.push(...list(p.characters));
  return out;
}

// 角色所在池（唯一归属，所以最多一个）
function poolOfChar(cfg, charId) {
  for (const p of listPools(cfg)) {
    if (list(p.characters).some((c) => c.id === charId)) return p;
  }
  return null;
}

// 跨池找角色
function findAny(cfg, charId) {
  for (const p of listPools(cfg)) {
    const c = find(p.characters, charId);
    if (c) return c;
  }
  return null;
}

// ---------- ★★ 池 ↔ 写手（1:1，见 normalizePoolObj 上的长注释）----------

// 这位写手的专属池（没有就 null）。权威是 pool.botId。
function poolOfBot(cfg, botId) {
  const id = String(botId || '').trim();
  if (!id) return null;
  return listPools(cfg).find((p) => String(p.botId || '') === id) || null;
}

// ★ 这位写手**能看见、能写**的全部角色 —— 就是它专属池里的成员。
//   server.js 的提示词注入与 list_characters 都用这个，**不要**改用 allOf(cfg)：
//   allOf 是全局名单，拿它当写手视野就是把别家写手笔下的人物名字和 id 全交出去
//   （2026-10-08 用户报的「角色池中的角色会干扰写手」就是这个）。
function charactersOfBot(cfg, bot) {
  const p = bot && poolOfBot(cfg, bot.id);
  return p ? list(p.characters) : [];
}

// ★ 按需建池：给一位**还没有专属池**的写手建一个空池（幂等；已有池就原样返回）。
//   只改内存，落盘由调用方负责。
//   ★ 这是 1:1 之后**唯一**的自动建池路径，而且是「用到才建」，不是「每次同步都补齐」：
//     用户删掉某位写手的池，就是要它真没了（2026-10-08 用户明确）。调用点：
//       · POST /api/characters {botId} —— 给它的池建第一个角色时顺带把池建出来
//       · POST /api/pools {botId} —— 用户在面板上点「新建池」（这条自带名字，不走这里）
//   名字用「<写手名>的池」并自动避重（同名写手、已有池都不会被顶掉）。
function ensurePoolForBot(cfg, botId) {
  const id = String(botId || '').trim();
  if (!id) return null;
  const have = poolOfBot(cfg, id);
  if (have) return have;
  const b = (Array.isArray(cfg.bots) ? cfg.bots : []).find((x) => x.id === id);
  if (!b) return null;
  const now = Date.now();
  const p = normalizePoolObj({
    name: uniquePoolName(cfg, `${b.name || b.id}的池`),
    desc: '',
    ts: now,
    botId: id,
  }, now);
  listPools(cfg).push(p);
  return p;
}

// 无主池的认领：把池判给某位写手（该写手必须还没有池）。
// 只做「赋值 + 互斥检查」，不落盘 —— 落盘由调用方负责。
function assignPoolToBot(cfg, poolId, botId) {
  const p = findPool(cfg, poolId);
  if (!p) return { ok: false, err: '角色池不存在: ' + poolId };
  const b = (Array.isArray(cfg.bots) ? cfg.bots : []).find((x) => x.id === botId);
  if (!b) return { ok: false, err: '写手不存在: ' + botId };
  if (String(p.botId || '') === botId) return { ok: true, pool: p, changed: false };
  if (p.botId) {
    const owner = (cfg.bots || []).find((x) => x.id === p.botId);
    return { ok: false, err: `角色池「${p.name}」已经归写手「${(owner && owner.name) || p.botId}」了` };
  }
  const mine = poolOfBot(cfg, botId);
  if (mine) return { ok: false, err: `写手「${b.name || botId}」已经有专属池「${mine.name}」了（一位写手一个池）` };
  p.botId = botId;
  return { ok: true, pool: p, changed: true };
}

// 给池取一个不重名的名字（写手改名 / 重名池都不该顶掉别人）
function uniquePoolName(cfg, base) {
  const taken = new Set(listPools(cfg).map((p) => p.name));
  const stem = (String(base || '').trim().slice(0, 36) || '角色池');
  if (!taken.has(stem)) return stem;
  for (let i = 2; i < 200; i++) {
    const n = `${stem} ${i}`;
    if (!taken.has(n)) return n;
  }
  return `${stem} ${Date.now().toString(36).slice(-4)}`;
}

// ★★ 一次性迁移：把**无主池**判给「唯一匹配」的写手（2026-10-08，配套 1:1 落地）。
//
//   背景：1:1 之前池是共用的，历史盘上会留下没有 botId 的池。直接让它们无主会
//   让用户「角色突然全都不见了」。所以要认领，但**不能乱猜**：
//     · 判据 = 该池里的角色，出现在哪些写手的 `activeCharacterIds` 里
//       （迁移前这里记的是「用户手动勾选」，也就是事实上的归属线索）
//     · 命中**恰好一位**写手 → 判给它
//     · 命中 0 位或 ≥2 位 → **不猜**，保持无主（不制造「谁改的说不清」）
//     · 该写手已经有池了 → 跳过（1:1 不能被破坏）
//
//   ★ 必须在 syncPoolCharacters() **之前**调用：同步会把 activeCharacterIds 重算成
//     「自己池里的角色」，那份归属线索就没了。
//   只改内存，落盘由调用方负责。
function claimLegacyPools(cfg) {
  const pools = listPools(cfg);
  const bots = Array.isArray(cfg.bots) ? cfg.bots : [];
  const claimed = [];
  const unowned = [];
  for (const p of pools) {
    if (p.botId) continue;                       // 已有主，不动
    const ids = new Set(list(p.characters).map((c) => c.id));
    if (!ids.size) { unowned.push({ poolId: p.id, poolName: p.name, n: 0 }); continue; }
    const hits = bots.filter((b) => (Array.isArray(b.activeCharacterIds) ? b.activeCharacterIds : [])
      .some((id) => ids.has(id)));
    if (hits.length !== 1) { unowned.push({ poolId: p.id, poolName: p.name, n: ids.size }); continue; }
    const b = hits[0];
    if (poolOfBot(cfg, b.id)) { unowned.push({ poolId: p.id, poolName: p.name, n: ids.size }); continue; }
    p.botId = String(b.id);
    claimed.push({ poolId: p.id, poolName: p.name, botId: b.id, botName: b.name || b.id, n: ids.size });
  }
  return { claimed, unowned };
}

function createPool(cfg, data = {}) {
  const p = normalizePoolObj({ ...data, id: newPoolId() }, Date.now());
  listPools(cfg).push(p);
  return p;
}

function updatePool(cfg, id, patch = {}) {
  const p = findPool(cfg, id);
  if (!p) return { ok: false, err: '角色池不存在' };
  if (patch.name !== undefined) {
    const n = String(patch.name).trim().slice(0, 40);
    if (!n) return { ok: false, err: '池名不能为空' };
    p.name = n;
  }
  if (patch.desc !== undefined) p.desc = String(patch.desc).slice(0, 200);
  return { ok: true, pool: p };
}

// 删除池：池内角色默认移到第一个剩余池（不丢人）；
// opts.dropCharacters = true 时连角色一起删。
// ★ 不允许删掉最后一个池：角色必须有个地方放，全删掉等于把角色体系清空 ——
//   那是「删角色」该干的事，不该藏在「删池」里顺手做掉。想清空请逐个删角色。
function removePool(cfg, id, opts = {}) {
  const pools = listPools(cfg);
  // 先判「存在」再判「是不是最后一个」：顺序反了的话，只有 1 个池时
  // 连「删一个根本不存在的池」都会被报成「至少要保留一个池」，归因完全错位。
  const i = pools.findIndex((p) => p.id === id);
  if (i < 0) return { ok: false, code: 'missing', err: '角色池不存在' };
  if (pools.length <= 1) return { ok: false, code: 'last', err: '至少要保留一个角色池（角色必须归属于某个池）' };
  const [gone] = pools.splice(i, 1);
  const chars = list(gone.characters);
  let moved = 0; let dropped = 0;
  if (chars.length) {
    const target = opts.dropCharacters ? null : pools[0];
    if (target) {
      target.characters = normalizePool([...target.characters, ...chars]);
      moved = chars.length;
    } else {
      dropped = chars.length;
    }
  }
  return { ok: true, pool: gone, moved, dropped };
}

// 角色换池：从原池摘出、放进目标池（唯一归属，不是复制）
function moveCharacter(cfg, charId, toPoolId) {
  const from = poolOfChar(cfg, charId);
  if (!from) return { ok: false, err: '角色不存在' };
  if (from.id === toPoolId) return { ok: true, pool: from, moved: false };
  const to = findPool(cfg, toPoolId);
  if (!to) return { ok: false, err: '目标角色池不存在' };
  const i = from.characters.findIndex((c) => c.id === charId);
  if (i < 0) return { ok: false, err: '角色不存在' };
  const [c] = from.characters.splice(i, 1);
  to.characters = normalizePool([...to.characters, c]);
  return { ok: true, pool: to, character: c };
}

// ★★ 池 ↔ 写手关系的**唯一收敛点**（2026-10-08 重写）。
//   做三件事，全部幂等：
//     ① 清理所有权：botId 指向已不存在的写手 → 置空（池变无主，**角色一个不删**）；
//        一位写手却拥有多个池（历史数据）→ 只留最早的那个，其余置空。
//     ② 派生镜像：bot.poolIds = [自己的池]（没有池就是 []）；activeCharacterIds /
//        poolCharacterIds = 自己池里的角色（**严格按池** —— 手动勾选这个概念已取消）。
//     ③ 顺手清掉指向已不存在角色的悬空 id（靠 ② 天然完成）。
//   ★★ **不再给没有池的写手补池**（2026-10-08 用户：「删除角色池 → 删了就真没了」）。
//      这里补出来的池会让「删池」按钮看起来失灵（删完立刻又出现一个）。写手可以没有池，
//      要建池走 ensurePoolForBot（按需）/ POST /api/pools（用户点新建）。
//
//   ★ 为什么必须落盘：store.getConfig() 每次重新读盘，随机池 id 只在内存里等于没建
//     （见 ensurePools 上的长注释）。所以本函数**只允许在写路径上调用**，
//     调用方必须 app.saveConfig(cfg)。凡是改池 / 改写手 / 改绑定的入口都要调它。
//   返回被改动的写手数（调用方据此判断要不要落盘 / 报「已变更」）。
function syncPoolCharacters(cfg) {
  const pools = listPools(cfg);
  const bots = Array.isArray(cfg.bots) ? cfg.bots : [];
  const botIds = new Set(bots.map((b) => String(b.id)));
  let touched = 0;

  // ---- ① 清理所有权 ----
  const claimed = new Set();
  for (const p of pools) {
    const owner = String(p.botId || '');
    if (!owner) continue;
    if (!botIds.has(owner)) { p.botId = ''; touched++; continue; }   // 写手没了 → 无主
    if (claimed.has(owner)) { p.botId = ''; touched++; continue; }   // 一写手多池 → 只留第一个
    claimed.add(owner);
  }

  // ---- ② 派生镜像 ----
  for (const b of bots) {
    const own = pools.find((p) => String(p.botId || '') === String(b.id)) || null;
    const ids = own ? list(own.characters).map((c) => c.id) : [];
    const before = Array.isArray(b.activeCharacterIds) ? b.activeCharacterIds.join(',') : null;
    const beforePools = Array.isArray(b.poolIds) ? b.poolIds.join(',') : null;
    // ★ 顺序按池内顺序：面板上的先后跟池里一致，用户不会觉得「跳来跳去」
    if (before !== ids.join(',')) touched++;
    if (beforePools !== (own ? own.id : '')) touched++;
    b.poolIds = own ? [own.id] : [];
    b.activeCharacterIds = ids;
    // 这个字段现在恒等于 activeCharacterIds —— 保留只是为了 config 的形状契约不漂移。
    b.poolCharacterIds = ids.slice();
  }
  return touched;
}

// 这位写手能不能单独移除某角色。
// ★ 1:1 之后**一律不能**：写手的角色就是它池里的成员，想撤掉就把角色换到别的池。
//   保留这个函数是为了给前端一个统一的判据（避免各处自己拼逻辑）。
function charSource(cfg, bot, charId) {
  const p = poolOfChar(cfg, charId);
  if (!p) return { from: 'pool', detachable: false };
  const own = poolOfBot(cfg, bot && bot.id);
  return {
    from: 'pool',
    poolId: p.id,
    poolName: p.name,
    detachable: false,
    // 顺手告诉调用方「这个角色到底归谁」—— 面板要用
    ownerId: p.botId || '',
    mine: Boolean(own && own.id === p.id),
  };
}

module.exports = {
  ID_PREFIX,
  EDITABLE_FIELDS,
  DEFAULT_CHAR_TEMPLATE,
  applyCharTemplate,
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
  counterNamesFor,
  parseDeclaredCounters,
  parseCounterSpecs,
  parseCounterRange,
  characterCounterSpecs,
  findCounterSpec,
  clampCounterValue,
  projectCounters,
  describeCounterRange,
  describeCounterSpec,
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
  POOL_PREFIX,
  DEFAULT_POOL_NAME,
  DEFAULT_POOL_ID,
  newPoolId,
  normalizePoolObj,
  ensurePools,
  listPools,
  findPool,
  allOf,
  poolOfChar,
  findAny,
  poolOfBot,
  charactersOfBot,
  ensurePoolForBot,
  assignPoolToBot,
  uniquePoolName,
  claimLegacyPools,
  createPool,
  updatePool,
  removePool,
  moveCharacter,
  syncPoolCharacters,
  charSource,
};
