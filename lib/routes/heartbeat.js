// 机器人心跳状态路由
'use strict';

module.exports = function (deps) {
  const { app, memory, hbConfigs, hbState } = deps;

  return [
    // GET /api/heartbeat/status — 各机器人各时段心跳的下次触发时间与状态
    {
      exact: '/api/heartbeat/status',
      m: 'GET',
      h: (c) => {
        const { send } = c;
        const cfg = app.getConfig();
        const now = Date.now();
        const list = [];
        for (const b of cfg.bots || []) {
          for (const { slot, h } of hbConfigs(b)) {
            const key = `${b.id}::${slot}`;
            const e = hbState.get(key);
            list.push({
              id: b.id,
              slot,
              enabled: !!(h && h.enabled === true && e),
              mode: h?.mode || 'interval',
              prompt: (h?.prompt || '').slice(0, 60),
              taskCount: Array.isArray(h?.tasks) ? h.tasks.length : 0,
              next: e ? e.next : 0,
              last: e ? e.last : 0,
              secondsLeft: e ? Math.max(0, Math.ceil((e.next - now) / 1000)) : 0,
              master: memory.getMasterSender(b.id),
            });
          }
        }
        return send(200, { ok: true, list });
      },
    },
  ];
};
