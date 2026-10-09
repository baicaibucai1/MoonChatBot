// 多角色池：数据层 + 路由层
// ------------------------------------------------------------------
// 覆盖的是「角色不能全堆在一个池子里」这条需求的核心机制：
//   池的增删改 / 角色唯一归属且可换池 / 写手绑池后批量拿到池内角色。
// ------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../lib/characters.js');

// 造一份干净的 config（每个用例独立，避免互相污染）
const fresh = (bots = []) => ({ bots });

// ---------- 迁移 ----------

test('ensurePools：把旧的单一 characters 迁进「默认池」', () => {
  const cfg = { characters: [{ id: 'CHR1', name: '银' }], bots: [] };
  const r = C.ensurePools(cfg);
  assert.equal(r.migrated, 1);
  assert.equal(C.listPools(cfg).length, 1);
  assert.equal(C.listPools(cfg)[0].name, C.DEFAULT_POOL_NAME);
  assert.equal(C.allOf(cfg).length, 1);
  assert.equal('characters' in cfg, false, '旧字段必须退役，避免与新池重复');
});

test('ensurePools 是幂等的：重复调用不会把角色搬丢或翻倍', () => {
  const cfg = { characters: [{ id: 'CHR1', name: '银' }], bots: [] };
  C.ensurePools(cfg);
  C.ensurePools(cfg);
  C.ensurePools(cfg);
  assert.equal(C.allOf(cfg).length, 1);
  assert.equal(C.listPools(cfg).length, 1);
});

// ★★ 回归：池 id 必须在「每次都重新读盘」的场景下保持稳定。
//   真实事故：store.getConfig() 每次调用都重读 config.json（lib/store.js），
//   而旧版单池 → 多池的升级最初只改内存、没落盘。于是 listPools() 每被读一次
//   就重造一个**随机 id** 的默认池：GET /api/pools 与 /api/state 返回的 poolId
//   根本不一致，绑池的写手瞬间指向不存在的池。
//   这里模拟「同一份盘上数据被反复读成新对象」——id 必须一模一样。
test('★ 池 id 稳定：同一份盘上配置被反复读成新对象，默认池 id 不变', () => {
  const onDisk = { characters: [{ id: 'CHR1', name: '银' }], bots: [] };
  // 模拟 getConfig()：每次从盘上解析出一份新对象（不共享引用）
  const readConfig = () => JSON.parse(JSON.stringify(onDisk));
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const cfg = readConfig();
    C.ensurePools(cfg);                       // 每次都得自愈一遍
    ids.push(C.listPools(cfg)[0].id);
  }
  assert.equal(new Set(ids).size, 1, `池 id 在多次读取间必须一致，实际拿到 ${JSON.stringify(ids)}`);
  assert.equal(ids[0], C.DEFAULT_POOL_ID);
});

test('★ ensurePools 报告 created：调用方据此知道「该落盘了」', () => {
  const legacy = { characters: [{ id: 'CHR1', name: '银' }], bots: [] };
  assert.equal(C.ensurePools(legacy).created, true, '迁移出默认池 → created');
  assert.equal(C.ensurePools(legacy).created, false, '第二次已经是新格式 → 不再 created');
  const already = { characterPools: [{ id: 'POOLx', name: '组', characters: [] }], bots: [] };
  assert.equal(C.ensurePools(already).created, false);
});

