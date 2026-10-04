// 跨模块共用的常量
// ------------------------------------------------------------------
// 放这里的都是「服务端和前端必须说同一句话」的东西：语法提示、占位文案。
// 之前同样的句子在 server.js 的提示词和 public/app.js 的界面提示里各写一份，
// 改了一处忘了另一处，用户看到的说法就对不上。
// ------------------------------------------------------------------
'use strict';

// ★ 计数器声明语法（`##Counter：名字[范围]`）—— 详见 lib/characters.js 的 parseCounterSpecs
const COUNTER_SYNTAX = '##Counter：名字[最小,最大]';
// 界面上的一句人话说明
const COUNTER_SYNTAX_HINT = '计数器写在正文里：' + COUNTER_SYNTAX + '　，[] 留空或不写 = 不限';

// ★ 世界卡的多世界语法（`## 世界：名字`）—— 世界卡可以有多个世界，写手挑一个当「活跃世界」
const WORLD_SECTION_PREFIX = '## 世界：';
const WORLD_SYNTAX_HINT = '世界卡里可以有多个世界：' + WORLD_SECTION_PREFIX + '名字';

module.exports = {
  COUNTER_SYNTAX,
  COUNTER_SYNTAX_HINT,
  WORLD_SECTION_PREFIX,
  WORLD_SYNTAX_HINT,
};
