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

// ---------- 写手绑池 = 批量拿到角色 ----------

test('★ 绑池即批量：池内角色自动进 activeCharacterIds', () => {
  const cfg = fresh([{ id: 'BOT1', name: '异世界' }]);
  C.ensurePools(cfg);
  const p = C.createPool(cfg, { name: '校园组' });
  const c1 = C.create(p.characters, { name: '银' }, 'user');
  const c2 = C.create(p.characters, { name: '顺顺' }, 'user');
  cfg.bots[0].poolIds = [p.id];

  C.syncPoolCharacters(cfg);
  assert.deepEqual(
    cfg.bots[0].activeCharacterIds.slice().sort(),
    [c1.id, c2.id].sort(),
    '池内角色应全部展开到写手身上',
  );
});

test('★ 池里后加的角色，写手同步后也能看到（不是一次性快照）', () => {
  const cfg = fresh([{ id: 'BOT1', name: '异世界' }]);
  C.ensurePools(cfg);
  const p = C.createPool(cfg, { name: '校园组' });
  C.create(p.characters, { name: '银' }, 'user');
  cfg.bots[0].poolIds = [p.id];
  C.syncPoolCharacters(cfg);
  const before = cfg.bots[0].activeCharacterIds.length;

  const c2 = C.create(p.characters, { name: '新来的' }, 'user');
  C.syncPoolCharacters(cfg);
  assert.equal(cfg.bots[0].activeCharacterIds.length, before + 1);
  assert.ok(cfg.bots[0].activeCharacterIds.includes(c2.id));
});

test('解绑池后同步：池内角色从写手身上撤掉，单独添加的不动', () => {
  const cfg = fresh([{ id: 'BOT1', name: '异世界' }]);
  C.ensurePools(cfg);
  const p = C.createPool(cfg, { name: '校园组' });
  const inPool = C.create(p.characters, { name: '银' }, 'user');
  const def = C.listPools(cfg)[0];
  const solo = C.create(def.characters, { name: '独行侠' }, 'user');

  const b = cfg.bots[0];
  b.poolIds = [p.id];
  b.activeCharacterIds = [solo.id];
  C.syncPoolCharacters(cfg);
  assert.ok(b.activeCharacterIds.includes(inPool.id));
  assert.ok(b.activeCharacterIds.includes(solo.id));

  b.poolIds = [];
  C.syncPoolCharacters(cfg);
  assert.equal(b.activeCharacterIds.includes(inPool.id), false, '解绑后池内角色应撤掉');
  assert.ok(b.activeCharacterIds.includes(solo.id), '单独添加的角色必须保留');
});

test('同步会顺手清掉指向已删角色的悬空 id', () => {
  const cfg = fresh([{ id: 'BOT1', name: '异世界' }]);
  C.ensurePools(cfg);
  cfg.bots[0].activeCharacterIds = ['CHR早就删了'];
  C.syncPoolCharacters(cfg);
  assert.deepEqual(cfg.bots[0].activeCharacterIds, []);
});

test('charSource：来自已绑定池的角色不可单独移除', () => {
  const cfg = fresh([{ id: 'BOT1', name: '异世界' }]);
  C.ensurePools(cfg);
  const def = C.listPools(cfg)[0];
  const other = C.createPool(cfg, { name: '别的组' });
  const c1 = C.create(def.characters, { name: '银' }, 'user');
  const c2 = C.create(other.characters, { name: '顺顺' }, 'user');
  const b = cfg.bots[0];
  b.poolIds = [def.id];

  const s1 = C.charSource(cfg, b, c1.id);
  assert.equal(s1.from, 'pool');
  assert.equal(s1.detachable, false, '来自已绑定池 → 不允许单独移除（同步会加回来）');

  const s2 = C.charSource(cfg, b, c2.id);
  assert.equal(s2.from, 'direct');
  assert.equal(s2.detachable, true);
});

// ---------- 路由顺序 ----------

test('★ pools 域必须排在 bots 域之前（否则 /api/bots/:id/pools 被截走）', () => {
  const src = require('node:fs').readFileSync(new URL('../lib/http/router.js', import.meta.url), 'utf8');
  const iPools = src.indexOf("'pools'");
  const iBots = src.indexOf("'bots'");
  assert.ok(iPools >= 0 && iBots >= 0);
  assert.ok(iPools < iBots, 'pools 必须声明在 bots 之前');
});
