// 长文模式（分段续写）纯逻辑单测 —— C19
// ------------------------------------------------------------------
// 为什么把这段逻辑单独抽成 lib/longreply.js 并在这里测：
// 「要不要再写一段」的判断一旦散在 server.js 的续写循环里，就只能靠真模型端到端验证
// —— 而 finish_reason 是模型给的，本地根本造不出来。抽成纯函数后，
// 截断补全 / 主动追加这两种语义的分野可以在毫秒级断言死，改坏了立刻红。
// ------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
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
  planPrompt,
  parsePlan,
  fillPlanChars,
  segPromptFirst,
  segPromptNext,
  targetPrompt,
} = require('../lib/longreply.js');

// ---------- resolveLongReply：三层优先级（机器人 > 全局 > 模型）----------

test('resolveLongReply：默认关闭（什么都没配时）', () => {
  assert.deepEqual(resolveLongReply({}, {}, {}), {
    enabled: false,
    target: DEFAULTS.target,
    segments: DEFAULTS.segments,
    maxChars: DEFAULTS.maxChars,
  });
  // 显式关掉也应是同一套默认值（只是 enabled 为 false）
  assert.deepEqual(resolveLongReply({ longReply: false }, { longReply: false }, {}), {
    enabled: false,
    target: DEFAULTS.target,
    segments: DEFAULTS.segments,
    maxChars: DEFAULTS.maxChars,
  });
});

test('resolveLongReply：三层都能开，取第一个显式 true', () => {
  // 用 DEFAULTS 而不是硬编码 —— 默认值调整过一次（段数 3→12、上限 8000→20000），
  // 写死数字会让这条用例在「只是改了默认值」时莫名其妙变红。
  const base = { target: DEFAULTS.target, segments: DEFAULTS.segments, maxChars: DEFAULTS.maxChars };
  // 机器人单独开
  assert.equal(resolveLongReply({}, { longReply: true }, {}).enabled, true);
  // 全局开
  assert.equal(resolveLongReply({ longReply: true }, {}, {}).enabled, true);
  // 模型级开
  assert.equal(resolveLongReply({}, {}, { longReply: true }).enabled, true);
  // 三者都开时结果一致
  assert.deepEqual(resolveLongReply({ longReply: true }, { longReply: true }, { longReply: true }), {
    enabled: true, ...base,
  });
});

test('resolveLongReply：机器人显式 false 压过全局 true（就近优先）', () => {
  // 这条是优先级的核心断言：全局默认开启后，单个角色仍然能自己关掉，
  // 否则「全局开 + 某角色关」的组合会失效，闲聊角色被硬拉长。
  assert.equal(resolveLongReply({ longReply: true }, { longReply: false }, {}).enabled, false);
  assert.equal(resolveLongReply({ longReply: false }, { longReply: true }, {}).enabled, true);
});

test('resolveLongReply：段数与字数被 clamp 到硬边界内', () => {
  // 手滑填 99 段不至于把 token 烧穿；填 0 / 负数 / 字符串都回落到默认
  const r = resolveLongReply({ longReplySegments: 99, longReplyMaxChars: 1 }, {}, {});
  assert.equal(r.segments, LIMITS.segments[1]);
  assert.equal(r.maxChars, LIMITS.maxChars[0]);

  const d = resolveLongReply({ longReplySegments: 0, longReplyMaxChars: 'abc' }, {}, {});
  assert.equal(d.segments, LIMITS.segments[0]);
  assert.equal(d.maxChars, DEFAULTS.maxChars);

  const n = resolveLongReply({ longReplySegments: 2.6, longReplyMaxChars: 1234.4 }, {}, {});
  assert.equal(n.segments, 3);          // 四舍五入
  assert.equal(n.maxChars, 1234);
});

test('clampInt：非有限数回默认，正常值 clamp', () => {
  assert.equal(clampInt(undefined, 7, [1, 9]), 7);
  assert.equal(clampInt(NaN, 7, [1, 9]), 7);
  assert.equal(clampInt(Infinity, 7, [1, 9]), 9);
  assert.equal(clampInt(-5, 7, [1, 9]), 1);
  assert.equal(clampInt(5, 7, [1, 9]), 5);
});

// ---------- shouldContinue：两种语义必须分开 ----------

