// 存量迁移：把旧的「角色卡」配置升级为「写手卡 + 角色池」
// ------------------------------------------------------------------
// 认知前提：bot 就是写手。所以迁移**不拆分 bot**，只做两件事：
//   1. 给每个 bot 补上写手字段（kind / activeCharacterIds）
//   2. 把「误放在写手人格槽里的角色设定」提取出来，落进全局角色池
//
// ★ 关键判断：怎么区分「写手设定」和「角色设定」？
//   现在无法自动判断 —— 所以策略是**只在明确是角色设定时才提取**：
//   用「非空模板」做判据（空模板 = 用户从没写过，不会误提取）。
//   已写过内容的一律提取成角色，且在原文加来源标记，用户可自行调整。
//
// ★ 幂等：迁移只在 config.characters 不存在时跑一次；重复调用无副作用。
// ------------------------------------------------------------------
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const characters = require('./characters');

// 与 lib/memory.js 的 DEFAULTS.persona 保持一致的判据基准
// （不 require memory.js 是为了避免循环依赖：memory.js 也要用 chatWithBot 链路）
const PERSONA_TEMPLATE_MARKERS = [
  '给机器人起个名字',
  '## 基本信息',
  '## 性格特点',
  '## 说话风格',
];

// 判断 persona.md 是不是「从没被写过」的空模板
// ⚠️ 判据必须谨慎：误判为「空」会让用户的真实设定在迁移时丢失。
//   踩过的坑：最初用 `t.length < 80` 做主判据 → 手写的短人格（如两行剑客设定，
//   约 44 字符）被判成空模板。**长度只能当辅助信号，不能当主判据。**
//
// 正确判据（按优先级）：
//   ① 完全空白 → 空
//   ② 去掉模板骨架行后，还有 ≥40 字符的实质内容 → 非空（无论多短）
//   ③ 没有模板骨架，但本身有内容 → 非空
//   ④ 只剩骨架 → 空
function isBlankPersona(text) {
  const t = String(text || '').trim();
  if (!t) return true;

  const hits = PERSONA_TEMPLATE_MARKERS.filter((m) => t.includes(m)).length;

  // 没有任何模板骨架：只要不是极短的空壳，就当作用户自己写的
  if (hits < 2) {
    // 纯标题 + 符号（如只有一行 `# 人格`）视为空
    const meaningful = t
      .split('\n')
      .map((l) => l.trim())
      .filter((s) => s && !/^#{1,6}\s/.test(s) && !/^[-—•*\s]+$/.test(s))
      .join('')
      .trim();
    return meaningful.length < 6;
  }

  // 含模板骨架 → 再看骨架之外有没有实质内容
  const stripped = t
    .split('\n')
    .filter((line) => {
      const s = line.trim();
      if (!s) return false;
      if (PERSONA_TEMPLATE_MARKERS.some((m) => s.includes(m))) return false;
      if (/^#{1,6}\s/.test(s)) return false;   // 纯标题行
      if (/^[-—•*\s]+$/.test(s)) return false; // 只有符号的项目符
      return true;
    })
    .join('')
    .trim();
  // 骨架之外还有实质内容 → 用户写过了（哪怕很短，如「- 名字：阿澈」）
  return stripped.length < 6;
}

// 从 persona.md 内容里拆出 name / persona / traits（尽力而为，拆不出就整体塞 persona）
function extractCharacter(text, fallbackName) {
  const t = String(text || '').trim();
  const out = { name: fallbackName || '未命名角色', persona: '', traits: '' };

  // ★ 优先从文本里找角色真名 —— 用 bot 名兜底是错的：
  //   bot 名是「写手名」，不是角色名（实测 BOT1 的 bot 名是「归云」，
  //   而 persona.md 里写的角色是「银」）。用错会让用户以为数据丢了。
  const namePatterns = [
    // 「- 名字：XXX」/「名字：XXX」
    /^[\s>*-]*名字[：:]\s*([^\n，,。（(]{1,20})/m,
    // 「# 角色：XXX」
    /^#+\s*角色[：:]\s*([^\n，,。（(]{1,20})/m,
    // 模板首行常见写法：「- 银，来自未来的仿真机器人男孩，……」
    /^[\s>*-]+([^\n，,。（(：:]{1,12})[，,]/m,
  ];
  for (const re of namePatterns) {
    const m = re.exec(t);
    if (m && m[1]) {
      const cand = m[1].trim().replace(/^[「『"']|[」』"']$/g, '');
      // 过滤掉明显是字段名而非人名的候选
      if (cand && !/^(名字|姓名|角色|人格|基本信息|性格特点|说话风格)$/.test(cand)) {
        out.name = cand;
        break;
      }
    }
  }

  // 「特点/性格」段落 → traits
  const traitMatch = /##\s*(性格特点|性格|特点)\s*\n([\s\S]*?)(?=\n##|$)/.exec(t);
  if (traitMatch) out.traits = traitMatch[2].trim();
  // 其余部分整体作为 persona（保留原始结构，不做有损改写）
  out.persona = t;
  return out;
}

// 主迁移：就地修改传入的 cfg 对象（由调用方决定何时保存）
function migrate(cfg, opts = {}) {
  const memoryDirOf = opts.memoryDirOf; // (botId) => 目录绝对路径
  const now = Date.now();
  const report = { ran: false, writers: 0, created: [], details: [] };

  if (!cfg || typeof cfg !== 'object') return report;
  if (!Array.isArray(cfg.bots)) cfg.bots = [];

  // ★ 幂等闸门：characters 已存在就认为迁移过了
  const already = Array.isArray(cfg.characters);
  if (already) {
    // 仍要补齐可能缺失的写手字段（后加的 bot）
    characters.sanitizeReferences(cfg.bots, cfg.characters);
    for (const b of cfg.bots) {
      if (!b.kind) { b.kind = 'writer'; report.writers++; }
      if (!Array.isArray(b.activeCharacterIds)) b.activeCharacterIds = [];
    }
    report.details.push('characters 已存在，只补齐缺失字段');
    return report;
  }

  cfg.characters = [];
  report.ran = true;

  for (const b of cfg.bots) {
    if (!b || typeof b !== 'object') continue;
    if (!b.kind) b.kind = 'writer';
    if (!Array.isArray(b.activeCharacterIds)) b.activeCharacterIds = [];
    report.writers++;

    // 尝试从 persona.md 提取角色
    if (typeof memoryDirOf !== 'function') { report.details.push(`${b.id}: 未提供 memoryDirOf，跳过提取`); continue; }
    const p = path.join(memoryDirOf(b.id), 'persona.md');
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch {
      // 记录而不是静默跳过 —— 迁移出问题时这份 details 是唯一线索
      report.details.push(`${b.id}: 读不到 persona.md（${p}），不提取角色`);
      continue;
    }

    if (isBlankPersona(text)) {
      report.details.push(`${b.id}: persona.md 是空模板，不提取角色`);
      continue;
    }

    const ex = extractCharacter(text, b.name);
    const c = characters.create(cfg.characters, {
      name: ex.name,
      persona: ex.persona,
      traits: ex.traits,
      tags: ['迁移'],
      source: `${b.id}/persona.md`,
      ts: now,
    }, 'migrate');
    if (!c) { report.details.push(`${b.id}: 角色创建失败`); continue; }
    b.activeCharacterIds = [c.id];
    report.created.push({ botId: b.id, charId: c.id, name: c.name, source: c.source });
    report.details.push(`${b.id}: 提取角色「${c.name}」← persona.md`);
  }

  return report;
}

module.exports = { migrate, isBlankPersona, extractCharacter, PERSONA_TEMPLATE_MARKERS };
