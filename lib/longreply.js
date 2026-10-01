// 长文模式（分段续写 + 先规划后写）：让角色能输出超出模型单次意愿的内容。
//
// 为什么需要分段：模型单次回复要么被上限掐断（finish_reason='length'），要么它自己觉得
// 「说完了」就收尾（'stop'）。实测本仓库用量记录：单次输出中位 281 tokens、最大 6092 ——
// 也就是说**它写得长，只是不愿意主动写长**。给它一个目标字数和一份结构蓝图，它才知道该写多少。
//
// 三种驱动方式，按优先级从高到低：
//   1. 有大纲（planTotal > 0）  → 按大纲段数走完，每段带要点与字数
//   2. 有目标（target > 0）     → 没写到目标就继续，写够了停
//   3. 都没设                   → 回到最初的语义：截断补全 / 主动追加
//
// 这里只放**纯逻辑**（配置解析 / 是否续写 / 提示语拼装 / 大纲解析），不碰网络 ——
// 这样它能被 tests/longreply.test.mjs 直接单测，不需要浏览器也不需要真模型。
'use strict';

// 无大纲时的续写指令。写得克制是有原因的：不给约束的话，模型大概率会
//   ① 把上一段重写一遍  ② 加「好的，我继续」这类过渡语  ③ 反过来问「要我继续吗」
// 这三条占掉了续写失败的绝大多数情形。
const CONTINUE_PROMPT =
  '（接着上面你写到的地方继续往下写。要求：从上次结束处接着写，不要重复已经写过的内容；' +
  '不要写「好的」「接下来」这类过渡语，也不要询问我是否继续；保持同样的人称、语气与叙事节奏；' +
  '这一段写完就停。）';

// 目标字数超过这个值才开始「先规划大纲」。低于它两三就写完了，
// 为它多花一次模型调用、还让首段背上一份大纲，不划算。
const PLAN_THRESHOLD = 2000;

// 单段能力的保守估计。实测中位 281 / 最大 6092 tokens，但那是「模型愿意写多少」而非「能写多少」；
// 取 1200 字是它能稳定写到的量 —— 估小了会多分几段（每段都扎实），估大了会频繁触发截断补全。
const SEG_CHARS = 1200;

// 默认值与硬边界。硬边界是防呆：配置里手滑填个 99 段，不至于把 token 烧穿。
// 段数默认从 3 提到 12：目标驱动后段数是按目标推算的，旧的 3 段上限会让「写 5000 字」根本到不了。
//
// ★ target 默认 1200 而不是 0：0 的意思是「没写够就一直续」，而长文模式一旦开启、
//   用户又没配目标，这条路会被一路走到撞上限（12 段 / 20000 字）—— 用户看到的
//   就是「怎么每次都写这么长」。给个默认目标才是刹车。真要不限，显式填 0。
const DEFAULTS = { target: 1200, segments: 12, maxChars: 20000 };
const LIMITS = { target: [0, 100000], segments: [1, 30], maxChars: [500, 100000] };

// 长度意图识别的档位：识别到「写长一点」用 longTarget，「简短」用 shortTarget。
// 都是**设置里可改的固定值**而不是让模型自己判断 —— 后者多一次调用、慢、费 token，
// 而且长度不可预测（它可能一次给你 8000 字）。固定档位结果可预期，也好调。
const INTENT_DEFAULTS = { longTarget: 3000, shortTarget: 300 };
const INTENT_LIMITS = { longTarget: [500, 100000], shortTarget: [50, 10000] };

// 显式字数低于这个值算「压短」，高于算「拉长」。
// 取 800：比短档默认（300）高、比默认目标（1200）低，正好卡在两者中间。
const INTENT_CHARS_FLOOR = 800;

