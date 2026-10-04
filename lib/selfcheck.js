// 输出后自检：正文写完之后，问模型一句「这一轮有没有该更新的东西」
// ------------------------------------------------------------------
// 用户决策 2026-10-05：
//   「模型在完成输出后，应该做以下操作，检查是否更新计数器，是否更新世界，剧情相关内容」
//
// 这三件事的**落地方式刻意不同**（沿用项目既有的权限模型）：
//   · 计数器  → 出「待确认」建议。数值变化是用户的地盘，AI 自己加会失控。
//   · 世界改变 → 出「待确认」建议。世界卡是底稿 + 追加流水的结构，追加也得用户点头。
//   · 剧情要点 → **直接写事件流**（events.jsonl）。它本来就是自动提炼的，没有确认环节。
//
// ★ 为什么单独一次调用、而不是让写手在正文里顺手产 JSON：
//   1. 正文是给人读的，往里塞结构化数据会污染输出（本项目已经在为【记录】标记收拾烂摊子）；
//   2. 自检发生在**正文完全写完之后**，模型看得见整篇，判断比边写边猜准；
//   3. 走**非流式**（`models.chat`）—— 前端不需要逐字看这段 JSON。
//
// ★ 失败必须无害：整套自检包在 try/catch 里，任何异常只打日志。
//   自检是「锦上添花」，绝不能因为它挂了就让用户拿不到正文（用户明确要求过这一点）。
//
// ★ 与 memory.maintain 的分工：自检开启时，**本轮的事件提炼由自检负责**，
//   maintain 只跑压缩/蒸馏/摘要（见 server.js 的调用点）。
//   不这么分，同一轮剧情会被记两遍。
'use strict';

// 自检的三态开关解析：写手覆盖 > 全局（全局默认**开**）
function isEnabled(bot, cfg) {
  if (bot && bot.selfCheck === true) return true;
  if (bot && bot.selfCheck === false) return false;
  return !cfg || cfg.selfCheck !== false;
}

// 每次自检最多接受多少条（防止模型一口气返回 20 条世界改变）
const MAX_COUNTER_TARGETS = 6;
const MAX_WORLD_ITEMS = 3;
const MAX_EVENTS = 3;

// 正文太长时的取样：**开头 + 结尾**都要。
// 只截前面会丢掉结局（该记的往往在最后），只截后面会丢掉起因。
// 预算：开头 2000 + 结尾 6000，够一次自检判断用了。
const HEAD_CHARS = 2000;
const TAIL_CHARS = 6000;

function sampleReply(reply) {
  const s = String(reply || '');
  if (s.length <= HEAD_CHARS + TAIL_CHARS) return s;
  return s.slice(0, HEAD_CHARS) + '\n\n……（中间省略）……\n\n' + s.slice(-TAIL_CHARS);
}

// 组装自检的 messages。
// ctx: { reply, characters:[{id,name,counters,ranges,declared}], world:{changes,active}, botName }
function buildMessages(ctx) {
  const lines = [];
  lines.push('你是剧情校对员。下面是写手刚写完的一段正文。你的任务**只有一件**：');
  lines.push('判断这一轮里有没有需要落到「角色卡」或「世界卡」上的客观变化，并按 JSON 输出。');
  lines.push('');
  lines.push('【判断标准】');
  lines.push('- 计数器：只有当剧情中发生了**确实改变了某个数值的事实**才报（被救 → 好感度 +5；挨了一刀 → 伤势 +1）。');
  lines.push('  没有事实支撑的猜测不要报；同一轮里对同一个人只报一次合计增量。');
  lines.push('- 世界改变：只有**世界层面**的变化才报（地点兴废、势力更替、规则被打破、大众认知改变）。');
  lines.push('  人物自己的遭遇属于角色卡，不要写进世界。');
  lines.push('- 剧情要点：只报**值得长期记住**的（关键剧情、关系变化、重要决定、重要新信息）。');
  lines.push('  日常寒暄、纯氛围描写、上一段的延续感叹，不要报。');
  lines.push('');
  lines.push('【这一轮可以动的角色】（只能从这里面选，用 id 指认）');
  if (!ctx.characters || !ctx.characters.length) {
    lines.push('（没有角色可选 —— counters / events 都留空数组）');
  } else {
    for (const c of ctx.characters) {
      const ks = Object.keys(c.counters || {});
      const ct = ks.length
        ? ks.map((k) => `${k}=${c.counters[k]}`).join('、')
        : '（还没有计数器）';
      lines.push(`- ${c.name}（id: ${c.id}）当前：${ct}`);
      if (c.declared && c.declared.length) {
        lines.push(`  可改的计数器名：${c.declared.map((s) => s.name + '（' + s.range + '）').join('、')}`);
      } else {
        lines.push('  可改的计数器名：（无 —— 这个角色没声明过任何计数器，counters 必须留空）');
      }
    }
  }
  lines.push('');
  lines.push('【世界卡现状】');
  if (ctx.world && ctx.world.active) {
    lines.push(`- 当前活跃世界：**${ctx.world.active}**（world 数组里记的改变都算在这个世界名下）`);
  }
  if (ctx.world && ctx.world.worlds && ctx.world.worlds.length > 1) {
    lines.push(`- 世界卡里有多个世界：${ctx.world.worlds.join('、')}（只有当前活跃那个才归你写）`);
  }
  if (ctx.world && ctx.world.changes && ctx.world.changes.length) {
    for (const w of ctx.world.changes.slice(-8)) lines.push(`- ${w.world ? `【${w.world}】` : ''}${w.text}`);
  } else {
    lines.push('（还没有记录过世界改变）');
  }
  lines.push('');
  lines.push('【正文】');
  lines.push(sampleReply(ctx.reply));
  lines.push('');
  lines.push('【输出格式】只输出一个 JSON 对象，不要任何多余文字。没有变化就给空数组。');
  lines.push('{');
  lines.push('  "counters": [{"characterId":"CHRxxx","deltas":{"好感度":5},"why":"为什么"}],');
  lines.push('  "world": [{"text":"世界被改成了什么样（一句话）","why":"为什么"}],');
  lines.push('  "events": [{"actors":["人物名"],"event":"剧情要点（≤80字）","emotion":"情绪","importance":3}]');
  lines.push('}');
  lines.push('');
  lines.push('说明：');
  lines.push('- counters.deltas 是**增量**（+5 写 5，-2 写 -2），不是绝对值；名字必须是上面列出的「可改的计数器名」。');
  lines.push('- 超出范围的值会被自动收敛到边界，所以按剧情实际幅度写就行，不用自己压。');
  lines.push('- importance：3=值得记住，4=重要转折，5=重大事件；1~2 会被丢弃。');
  lines.push('- event 与 emotion 必须用简体中文。');

  return [
    { role: 'system', content: lines.join('\n') },
    { role: 'user', content: '请按上面的格式输出这一轮的自检结果（JSON）。' },
  ];
}