test('shouldContinue：被截断（length）无条件续 —— 不开长文模式也要续', () => {
  // 这是「截断自动续」的语义：回复是半截的，不补全用户拿到的就是断句
  assert.equal(shouldContinue({ finishReason: 'length', currentLen: 100, segIndex: 1, enabled: false, segments: 3, maxChars: 8000 }), true);
});

test('shouldContinue：模型自己写完（stop）只在长文模式开启时续', () => {
  const base = { currentLen: 100, segIndex: 1, segments: 3, maxChars: 8000 };
  assert.equal(shouldContinue({ ...base, finishReason: 'stop', enabled: false }), false);
  assert.equal(shouldContinue({ ...base, finishReason: 'stop', enabled: true }), true);
});

test('shouldContinue：段数用完 / 字数到顶就停（哪怕是截断）', () => {
  const base = { finishReason: 'length', enabled: true, segments: 3, maxChars: 8000 };
  // 已完成 3 段 = 段数上限 → 停
  assert.equal(shouldContinue({ ...base, currentLen: 100, segIndex: 3 }), false);
  assert.equal(shouldContinue({ ...base, currentLen: 100, segIndex: 2 }), true);
  // 字数到顶 → 停，截断也不续（否则会无限续下去）
  assert.equal(shouldContinue({ ...base, currentLen: 8000, segIndex: 1 }), false);
  assert.equal(shouldContinue({ ...base, currentLen: 7999, segIndex: 1 }), true);
});

test('shouldContinue：segIndex 非法 / finishReason 未知 → 不续', () => {
  const base = { enabled: true, segments: 3, maxChars: 8000, currentLen: 10 };
  assert.equal(shouldContinue({ ...base, finishReason: 'length', segIndex: 0 }), false);
  assert.equal(shouldContinue({ ...base, finishReason: 'tool_calls', segIndex: 1 }), false);
  assert.equal(shouldContinue({ ...base, finishReason: null, segIndex: 1 }), false);
  assert.equal(shouldContinue({ ...base, finishReason: undefined, segIndex: 1 }), false);
});

// ---------- continueMessages：assistant prefix 姿势 ----------

test('continueMessages：原始消息 + 已写正文(assistant) + 续写指令(user)', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '写个故事' },
  ];
  const out = continueMessages(messages, '从前有座山');
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { role: 'system', content: 'S' });
  assert.deepEqual(out[1], { role: 'user', content: '写个故事' });
  assert.deepEqual(out[2], { role: 'assistant', content: '从前有座山' });
  assert.equal(out[3].role, 'user');
  assert.equal(out[3].content, CONTINUE_PROMPT);
});

test('continueMessages：不修改传入的 messages（续写是追加不是原地改）', () => {
  const messages = [{ role: 'user', content: '写' }];
  continueMessages(messages, '正文');
  assert.equal(messages.length, 1, '原数组被污染会导致下一轮工具循环的消息链错乱');
});

test('continueMessages：正文为空也不炸（转成空字符串而非 "undefined"）', () => {
  const out = continueMessages([{ role: 'user', content: '写' }], undefined);
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[1].content, '');
});

// ---------- 目标字数（C19-c）----------

test('resolveLongReply：目标字数 角色 > 全局，空串视为未设', () => {
  assert.equal(resolveLongReply({ longReplyTarget: 3000 }, {}, {}).target, 3000);
  // 角色显式填了就用角色的（写作型角色和闲聊角色的合理长度差一个量级）
  assert.equal(resolveLongReply({ longReplyTarget: 3000 }, { longReplyTarget: 8000 }, {}).target, 8000);
  // 角色留空（''）→ 回落全局，不能被当成 0
  assert.equal(resolveLongReply({ longReplyTarget: 3000 }, { longReplyTarget: '' }, {}).target, 3000);
  // 什么都没设 → 0（不限）
  assert.equal(resolveLongReply({}, {}, {}).target, 0);
});

test('resolveLongReply：目标字数被 clamp 到硬边界内', () => {
  assert.equal(resolveLongReply({ longReplyTarget: -100 }, {}, {}).target, LIMITS.target[0]);
  assert.equal(resolveLongReply({ longReplyTarget: 1e9 }, {}, {}).target, LIMITS.target[1]);
  assert.equal(resolveLongReply({ longReplyTarget: 'abc' }, {}, {}).target, DEFAULTS.target);
});