function clampInt(v, def, [lo, hi]) {
  const n = Number(v);
  // NaN（含 undefined / 非数字字符串）→ 默认。
  // ±Infinity 不回默认而是 clamp 到边界：它跟 999999 一样是「超出范围的极值」，
  // 两者行为若不一致（一个回默认、一个压到上界）配置语义就很别扭。
  if (Number.isNaN(n)) return def;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * 解析长文模式配置，沿用项目里 webSearch / streamReply 的三层优先级：
 * **机器人 > 全局 > 模型**，取第一个显式 true/false。
 *
 * 段数与硬上限只从全局读（给每个角色单独配段数太细，且角色页已经够长了）。
 * 目标字数角色可单独覆盖 —— 写作型角色和闲聊角色的合理长度差一个量级。
 * 长度意图识别（auto）角色也可覆盖 —— 闲聊角色不该被「详细」两个字拉到 3000 字。
 *
 * @returns {{enabled:boolean, target:number, segments:number, maxChars:number,
 *            auto:boolean, longTarget:number, shortTarget:number}}
 */
function resolveLongReply(cfg, bot, model) {
  const c = cfg || {};
  // ★ 取**第一个显式** true/false，而不是「任一为真即为真」——
  //   后者会让「全局开 + 某角色显式关」失效，闲聊角色照样被硬拉长。
  const enabled = [bot && bot.longReply, c.longReply, model && model.longReply]
    .find((v) => v === true || v === false) === true;
  // 目标：角色 > 全局（模型级不设目标 —— 那是端点能力，不是写作意图）
  const rawTarget = bot && bot.longReplyTarget !== undefined && bot.longReplyTarget !== null && bot.longReplyTarget !== ''
    ? bot.longReplyTarget : c.longReplyTarget;
  // 自动识别长度意图：角色 > 全局，**没设时默认开启**（这是新功能，默认就该生效；
  // 老的 three-state 语义 find(...) === true 在都没设时给 false，这里要反过来）
  const autoRaw = [bot && bot.longReplyAuto, c.longReplyAuto].find((v) => v === true || v === false);
  return {
    enabled,
    target: clampInt(rawTarget, DEFAULTS.target, LIMITS.target),
    segments: clampInt(c.longReplySegments, DEFAULTS.segments, LIMITS.segments),
    maxChars: clampInt(c.longReplyMaxChars, DEFAULTS.maxChars, LIMITS.maxChars),
    auto: autoRaw === undefined ? true : autoRaw === true,
    longTarget: clampInt(c.longReplyLongTarget, INTENT_DEFAULTS.longTarget, INTENT_LIMITS.longTarget),
    shortTarget: clampInt(c.longReplyShortTarget, INTENT_DEFAULTS.shortTarget, INTENT_LIMITS.shortTarget),
  };
}

/**
 * 要不要再写一段。
 *
 * 判定顺序是刻意的：**硬上限 → 截断 → 大纲 → 目标 → 兜底**。
 * 截断排在「长文是否开启」之前，因为被掐断的回复是残次品，补全与开关无关。
 *
 * @param {object} ctx
 * @param {string|null} ctx.finishReason 上一段的结束原因（'stop' / 'length' / null）
 * @param {number} ctx.currentLen        已写正文字数
 * @param {number} ctx.segIndex          已完成段数（首段算 1）
 * @param {boolean} ctx.enabled          长文模式是否开启
 * @param {number} ctx.target            目标字数（0 = 不限）
 * @param {number} ctx.planTotal         大纲段数（0 = 无大纲）
 * @param {number} ctx.planDone          已完成的大纲段数（首段算 1）；无大纲时不用传
 * @param {number} ctx.segments          段数硬上限（兜底，防烧穿）
 * @param {number} ctx.maxChars          总字数硬上限
 */
function shouldContinue(ctx) {
  const { finishReason, currentLen, segIndex, enabled, target, planTotal, planDone, segments, maxChars } = ctx || {};
  if (!(segIndex >= 1)) return false;
  if (segIndex >= segments) return false;      // 段数兜底（按实际调用次数）
  if (currentLen >= maxChars) return false;    // 硬上限
  if (finishReason === 'length') return true;  // 被截断 → 无条件补全（与开关无关）
  if (!enabled) return false;                  // 长文关闭：它自己写完了就停
  // ★ 有大纲时按**大纲进度**判定，不能用调用次数：截断补全是在「补完当前这一段」，
  //   并不前进到大纲的下一段。若用 segIndex，一次截断就白吃掉一个大纲段的配额，
  //   最后一段永远写不到（plan 5 段、首段截断一次 → 实际只写到第 4 段就停）。
  if (planTotal > 0) return (planDone ?? segIndex) < planTotal;
  if (target > 0) return currentLen < target;  // 有目标：没写到就继续
  return finishReason === 'stop';              // 都没设：最初的「写完→追加」语义
}

/**
 * 目标字数要分几段（无大纲时的粗估）。
 * 只在「不做规划」的短任务里用 —— 段数偏高一点无妨，反正没写够会自动续。
 */
function estimateSegments(target, segments) {
  if (!(target > 0)) return 1;
  return Math.max(1, Math.min(segments || DEFAULTS.segments, Math.ceil(target / SEG_CHARS)));
}

/**
 * 构造续写请求的消息链：原始消息 + 已写正文（assistant）+ 续写指令（user）。
 *
 * 用 assistant prefix 而不是「把已写内容塞进 user 消息」，是因为前者是 OpenAI 兼容协议里
 * 标准的「接着写」姿势 —— 模型把它当成自己说了一半的话，衔接最自然。
 *
 * 每次续写都往同一条链上追加（而不是每轮重建只留一段），让模型能看见自己的写作轨迹，
 * 第二段之后不会莫名其妙换语气。
 */
function continueMessages(messages, written, prompt) {
  return [
    ...(messages || []),
    { role: 'assistant', content: String(written || '') },
    { role: 'user', content: prompt || CONTINUE_PROMPT },
  ];
}

/**
 * 本段是不是「原地打转」—— 内容已经在已写正文里出现过了。
 *
 * 目标驱动下这是真会踩的坑：告诉模型「还没写够」，它可能把上一段原样再吐一遍，
 * 于是每次判定都「没写够」，一路撞到段数上限，最后拿到 N 遍重复正文。
 *
 * 判据刻意收得很紧：**只有整段归一化后完全被已写正文包含**才算。
 * 正常写作里偶尔复现一句短句（反复、回扣）是允许的，重复到「整段一字不差」才是打转。
 * 比对前先吃掉空白，因为拼接时加的换行会让逐字比较失真。
 */
function isDuplicate(piece, written) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const p = norm(piece);
  const w = norm(written);
  return p.length >= 20 && w.includes(p);
}

