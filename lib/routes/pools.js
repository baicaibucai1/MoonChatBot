// 角色池（多池）路由：/api/pools/*
// ------------------------------------------------------------------
// ★ 认知前提：角色不堆在一个大池子里 —— 按作品 / 世界观 / 分组拆成多个池，
//   写手绑定整池即可批量拿到池内所有角色（见 lib/characters.js 文件头）。
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

  // 池的对外形状：带上角色数与「被哪些写手绑定」
  const poolView = (cfg, p) => ({
    id: p.id,
    name: p.name,
    desc: p.desc || '',
    ts: p.ts,
    count: (p.characters || []).length,
    characters: (p.characters || []).map(bare),
    usedBy: (cfg.bots || [])
      .filter((b) => Array.isArray(b.poolIds) && b.poolIds.includes(p.id))
      .map((b) => ({ id: b.id, name: b.name || b.id })),
  });

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
    // ---------- 新建池 ----------
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
            const pools = characters.listPools(cfg);
            if (pools.length >= 100) return send(400, { ok: false, err: '角色池数量已达上限（100）' });
            // 同名直接拒：池名是给人认的，重名会让「切到哪个池」变得难辨
            if (pools.some((p) => p.name === name)) return send(400, { ok: false, err: '已存在同名角色池' });
            const p = characters.createPool(cfg, { name, desc: body?.desc });
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
            send(200, { ok: true, character: bare(r.character), pool: poolView(cfg, r.pool) });
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
    // 默认把池内角色移到第一个剩余池（不丢人）；body.drop=true / '1' 才连角色一起删。
    // ★ 最后一个池删不掉（400）—— 角色必须有个地方放，见 lib/characters.js removePool。
    {
      re: new RegExp('^/api/pools/(' + ID_CLASS + '{1,64})$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const cfg = app.getConfig();
            // drop=1（或 true）才连池内角色一起删；默认把人移到第一个剩余池
            const drop = body?.drop === true || String(body?.drop || '') === '1';
            const r = characters.removePool(cfg, m[1], { dropCharacters: drop });
            // 「至少留一个池」是业务规则 → 400；「池不存在」才是 404
            if (!r.ok) return send(r.code === 'last' ? 400 : 404, { ok: false, err: r.err });
            // 清掉写手身上对这个已删池的绑定
            for (const b of cfg.bots || []) {
              if (!Array.isArray(b.poolIds)) continue;
              b.poolIds = b.poolIds.filter((x) => x !== m[1]);
            }
            characters.syncPoolCharacters(cfg);
            app.saveConfig(cfg);
            send(200, { ok: true, moved: r.moved, dropped: r.dropped });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
    // ---------- 写手绑定角色池（批量拿到池内全部角色）----------
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
            const valid = new Set(characters.listPools(cfg).map((p) => p.id));
            const seen = new Set();
            b.poolIds = ids.filter((x) => valid.has(x) && (seen.has(x) ? false : (seen.add(x), true)));
            // ★ 绑定即展开：池内角色进 activeCharacterIds，旧的读取点全部照常工作
            characters.syncPoolCharacters(cfg);
            app.saveConfig(cfg);
            send(200, {
              ok: true,
              poolIds: b.poolIds,
              activeCharacterIds: b.activeCharacterIds || [],
              rejected: ids.filter((x) => !valid.has(x)),
            });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
  ];
};