// ★★ 回归（2026-10-08 全量测试抓到的）：
//   characterPools 已存在时，残留的顶层 characters 本来是**被静默忽略**的 ——
//   4 个探针往那儿塞角色 / 改 persona，服务器只读池、没人读旧字段，
//   报出来却是「池外角色不见了 / 计数器不收敛 / 提议帧不下发」，
//   指向的功能和真实原因毫无关系，而且**全程零报错**。
//   现在必须收编进默认池并报 orphans —— 宁可归属可疑，也不能静默丢数据。
test('★ 残留的旧 characters 不再被静默忽略：收编进默认池并报 orphans', () => {
  const cfg = {
    characterPools: [{ id: C.DEFAULT_POOL_ID, name: '默认池', characters: [{ id: 'CHR1', name: '银' }] }],
    characters: [{ id: 'CHR2', name: '池外角色' }],
    bots: [],
  };
  const r = C.ensurePools(cfg);
  assert.equal(r.orphans, 1, '收编 1 位');
  assert.equal(r.migrated, 0, '这不算「旧格式迁移」，是残留收编');
  assert.equal('characters' in cfg, false, '旧字段必须摘掉');
  assert.deepEqual(C.allOf(cfg).map((c) => c.id).sort(), ['CHR1', 'CHR2'], '两位都得在池里');
});

test('★ 收编去重：池里已有同 id 时保留池里那份，不重复插', () => {
  const cfg = {
    characterPools: [{ id: C.DEFAULT_POOL_ID, name: '默认池', characters: [{ id: 'CHR1', name: '池里的银' }] }],
    characters: [{ id: 'CHR1', name: '旧字段的银' }, { id: 'CHR2', name: '新角色' }],
    bots: [],
  };
  const r = C.ensurePools(cfg);
  assert.equal(r.orphans, 1, '只有 CHR2 是新的');
  assert.equal(C.allOf(cfg).length, 2);
  assert.equal(C.allOf(cfg).find((c) => c.id === 'CHR1').name, '池里的银');
});

test('★ 收编是幂等的：同一份「带残留的盘上数据」反复读，不会每次翻倍', () => {
  const onDisk = {
    characterPools: [{ id: C.DEFAULT_POOL_ID, name: '默认池', characters: [] }],
    characters: [{ id: 'CHR9', name: '遗留' }],
    bots: [],
  };
  const counts = [];
  for (let i = 0; i < 4; i++) {
    const cfg = JSON.parse(JSON.stringify(onDisk)); // 模拟 getConfig() 每次都读出新对象
    C.ensurePools(cfg);
    C.ensurePools(cfg);
    counts.push(C.allOf(cfg).length);
  }
  assert.deepEqual(counts, [1, 1, 1, 1], `每次都必须恰好 1 位，实际 ${JSON.stringify(counts)}`);
});

// ★★ 回归：「至少有一个池」不能只靠「删池」守住。
//   removePool 守着这条，但那只覆盖「删」这一条路 —— 整份 PUT /api/config
//   传 characterPools: [] 同样能把角色体系清空，之后新建角色会无处可放。
//   这条不变量归 ensurePools 管，因为它是配置的入口。
test('★ 空池数组自愈：被 PUT 成 [] 也会补回默认池', () => {
  const cfg = { characterPools: [], bots: [] };
  const r = C.ensurePools(cfg);
  assert.equal(r.created, true, '补了池 → 调用方该落盘');
  assert.equal(C.listPools(cfg).length, 1);
  assert.equal(C.listPools(cfg)[0].id, C.DEFAULT_POOL_ID);
  assert.equal(C.ensurePools(cfg).created, false, '再调用不该重复补');
});

test('★ 不许删掉最后一个池（否则等于把角色体系清空）', () => {
  const cfg = { characters: [{ id: 'CHR1', name: '银' }], bots: [{ id: 'BOT1' }] };
  C.ensurePools(cfg);
  const only = C.listPools(cfg)[0];
  const r = C.removePool(cfg, only.id);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'last');
  assert.equal(C.listPools(cfg).length, 1, '池必须还在');
  assert.equal(C.allOf(cfg).length, 1, '角色也必须还在');
});

test('★ 删不存在的池报 missing，而不是被「最后一个池」规则抢先', () => {
  const cfg = { characters: [{ id: 'CHR1', name: '银' }], bots: [] };
  C.ensurePools(cfg);
  // 只有 1 个池的情况下删一个不存在的 id：必须报「不存在」，不能报「至少要保留一个」
  const r = C.removePool(cfg, 'POOLnosuch');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing', '归因必须是「池不存在」');
});

// ---------- 池的增删改 ----------