// ---------------- 长度意图识别（用户说「写长一点」就该真的写长）----------------

// 拉长意图。刻意只收**明确要求更长/更详**的说法 ——
// 「说说」「讲讲」「介绍一下」这类中性词一个都不收，否则日常提问全被拉到 3000 字。
const LONG_WORDS = [
  '长文', '长篇', '长一点', '长一些', '再长', '写长', '长文本', '长作文',
  '详细', '详尽', '展开', '展开讲', '充分', '深入', '全面', '系统地', '完整', '丰富', '铺开',
  '多写点', '多写些', '多写一点', '写多点', '写多些', '写详细', '细说', '细讲',
  '不要省略', '别省略', '写透', '掰开',
];

// 压短意图。同样是明确要求才收 —— 「总结一下」算，「总结」单字太泛不收。
const SHORT_WORDS = [
  '简短', '简单说', '一句话', '概括', '简要', '简练', '精炼', '简洁', '言简意赅',
  '短一点', '简短点', '别太长', '不用太长', '不要太长', '少写点', '掐短',
  '总结一下', '小结一下', '长话短说', '要点即可', '说重点',
];

function countHits(text, words) {
  let n = 0;
  for (const w of words) if (text.includes(w)) n++;
  return n;
}

/**
 * 从文本里抽出**显式字数**，抽不到返回 0。
 *
 * 显式字数比关键词可靠得多（「写一篇 3000 字的小说」不需要猜），所以优先认它。
 * 只认阿拉伯数字与「三千字」这类整千整百；「一千五」这种复合中文数字认不出来，
 * 但**认不出来好过认错** —— 认错会直接把目标字数设成错的。
 */
function parseLengthChars(text) {
  const t = String(text || '');
  // 区间「2000-3000字」取上限（用户给区间时通常想要更充分的那头）
  let m = /(\d{2,7})\s*[-~—－到至]\s*(\d{2,7})\s*字/.exec(t);
  if (m) return Math.max(Number(m[1]), Number(m[2]));
  // 「800 字以内」「300 字左右」
  m = /(\d{2,7})\s*字\s*(?:以内|以下|之内|左右|上下|附近)/.exec(t);
  if (m) return Number(m[1]);
  // 「不超过 500 字」「控制在 300 字」
  m = /(?:不超过|最多|控制在|限制在|别超过)\s*(\d{2,7})\s*字/.exec(t);
  if (m) return Number(m[1]);
  // 「写 3000 字」「来一篇 2000 字的」
  m = /(\d{2,7})\s*字/.exec(t);
  if (m) return Number(m[1]);
  // 整千/整百的中文数字：「三千字」「五百字」。
  // ★ 前后都要挡住相邻的数字：「一千五百字」里若让「五百字」单独命中会得到 500（错得离谱），
  //   而不是老实承认认不出来。认不出来最多是不生效，认错会直接把目标字数设成错的。
  const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  m = /(?<![一二三四五六七八九十两千百])([一二三四五六七八九十两])\s*(千|百)(?![一二三四五六七八九十两])\s*字/.exec(t);
  if (m) return (CN[m[1]] || 0) * (m[2] === '千' ? 1000 : 100);
  return 0;
}

/**
 * 识别这条消息里的长度意图。
 *
 * 只看**最后一条用户消息**（调用方负责传）：历史里提过一次「写详细」不该让
 * 后面十轮对话全部变成 3000 字。
 *
 * @returns {{kind:'long'|'short'|'none', target:number|null}}
 *   target 为 null 表示「没有显式字数，用配置里的档位」
 */
