// ID / 文件名的安全字符集 —— 全项目唯一来源
// 背景：拆分前同一个字符类在 server.js 里被复制粘贴了 34 次，改校验规则必须逐处找齐。
// 现在统一从这里取，路由正则也用 ID_SEG 拼装，杜绝「改一处漏一处」。
'use strict';

// 字符类本体：中文、字母、数字、下划线、连字符
// 用 .source 取源码字符串，保证路由正则与整体校验用的是同一份定义
const ID_CLASS = /[\w\u4e00-\u9fa5-]/.source;

// 路由参数捕获段，用于拼装形如 /^\/api\/memory\/([\w\u4e00-\u9fa5-]+)\/files$/ 的正则
const ID_SEG = '(' + ID_CLASS + '+)';

// 取反字符类：用于「清洗文件名」等把非法字符替换成下划线的场景
const NOT_ID_CLASS = '[^' + ID_CLASS.slice(1, -1) + ']';

// 整体校验：1–64 位
const ID_RE = new RegExp('^' + ID_CLASS + '{1,64}$');

// 历史上 ADMIN_ID_RE 与 ID_RE 内容完全相同（同一份拷贝、两个名字），此处合并为同一规则
const ADMIN_ID_RE = ID_RE;

// 管理员会话 id：纯 ASCII（字母/数字/下划线/连字符），最长 40 位
const SESSION_ID_RE = /^[\w-]{1,40}$/;

module.exports = { ID_CLASS, ID_SEG, NOT_ID_CLASS, ID_RE, ADMIN_ID_RE, SESSION_ID_RE };