test('shouldContinue：有大纲 → 按大纲段数走完（用大纲进度，不是调用次数）', () => {
  const base = { finishReason: 'stop', enabled: true, segments: 30, maxChars: 100000, target: 5000 };
  // planDone=1（写完第 1 段）/ planTotal=5 → 还要写
  assert.equal(shouldContinue({ ...base, segIndex: 1, planTotal: 5, planDone: 1 }), true);
  // planDone=5 → 大纲走完，停
  assert.equal(shouldContinue({ ...base, segIndex: 5, planTotal: 5, planDone: 5 }), false);
  // ★ 关键：截断补全不推进大纲进度，所以 planDone 仍是 1、即便已调用了 4 次 ——
  //   若这里改用 segIndex 判定，一次截断就会吃掉一个大纲段的配额，最后一段永远写不到。
  assert.equal(shouldContinue({ ...base, segIndex: 4, planTotal: 5, planDone: 1 }), true);
});

test('shouldContinue：有目标 → 没写够就续，写够了停', () => {
  const base = { finishReason: 'stop', enabled: true, segments: 30, maxChars: 100000, planTotal: 0 };
  assert.equal(shouldContinue({ ...base, segIndex: 1, currentLen: 1200, target: 5000 }), true);
  assert.equal(shouldContinue({ ...base, segIndex: 4, currentLen: 5100, target: 5000 }), false);
});

test('shouldContinue：截断补全优先于一切（长文关闭、大纲走完也照样续）', () => {
  const base = { finishReason: 'length', currentLen: 900, segIndex: 1, segments: 30, maxChars: 100000 };
  assert.equal(shouldContinue({ ...base, enabled: false }), true);
  assert.equal(shouldContinue({ ...base, enabled: true, planTotal: 3, planDone: 3 }), true);
  assert.equal(shouldContinue({ ...base, enabled: true, target: 800 }), true);   // 已超目标也补全
});

test('estimateSegments：按单段能力估算，且不超过段数上限', () => {
  assert.equal(estimateSegments(3000, 30), Math.ceil(3000 / SEG_CHARS));
  assert.equal(estimateSegments(0, 30), 1);          // 无目标 → 1 段（不主动分段）
  assert.equal(estimateSegments(100000, 12), 12);    // 被段数上限压住
});

// ---------- 规划：大纲解析（容错是重点）----------

test('parsePlan：吃下三种常见写法（规定格式 / 自然语言 / markdown 列表）', () => {
  assert.deepEqual(parsePlan('1｜要点：开头的场景｜字数：600\n2｜要点：冲突升级｜字数：800'),
    [{ brief: '开头的场景', chars: 600 }, { brief: '冲突升级', chars: 800 }]);
  assert.deepEqual(parsePlan('1. 开头的场景（600字）\n2. 冲突升级（800字）'),
    [{ brief: '开头的场景', chars: 600 }, { brief: '冲突升级', chars: 800 }]);
  assert.deepEqual(parsePlan('- 开头的场景 | 600\n- 冲突升级 | 800'),
    [{ brief: '开头的场景', chars: 600 }, { brief: '冲突升级', chars: 800 }]);
});

test('parsePlan：要点里不留字数片段的残渣', () => {
  // 曾经的 bug：「｜字数：600」只剥掉了数字，要点变成「开头的场景｜字数：」——
  // 那段残渣会被塞进写作指令，模型照着写出怪东西。
  const [seg] = parsePlan('1｜要点：开头的场景｜字数：600');
  assert.equal(seg.brief, '开头的场景');
  assert.equal(seg.chars, 600);
});

test('parsePlan：序言、总结、空行都不算成段', () => {
  const out = parsePlan('好的，这是我的计划：\n\n1｜要点：开场｜字数：600\n2｜要点：发展｜字数：700\n\n以上就是分段安排。');
  assert.equal(out.length >= 2, true);
  for (const s of out) assert.ok(s.brief && !/^以上就是|^好的/.test(s.brief), '序言/总结被当成了段落：' + s.brief);
});

test('parsePlan：完全解析不出 → 空数组（调用方据此降级）', () => {
  assert.deepEqual(parsePlan(''), []);
  assert.deepEqual(parsePlan('   \n\n  '), []);
});