function detectLengthIntent(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'none', target: null };
  const chars = parseLengthChars(t);
  if (chars > 0) {
    // 显式字数按大小分长短：800 字以下视为压短，以上视为拉长
    return { kind: chars >= INTENT_CHARS_FLOOR ? 'long' : 'short', target: chars };
  }
  const long = countHits(t, LONG_WORDS);
  const short = countHits(t, SHORT_WORDS);
  if (short > long) return { kind: 'short', target: null };
  if (long > short) return { kind: 'long', target: null };
  return { kind: 'none', target: null };
}

/**
 * 把意图套用到解析好的配置上，得到**这一次回复**实际生效的长文参数。
 *
 * 三条语义，都是刻意设计的：
 *   long  → **无视开关**临时开启多段输出。用户明说了要长，不该被一个全局开关挡住；
 *           只影响这一次回复，不写回配置。
 *   short → **不靠目标字数**：目标只管「没写够就继续」，模型第一次就写了 800 字的话
 *           300 的目标根本不会触发续写，也变不短。所以短档走「提示词约束 + 关掉续写」。
 *   none  → 用配置；长文开着就按目标走（默认 1200 当刹车），关着就只写一段。
 *
 * @returns 入参的副本 + {intent, hint}；hint 非空时要作为一条附加要求发给模型
 */
function applyIntent(lr, intent) {
  const it = intent || { kind: 'none', target: null };
  const out = { ...lr, intent: it.kind, hint: '' };
  if (it.kind === 'long') {
    out.enabled = true;
    out.target = it.target > 0 ? it.target : lr.longTarget;
  } else if (it.kind === 'short') {
    out.enabled = false;
    out.target = 0;
    out.hint = `（请简洁回答：控制在 ${it.target > 0 ? it.target : lr.shortTarget} 字以内，不要展开铺垫。）`;
  } else {
    // 长文关着就不给目标（否则 shouldContinue 里的 !enabled 会直接 return false，目标形同虚设）
    out.target = lr.enabled ? lr.target : 0;
  }
  return out;
}

// ---------------- 规划（先列结构，再逐段写） ----------------

/**
 * 生成大纲的请求。只做规划、明确禁止写正文 ——
 * 否则模型会一边列计划一边把第一段写了，后面再让它写第一段就会重复。
 */
function planPrompt(target, n) {
  return `（先不要写正文，只做规划。）
请为这个写作任务制定一份分段计划：
1. 全文总长约 ${target} 字，分成 ${n} 段写完
2. 每段给出「这一段写什么」的要点，以及这一段要写多少字
3. 各段字数之和接近总长；段落之间要有推进关系，不要重复
4. 只输出计划本身，不要写正文，不要加开场白和总结

严格按下面的格式输出，每行一段：
1｜要点：……｜字数：600`;
}

/**
 * 解析模型给的大纲。
 *
 * ★ 容错是这里的重点：模型几乎不会老老实实按格式输出。要能吃下三种常见写法：
 *     1｜要点：xxx｜字数：600       （要求的格式）
 *     1. xxx（600字）              （自然语言）
 *     - xxx | 600                  （markdown 列表 + 竖线）
 * 解析不出来就返回空数组 —— 调用方据此**降级**到无大纲模式，绝不能让一次规划失败毁掉整篇回复。
 *
 * @returns {{brief:string, chars:number}[]}
 */
