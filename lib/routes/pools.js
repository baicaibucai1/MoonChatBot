// 角色池（多池）路由：/api/pools/*
// ------------------------------------------------------------------
// ★ 认知前提：**池 ↔ 写手 = 1:1**（用户决策 2026-10-08「角色池对应写手」）。
//   一位写手一个专属池，一个池只归一位写手；写手只看得到自己池里的角色。
//   权威是 `characterPools[i].botId`，见 lib/characters.js 文件头。
//   · POST   /api/pools              必须带 botId（给还没有池的写手建）
//   · DELETE /api/pools/:id          **有主的池不能删**（无主的历史池可以）
//   · PUT    /api/bots/:id/pools     认领一个无主池 / 换个池（最多一个）
//
// ★ 路由顺序必须「先具体后通配」：
//   /api/pools/move（精确）必须排在 /api/pools/:id 之前，否则会被通配吃掉。
//
// ★ 本域也注册了 /api/bots/:id/pools，所以在 lib/http/router.js 里
//   必须排在 'bots' 之前 —— 理由与 characters 域相同（否则被 bots 的
//   /api/bots/:id 通配截走，报「接口不存在」，极难定位）。
// ------------------------------------------------------------------
'use strict';
const { ID_CLASS } = require('../ids');
const characters = require('../characters');