test('fillPlanChars：缺字数的段按剩余目标均分，且不低于 200', () => {
  // 「字数 0」若被当成「这段不用写」，后面的段就会全挤在一起
  const out = fillPlanChars([{ brief: 'A', chars: 1000 }, { brief: 'B', chars: 0 }, { brief: 'C', chars: 0 }], 3000);
  assert.deepEqual(out.map((s) => s.chars), [1000, 1000, 1000]);
  const tiny = fillPlanChars([{ brief: 'A', chars: 0 }, { brief: 'B', chars: 0 }], 100);
  assert.ok(tiny.every((s) => s.chars >= 200), '均分后不能低于 200 字');
});

// ---------- isDuplicate：识别「模型在原地打转」----------

test('isDuplicate：把上一段原样再吐一遍 → 判定重复', () => {
  // 目标驱动的真实现象：催它「还没写够」，它就把上一段又写一遍，于是永远够不到目标，
  // 一路撞到段数上限，最后拿到 N 遍重复正文。
  const written = '夜色沉下来，街灯一盏盏亮起，他站在桥头等一个不会来的人。';
  assert.equal(isDuplicate(written, written + '\n\n' + '他转身走了。'), true);
});

test('isDuplicate：全新的一段不算重复', () => {
  const written = '夜色沉下来，街灯一盏盏亮起，他站在桥头等一个不会来的人。';
  assert.equal(isDuplicate('第二天清晨，桥下的水面浮着一层薄雾，他回来了。', written), false);
});

test('isDuplicate：短句回扣不算重复（避免误杀反复/呼应）', () => {
  // 「又是寂静的夜。」这种刻意的重复是写作手法，不能因为它是原文的子串就停。
  const written = '他等了很久。又是寂静的夜。远处传来钟声。';
  assert.equal(isDuplicate('又是寂静的夜。', written), false);
});

test('isDuplicate：比对前吃掉空白（拼接加的换行不该影响判定）', () => {
  const written = '第一段写完了，内容足够长，可以构成一整段完整的叙述文本。';
  assert.equal(isDuplicate('第一段写完了，\n内容足够长，可以构成一整段完整的叙述文本。', written), true);
});

test('isDuplicate：首段（已写为空）不可能重复', () => {
  assert.equal(isDuplicate('任何内容，哪怕很长很长很长很长。', ''), false);
});

// ---------- 规划：提示语 ----------

test('segPromptFirst：带全文结构，且明确「只写第 1 段」', () => {
  const plan = [{ brief: '开场', chars: 600 }, { brief: '发展', chars: 800 }];
  const p = segPromptFirst(plan, 1400);
  assert.ok(p.includes('开场') && p.includes('发展'), '首段要看得见全局结构');
  assert.ok(p.includes('第 1 段'), '要点名本段序号');
  assert.ok(/只写这一段|不要把后面/.test(p), '必须约束它别一口气写完');
});

test('segPromptNext：指明第几段 / 共几段，并禁止过渡语', () => {
  const plan = [{ brief: '开场', chars: 600 }, { brief: '发展', chars: 800 }, { brief: '结尾', chars: 400 }];
  const p = segPromptNext(plan, 1);
  assert.ok(p.includes('第 2 段'), '');
  assert.ok(p.includes('共 3 段'), '');
  assert.ok(p.includes('发展'), '带上本段要点');
});

test('segPromptNext：索引越界时退回普通续写指令（不炸）', () => {
  assert.equal(segPromptNext([{ brief: 'A', chars: 1 }], 9), CONTINUE_PROMPT);
});

test('targetPrompt：把「还差多少」直接告诉模型', () => {
  const p = targetPrompt(1200, 5000);
  assert.ok(p.includes('1200') && p.includes('5000'), '进度与目标都要出现');
});

test('planPrompt：只做规划，明确禁止写正文', () => {
  const p = planPrompt(5000, 5);
  assert.ok(p.includes('5000') && p.includes('5'));
  assert.ok(/不要写正文|只输出计划/.test(p), '不禁止的话模型会边列计划边把第一段写了');
});

test('PLAN_THRESHOLD：低于它不值得规划（省一次模型调用）', () => {
  assert.ok(PLAN_THRESHOLD >= 1000, '阈值太低会让短任务也为规划多花一次调用');
  assert.ok(PLAN_THRESHOLD <= 5000, '阈值太高则中等长度的长文拿不到蓝图');
});