test('新建池：可以建多个，角色不再挤在一个池里', () => {
  const cfg = fresh();
  C.ensurePools(cfg);
  const a = C.createPool(cfg, { name: '校园组' });
  const b = C.createPool(cfg, { name: '异世界组' });
  assert.equal(C.listPools(cfg).length, 3); // 默认池 + 2
  assert.notEqual(a.id, b.id);
  assert.ok(a.id.startsWith(C.POOL_PREFIX));
});

test('改池名：空名拒绝，正常名可改', () => {
  const cfg = fresh();
  C.ensurePools(cfg);
  const p = C.createPool(cfg, { name: '校园组' });
  assert.equal(C.updatePool(cfg, p.id, { name: '   ' }).ok, false, '空名必须拒');
  assert.equal(C.updatePool(cfg, p.id, { name: '校园组B' }).ok, true);
  assert.equal(C.findPool(cfg, p.id).name, '校园组B');
  assert.equal(C.updatePool(cfg, 'POOL不存在', { name: 'x' }).ok, false);
});

test('删池：池内角色默认移到第一个剩余池，不丢人', () => {
  const cfg = fresh();
  C.ensurePools(cfg);
  const def = C.listPools(cfg)[0];
  const p = C.createPool(cfg, { name: '校园组' });
  C.create(p.characters, { name: '银' }, 'user');
  C.create(p.characters, { name: '顺顺' }, 'user');
  const r = C.removePool(cfg, p.id);
  assert.equal(r.ok, true);
  assert.equal(r.moved, 2);
  assert.equal(r.dropped, 0);
  assert.equal(C.allOf(cfg).length, 2, '角色不能凭空消失');
  assert.equal(def.characters.length, 2, '人应该落到默认池');
});

test('删池：dropCharacters=true 才连角色一起删', () => {
  const cfg = fresh();
  C.ensurePools(cfg);
  const p = C.createPool(cfg, { name: '临时组' });
  C.create(p.characters, { name: '路人甲' }, 'user');
  const r = C.removePool(cfg, p.id, { dropCharacters: true });
  assert.equal(r.dropped, 1);
  assert.equal(C.allOf(cfg).length, 0);
});

// ---------- 角色唯一归属 + 换池 ----------

test('角色唯一归属：换池是移动，不是复制', () => {
  const cfg = fresh();
  C.ensurePools(cfg);
  const def = C.listPools(cfg)[0];
  const p = C.createPool(cfg, { name: '校园组' });
  const c = C.create(def.characters, { name: '银' }, 'user');

  assert.equal(C.poolOfChar(cfg, c.id).id, def.id);
  const r = C.moveCharacter(cfg, c.id, p.id);
  assert.equal(r.ok, true);
  assert.equal(C.allOf(cfg).length, 1, '总数不变 —— 是移动不是复制');
  assert.equal(def.characters.length, 0);
  assert.equal(C.poolOfChar(cfg, c.id).id, p.id);
});

test('换池到不存在的池 / 不存在的角色都要报错而不是静默', () => {
  const cfg = fresh();
  C.ensurePools(cfg);
  const def = C.listPools(cfg)[0];
  const c = C.create(def.characters, { name: '银' }, 'user');
  assert.equal(C.moveCharacter(cfg, c.id, 'POOL没有').ok, false);
  assert.equal(C.moveCharacter(cfg, 'CHR没有', def.id).ok, false);
  assert.equal(C.moveCharacter(cfg, c.id, def.id).moved, false, '原地不动应标记未移动');
});

// ---------- 池 ↔ 写手：1:1（用户决策 2026-10-08「角色池对应写手」）----------
//
// ★ 权威是 `pool.botId`；bot.poolIds / activeCharacterIds 都是**派生镜像**，
//   由 syncPoolCharacters 重算。所以下面每个用例都断言「同步之后」的值。

