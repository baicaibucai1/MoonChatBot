// 模型连通性测试路由
'use strict';
const { ID_SEG } = require('../ids');

module.exports = function (deps) {
  const { app, memory, models } = deps;

  return [
    // POST /api/models/:id/test — 用一句简单请求验证连通
    {
      re: new RegExp('^/api/models/' + ID_SEG + '/test$'),
      m: 'POST',
      h: (c, m) => {
        const { send } = c;
        const cfg = app.getConfig();
        const model = cfg.models.find((x) => x.id === m[1]);
        if (!model) return send(404, { ok: false, err: '模型不存在' });
        const apiKey = model.apiKey || app.env[model.apiKeyEnv];
        if (!apiKey) return send(400, { ok: false, err: '该模型的 API Key 未配置（直接填 Key，或在 .env 设置对应变量）' });
        models.chat(model, [{ role: 'user', content: 'ping' }], { apiKey, maxTokens: 32 })
          .then((res) => {
            memory.recordUsage('模型测试', m[1], { usage: res.usage, promptTokens: res.promptTokens, ok: true });
            send(200, { ok: true, reply: (res?.content ?? '').slice(0, 200) });
          })
          .catch((err) => {
            memory.recordUsage('模型测试', m[1], { promptTokens: err.promptTokens, ok: false });
            send(200, { ok: false, err: err.message });
          });
        return true;
      },
    },
  ];
};
