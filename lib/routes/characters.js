// 角色池路由：/api/characters/*
// ------------------------------------------------------------------
// 认知前提：bot 就是写手。角色是写手笔下的人物，集中存在全局池里，
// 所有写手共用。写手通过 bot.activeCharacterIds 引用池里的角色。
//
// ★ 路由顺序必须「先具体后通配」：
//   /api/characters/rollback/:id 和 /api/characters/:id/history 这类具体路径
//   必须排在 /api/characters/:id 之前，否则会被通配吃掉（报「接口不存在」，极难定位）。
// ------------------------------------------------------------------
'use strict';
const { ID_CLASS } = require('../ids');
const characters = require('../characters');

module.exports = function (deps) {
  const { app } = deps;

  // 全部角色（跨池扁平）—— 列表 / 合法性校验用
  // ★ ensurePools 会把旧的单一 characters 迁进「默认池」，并在此后保持幂等
  const allChars = (cfg) => {
    characters.ensurePools(cfg);
    return characters.allOf(cfg);
  };

  // 某位角色所在池的数组 —— 按 id 的操作（版本档 / 改写 / 删除 / 计数器…）用它。
  // 角色唯一归属一个池，所以这里最多命中一个；找不到就返回空数组让上层报 404。
  const poolArrOf = (cfg, id) => {
    const p = characters.poolOfChar(cfg, id);
    return p ? p.characters : [];
  };

  // 按 poolId 取池；没给就落第一个池（保证「一定能建出来」）
  const targetPool = (cfg, poolId) => {
    characters.ensurePools(cfg);
    const pid = String(poolId || '').trim();
    const p = pid ? characters.findPool(cfg, pid) : characters.listPools(cfg)[0];
    return p || null;
  };

  // 给角色补上「被哪些写手使用」—— 前端要显示引用数
  // ★ 多池后还要补 poolId / poolName：前端据此标注来源、提供「换池」
  const withUsage = (cfg, c) => {
    const p = characters.poolOfChar(cfg, c && c.id);
    return {
      ...c,
      poolId: p ? p.id : '',
      poolName: p ? p.name : '',
      usedBy: (cfg.bots || [])
        .filter((b) => Array.isArray(b.activeCharacterIds) && b.activeCharacterIds.includes(c.id))
        .map((b) => ({ id: b.id, name: b.name || b.id })),
    };
  };

  // 列表用的精简视图：剥掉版本档全文，经历只带最近几条。
  // ★ 经历最多 100 条/角色，列表一次返回全部会明显变重 —— 详情接口才给全量。
  const bare = (c, opts = {}) => {
    const { history, experiences, ...rest } = c;
    const exps = experiences || [];
    return {
      ...rest,
      historyCount: (history || []).length,
      experienceCount: exps.length,
      experiences: opts.fullExp ? exps : exps.slice(-3),
    };
  };
  const bareFull = (c) => bare(c, { fullExp: true });

  return [
    // ---------- 列表 ----------
    {
      exact: '/api/characters',
      m: 'GET',
      h: (c) => {
        const { send } = c;
        const cfg = app.getConfig();
        const pool = allChars(cfg);
        send(200, {
          ok: true,
          characters: pool.map((x) => withUsage(cfg, bare(x))),
          total: pool.length,
        });
        return true;
      },
    },
    // ---------- 新建 ----------
    {
      exact: '/api/characters',
      m: 'POST',
      h: (c) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const pool = targetPool(cfg, body?.poolId);
            if (!pool) return send(400, { ok: false, err: '没有可用的角色池，请先新建一个角色池' });
            const name = String(body?.name || '').trim();
            if (!name) return send(400, { ok: false, err: '角色名不能为空' });
            if (characters.allOf(cfg).length >= 500) return send(400, { ok: false, err: '角色数量已达上限（500）' });
            const ch = characters.create(pool.characters, {
              name,
              persona: body?.persona,
              traits: body?.traits,
              age: body?.age,
              appearance: body?.appearance,
              background: body?.background,
              tags: body?.tags,
              avatar: body?.avatar,
              source: body?.source,
            }, 'user');
            if (!ch) return send(400, { ok: false, err: '角色数据非法' });
            // 绑定了这个池的写手立即看到新角色（不用等下次重启）
            characters.syncPoolCharacters(cfg);
            app.saveConfig(cfg);
            send(200, { ok: true, character: withUsage(cfg, bare(ch)) });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 历史档 ----------
    // ★ 必须排在 /:id 通配之前（先具体后通配）
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})/history$'),
      m: 'GET',
      h: (c, m) => {
        const { send } = c;
        const cfg = app.getConfig();
        const ch = characters.findAny(cfg, m[1]);
        if (!ch) return send(404, { ok: false, err: '角色不存在: ' + m[1] });
        const hist = (ch.history || []).map((h, i) => ({ index: i, ...h }));
        send(200, { ok: true, history: hist.reverse() }); // 新的在前
        return true;
      },
    },
    // ---------- 回滚 ----------
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})/rollback$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const pool = poolArrOf(cfg, m[1]);
            const idx = Number(body?.index);
            if (!Number.isInteger(idx) || idx < 0) return send(400, { ok: false, err: '无效的历史版本索引' });
            const r = characters.rollback(pool, m[1], idx, 'user');
            if (!r.ok) return send(404, { ok: false, err: r.err });
            app.saveConfig(cfg);
            send(200, { ok: true, character: withUsage(cfg, bare(r.character)) });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 沉淀经历（用户确认后的落点）----------
    // ★ 必须排在 /:id 通配之前（先具体后通配）
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})/commit$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const pool = poolArrOf(cfg, m[1]);
            const target = characters.find(pool, m[1]);
            // ★ 范围以**角色卡上的 `##Counter：`** 为准 —— 即使前端绕过提议直接打接口也逃不掉收敛
            const r = characters.commitExperience(pool, m[1], {
              text: body?.text,
              counters: body?.counters,
              by: body?.by,
            }, characters.characterCounterSpecs(target));
            if (!r.ok) return send(404, { ok: false, err: r.err });
            app.saveConfig(cfg);
            send(200, {
              ok: true, character: withUsage(cfg, bare(r.character)),
              applied: r.applied, clamped: r.clamped || [], entry: r.entry,
            });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 计数器：设置（绝对值）----------
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})/counters$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const pool = poolArrOf(cfg, m[1]);
            const r = characters.setCounter(
              pool, m[1], body?.name, body?.value,
              characters.characterCounterSpecs(characters.find(pool, m[1])),
            );
            if (!r.ok) return send(404, { ok: false, err: r.err });
            app.saveConfig(cfg);
            send(200, {
              ok: true, character: withUsage(cfg, bare(r.character)),
              name: r.name, before: r.before, after: r.after, clamped: r.clamped || [],
            });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 计数器：删除 ----------
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})/counters/(' + ID_CLASS + '{1,64})$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        try {
          const cfg = app.getConfig();
          const pool = poolArrOf(cfg, m[1]);
          const r = characters.removeCounter(pool, m[1], decodeURIComponent(m[2]));
          if (!r.ok) return send(404, { ok: false, err: r.err });
          app.saveConfig(cfg);
          send(200, { ok: true, character: withUsage(cfg, bare(r.character)) });
        } catch (err) { send(500, { ok: false, err: err.message }); }
        return true;
      },
    },
    // ---------- 经历：追加 ----------
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})/experiences$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const pool = poolArrOf(cfg, m[1]);
            const r = characters.appendExperience(pool, m[1], { text: body?.text, by: body?.by });
            if (!r.ok) return send(404, { ok: false, err: r.err });
            app.saveConfig(cfg);
            send(200, { ok: true, character: withUsage(cfg, bare(r.character)), entry: r.entry });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 经历：删除（按条目 id）----------
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})/experiences/(' + ID_CLASS + '{1,64})$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        try {
          const cfg = app.getConfig();
          const pool = poolArrOf(cfg, m[1]);
          const r = characters.removeExperience(pool, m[1], decodeURIComponent(m[2]));
          if (!r.ok) return send(404, { ok: false, err: r.err });
          app.saveConfig(cfg);
          send(200, { ok: true, character: withUsage(cfg, bare(r.character)) });
        } catch (err) { send(500, { ok: false, err: err.message }); }
        return true;
      },
    },
    // ---------- 单个角色详情（带完整历史档 + 全部经历）----------
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})$'),
      m: 'GET',
      h: (c, m) => {
        const { send } = c;
        const cfg = app.getConfig();
        const ch = characters.findAny(cfg, m[1]);
        if (!ch) return send(404, { ok: false, err: '角色不存在: ' + m[1] });
        send(200, { ok: true, character: withUsage(cfg, bareFull(ch)) });
        return true;
      },
    },
    // ---------- 改写（带版本档）----------
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})$'),
      m: 'PUT',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const pool = poolArrOf(cfg, m[1]);
            // 仅接受白名单字段，防止注入 history/id 等
            const patch = {};
            for (const k of characters.EDITABLE_FIELDS) {
              if (body && body[k] !== undefined) patch[k] = body[k];
            }
            const r = characters.update(pool, m[1], patch, 'user');
            if (!r.ok) return send(404, { ok: false, err: r.err });
            app.saveConfig(cfg);
            send(200, { ok: true, character: withUsage(cfg, bare(r.character)), changed: r.changed });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 删除（连根拔：同时清理所有写手的引用）----------
    {
      re: new RegExp('^/api/characters/(' + ID_CLASS + '{1,64})$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        try {
          const cfg = app.getConfig();
          const pool = poolArrOf(cfg, m[1]);
          const r = characters.remove(pool, m[1]);
          if (!r.ok) return send(404, { ok: false, err: r.err });
          // ★ 删记录必须同时清引用，否则写手身上留悬空 id
          const touched = characters.pruneReferences(cfg.bots || [], m[1]);
          // 再跑一次同步：把池内剩余角色重新对齐到写手身上（去重 / 去悬空）
          characters.syncPoolCharacters(cfg);
          app.saveConfig(cfg);
          send(200, { ok: true, prunedBots: touched });
        } catch (err) { send(500, { ok: false, err: err.message }); }
        return true;
      },
    },
    // ---------- 写手的角色引用（增删）----------
    {
      re: new RegExp('^/api/bots/(' + ID_CLASS + '{1,64})/characters$'),
      m: ['PUT', 'POST'],
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const pool = allChars(cfg);
            const b = (cfg.bots || []).find((x) => x.id === m[1]);
            if (!b) return send(404, { ok: false, err: '写手不存在: ' + m[1] });
            const ids = Array.isArray(body?.characterIds) ? body.characterIds.map((x) => String(x)) : null;
            if (!ids) return send(400, { ok: false, err: 'characterIds 必须是数组' });
            // 只接受池里真实存在的 id（防悬空引用）
            const valid = new Set(pool.map((x) => x.id));
            const cleaned = ids.filter((x) => valid.has(x));
            // 去重但保序
            const seen = new Set();
            b.activeCharacterIds = cleaned.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
            app.saveConfig(cfg);
            send(200, {
              ok: true,
              activeCharacterIds: b.activeCharacterIds,
              rejected: ids.filter((x) => !valid.has(x)),
            });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
  ];
};