test('★ 写手**不会**被自动补池 —— 没有池就是没有池', () => {
  // 2026-10-08 用户决策：「删除角色池 → 删了就真没了」。这条正是那次 bug 的根因：
  // 旧的 syncPoolCharacters 会给没有池的写手补一个空池，于是删完立刻又长出来，
  // 用户看到的是「删除按钮彻底失灵」。所以这里**反向**断言：不许补。
  const cfg = fresh([{ id: 'BOT1', name: '归云' }, { id: 'BOT2', name: '洛天' }]);
  C.ensurePools(cfg);
  C.syncPoolCharacters(cfg);

  assert.equal(C.poolOfBot(cfg, 'BOT1'), null, '归云没有池');
  assert.equal(C.poolOfBot(cfg, 'BOT2'), null, '洛天没有池');
  assert.deepEqual(cfg.bots[0].poolIds, [], '派生镜像也是空');
  assert.deepEqual(cfg.bots[1].poolIds, []);
  assert.deepEqual(cfg.bots[0].activeCharacterIds, [], '没有池 = 看不见任何角色');
  // 只剩 ensurePools 兜底的「默认池」（固定 id、无主、空）——它保「至少有一个池」
  // 这条不变量（removePool / 整份 PUT 都靠它），也是历史角色迁入的落点。
  assert.equal(C.listPools(cfg).length, 1);
  assert.equal(C.findPool(cfg, C.DEFAULT_POOL_ID).botId, '', '兜底池无主');
  assert.equal(C.charactersOfBot(cfg, cfg.bots[0]).length, 0, '写手看不到兜底池里的东西');
});

test('★ 删掉写手的专属池后，同步**不会**把它补回来', () => {
  const cfg = fresh([{ id: 'BOT1', name: '归云' }]);
  C.ensurePools(cfg);
  const own = C.createPool(cfg, { name: '归云的池', botId: 'BOT1' });
  C.create(own.characters, { name: '银' }, 'user');
  C.syncPoolCharacters(cfg);
  assert.deepEqual(cfg.bots[0].poolIds, [own.id], '先有池');
  assert.equal(cfg.bots[0].activeCharacterIds.length, 1);

  const r = C.removePool(cfg, own.id, { dropCharacters: true });
  assert.equal(r.ok, true, '有主池也删得掉');
  C.syncPoolCharacters(cfg);
  C.syncPoolCharacters(cfg);      // 连同步两次，看它会不会「长出来」
  assert.equal(C.poolOfBot(cfg, 'BOT1'), null, '删了就真没了');
  assert.deepEqual(cfg.bots[0].poolIds, []);
  assert.deepEqual(cfg.bots[0].activeCharacterIds, []);
  assert.equal(C.listPools(cfg).length, 1, '只剩兜底池');
});

test('★ ensurePoolForBot：按需建池（幂等；已有池原样返回；没这位写手返回 null）', () => {
  const cfg = fresh([{ id: 'BOT1', name: '归云' }, { id: 'BOT2', name: '归云' }]);
  C.ensurePools(cfg);

  const p = C.ensurePoolForBot(cfg, 'BOT1');
  assert.ok(p, '建出来了');
  assert.equal(p.botId, 'BOT1');
  assert.equal(p.name, '归云的池');
  assert.equal(p.characters.length, 0, '是空池');

  assert.equal(C.ensurePoolForBot(cfg, 'BOT1').id, p.id, '幂等：已有池就原样返回');
  assert.equal(C.listPools(cfg).length, 2, '没有多建');

  // 同名写手：第二个不能顶掉第一个，名字要避重
  const p2 = C.ensurePoolForBot(cfg, 'BOT2');
  assert.notEqual(p2.name, p.name, '同名写手也不撞名');
  assert.equal(p2.botId, 'BOT2');

  assert.equal(C.ensurePoolForBot(cfg, ''), null, '空 botId 不建池');
  assert.equal(C.ensurePoolForBot(cfg, 'BOT没有'), null, '写手不存在不建池');
});