// 宽松解析：模型偶尔会用 ```json 包裹，或前后带一句解释
function looseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const body = fence ? fence[1] : s;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

// 把模型输出收敛成结构化结果。**只做形状校验，不做权限判断** ——
// 权限（这个名字归不归这位写手、这个人是不是它的角色）留给 server.js，
// 因为那需要 cfg / bot 上下文，属于接线层的事。
function parseResult(text) {
  const j = looseJson(text);
  const out = { counters: [], world: [], events: [], ok: !!j };
  if (!j) return out;

  if (Array.isArray(j.counters)) {
    for (const row of j.counters.slice(0, MAX_COUNTER_TARGETS)) {
      if (!row || typeof row !== 'object') continue;
      const characterId = String(row.characterId || '').trim();
      if (!characterId) continue;
      const deltas = {};
      for (const [k, v] of Object.entries(row.deltas && typeof row.deltas === 'object' ? row.deltas : {})) {
        const name = String(k).trim().slice(0, 32);
        const num = Number(v);
        if (!name || !Number.isFinite(num) || num === 0) continue;   // 0 无意义，丢掉
        deltas[name] = num;
      }
      if (!Object.keys(deltas).length) continue;
      out.counters.push({ characterId, deltas, why: String(row.why || '').slice(0, 120) });
    }
  }

  if (Array.isArray(j.world)) {
    for (const row of j.world.slice(0, MAX_WORLD_ITEMS)) {
      const text2 = String((row && row.text) || '').trim().slice(0, 300);
      if (!text2) continue;
      out.world.push({ text: text2, why: String((row && row.why) || '').slice(0, 120) });
    }
  }

  if (Array.isArray(j.events)) {
    for (const row of j.events.slice(0, MAX_EVENTS)) {
      if (!row || typeof row !== 'object') continue;
      const event = String(row.event || '').trim().slice(0, 300);
      if (!event) continue;
      const imp = Math.round(Number(row.importance) || 3);
      out.events.push({
        actors: Array.isArray(row.actors) ? row.actors.map((x) => String(x).trim()).filter(Boolean).slice(0, 5) : [],
        event,
        emotion: String(row.emotion || '').slice(0, 30),
        importance: Math.max(1, Math.min(5, imp)),
      });
    }
  }
  return out;
}

// 「这一轮同步了什么」的短句 —— 前端底部那行灰字直接用。
// ★ 文案是给用户扫一眼的，所以写「做了什么」而不是「字段名」。
function syncItemsOf(result, nameOf) {
  const items = [];
  for (const ev of result.events || []) {
    items.push({ kind: 'event', text: `剧情记录 +1（${ev.event.slice(0, 24)}${ev.event.length > 24 ? '…' : ''}）` });
  }
  for (const row of result.counters || []) {
    const who = nameOf ? nameOf(row.characterId) : '';
    const d = Object.entries(row.deltas).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join('、');
    items.push({ kind: 'counter', text: `${who ? who + ' 的 ' : ''}计数器 ${d}（待你确认）` });
  }
  for (const w of result.world || []) {
    items.push({ kind: 'world', text: `世界改变「${w.text.slice(0, 20)}${w.text.length > 20 ? '…' : ''}」（待你确认）` });
  }
  return items;
}

module.exports = {
  isEnabled,
  buildMessages,
  parseResult,
  looseJson,
  syncItemsOf,
  sampleReply,
  MAX_COUNTER_TARGETS,
  MAX_WORLD_ITEMS,
  MAX_EVENTS,
  HEAD_CHARS,
  TAIL_CHARS,
};