module.exports = function (deps) {
  const { app } = deps;

  // 列表视图：剥掉版本档全文，经历只带最近 3 条（与角色列表接口保持一致）
  const bare = (c) => {
    const { history, experiences, ...rest } = c;
    const exps = experiences || [];
    return {
      ...rest,
      historyCount: (history || []).length,
      experienceCount: exps.length,
      experiences: exps.slice(-3),
    };
  };

  // 池的对外形状：带上角色数 + **归属写手**（池 ↔ 写手 1:1）。
  // ★ `usedBy` 保留原名（旧前端在用），语义变成「主人」——最多一位，无主就是 []。
  const poolView = (cfg, p) => {
    const owner = p.botId ? (cfg.bots || []).find((b) => b.id === p.botId) : null;
    return {
      id: p.id,
      name: p.name,
      desc: p.desc || '',
      ts: p.ts,
      botId: p.botId || '',
      botName: owner ? (owner.name || owner.id) : '',
      count: (p.characters || []).length,
      characters: (p.characters || []).map(bare),
      usedBy: owner ? [{ id: owner.id, name: owner.name || owner.id }] : [],
    };
  };

  return [
    // ---------- 池列表 ----------
    {
      exact: '/api/pools',
      m: 'GET',
      h: (c) => {
        const { send } = c;
        const cfg = app.getConfig();
        const pools = characters.listPools(cfg);
        send(200, { ok: true, pools: pools.map((p) => poolView(cfg, p)), total: pools.length });
        return true;
      },
    },
    // ---------- 新建池（★ 必须指定归属写手：池 ↔ 写手 1:1）----------
    {
      exact: '/api/pools',
      m: 'POST',
      h: (c) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const name = String(body?.name || '').trim();
            if (!name) return send(400, { ok: false, err: '池名不能为空' });
            const botId = String(body?.botId || '').trim();
            if (!botId) {
              return send(400, {
                ok: false,
                err: '必须指定归属写手（botId）—— 池 ↔ 写手是 1:1，没有「公共池」。'
                  + '每位写手建好时会自动获得一个专属池，通常不需要手动新建。',
              });
            }
            const b = (cfg.bots || []).find((x) => x.id === botId);
            if (!b) return send(404, { ok: false, err: '写手不存在: ' + botId });
            const pools = characters.listPools(cfg);
            if (pools.length >= 100) return send(400, { ok: false, err: '角色池数量已达上限（100）' });
            // 同名直接拒：池名是给人认的，重名会让「切到哪个池」变得难辨
            if (pools.some((p) => p.name === name)) return send(400, { ok: false, err: '已存在同名角色池' });
            if (characters.poolOfBot(cfg, botId)) {
              return send(400, {
                ok: false,
                err: `写手「${b.name || botId}」已经有专属池了（一位写手一个池）。要换池请改那个池的名字，或先删掉它。`,
              });
            }
            const p = characters.createPool(cfg, { name, desc: body?.desc, botId });
            characters.syncPoolCharacters(cfg);
            app.saveConfig(cfg);
            send(200, { ok: true, pool: poolView(cfg, p) });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 角色换池（★ 精确路径，必须排在 /:id 通配之前）----------
    {
      exact: '/api/pools/move',
      m: 'POST',
      h: (c) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const charId = String(body?.characterId || '').trim();
            const toPoolId = String(body?.toPoolId || '').trim();
            if (!charId || !toPoolId) return send(400, { ok: false, err: 'characterId 与 toPoolId 必填' });
            const r = characters.moveCharacter(cfg, charId, toPoolId);
            if (!r.ok) return send(404, { ok: false, err: r.err });
            // 换池后重写手身上的引用：原池绑定的写手要撤掉，新池绑定的要补上
            characters.syncPoolCharacters(cfg);
            app.saveConfig(cfg);
            // ★ 已经在目标池里时 moveCharacter 走的是 `moved:false` 那条短路 ——
            //   它**只回 pool、不回 character**。这里必须自己再取一次角色，
            //   否则 bare(undefined) 直接抛 500（「换到自己已经在的池」是个很正常的操作：
            //   面板的下拉、写手的「换池」都可能提交当前值）。幂等：200 + moved:false。
            const ch = r.character || characters.findAny(cfg, charId);
            send(200, {
              ok: true,
              moved: r.moved !== false,
              character: ch ? bare(ch) : null,
              pool: poolView(cfg, r.pool),
            });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 在指定池里新建角色 ----------
    {
      re: new RegExp('^/api/pools/(' + ID_CLASS + '{1,64})/characters$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const p = characters.findPool(cfg, m[1]);
            if (!p) return send(404, { ok: false, err: '角色池不存在: ' + m[1] });
            const name = String(body?.name || '').trim();
            if (!name) return send(400, { ok: false, err: '角色名不能为空' });
            if (characters.allOf(cfg).length >= 500) return send(400, { ok: false, err: '角色数量已达上限（500）' });
            const ch = characters.create(p.characters, {
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
            characters.syncPoolCharacters(cfg);
            app.saveConfig(cfg);
            send(200, { ok: true, character: bare(ch), pool: poolView(cfg, p) });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 改名 / 改描述 ----------
    {
      re: new RegExp('^/api/pools/(' + ID_CLASS + '{1,64})$'),
      m: 'PUT',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const nextName = String(body?.name || '').trim();
            if (nextName) {
              const dup = characters.listPools(cfg).some((p) => p.name === nextName && p.id !== m[1]);
              if (dup) return send(400, { ok: false, err: '已存在同名角色池' });
            }
            const r = characters.updatePool(cfg, m[1], { name: body?.name, desc: body?.desc });
            if (!r.ok) return send(404, { ok: false, err: r.err });
            app.saveConfig(cfg);
            send(200, { ok: true, pool: poolView(cfg, r.pool) });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 删池 ----------
    // ★ 有主的池**不能删**：它是某位写手的专属池（1:1）。删掉等于让写手突然失去
    //   全部角色 —— 那是「删角色」该干的事，不该藏在「删池」里顺手做掉。
    //   无主的池（历史遗留 / 写手已删）可以删，默认把池内角色移到第一个剩余池（不丢人）；
    //   body.drop=true / '1' 才连角色一起删。
    // ★ 最后一个池删不掉（400）—— 见 lib/characters.js removePool。
    {
      re: new RegExp('^/api/pools/(' + ID_CLASS + '{1,64})$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const target = characters.findPool(cfg, m[1]);
            if (!target) return send(404, { ok: false, err: '角色池不存在' });
            if (target.botId) {
              const owner = (cfg.bots || []).find((b) => b.id === target.botId);
              return send(400, {
                ok: false,
                err: `「${target.name}」是写手「${(owner && owner.name) || target.botId}」的专属池，不能删。`
                  + `（池 ↔ 写手 1:1。）要清空它请逐个删掉里面的角色，或把角色换到别的池。`,
              });
            }
            // drop=1（或 true）才连池内角色一起删；默认把人移到第一个剩余池
            const drop = body?.drop === true || String(body?.drop || '') === '1';
            const r = characters.removePool(cfg, m[1], { dropCharacters: drop });
            // 「至少留一个池」是业务规则 → 400；「池不存在」才是 404
            if (!r.ok) return send(r.code === 'last' ? 400 : 404, { ok: false, err: r.err });
            characters.syncPoolCharacters(cfg);
            app.saveConfig(cfg);
            send(200, { ok: true, moved: r.moved, dropped: r.dropped });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 写手 ↔ 池：认领 / 换池（1:1，最多一个）----------
    // poolIds 给 1 个 → 把那个**无主**池认领给它（已有主则拒绝）；
    // 给 0 个 → 释放当前池（变无主），同步会再给它建一个空池。
    {
      re: new RegExp('^/api/bots/(' + ID_CLASS + '{1,64})/pools$'),
      m: ['PUT', 'POST'],
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            const b = (cfg.bots || []).find((x) => x.id === m[1]);
            if (!b) return send(404, { ok: false, err: '写手不存在: ' + m[1] });
            const ids = Array.isArray(body?.poolIds) ? body.poolIds.map((x) => String(x)) : null;
            if (!ids) return send(400, { ok: false, err: 'poolIds 必须是数组' });
            if (ids.length > 1) {
              return send(400, {
                ok: false,
                err: '一位写手只能有一个专属池（池 ↔ 写手 1:1），poolIds 最多给一个。',
              });
            }
            // 先释放当前归属，再认领新池 —— 这样「换个池」也是一次调用搞定
            const cur = characters.poolOfBot(cfg, b.id);
            if (cur && cur.id !== ids[0]) cur.botId = '';
            if (ids.length === 1) {
              const r = characters.assignPoolToBot(cfg, ids[0], b.id);
              if (!r.ok) {
                if (cur) cur.botId = b.id;                       // 回滚这次释放
                const exists = characters.findPool(cfg, ids[0]);
                return send(exists ? 400 : 404, { ok: false, err: r.err });
              }
            }
            // ★ 同步会重算 bot.poolIds / activeCharacterIds（派生镜像），
            //   并且在「释放了池、又没认领新的」时补一个空池出来。
            characters.syncPoolCharacters(cfg);
            app.saveConfig(cfg);
            send(200, {
              ok: true,
              poolIds: b.poolIds || [],
              activeCharacterIds: b.activeCharacterIds || [],
            });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
  ];
};
