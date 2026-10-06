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

// ★★ SSE 心跳间隔（两条流式链路共用：管理员 /admin/chat/stream、写手 /bots/:id/chat/stream）
//
// 为什么必须有心跳（2026-10-05 修「管理员调用模型就返回成功然后断掉」）：
//   Agent 是**多轮工具循环**（读记忆库 → 读会话 → 再产出），模型首字十几秒、几十秒都属正常，
//   而工具轮期间后端**一个字节都不产生**。前端曾经用「5s 内没有任何事件就 abort」的看门狗，
//   它分不清「连接死了」和「模型正在想」，于是把每一次正常的长思考都误杀 ——
//   误杀后还会删掉已渲染的气泡、再重发一次请求（同一批工具副作用跑两遍）。
//   有心跳之后，只要收到任何一帧（含 ping）就能重置看门狗，只有真·哑连接才会被掐。
//   同时它也让长文写作（几分钟、中间可能长时间无正文）不至于被中间代理按空闲超时掐断。
//
// 取值：15s。前端那条链路的「空闲上限」是 45s，留 3 拍余量，容忍偶发丢帧。
const SSE_HEARTBEAT_MS = 15000;

module.exports = {
  COUNTER_SYNTAX,
  COUNTER_SYNTAX_HINT,
  WORLD_SECTION_PREFIX,
  WORLD_SYNTAX_HINT,
  SSE_HEARTBEAT_MS,
};