function parsePlan(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  // ★ 序言与总结混进来是常态（「好的，这是我的计划：」「以上就是安排」）——
  //   它们会被当成一段塞进大纲，第一段要点变成一句废话。
  //   判据：只要文本里**存在**带序号 / 项目符号 / 「要点：」的行，就只认这些行 ——
  //   寒暄句通常不带序号。一行序号都没有时（模型直接列要点）再放宽，
  //   否则会把整份有效内容全丢掉。
  const marked = lines.filter((l) => /^\s*(?:\d+\s*[.、)）:：|｜]|[-*・]|要点\s*[:：])/.test(l));
  const segs = [];
  for (let line of (marked.length ? marked : lines)) {
    // 去掉行首序号 / 项目符号：「1.」「1、」「1)」「-」「*」「1｜」
    line = line.replace(/^\s*\d+\s*[.、)）:：|｜]?\s*/, '').replace(/^\s*[-*・]\s*/, '');
    if (!line) continue;

    // 字数：优先认行尾的「｜600」，其次「字数：600」「约 600 字」「600字」
    let chars = 0;
    const tail = /[|｜]\s*(\d{2,6})\s*$/.exec(line);
    const inline = /(?:字数|约写|约)\s*[:：]?\s*(\d{2,6})/.exec(line);
    const plain = /(\d{2,6})\s*字/.exec(line);
    if (tail) chars = Number(tail[1]);
    else if (inline) chars = Number(inline[1]);
    else if (plain) chars = Number(plain[1]);

    // 要点：剥掉「要点：」前缀，再把行尾的字数片段**连同它的标签一起**去掉。
    // ★ 顺序与完整性很关键：「开头的场景｜字数：600」若只剥数字，会剩下一个残缺的
    //   「开头的场景｜字数：」—— 那段尾巴会被塞进写作指令里，模型照着写出怪东西。
    const brief = line
      .replace(/^要点\s*[:：]\s*/, '')
      .replace(/[|｜]\s*(?:字数|约写|约)?\s*[:：]?\s*\d{2,6}\s*字?\s*$/, '')   // ｜字数：600 / | 600
      .replace(/[（(]\s*(?:约)?\s*\d{2,6}\s*字?\s*[)）]\s*$/, '')               // （600字）
      .replace(/\s*(?:字数|约写|约)\s*[:：]?\s*\d{2,6}\s*字?\s*$/, '')          // 约 600 字
      .replace(/[|｜\-—]\s*$/, '')                                              // 残留分隔符
      .replace(/^第\s*[一二三四五六七八九十\d]+\s*段\s*[:：]\s*/, '')           // 第一段：
      .replace(/^(?:约\s*)?\d{2,6}\s*字\s*[:：]\s*/, '')                        // 约600字：
      .trim();
    if (!brief) continue;
    segs.push({ brief, chars: chars || 0 });
  }
  return segs;
}

/**
 * 大纲生成后补均分：模型常常忘记写字数，或某段填 0 ——
 * 这时按剩余目标字数均分，避免「字数 0」被当成「这段不用写」。
 */
function fillPlanChars(plan, target) {
  const segs = (plan || []).map((s) => ({ ...s }));
  const known = segs.filter((s) => s.chars > 0);
  const missing = segs.length - known.length;
  if (!missing || !(target > 0)) return segs;
  const used = known.reduce((a, s) => a + s.chars, 0);
  const each = Math.max(200, Math.round((target - used) / missing));
  for (const s of segs) if (!(s.chars > 0)) s.chars = each;
  return segs;
}

// 首段：把全文结构一并给它，让它知道这段在全局里的位置，也别一口气把后面写了
function segPromptFirst(plan, target) {
  const outline = (plan || []).map((s, i) => `${i + 1}. ${s.brief}（约 ${s.chars} 字）`).join('\n');
  const first = (plan || [])[0] || { brief: '', chars: 0 };
  return `（这是一篇总长约 ${target} 字的长文，结构已经定好：\n${outline}）\n\n` +
    `现在只写第 1 段：${first.brief}，约 ${first.chars} 字。\n` +
    `要求：只写这一段，不要把后面的内容也写了；不要复述上面的结构；不要写「好的」这类开场。`;
}

// 后续段：带本段要点与字数，并明确「只写这一段」
function segPromptNext(plan, idx) {
  const s = (plan || [])[idx];
  if (!s) return CONTINUE_PROMPT;
  return `（继续写第 ${idx + 1} 段，全文共 ${plan.length} 段 —— 本段：${s.brief}，约 ${s.chars} 字。）\n` +
    `要求：从上一段结束处接着写，只写这一段；不要重复已写过的内容；不要写过渡语，也不要询问我是否继续。`;
}

// 无大纲但有目标：直接告诉它还差多少 —— 比「接着写」有效得多，
// 模型看不见进度时往往会再写一小段就收尾。
function targetPrompt(currentLen, target) {
  return `（还没写够：全文目标约 ${target} 字，目前已写 ${currentLen} 字。）\n` +
    `请继续往下写，推进新的内容直到接近目标；不要重复已写过的内容，不要写过渡语。`;
}

module.exports = {
  CONTINUE_PROMPT,
  PLAN_THRESHOLD,
  SEG_CHARS,
  DEFAULTS,
  LIMITS,
  clampInt,
  resolveLongReply,
  shouldContinue,
  estimateSegments,
  continueMessages,
  isDuplicate,
  INTENT_DEFAULTS,
  INTENT_LIMITS,
  INTENT_CHARS_FLOOR,
  detectLengthIntent,
  parseLengthChars,
  applyIntent,
  planPrompt,
  parsePlan,
  fillPlanChars,
  segPromptFirst,
  segPromptNext,
  targetPrompt,
};
