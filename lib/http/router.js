// API 路由表 —— 有序匹配，命中即处理
//
// 设计取舍：不引入「路由器库」，只把原先散在 703 行 handleApi 里的 if 链
// 改成一张显式有序表。原因有三：
//   1. 原实现靠正则锚定 + 书写顺序表达「先具体后通配」，改成路径树会改变语义；
//   2. 顺序即语义，显式表让「谁先匹配」一眼可见，不再藏在缩进里；
//   3. handler 逐条搬自原实现，可逐条对照，便于用接口基线做等价性验证。
'use strict';

const { createContext } = require('./context');

// 各域路由按原 handleApi 的书写顺序拼装。
// ⚠️ 调整这里的顺序会改变匹配结果，不要随意改动。
const DOMAINS = [
  'avatar',     // 头像上传
  'meta',       // 全局状态 / 配置 / 用量
  'global',     // 全局记忆文件
  'memory',     // 机器人记忆（最大一块）
  'models',     // 模型连通性测试
  'bots',       // 机器人控制
  'admin',      // 面板管理员 AI
  'heartbeat',  // 心跳状态
  'moments',    // 精彩时刻
];

function createRouter(deps) {
  const routes = [];
  for (const name of DOMAINS) {
    routes.push(...require('../routes/' + name)(deps));
  }

  /**
   * 路由条目字段：
   *   exact  精确路径（与 re 二选一）
   *   re     路径正则，捕获组按位置传给 handler
   *   m      允许的方法：字符串 / 数组 / null（不限）
   *   h      handler(ctx, matchArray) → 返回 false 表示「不处理，继续下探」，其余值表示已处理
   */
  function methodAllowed(entry, method) {
    if (!entry.m) return true;
    const allow = Array.isArray(entry.m) ? entry.m : [entry.m];
    return allow.includes(method);
  }

  /**
   * 找出第一个「方法 + 路径」都匹配的条目（只看匹配条件，不执行 handler）。
   * 供测试与调试使用；注意 handler 仍可能返回 false 继续下探（如 /api/moments/:id）。
   */
  function matchEntry(method, p) {
    for (const r of routes) {
      if (!methodAllowed(r, method)) continue;
      if (r.exact !== undefined) {
        if (p === r.exact) return r;
        continue;
      }
      if (r.re.exec(p)) return r;
    }
    return null;
  }

  /** 处理一次 API 请求。 */
  function handle(req, res, p) {
    const ctx = createContext(req, res, p);

    for (const r of routes) {
      if (!methodAllowed(r, req.method)) continue;

      let match = null;
      if (r.exact !== undefined) {
        if (p !== r.exact) continue;
      } else {
        match = r.re.exec(p);
        if (!match) continue;
      }

      if (r.h(ctx, match) !== false) return;
    }

    ctx.send(404, { ok: false, err: '接口不存在: ' + p });
  }

  return { handle, matchEntry, routes };
}

module.exports = { createRouter };
