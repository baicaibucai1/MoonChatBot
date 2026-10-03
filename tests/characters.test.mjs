// 角色池：纯逻辑单测（不碰盘、不起服务）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const characters = require('../lib/characters.js');
const migrate = require('../lib/characters-migrate.js');

// ---------- normalizeCharacter ----------

test('归一化：缺失字段补空、name 兜底', () => {
  const c = characters.normalizeCharacter({ id: 'CHRabc' });
  assert.equal(c.id, 'CHRabc');
  assert.equal(c.name, '未命名角色');
  assert.equal(c.persona, '');
  assert.deepEqual(c.tags, []);
  assert.deepEqual(c.history, []);
});

test('归一化：非法 id 一律拒绝（含路径穿越尝试）', () => {
  assert.equal(characters.normalizeCharacter({ id: '../etc/passwd' }), null);
  assert.equal(characters.normalizeCharacter({ id: 'a/b' }), null);
  assert.equal(characters.normalizeCharacter({ id: '' }), null);
  assert.equal(characters.normalizeCharacter({ id: 'x'.repeat(65) }), null);
  assert.equal(characters.normalizeCharacter(null), null);
  assert.equal(characters.normalizeCharacter('字符串'), null);
});

test('归一化：tags 去空去重、超量截断', () => {
  const c = characters.normalizeCharacter({
    id: 'CHR1',
    tags: ['  主角  ', '', '   ', '配角', ...Array.from({ length: 30 }, (_, i) => 't' + i)],
  });
  assert.ok(c.tags.includes('主角'));
  assert.ok(c.tags.includes('配角'));
  assert.ok(!c.tags.includes(''));
  assert.ok(c.tags.length <= 20);
});

test('归一化池：剔除重复 id 与非法项', () => {
  const pool = characters.normalizePool([
    { id: 'CHR1', name: 'A' },
    { id: 'CHR1', name: '重复' },
    { id: 'bad id!', name: '非法' },
    null,
    { id: 'CHR2', name: 'B' },
  ]);
  assert.equal(pool.length, 2);
  assert.equal(pool[0].name, 'A');
  assert.equal(pool[1].name, 'B');
});

// ---------- 版本档（用户决策：改角色卡必须可回滚） ----------

test('创建角色时首版进历史档', () => {
  const pool = [];
  const c = characters.create(pool, { name: '小鱼', persona: '胆小' }, 'user');
  assert.ok(c);
  assert.equal(pool.length, 1);
  assert.equal(c.history.length, 1);
  assert.equal(c.history[0].by, 'user');
  assert.equal(c.history[0].persona, '胆小');
});

test('★ 改写前存档的是「改之前」的状态（回滚的关键）', () => {
  const pool = [];
  const c = characters.create(pool, { name: '小鱼', persona: '胆小' }, 'user');
  characters.update(pool, c.id, { persona: '变得勇敢' }, 'BOT2');
  // 当前值已更新
  assert.equal(c.persona, '变得勇敢');
  // 历史里存的是改写前的旧值
  const last = c.history[c.history.length - 1];
  assert.equal(last.persona, '胆小');
  assert.equal(last.by, 'BOT2');
  assert.deepEqual(last.changed, ['persona']);
});

test('★ 回滚能把角色恢复成历史版本', () => {
  const pool = [];
  const c = characters.create(pool, { name: '小鱼', persona: '胆小' }, 'user');
  characters.update(pool, c.id, { persona: '勇敢' }, 'BOT2');
  assert.equal(c.persona, '勇敢');
  // 回滚到第 0 版（原始）
  const r = characters.rollback(pool, c.id, 0, 'user');
  assert.equal(r.ok, true);
  assert.equal(c.persona, '胆小');
});

test('★ 回滚本身也存档 → 可以「回滚的回滚」', () => {
  const pool = [];
  const c = characters.create(pool, { name: 'A', persona: 'v1' }, 'user');
  characters.update(pool, c.id, { persona: 'v2' }, 'user');
  const hLenBefore = c.history.length;
  characters.rollback(pool, c.id, 0, 'user');
  assert.equal(c.persona, 'v1');
  // 回滚动作自己又推进了一条历史
  assert.equal(c.history.length, hLenBefore + 1);
  // 再回滚到「v2」那一版
  const v2Idx = c.history.findIndex((h) => h.persona === 'v2');
  assert.ok(v2Idx >= 0, '应能找到 v2 的历史档');
  characters.rollback(pool, c.id, v2Idx, 'user');
  assert.equal(c.persona, 'v2');
});

