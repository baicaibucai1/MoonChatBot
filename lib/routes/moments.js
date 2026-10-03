// 机器人「精彩时刻」路由：POST 提炼 / DELETE 删除或清空
// 注意：本段与原实现一样，方法不是 POST/DELETE 时**不作响应**，交由路由表继续下探到 404。
// 为了让「先做机器人存在性校验」的语义完全一致（未知 id 报「机器人不存在」而不是「接口不存在」），
// 这里注册为不限方法，由 handler 自己按方法分派。
'use strict';
const { ID_CLASS } = require('../ids');

module.exports = function (deps) {
  const { app, genBotMoments } = deps;

  return [
    {
      // 注意必须带捕获括号，否则 handler 拿不到 id（原实现: /^\/api\/moments\/([\w\u4e00-\u9fa5-]{1,64})$/）
      re: new RegExp('^/api/moments/(' + ID_CLASS + '{1,64})$'),
      m: null,
      h: (c, momentsM) => {
        const { send, readBody, req } = c;
        const id = momentsM[1];
        const cfg = app.getConfig();
        const b = (cfg.bots || []).find((x) => x.id === id);
        if (!b) return send(404, { ok: false, err: '机器人不存在: ' + id });

        // POST — 提炼并覆盖保存
        if (req.method === 'POST') {
          (async () => {
            try {
              const r = await genBotMoments(b);
              send(200, r.ok ? { ok: true, moments: r.moments } : { ok: false, err: r.err || '提炼失败' });
            } catch (err) { send(500, { ok: false, err: err.message }); }
          })();
          return true;
        }

        // DELETE — 删除指定一条 { index }，index 省略则清空
        if (req.method === 'DELETE') {
          readBody((body) => {
            const list = Array.isArray(b.moments) ? b.moments.slice() : [];
            const idx = Number(body?.index);
            if (Number.isInteger(idx) && idx >= 0 && idx < list.length) list.splice(idx, 1);
            else list.length = 0;
            b.moments = list;
            app.saveConfig(cfg);
            send(200, { ok: true });
          });
          return true;
        }

        // 其余方法：不处理，继续下探（与原实现一致）
        return false;
      },
    },
  ];
};
