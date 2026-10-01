// 元信息路由：全局状态 / 保存配置 / 用量统计
'use strict';
const { ID_RE } = require('../ids');
// 长文模式的边界收敛复用 lib/longreply.js 的同一份定义（默认值 / 硬边界只写一处）
const { clampInt, DEFAULTS, LIMITS, INTENT_DEFAULTS, INTENT_LIMITS, LENGTH_PERMISSIONS, PERM_DEFAULTS } = require('../longreply');

module.exports = function (deps) {
  const { app, memory, seedHeart } = deps;

  return [
    // GET /api/state — 全局状态
    // 注意：原实现没有方法校验，任意方法都会命中本分支并返回 200（批 0 基线如实记录了该行为，
    // 此处保持原样；补校验属于行为变更，留到批 2 与基线一起更新）
    {
      exact: '/api/state',
      m: null,
      h: (c) => {
        const { send } = c;
        const cfg = app.getConfig();
        const envMask = Object.fromEntries(cfg.models.map((m) => [m.id, Boolean(m.apiKey || app.env[m.apiKeyEnv])]));
        return send(200, {
          ok: true,
          port: cfg.port,
          webSearch: cfg.webSearch,
          searchMode: cfg.searchMode,
          distillModel: cfg.distillModel || '',
          bots: cfg.bots.map((b) => ({ ...b, runtime: app.bots.getStatus(b.id) })),
          streamReply: cfg.streamReply === true,
          // 长文模式（分段续写 / 先规划后写）：全局默认开关 + 目标字数 + 段数/字数上限
          // ★ 一律输出**确定值**而不是 undefined：未配置时 undefined 会被 JSON.stringify 省略，
          //   于是 /api/state 的字段集会在「用户第一次保存设置」时突然多出几项 ——
          //   基线探针会莫名其妙漂一次。归一化后契约一次性固定。
          longReply: cfg.longReply === true,
          longReplyTarget: clampInt(cfg.longReplyTarget, DEFAULTS.target, LIMITS.target),
          longReplySegments: clampInt(cfg.longReplySegments, DEFAULTS.segments, LIMITS.segments),
          longReplyMaxChars: clampInt(cfg.longReplyMaxChars, DEFAULTS.maxChars, LIMITS.maxChars),
          // 长度意图识别：自动识别开关（默认开）+ 长档 / 短档字数
          longReplyAuto: cfg.longReplyAuto === true || cfg.longReplyAuto === undefined,
          longReplyLongTarget: clampInt(cfg.longReplyLongTarget, INTENT_DEFAULTS.longTarget, INTENT_LIMITS.longTarget),
          longReplyShortTarget: clampInt(cfg.longReplyShortTarget, INTENT_DEFAULTS.shortTarget, INTENT_LIMITS.shortTarget),
          // 长度自主权：模型能否自己决定写多长（off / limited / full）+ 允许的区间
          lengthPerm: LENGTH_PERMISSIONS.includes(cfg.lengthPerm) ? cfg.lengthPerm : PERM_DEFAULTS.mode,
          lengthMin: clampInt(cfg.lengthMin, PERM_DEFAULTS.min, [100, 50000]),
          lengthMax: clampInt(cfg.lengthMax, PERM_DEFAULTS.max, [100, 100000]),
          models: cfg.models.map((m) => ({ ...m, hasKey: envMask[m.id] })),
        });
      },
    },

    // PUT /api/config — 保存配置并热重载
    // ID 需为安全字符集（中文/字母/数字/下划线/连字符），否则后续记忆目录、路由、内联事件均可能出错/注入
    {
      exact: '/api/config',
      m: 'PUT',
      h: (c) => {
        const { send, readBody } = c;
        readBody((body) => {
          const cfg = app.getConfig();
          if (body.bots) {
            if (!Array.isArray(body.bots) || !body.bots.every((b) => b && ID_RE.test(String(b.id || ''))))
              return send(400, { ok: false, err: '机器人 ID 含非法字符（仅允许中文/字母/数字/下划线/连字符，最长 64 位）' });
            cfg.bots = body.bots;
          }
          if (body.models) {
            if (!Array.isArray(body.models) || !body.models.every((m) => m && ID_RE.test(String(m.id || ''))))
              return send(400, { ok: false, err: '模型 ID 含非法字符（仅允许中文/字母/数字/下划线/连字符，最长 64 位）' });
            cfg.models = body.models;
          }
          if (body.port) cfg.port = Number(body.port);
          if (body.webSearch === true || body.webSearch === false) cfg.webSearch = body.webSearch;
          if (body.streamReply === true || body.streamReply === false) cfg.streamReply = body.streamReply;
          // 长文模式：全局默认开关（角色可在自己的设置里覆盖）+ 目标字数 + 续写上限
          if (body.longReply === true || body.longReply === false) cfg.longReply = body.longReply;
          // 上限值在这里再 clamp 一次：前端输入框的 min/max 只是提示，直接调 API 传 99 也得收敛
          if (body.longReplyTarget !== undefined)
            cfg.longReplyTarget = clampInt(body.longReplyTarget, DEFAULTS.target, LIMITS.target);
          if (body.longReplySegments !== undefined)
            cfg.longReplySegments = clampInt(body.longReplySegments, DEFAULTS.segments, LIMITS.segments);
          if (body.longReplyMaxChars !== undefined)
            cfg.longReplyMaxChars = clampInt(body.longReplyMaxChars, DEFAULTS.maxChars, LIMITS.maxChars);
          // 长度意图识别
          if (body.longReplyAuto === true || body.longReplyAuto === false) cfg.longReplyAuto = body.longReplyAuto;
          if (body.longReplyLongTarget !== undefined)
            cfg.longReplyLongTarget = clampInt(body.longReplyLongTarget, INTENT_DEFAULTS.longTarget, INTENT_LIMITS.longTarget);
          if (body.longReplyShortTarget !== undefined)
            cfg.longReplyShortTarget = clampInt(body.longReplyShortTarget, INTENT_DEFAULTS.shortTarget, INTENT_LIMITS.shortTarget);
          // 长度自主权（off / limited / full）：非白名单值一律忽略，避免手滑写个奇怪字符串
          if (LENGTH_PERMISSIONS.includes(body.lengthPerm)) cfg.lengthPerm = body.lengthPerm;
          if (body.lengthMin !== undefined)
            cfg.lengthMin = clampInt(body.lengthMin, PERM_DEFAULTS.min, [100, 50000]);
          if (body.lengthMax !== undefined)
            cfg.lengthMax = clampInt(body.lengthMax, PERM_DEFAULTS.max, [100, 100000]);
          if (['auto', 'light', 'browser'].includes(body.searchMode)) cfg.searchMode = body.searchMode;
          // 全局「蒸馏/总结模型」：'' 表示跟随各机器人绑定模型；指定则所有后台总结任务统一使用该模型
          if (body.distillModel !== undefined) {
            const dm = String(body.distillModel || '').trim();
            if (!dm) delete cfg.distillModel;
            else {
              if (!(cfg.models || []).some((m) => m.id === dm)) return send(400, { ok: false, err: '蒸馏/总结模型不存在: ' + dm });
              cfg.distillModel = dm;
            }
          }
          app.saveConfig(cfg);
          app.bots.sync(cfg);
          seedHeart(cfg);
          send(200, { ok: true });
        });
        return true;
      },
    },

    // GET /api/usage — Token 用量统计
    {
      exact: '/api/usage',
      m: 'GET',
      h: (c) => c.send(200, { ok: true, stats: memory.getUsageStats() }),
    },
  ];
};