test('★ 给没有池的写手建第一个角色：懒建池（ensurePoolForBot）+ 落进那个池', () => {
  // 这条是「按需建池」的实际用法：写手可以没有池，但既然要往里放角色，它非有池不可。
  const cfg = fresh([{ id: 'BOT1', name: '归云' }]);
  C.ensurePools(cfg);
  assert.equal(C.poolOfBot(cfg, 'BOT1'), null);

  const p = C.ensurePoolForBot(cfg, 'BOT1');
  C.create(p.characters, { name: '银' }, 'user');
  C.syncPoolCharacters(cfg);

  assert.equal(C.charactersOfBot(cfg, cfg.bots[0]).length, 1, '写手看到了');
  assert.equal(C.charactersOfBot(cfg, cfg.bots[0])[0].name, '银');
});

test('★ 专属池即批量：池内角色自动进 activeCharacterIds', () => {
  const cfg = fresh([{ id: 'BOT1', name: '归云' }]);
  C.ensurePools(cfg);
  const p = C.createPool(cfg, { name: '归云的池', botId: 'BOT1' });
  const c1 = C.create(p.characters, { name: '银' }, 'user');
  const c2 = C.create(p.characters, { name: '顺顺' }, 'user');

  C.syncPoolCharacters(cfg);
  assert.deepEqual(cfg.bots[0].activeCharacterIds.slice().sort(), [c1.id, c2.id].sort(),
    '池内角色应全部展开到写手身上');
});

test('★ 池里后加的角色，写手同步后也能看到（不是一次性快照）', () => {
  const cfg = fresh([{ id: 'BOT1', name: '归云' }]);
  C.ensurePools(cfg);
  const p = C.createPool(cfg, { name: '归云的池', botId: 'BOT1' });
  C.create(p.characters, { name: '银' }, 'user');
  C.syncPoolCharacters(cfg);
  const before = cfg.bots[0].activeCharacterIds.length;

  const c2 = C.create(p.characters, { name: '新来的' }, 'user');
  C.syncPoolCharacters(cfg);
  assert.equal(cfg.bots[0].activeCharacterIds.length, before + 1);
  assert.ok(cfg.bots[0].activeCharacterIds.includes(c2.id));
});

test('★ 换池即换归属：角色换到别人池里，原写手立刻看不见、新写手看得见', () => {
  const cfg = fresh([{ id: 'BOT1', name: '归云' }, { id: 'BOT2', name: '洛天' }]);
  C.ensurePools(cfg);
  const p1 = C.createPool(cfg, { name: '归云的池', botId: 'BOT1' });
  const p2 = C.createPool(cfg, { name: '洛天的池', botId: 'BOT2' });
  const ch = C.create(p1.characters, { name: '银' }, 'user');
  C.syncPoolCharacters(cfg);
  assert.deepEqual(cfg.bots[0].activeCharacterIds, [ch.id]);
  assert.deepEqual(cfg.bots[1].activeCharacterIds, []);

  C.moveCharacter(cfg, ch.id, p2.id);
  C.syncPoolCharacters(cfg);
  assert.deepEqual(cfg.bots[0].activeCharacterIds, [], '原写手看不见了');
  assert.deepEqual(cfg.bots[1].activeCharacterIds, [ch.id], '新写手看得见了');
  assert.equal(C.allOf(cfg).length, 1, '换池是移动不是复制');
});

test('★ 写手删掉后：它的池变无主，但**角色一个不删**', () => {
  const cfg = fresh([{ id: 'BOT1', name: '归云' }]);
  C.ensurePools(cfg);
  const p = C.createPool(cfg, { name: '归云的池', botId: 'BOT1' });
  const ch = C.create(p.characters, { name: '银' }, 'user');
  C.syncPoolCharacters(cfg);

  cfg.bots = [];                 // 写手被删
  const n = C.syncPoolCharacters(cfg);
  assert.ok(n > 0, '配置被改动了 → 调用方要落盘');
  assert.equal(C.findPool(cfg, p.id).botId, '', '池变无主');
  assert.equal(C.allOf(cfg).length, 1, '角色还在（宁可无主也不静默丢数据）');
  assert.equal(C.findAny(cfg, ch.id).name, '银');
});

