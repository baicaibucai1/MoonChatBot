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
  INTENT_DEFAULTS,
  INTENT_CHARS_FLOOR,
  detectLengthIntent,
  parseLengthChars,
  applyIntent,
  LENGTH_PERMISSIONS,
  PERM_DEFAULTS,
  lengthTool,
  permRange,
  resolveLengthPerm,
  clampLengthRequest,
  planPrompt,
  parsePlan,
  fillPlanChars,
  segPromptFirst,
  segPromptNext,
  targetPrompt,
} = require('../lib/longreply.js');

// ---------- resolveLongReply：三层优先级（机器人 > 全局 > 模型）----------

// 长度意图识别的三个新字段。★ auto 默认 true —— 这是新功能，没配就该生效。
const EXTRA = { auto: true, longTarget: INTENT_DEFAULTS.longTarget, shortTarget: INTENT_DEFAULTS.shortTarget };

test('resolveLongReply：默认关闭（什么都没配时）', () => {
  assert.deepEqual(resolveLongReply({}, {}, {}), {
    enabled: false,
    target: DEFAULTS.target,
    segments: DEFAULTS.segments,
    maxChars: DEFAULTS.maxChars,
    ...EXTRA,
  });
  // 显式关掉也应是同一套默认值（只是 enabled 为 false）
  assert.deepEqual(resolveLongReply({ longReply: false }, { longReply: false }, {}), {
    enabled: false,
    target: DEFAULTS.target,
    segments: DEFAULTS.segments,
    maxChars: DEFAULTS.maxChars,
    ...EXTRA,
  });
});

