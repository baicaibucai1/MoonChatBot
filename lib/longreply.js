// 长文模式（分段续写）：让角色能输出超出模型单次上限的内容。
//
// 为什么需要分段：模型单次回复有上限（多数 OpenAI 兼容端点默认 2k~4k token ——
// 本仓库多数模型把 maxTokens 配成 0，即不传该参数、用端点默认值）。于是长回复要么
// 被从中间掐断，要么模型自己觉得「说完了」就提前收尾。两种情况的续写语义不同，
// 必须分开对待，否则闲聊也会被硬生生拉长：
//
//   finish_reason='length' → 它还有话没说完，续写是**补全** —— 无条件做，零跑题风险
//   finish_reason='stop'   → 它认为已结束，续写是**追加** —— 只有开了长文模式才做
//
// 这里只放**纯逻辑**（配置解析 / 是否续写 / 续写消息怎么拼），不碰网络 ——
// 这样它能被 tests/longreply.test.mjs 直接单测，不需要浏览器也不需要真模型。
'use strict';

// 续写指令。写得克制是有原因的：不给约束的话，模型大概率会
//   ① 把上一段重写一遍  ② 加「好的，我继续」这类过渡语  ③ 反过来问「要我继续吗」
// 这三条占掉了续写失败的绝大多数情形。
const CONTINUE_PROMPT =
  '（接着上面你写到的地方继续往下写。要求：从上次结束处接着写，不要重复已经写过的内容；' +
  '不要写「好的」「接下来」这类过渡语，也不要询问我是否继续；保持同样的人称、语气与叙事节奏；' +
  '这一段写完就停。）';

// 默认值与硬边界。硬边界是防呆：配置里手滑填个 99 段，不至于把 token 烧穿。
const DEFAULTS = { segments: 3, maxChars: 8000 };
const LIMITS = { segments: [1, 8], maxChars: [500, 40000] };

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
 * **机器人 > 全局 > 模型**，取第一个显式 true/false；都没设 → 关闭。
 *
 * 段数与总字数只从全局读（给每个角色单独配段数太细，且角色页已经够长了）。
 * @returns {{enabled:boolean, segments:number, maxChars:number}}
 */
function resolveLongReply(cfg, bot, model) {
  const c = cfg || {};
  // ★ 取**第一个显式** true/false，而不是「任一为真即为真」——
  //   后者会让「全局开 + 某角色显式关」失效，闲聊角色照样被硬拉长。
  const chain = [bot && bot.longReply, c.longReply, model && model.longReply];
  const explicit = chain.find((v) => v === true || v === false);
  const enabled = explicit === true;
  return {
    enabled,
    segments: clampInt(c.longReplySegments, DEFAULTS.segments, LIMITS.segments),
    maxChars: clampInt(c.longReplyMaxChars, DEFAULTS.maxChars, LIMITS.maxChars),
  };
}

/**
 * 要不要再写一段。
 * @param {object} ctx
 * @param {string|null} ctx.finishReason 上一段的结束原因（'stop' / 'length' / null）
 * @param {number} ctx.currentLen        已写正文字数
 * @param {number} ctx.segIndex          已完成段数（首段算 1）
 * @param {boolean} ctx.enabled          长文模式是否开启
 * @param {number} ctx.segments          段数上限（含首段）
 * @param {number} ctx.maxChars          总字数上限
 */
function shouldContinue(ctx) {
  const { finishReason, currentLen, segIndex, enabled, segments, maxChars } = ctx || {};
  if (!(segIndex >= 1) || segIndex >= segments) return false;   // 段数用完
  if (currentLen >= maxChars) return false;                     // 字数到顶
  if (finishReason === 'length') return true;                   // 被截断 → 无条件补全
  if (finishReason === 'stop' && enabled) return true;          // 写完了但开了长文模式 → 追加
  return false;
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
function continueMessages(messages, written) {
  return [
    ...(messages || []),
    { role: 'assistant', content: String(written || '') },
    { role: 'user', content: CONTINUE_PROMPT },
  ];
}

module.exports = {
  CONTINUE_PROMPT,
  DEFAULTS,
  LIMITS,
  clampInt,
  resolveLongReply,
  shouldContinue,
  continueMessages,
};