test('★ 一位写手却有两个池（历史数据）→ 只留第一个，其余置空不删', () => {
  const cfg = fresh([{ id: 'BOT1', name: '归云' }]);
  cfg.characterPools = [
    { id: 'POOLa', name: 'A', botId: 'BOT1', characters: [] },
    { id: 'POOLb', name: 'B', botId: 'BOT1', characters: [] },
  ];
  C.syncPoolCharacters(cfg);
  assert.equal(C.findPool(cfg, 'POOLa').botId, 'BOT1');
  assert.equal(C.findPool(cfg, 'POOLb').botId, '', '第二个池置空，但池本身留着');
  assert.deepEqual(cfg.bots[0].poolIds, ['POOLa']);
});

test('assignPoolToBot：认领无主池 OK；抢别人的池 / 建第二个池都拒绝', () => {
  const cfg = fresh([{ id: 'BOT1', name: '归云' }, { id: 'BOT2', name: '洛天' }]);
  C.ensurePools(cfg);
  const orphan = C.createPool(cfg, { name: '无主的' });

  assert.equal(C.assignPoolToBot(cfg, orphan.id, 'BOT1').ok, true, '无主池可认领');
  assert.equal(C.poolOfBot(cfg, 'BOT1').id, orphan.id);

  const r2 = C.assignPoolToBot(cfg, orphan.id, 'BOT2');
  assert.equal(r2.ok, false, '已经有主的池不能被抢');
  assert.match(r2.err, /归写手/);

  const orphan2 = C.createPool(cfg, { name: '又一个无主的' });
  const r3 = C.assignPoolToBot(cfg, orphan2.id, 'BOT1');
  assert.equal(r3.ok, false, '一位写手只能有一个池');
  assert.match(r3.err, /已经有专属池/);
});

test('同步会顺手清掉指向已删角色的悬空 id', () => {
  const cfg = fresh([{ id: 'BOT1', name: '异世界' }]);
  C.ensurePools(cfg);
  cfg.bots[0].activeCharacterIds = ['CHR早就删了'];
  C.syncPoolCharacters(cfg);
  assert.deepEqual(cfg.bots[0].activeCharacterIds, [], '派生字段会按池重算，悬空 id 自然消失');
});

test('charSource：1:1 之后任何角色都不能从写手身上单独移除，并报出归属', () => {
  const cfg = fresh([{ id: 'BOT1', name: '归云' }, { id: 'BOT2', name: '洛天' }]);
  C.ensurePools(cfg);
  const mine = C.createPool(cfg, { name: '归云的池', botId: 'BOT1' });
  const theirs = C.createPool(cfg, { name: '洛天的池', botId: 'BOT2' });
  const c1 = C.create(mine.characters, { name: '银' }, 'user');
  const c2 = C.create(theirs.characters, { name: '顺顺' }, 'user');
  const b = cfg.bots[0];

  const s1 = C.charSource(cfg, b, c1.id);
  assert.equal(s1.from, 'pool');
  assert.equal(s1.detachable, false);
  assert.equal(s1.mine, true, '这是它自己池里的角色');
  assert.equal(s1.ownerId, 'BOT1');

  const s2 = C.charSource(cfg, b, c2.id);
  assert.equal(s2.detachable, false, '池外角色也不能「移除」——它本来就不属于这位写手');
  assert.equal(s2.mine, false);
  assert.equal(s2.ownerId, 'BOT2', '面板据此显示「归 洛天」');
});

// ---------- 路由顺序 ----------

test('★ pools 域必须排在 bots 域之前（否则 /api/bots/:id/pools 被截走）', () => {
  const src = require('node:fs').readFileSync(new URL('../lib/http/router.js', import.meta.url), 'utf8');
  const iPools = src.indexOf("'pools'");
  const iBots = src.indexOf("'bots'");
  assert.ok(iPools >= 0 && iBots >= 0);
  assert.ok(iPools < iBots, 'pools 必须声明在 bots 之前');
});
