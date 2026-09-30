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
  DEFAULTS,
  LIMITS,
  clampInt,
  resolveLongReply,
  shouldContinue,
  continueMessages,
} = require('../lib/longreply.js');

// ---------- resolveLongReply：三层优先级（机器人 > 全局 > 模型）----------

test('resolveLongReply：默认关闭（什么都没配时）', () => {
  assert.deepEqual(resolveLongReply({}, {}, {}), {
    enabled: false,
    segments: DEFAULTS.segments,
    maxChars: DEFAULTS.maxChars,
  });
  assert.deepEqual(resolveLongReply({ longReply: false }, { longReply: false }, {}), {
    enabled: false,
    segments: 3,
    maxChars: 8000,
  });
});

test('resolveLongReply：三层都能开，取第一个显式 true', () => {
  const base = { segments: 3, maxChars: 8000 };
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