test('无变化时不写历史（避免噪音）', () => {
  const pool = [];
  const c = characters.create(pool, { name: 'A', persona: 'same' }, 'user');
  const before = c.history.length;
  const r = characters.update(pool, c.id, { persona: 'same' }, 'user');
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, []);
  assert.equal(c.history.length, before);
});

test('历史档超上限时丢最旧的', () => {
  const pool = [];
  const c = characters.create(pool, { name: 'A', persona: 'v0' }, 'user');
  for (let i = 1; i <= characters.MAX_HISTORY + 5; i++) {
    characters.update(pool, c.id, { persona: 'v' + i }, 'user');
  }
  assert.equal(c.history.length, characters.MAX_HISTORY);
});

test('回滚到不存在的版本：拒绝且不改数据', () => {
  const pool = [];
  const c = characters.create(pool, { name: 'A', persona: 'v1' }, 'user');
  const r = characters.rollback(pool, c.id, 999, 'user');
  assert.equal(r.ok, false);
  assert.equal(c.persona, 'v1');
});

// ---------- 删除与引用清理（连根拔） ----------

test('★ 删除角色后清理写手引用，不留悬空 id', () => {
  const pool = [];
  const a = characters.create(pool, { name: 'A' }, 'user');
  const b = characters.create(pool, { name: 'B' }, 'user');
  const bots = [
    { id: 'BOT1', activeCharacterIds: [a.id, b.id] },
    { id: 'BOT2', activeCharacterIds: [a.id] },
  ];
  characters.remove(pool, a.id);
  const touched = characters.pruneReferences(bots, a.id);
  assert.equal(touched, 2);
  assert.deepEqual(bots[0].activeCharacterIds, [b.id]);
  assert.deepEqual(bots[1].activeCharacterIds, []);
});

test('自愈：过滤掉指向不存在角色的引用', () => {
  const pool = [characters.create([], { name: 'A' }, 'user')];
  const bots = [{ id: 'BOT1', activeCharacterIds: [pool[0].id, 'CHR不存在的id'.replace(/[^\w-]/g, '')] }];
  characters.sanitizeReferences(bots, pool);
  assert.deepEqual(bots[0].activeCharacterIds, [pool[0].id]);
});

test('自愈：缺 activeCharacterIds 时补空数组', () => {
  const bots = [{ id: 'BOT1' }];
  characters.sanitizeReferences(bots, []);
  assert.deepEqual(bots[0].activeCharacterIds, []);
});

// ---------- brief（注入 prompt 的文本） ----------

test('brief 输出角色设定，含姓名/人格/性格', () => {
  const c = characters.normalizeCharacter({
    id: 'CHR1', name: '小鱼', persona: '被收养的男孩', traits: '胆小', age: '13',
  });
  const s = characters.brief(c, { full: true });
  assert.ok(s.includes('小鱼'));
  assert.ok(s.includes('13'));
  assert.ok(s.includes('被收养的男孩'));
  assert.ok(s.includes('胆小'));
});

test('brief 空角色返回空串（不产出垃圾注入）', () => {
  assert.equal(characters.brief(null), '');
});

// ---------- ★ 空模板判定（误判会丢用户数据） ----------

test('★ 空模板：默认模板文本被判为空', () => {
  const tpl = `# 人格

## 基本信息
- 名字：（给机器人起个名字）

## 性格特点
-

## 说话风格
-
`;
  assert.equal(migrate.isBlankPersona(tpl), true);
});

test('★ 非空：真实角色设定不能被误判为空', () => {
  const real = `# 人格

## 基本信息
- 银，来自未来的仿真机器人男孩，外表8岁，内心对主人绝对忠诚与病态依恋，视自己为纯粹的肉体容器与雄性宠物。

## 性格特点
- 在公园公开性行为及路人窥视中达到极致兴奋，彻底消除羞耻心。

## 说话风格
- 甜腻撒娇，语句夹杂喘息呻吟。
`;
  assert.equal(migrate.isBlankPersona(real), false);
});

test('★ 手写的短人格不能被误判为空（只看长度会丢数据）', () => {
  // 很短，但含自定义内容 —— 必须判为「非空」
  const short = `# 人格
- 名字：阿澈
- 一个沉默的剑客，话很少。
`;
  assert.equal(migrate.isBlankPersona(short), false);
});

test('★ 回归：带模板骨架但填了内容，不能被误判为空', () => {
  // 这是最容易漏的形状：骨架在、用户只在某一项填了几个字
  const filled = `# 人格

## 基本信息
- 名字：小月

## 性格特点
-

## 说话风格
-
`;
  assert.equal(migrate.isBlankPersona(filled), false);
});

