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
  const report = { ran: false, persist: false, writers: 0, created: [], details: [] };

  if (!cfg || typeof cfg !== 'object') return report;
  if (!Array.isArray(cfg.bots)) cfg.bots = [];

  // ★ 幂等闸门：旧标记是「存在 characters 字段」（哪怕是空数组，也代表迁移跑过了）；
  //   新标记是 characterPools。两者任一命中就只补字段、不重复提取角色。
  const hadCharsField = Array.isArray(cfg.characters);
  const hadPools = Array.isArray(cfg.characterPools);

  // 把老格式（单一 characters）装进「默认池」；已是新格式则只做结构自愈。幂等。
  const mig = characters.ensurePools(cfg);
  const firstPool = characters.listPools(cfg)[0];
  const target = firstPool ? firstPool.characters : [];

  // fillFields 返回「这次真的动了配置几处」——调用方靠它决定要不要落盘
  const fillFields = () => {
    let added = 0;
    for (const b of cfg.bots) {
      if (!b.kind) { b.kind = 'writer'; report.writers++; added++; }
      if (!Array.isArray(b.activeCharacterIds)) { b.activeCharacterIds = []; added++; }
      if (!Array.isArray(b.poolIds)) { b.poolIds = []; added++; }
    }
    characters.sanitizeReferences(cfg.bots, characters.allOf(cfg));
    characters.syncPoolCharacters(cfg);
    return added;
  };

  if (hadPools || hadCharsField) {
    const added = fillFields();
    // ★ 必须让调用方知道「配置被改过」，否则这里只改内存不落盘：
    //   store.getConfig() 每次调用都重新读盘（lib/store.js），ensurePools 造的池
    //   于是每读一次就重造一遍 —— 池 id 变成一次性的，绑池的写手瞬间指向不存在的池。
    report.persist = mig.migrated > 0 || mig.created || mig.orphans > 0 || added > 0;
    report.details.push(mig.migrated
      ? `旧角色 ${mig.migrated} 位已迁入角色池「${firstPool ? firstPool.name : '默认池'}」`
      : 'characterPools 已存在，只补齐缺失字段');
    // 残留旧字段被收编也要报出来 —— 这条以前是完全静默的，正是它让 4 个探针
    // 悄悄失效（见 ensurePools 里的长注释）。落盘 + 打印，才能让写入方看见。
    if (mig.orphans) {
      report.details.push(
        `退役字段 characters 里残留的 ${mig.orphans} 位角色已收编进「${firstPool ? firstPool.name : '默认池'}」`,
      );
    }
    return report;
  }

  report.ran = true;
  report.persist = true;   // 首次迁移必然改动了配置，调用方要落盘

  for (const b of cfg.bots) {
    if (!b || typeof b !== 'object') continue;
    if (!b.kind) b.kind = 'writer';
    if (!Array.isArray(b.activeCharacterIds)) b.activeCharacterIds = [];
    if (!Array.isArray(b.poolIds)) b.poolIds = [];
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
    const c = characters.create(target, {
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