test('resolveLongReply：三层都能开，取第一个显式 true', () => {
  // 用 DEFAULTS 而不是硬编码 —— 默认值调整过一次（段数 3→12、上限 8000→20000），
  // 写死数字会让这条用例在「只是改了默认值」时莫名其妙变红。
  const base = { target: DEFAULTS.target, segments: DEFAULTS.segments, maxChars: DEFAULTS.maxChars, ...EXTRA };
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
  // ★ 什么都没设 → 默认目标 1200，而不是 0（不限）。
  //   0 的语义是「没写够就一直续」，长文一开就一路写到撞上限 —— 用户看到的就是「太长了」。
  //   默认给个目标才是刹车；真要不限，显式填 0。
  assert.equal(resolveLongReply({}, {}, {}).target, DEFAULTS.target);
  assert.equal(resolveLongReply({ longReplyTarget: 0 }, {}, {}).target, 0, '显式填 0 才是不限');
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

// ---------- 长度意图识别：用户说「写长一点」就该真的写长 ----------

test('detectLengthIntent：拉长意图的几种说法', () => {
  for (const s of ['写长一点', '来一篇长文', '详细说说', '展开讲讲', '多写点', '长文本输出']) {
    assert.equal(detectLengthIntent(s).kind, 'long', `「${s}」应识别为拉长`);
  }
});

test('detectLengthIntent：压短意图的几种说法', () => {
  for (const s of ['简短一点', '一句话概括', '简要说明', '长话短说', '不用太长']) {
    assert.equal(detectLengthIntent(s).kind, 'short', `「${s}」应识别为压短`);
  }
});

test('detectLengthIntent：中性提问不触发（否则日常对话全被拉长）', () => {
  for (const s of ['今天天气怎么样', '介绍一下你自己', '讲讲这个故事', '帮我看看这段代码']) {
    assert.equal(detectLengthIntent(s).kind, 'none', `「${s}」不该触发长度意图`);
  }
});

test('detectLengthIntent：显式字数优先于关键词', () => {
  // 「详细」会判长，但显式 300 字更小 → 应该听字数的
  assert.deepEqual(detectLengthIntent('详细说说，300字'), { kind: 'short', target: 300 });
});

test('detectLengthIntent：显式字数按 800 分长短', () => {
  assert.equal(detectLengthIntent('写一篇 3000 字的小说').kind, 'long');
  assert.equal(detectLengthIntent('写一篇 2000 字的文章').target, 2000);
  assert.equal(detectLengthIntent('控制在 300 字以内').kind, 'short');
});

test('detectLengthIntent：长短词同时出现时，显式字数仍然最优先', () => {
  assert.equal(detectLengthIntent('长话短说，写 3000 字').target, 3000);
});

test('parseLengthChars：区间取上限、中文数字、空值', () => {
  assert.equal(parseLengthChars('2000-3000字'), 3000, '区间取更充分的那头');
  assert.equal(parseLengthChars('800字以内'), 800);
  assert.equal(parseLengthChars('不超过500字'), 500);
  assert.equal(parseLengthChars('五千字'), 5000);
  assert.equal(parseLengthChars('三百字'), 300);
  assert.equal(parseLengthChars('随便写点'), 0);
  // 「一千五」认不出来 —— 认不出来好过认成 1000
  assert.equal(parseLengthChars('一千五百字'), 0);
});

test('detectLengthIntent：空消息返回 none（不炸）', () => {
  assert.equal(detectLengthIntent('').kind, 'none');
  assert.equal(detectLengthIntent(null).kind, 'none');
});

// ---------- applyIntent：意图怎么落到这一次回复上 ----------

const LR_BASE = {
  enabled: false, target: INTENT_DEFAULTS.longTarget === 3000 ? 1200 : 1200,
  segments: 12, maxChars: 20000, auto: true,
  longTarget: INTENT_DEFAULTS.longTarget, shortTarget: INTENT_DEFAULTS.shortTarget,
};

test('applyIntent：★ 识别到「写长」→ 无视开关临时开启多段输出', () => {
  // 全局和角色都关着长文，但用户明说了要长 —— 这次就该写长，且不写回配置
  const out = applyIntent({ ...LR_BASE, enabled: false }, detectLengthIntent('写长一点'));
  assert.equal(out.enabled, true, '要长时无视开关');
  assert.equal(out.target, INTENT_DEFAULTS.longTarget, '用长档目标');
  assert.equal(out.intent, 'long');
});

test('applyIntent：识别到「写长」且带显式字数 → 用那个字数', () => {
  const out = applyIntent({ ...LR_BASE }, detectLengthIntent('写一篇 5000 字的故事'));
  assert.equal(out.target, 5000);
});

test('applyIntent：★ 识别到「简短」→ 关续写 + 给提示词（不能靠目标字数压短）', () => {
  const out = applyIntent({ ...LR_BASE, enabled: true }, detectLengthIntent('简短一点'));
  assert.equal(out.enabled, false, '短档不续写');
  assert.equal(out.target, 0, '目标字数压不短已经写出来的内容');
  assert.ok(out.hint.includes(String(INTENT_DEFAULTS.shortTarget)), '提示词里要写明字数上限');
});

test('applyIntent：无意图 + 长文开启 → 用配置目标（默认 1200 当刹车）', () => {
  const out = applyIntent({ ...LR_BASE, enabled: true, target: 1200 }, { kind: 'none', target: null });
  assert.equal(out.target, 1200);
  assert.equal(out.hint, '');
});

test('applyIntent：无意图 + 长文关闭 → 目标归零（只写一段）', () => {
  const out = applyIntent({ ...LR_BASE, enabled: false, target: 1200 }, { kind: 'none', target: null });
  assert.equal(out.target, 0, '关着时给目标是形同虚设的（!enabled 会直接 return false）');
  assert.equal(out.enabled, false);
});

test('applyIntent：不修改入参（意图只影响这一次回复）', () => {
  const lr = { ...LR_BASE, enabled: false };
  applyIntent(lr, detectLengthIntent('写长一点'));
  assert.equal(lr.enabled, false, '不能把临时开启写回配置');
});

// ---------- 长度自主权：让模型自己决定写多长，但权限由人控 ----------

test('resolveLengthPerm：默认「建议式」（既不关死也不放任）', () => {
  const p = resolveLengthPerm({}, {});
  assert.equal(p.mode, 'limited');
  assert.equal(p.min, PERM_DEFAULTS.min);
  assert.equal(p.max, PERM_DEFAULTS.max);
});

test('resolveLengthPerm：角色 > 全局，且只认白名单里的三档', () => {
  // ⚠️ 签名是 (cfg, bot) —— 第一个参数是全局配置
  assert.equal(resolveLengthPerm({ lengthPerm: 'full' }, {}).mode, 'full');
  assert.equal(resolveLengthPerm({ lengthPerm: 'full' }, { lengthPerm: 'off' }).mode, 'off', '角色就近优先');
  assert.equal(resolveLengthPerm({ lengthPerm: 'off' }, { lengthPerm: 'full' }).mode, 'full', '角色能把全局的 off 提上来');
  // 手滑写个奇怪字符串 → 回落默认，不能变成「未知档位」
  assert.equal(resolveLengthPerm({ lengthPerm: 'yes' }, {}).mode, PERM_DEFAULTS.mode);
  assert.equal(resolveLengthPerm({ lengthPerm: 'yes' }, { lengthPerm: 'off' }).mode, 'off', '全局非法值不该挡住合法角色值');
});

test('★ permRange：off 不给工具，full 放开区间', () => {
  assert.equal(permRange({ mode: 'off' }), null, 'off 时必须返回 null —— 调用方据此不挂工具');
  assert.deepEqual(permRange({ mode: 'full' }), { min: 100, max: 100000 });
  assert.deepEqual(permRange({ mode: 'limited', min: 500, max: 6000 }), { min: 500, max: 6000 });
});

test('permRange：min 配得比 max 大时不产生空区间（取 min 兜底）', () => {
  // 手滑填反了 → 结果是「就按 min 这个数」，而不是一个 min>max 的区间（那会让 clamp 行为诡异）
  assert.deepEqual(permRange({ mode: 'limited', min: 5000, max: 100 }), { min: 5000, max: 5000 });
});

test('lengthTool：off 时不该有工具，其它档位描述里带上真实区间', () => {
  assert.equal(lengthTool({ mode: 'off' }), null);
  const t = lengthTool({ mode: 'limited', min: 800, max: 4000 });
  assert.equal(t.function.name, 'set_reply_length');
  assert.ok(t.function.description.includes('800') && t.function.description.includes('4000'),
    '描述里要写明可选区间，否则模型不知道该要多少');
});

test('★ clampLengthRequest：越界不报错，收敛到边界', () => {
  const perm = { mode: 'limited', min: 500, max: 6000 };
  // 要太多 → 给上限（不是拒绝，否则模型得重要一次，多一次往返）
  assert.deepEqual(clampLengthRequest(20000, perm), { chars: 6000, clamped: true, min: 500, max: 6000 });
  // 要太少 → 给下限
  assert.deepEqual(clampLengthRequest(50, perm), { chars: 500, clamped: true, min: 500, max: 6000 });
  // 区间内 → 原样
  assert.deepEqual(clampLengthRequest(3000, perm), { chars: 3000, clamped: false, min: 500, max: 6000 });
});

test('clampLengthRequest：模型给不出数字时按上限（等于「按你能给的最长写」）', () => {
  const perm = { mode: 'limited', min: 500, max: 6000 };
  for (const bad of [undefined, null, 'abc', 0, -100, NaN]) {
    assert.equal(clampLengthRequest(bad, perm).chars, 6000, `${String(bad)} 应回落到上限`);
  }
});

test('clampLengthRequest：off 时返回 null（调用方据此拒绝）', () => {
  assert.equal(clampLengthRequest(3000, { mode: 'off' }), null);
});

test('clampLengthRequest：full 档下区间放到最宽', () => {
  const r = clampLengthRequest(50000, { mode: 'full' });
  assert.equal(r.chars, 50000, 'full 档下 5 万字以内应原样通过');
  assert.equal(r.clamped, false);
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