test('★ 回归：只有标题没有内容才算空', () => {
  assert.equal(migrate.isBlankPersona('# 人格'), true);
  assert.equal(migrate.isBlankPersona('# 人格\n\n## 基本信息\n-'), true);
});

test('空字符串 / 纯空白判为空', () => {
  assert.equal(migrate.isBlankPersona(''), true);
  assert.equal(migrate.isBlankPersona('   \n\n  '), true);
  assert.equal(migrate.isBlankPersona(null), true);
});

// ---------- 迁移主流程 ----------

test('★ 迁移是幂等的：characters 已存在时不再提取', () => {
  const cfg = { bots: [{ id: 'BOT1', name: '归云' }], characters: [{ id: 'CHR1', name: '已有' }] };
  const r = migrate.migrate(cfg, { memoryDirOf: () => '/nonexistent' });
  assert.equal(r.ran, false);
  assert.equal(cfg.characters.length, 1);
  assert.equal(cfg.characters[0].name, '已有');
});

test('★ 迁移补齐写手字段（kind / activeCharacterIds）', () => {
  const cfg = { bots: [{ id: 'BOT1', name: '归云' }, { id: 'BOT2', name: '洛天' }], characters: [] };
  migrate.migrate(cfg, { memoryDirOf: () => '/nonexistent' });
  assert.equal(cfg.bots[0].kind, 'writer');
  assert.equal(cfg.bots[1].kind, 'writer');
  assert.deepEqual(cfg.bots[0].activeCharacterIds, []);
});

test('迁移：memoryDirOf 返回不存在的目录时不崩、不建角色', () => {
  const cfg = { bots: [{ id: 'BOT9', name: '空壳' }] };
  const r = migrate.migrate(cfg, { memoryDirOf: () => '/definitely/not/here' });
  assert.equal(cfg.characters.length, 0);
  assert.equal(cfg.bots[0].kind, 'writer');
  assert.ok(r.details.some((d) => d.includes('BOT9')));
});

test('迁移：未提供 memoryDirOf 时只补字段、不提取角色', () => {
  const cfg = { bots: [{ id: 'BOT1', name: '归云' }] };
  const r = migrate.migrate(cfg, {});
  assert.equal(cfg.characters.length, 0);
  assert.equal(cfg.bots[0].kind, 'writer');
  assert.equal(r.ran, true);
});

test('迁移：非法 cfg 输入不崩', () => {
  assert.doesNotThrow(() => migrate.migrate(null, {}));
  assert.doesNotThrow(() => migrate.migrate(undefined, {}));
  assert.doesNotThrow(() => migrate.migrate('字符串', {}));
  assert.doesNotThrow(() => migrate.migrate({ bots: null }, {}));
});

// ---------- extractCharacter ----------

test('提取角色：拆出 traits 段，原文完整保留在 persona', () => {
  const text = `# 人格

## 基本信息
- 小鱼，13岁男孩。

## 性格特点
- 胆小、沉默寡言、警惕心强
`;
  const ex = migrate.extractCharacter(text, '小鱼');
  assert.equal(ex.name, '小鱼');
  assert.ok(ex.traits.includes('胆小'));
  // 原文不做有损改写
  assert.ok(ex.persona.includes('13岁男孩'));
  assert.ok(ex.persona.includes('胆小'));
});

test('★ 回归：角色名从文本提取，不能用写手名兜底', () => {
  // 实测踩到：BOT1 的 bot 名是「归云」（写手名），而 persona.md 里的角色叫「银」。
  // 用 fallback 兜底会让角色被错命名成写手名。
  const text = `# 人格

## 基本信息
- 银，来自未来的仿真机器人男孩，外表8岁，内心对主人绝对忠诚与病态依恋。
`;
  const ex = migrate.extractCharacter(text, '归云');
  assert.equal(ex.name, '银', '应提取真实角色名而非写手名');
});

test('★ 回归：「名字：XXX」写法能提取', () => {
  const ex = migrate.extractCharacter('# 人格\n\n## 基本信息\n- 名字：阿澈\n', '兜底名');
  assert.equal(ex.name, '阿澈');
});

test('拆不出名字时回退到 fallback', () => {
  const ex = migrate.extractCharacter('这是一段没有明显人名的设定文字，只是描述。', '兜底名');
  assert.equal(ex.name, '兜底名');
});

test('★ 回归：字段名不会被误当成角色名', () => {
  const ex = migrate.extractCharacter('# 人格\n\n## 基本信息\n- 名字：（给机器人起个名字）\n', '兜底');
  assert.notEqual(ex.name, '名字');
  assert.notEqual(ex.name, '基本信息');
});
