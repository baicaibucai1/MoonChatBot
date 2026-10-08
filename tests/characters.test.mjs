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

test('★ 回归：traits 已包含在 persona 里时不重复输出', () => {
  // 实测踩到：迁移时 persona 存原文全文、traits 存从其中抽出的性格段，
  // 两个都输出会让同一段性格在 prompt 里出现两遍。
  const text = `# 人格

## 基本信息
- 银，8岁机器人男孩。

## 性格特点
- 病态依恋主人
`;
  const c = characters.normalizeCharacter({
    id: 'CHR1', name: '银',
    persona: text,
    traits: '- 病态依恋主人',
  });
  const s = characters.brief(c);
  // 「病态依恋主人」只能出现一次
  const count = (s.match(/病态依恋主人/g) || []).length;
  assert.equal(count, 1, `重复输出 ${count} 次`);
});

test('traits 提供了 persona 里没有的信息时仍要输出', () => {
  const c = characters.normalizeCharacter({
    id: 'CHR1', name: '银',
    persona: '一个机器人男孩。',
    traits: '极度依恋主人，怕被抛弃',
  });
  const s = characters.brief(c);
  assert.ok(s.includes('怕被抛弃'), 'traits 的独有信息必须保留');
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
  assert.equal(characters.allOf(cfg).length, 1);
  assert.equal(characters.allOf(cfg)[0].name, '已有');
});

// ★★ 回归：走「已经迁过写手卡」这条早退分支时，也必须报告 persist。
//   真实事故：这条分支原先只改内存、不回话给调用方，server.js 于是不落盘；
//   而 store.getConfig() 每次都重新读盘 → 这次内存里造的「默认池」下一读就没了，
//   池 id 每请求一换，绑池立刻失效。persist=false 就是这个 bug 的开关。
test('★ 已迁过写手卡时：单池→多池仍要报告 persist（否则不落盘、池 id 每次都飘）', () => {
  const cfg = {
    bots: [{ id: 'BOT1', name: '归云', kind: 'writer', activeCharacterIds: [], poolIds: [] }],
    characters: [{ id: 'CHR1', name: '银' }],
  };
  const r = migrate.migrate(cfg, { memoryDirOf: () => '/nonexistent' });
  assert.equal(r.ran, false, '不是首次迁移');
  assert.equal(r.persist, true, '★ 改了配置就必须让调用方落盘');
  assert.equal(Array.isArray(cfg.characterPools), true);
  assert.equal('characters' in cfg, false);
});

test('★ 配置已经齐备时 persist=false（别每次启动都白写一遍盘）', () => {
  const cfg = {
    bots: [{ id: 'BOT1', name: '归云', kind: 'writer', activeCharacterIds: ['CHR1'], poolIds: [], poolCharacterIds: [] }],
    characterPools: [{ id: 'POOLdefault', name: '默认池', characters: [{ id: 'CHR1', name: '银' }] }],
  };
  const r = migrate.migrate(cfg, { memoryDirOf: () => '/nonexistent' });
  assert.equal(r.ran, false);
  assert.equal(r.persist, false);
});

// ★★ 回归（2026-10-08）：早退分支里「收编残留旧字段」也必须报告 persist，
//   否则收编只活在这份内存对象里 —— 下一次 store.getConfig() 读盘，
//   残留的 characters 又回来了，每请求收编一次，永远不落盘、日志一直响。
test('★ 收编残留的旧 characters 时也要报告 persist 并写进 details', () => {
  const cfg = {
    bots: [{ id: 'BOT1', name: '归云', kind: 'writer', activeCharacterIds: [], poolIds: [], poolCharacterIds: [] }],
    characterPools: [{ id: 'POOLdefault', name: '默认池', characters: [{ id: 'CHR1', name: '银' }] }],
    characters: [{ id: 'CHR2', name: '残留角色' }],
  };
  const r = migrate.migrate(cfg, { memoryDirOf: () => '/nonexistent' });
  assert.equal(r.ran, false, '不是首次迁移');
  assert.equal(r.persist, true, '收编改动了配置 → 必须落盘');
  assert.equal('characters' in cfg, false, '旧字段被摘掉');
  assert.equal(characters.allOf(cfg).length, 2, '残留角色进了池，没丢');
  assert.match(r.details.join('\n'), /残留/, '细节里要说明发生了什么（以前是静默的）');
});

test('★ 首次迁移也报告 persist=true', () => {
  const cfg = { bots: [{ id: 'BOT1', name: '归云' }] };
  const r = migrate.migrate(cfg, {});
  assert.equal(r.ran, true);
  assert.equal(r.persist, true);
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
  assert.equal(characters.allOf(cfg).length, 0);
  assert.equal(cfg.bots[0].kind, 'writer');
  assert.ok(r.details.some((d) => d.includes('BOT9')));
});

test('迁移：未提供 memoryDirOf 时只补字段、不提取角色', () => {
  const cfg = { bots: [{ id: 'BOT1', name: '归云' }] };
  const r = migrate.migrate(cfg, {});
  assert.equal(characters.allOf(cfg).length, 0);
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

// ---------- buildEditPatch：写手工具参数 → 合法 patch ----------
// 这段是「写手改角色卡」的入口过滤，弄错就会出安全问题（能改 id/history）
// 或体验问题（生成一条空建议让用户白点一次确认）。

test('buildEditPatch：白名单外的键一律丢弃（防伪造版本档）', () => {
  const p = characters.buildEditPatch({
    id: 'CHRfake', history: [{ by: 'ai' }], source: '伪造来源', ts: 1,
    persona: '新设定',
  });
  assert.deepEqual(Object.keys(p), ['persona']);
  assert.equal(p.id, undefined);
  assert.equal(p.history, undefined);
});

test('buildEditPatch：avatar 默认禁改（图片归形象库阶段）', () => {
  const p = characters.buildEditPatch({ avatar: 'x.png', traits: '冷静' });
  assert.equal(p.avatar, undefined);
  assert.equal(p.traits, '冷静');
});

test('buildEditPatch：可显式放开被禁字段', () => {
  const p = characters.buildEditPatch({ avatar: 'x.png' }, { deny: [] });
  assert.equal(p.avatar, 'x.png');
});

test('buildEditPatch：null / undefined 视为「未提供」而非「清空」', () => {
  // ★ 区别很重要：模型没提的字段不该被清掉，否则改一项会误伤其他项
  const p = characters.buildEditPatch({ persona: 'A', traits: null, age: undefined });
  assert.deepEqual(Object.keys(p), ['persona']);
});

test('buildEditPatch：空字符串是有效值（允许显式清空）', () => {
  const p = characters.buildEditPatch({ traits: '' });
  assert.deepEqual(Object.keys(p), ['traits']);
  assert.equal(p.traits, '');
});

test('buildEditPatch：没有任何可改字段时返回空对象（上层据此回绝）', () => {
  assert.deepEqual(characters.buildEditPatch({}), {});
  assert.deepEqual(characters.buildEditPatch(null), {});
  assert.deepEqual(characters.buildEditPatch({ reason: '只是想说点什么' }), {});
});

// ---------- 提议 → 确认 的语义：提议阶段绝不能改到池子 ----------

test('★ 不变量：提议阶段不落盘（patch 是独立副本，改它不影响角色）', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银', persona: '原始设定' }, 'user');
  const patch = characters.buildEditPatch({ persona: '改写后的设定' });
  // 仅构造建议：没有调 update → 角色必须纹丝不动
  assert.equal(characters.find(pool, c.id).persona, '原始设定');
  assert.equal(c.history.length, 1, '提议不产生版本档');
  // 用户点了确认后才会走到 update
  const r = characters.update(pool, c.id, patch, 'ai');
  assert.equal(r.ok, true);
  assert.equal(characters.find(pool, c.id).persona, '改写后的设定');
  assert.equal(c.history.length, 2, '确认写入才产生版本档');
});

test('★ 确认写入后能一路回滚到 AI 改写前', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银', persona: '原始设定' }, 'user');
  characters.update(pool, c.id, { persona: 'AI 改写版' }, 'ai');
  // history[0] 是「改之前」的快照
  const rb = characters.rollback(pool, c.id, 0, 'user');
  assert.equal(rb.ok, true);
  assert.equal(characters.find(pool, c.id).persona, '原始设定');
});

test('★ 版本档记录改写者（by=ai），用户能看出是谁动的', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  characters.update(pool, c.id, { traits: 'AI 加的' }, 'ai');
  const last = c.history[c.history.length - 1];
  assert.equal(last.by, 'ai');
  assert.deepEqual(last.changed, ['traits']);
});

// ================= 经历与计数器（用户决策 2026-10-04）=================
// 设计见《经历与计数器机制.md》：经历的产生地在写手，落点在角色卡，
// 中间必须过「用户确认」；计数器「同名共享、异名不引用」。

// ---------- 归一化 ----------

test('normalizeCounters：只留数字，丢非数字 / 空名', () => {
  const c = characters.normalizeCounters({ 好感度: 5, 仇恨: '不是数', '': 1, 信赖: '3' });
  assert.deepEqual(c, { 好感度: 5, 信赖: 3 });
});

test('normalizeCounters：非对象输入一律给空表（不能崩）', () => {
  assert.deepEqual(characters.normalizeCounters(null), {});
  assert.deepEqual(characters.normalizeCounters([]), {});
  assert.deepEqual(characters.normalizeCounters('字符串'), {});
});

test('normalizeCounters：超长名截断、超量条目丢弃', () => {
  const long = characters.normalizeCounters({ ['名'.repeat(40)]: 1 });
  assert.equal(Object.keys(long)[0].length, characters.MAX_COUNTER_NAME);
  const many = {};
  for (let i = 0; i < characters.MAX_COUNTERS + 10; i++) many['c' + i] = i;
  assert.equal(Object.keys(characters.normalizeCounters(many)).length, characters.MAX_COUNTERS);
});

test('normalizeExperiences：空文本丢弃、缺 id 自动补、文本超长截断', () => {
  const list = characters.normalizeExperiences([
    { text: '   ' },
    { text: '在渡口与老张结盟' },
    { text: 'x'.repeat(999), id: 'EXPaaa' },
    null, '字符串',
  ]);
  assert.equal(list.length, 2);
  assert.ok(list[0].id.startsWith('EXP'));
  assert.equal(list[1].text.length, 500);
});

test('normalizeExperiences：重复 id 会被重新分配（id 必须唯一，删除靠它定位）', () => {
  const list = characters.normalizeExperiences([
    { id: 'EXPsame', text: 'A' },
    { id: 'EXPsame', text: 'B' },
  ]);
  assert.notEqual(list[0].id, list[1].id);
});

test('normalizeExperiences：超过上限丢最老的（源头在写手侧，不算丢数据）', () => {
  const raw = [];
  for (let i = 0; i < characters.MAX_EXPERIENCES + 5; i++) raw.push({ text: 'E' + i });
  const list = characters.normalizeExperiences(raw);
  assert.equal(list.length, characters.MAX_EXPERIENCES);
  assert.equal(list[0].text, 'E5');
  assert.equal(list[list.length - 1].text, 'E' + (characters.MAX_EXPERIENCES + 4));
});

test('normalizeCharacter：counters / experiences 被带进角色对象', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1', counters: { 好感度: 5 }, experiences: [{ text: 'x' }] });
  assert.deepEqual(c.counters, { 好感度: 5 });
  assert.equal(c.experiences.length, 1);
});

// ---------- ★★ 同名共享 / 异名不引用 ----------

test('★ 同名共享：两位写手声明同名计数器 → 读写同一格', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  const names = ['好感度'];   // 两位写手的声明相同
  characters.commitExperience(pool, c.id, { text: 'A 的剧情', counters: characters.filterDeclared({ 好感度: 3 }, names) });
  characters.commitExperience(pool, c.id, { text: 'B 的剧情', counters: characters.filterDeclared({ 好感度: 4 }, names) });
  const cur = characters.find(pool, c.id);
  assert.equal(cur.counters['好感度'], 7, '增量累加，不是覆盖');
  assert.deepEqual(characters.declaredView(cur, names), { 好感度: 7 });
});

test('★★ 异名不引用：声明「仇恨」的写手动不了「好感度」', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  characters.commitExperience(pool, c.id, { text: 'x', counters: characters.filterDeclared({ 好感度: 5 }, ['好感度']) });
  // B 声明的是「仇恨」，即使参数里混进了「好感度」也会被过滤掉
  const patch = characters.filterDeclared({ 好感度: 999, 仇恨: 2 }, ['仇恨']);
  assert.deepEqual(patch, { 仇恨: 2 });
  characters.commitExperience(pool, c.id, { text: 'y', counters: patch });
  const cur = characters.find(pool, c.id);
  assert.equal(cur.counters['好感度'], 5, '别家声明的计数器纹丝不动');
  assert.equal(cur.counters['仇恨'], 2);
});

test('declaredView：声明了但没设过 → 按 0 显示（不是 undefined）', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1' });
  assert.deepEqual(characters.declaredView(c, ['好感度']), { 好感度: 0 });
});

test('declaredView：传进来的名字去空格、空名忽略', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1', counters: { 好感度: 2 } });
  assert.deepEqual(characters.declaredView(c, [' 好感度 ', '']), { 好感度: 2 });
});

test('filterDeclared：非数字的增量被丢掉', () => {
  assert.deepEqual(characters.filterDeclared({ 好感度: 'abc' }, ['好感度']), {});
});

// ---------- ★★ counterNamesFor：角色卡正文声明 ∪ 写手声明 ----------
//
// 用户决策 2026-10-08：「角色的计数器应该是绑定在角色身上的，但是写手可以根据提示词的
// 计数器创建计数器」→ 角色卡正文的 `##Counter：名字[范围]` **本身就是一处声明**，
// 权限不能再只认写手那一份。下面第一条就是当初那个 bug 的回归测试。

test('★ counterNamesFor：角色卡声明 + 写手没声明 → 仍然有权改（回归：原先被静默丢掉）', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1', persona: '##Counter：好感度[0,100]' });
  const allow = characters.counterNamesFor(c, []);       // 写手一个字都没声明
  assert.deepEqual(allow, ['好感度'], '卡上写了就算数，写手不必再抄一遍');

  // 权限生效的三个后果，缺一不可：
  assert.deepEqual(characters.declaredView(c, allow), { 好感度: 0 }, '① 看得见（没记过 → 0）');
  assert.deepEqual(characters.filterDeclared({ 好感度: 10 }, allow), { 好感度: 10 }, '② 提议不再被丢');
  const s = characters.stateBrief(c, allow);
  assert.ok(s.includes('好感度'), '③ 提示词里真的出现了');
});

test('counterNamesFor：两处取并集，角色卡在前、去重、去空格', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1', persona: '##Counter：好感度[0,100]' });
  assert.deepEqual(
    characters.counterNamesFor(c, [' 好感度 ', '', '理智', '理智']),
    ['好感度', '理智'],
  );
});

test('counterNamesFor：卡上没写、写手也没声明 → 空（安全的一侧）', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1', persona: '普通人格，没有计数器' });
  assert.deepEqual(characters.counterNamesFor(c, []), []);
  assert.deepEqual(characters.counterNamesFor(c, undefined), []);
});

test('counterNamesFor：写手单独声明（卡上没写）这条路仍然通 —— 老配置全靠它', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1', persona: '普通人格' });
  assert.deepEqual(characters.counterNamesFor(c, ['剑术']), ['剑术']);
});

test('counterNamesFor：范围以角色卡为准 —— 同名的写手声明不覆盖卡的 spec', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1', persona: '##Counter：好感度[0,10]' });
  // 名字来自并集，但 counterSpecsFor 是另一件事：这里只验证名字集合不会把范围带歪
  const specs = characters.characterCounterSpecs(c);
  assert.equal(characters.findCounterSpec(specs, '好感度').max, 10);
  assert.deepEqual(characters.counterNamesFor(c, ['好感度']), ['好感度']);
});

test('★★ counterNamesFor 是「按角色」算的：池外角色拿不到卡上声明的名字', () => {
  // list_characters 里池外角色只传 declared，避免变成偷看别家私有计数器的窗口。
  const mine = characters.normalizeCharacter({ id: 'CHR1', persona: '##Counter：好感度[0,100]' });
  const other = characters.normalizeCharacter({ id: 'CHR2', persona: '##Counter：秘密[0,100]' });
  assert.deepEqual(characters.counterNamesFor(mine, []), ['好感度']);
  assert.deepEqual(characters.counterNamesFor(other, []), ['秘密'],
    '函数本身会认；是否调用由调用点按「这位写手选没选定这个角色」决定');
  // 调用点的口径：池外的只传写手声明 → 「秘密」被挡在外面
  assert.deepEqual(characters.filterDeclared({ 秘密: 5 }, []), {});
});

// ---------- 写手声明从哪来 ----------

test('parseDeclaredCounters：解析「含『计数』标题」的小节', () => {
  const md = [
    '# 写手设定', '',
    '## 语气', '- 冷淡', '',
    '## 计数器',
    '- 好感度：范围 0–100，初次见面 0，被善待时 +1~3',
    '- 信任度：范围 0–100',
    '',
    '## 其他', '- 好感度：这行不该被算进来',
  ].join('\n');
  assert.deepEqual(characters.parseDeclaredCounters(md), ['好感度', '信任度']);
});

test('parseDeclaredCounters：没有计数器小节 → 空数组（写手就动不了任何计数器）', () => {
  assert.deepEqual(characters.parseDeclaredCounters('# 写手设定\n## 语气\n- 冷淡'), []);
  assert.deepEqual(characters.parseDeclaredCounters(''), []);
  assert.deepEqual(characters.parseDeclaredCounters(null), []);
});

test('parseDeclaredCounters：标题词 / 说明行不算计数器名', () => {
  const md = '## 计数器\n- 规则：以下为角色状态\n- 说明：随时可改';
  assert.deepEqual(characters.parseDeclaredCounters(md), []);
});

test('parseDeclaredCounters：剥掉名字上的引号', () => {
  assert.deepEqual(characters.parseDeclaredCounters('## 计数器\n- 「好感度」：0–100'), ['好感度']);
});

// ---------- ★ 计数器新语法：##Counter：名字[范围] ----------

test('parseCounterSpecs：基本语法（## 后有无空格都认，全角/半角冒号都认）', () => {
  const md = [
    '# 角色：银',
    '##Counter：好感度[0,100]',
    '## Counter：信任[0,100]',
    '##counter: 秘密[]',
    '##Counter：羁绊',
  ].join('\n');
  const specs = characters.parseCounterSpecs(md);
  assert.deepEqual(specs.map((s) => s.name), ['好感度', '信任', '秘密', '羁绊']);
  assert.deepEqual([specs[0].min, specs[0].max], [0, 100]);
  assert.equal(specs[2].min, null, '[] 留空 = 不限');
  assert.equal(specs[2].max, null);
  assert.equal(specs[3].min, null, '不写方括号 = 不限');
  assert.equal(specs[3].max, null);
});

test('parseCounterSpecs：范围写法宽容（波浪线/连字符/中文逗号/负数/单点）', () => {
  assert.deepEqual(characters.parseCounterRange('0~100'), { min: 0, max: 100 });
  assert.deepEqual(characters.parseCounterRange('0-100'), { min: 0, max: 100 });
  assert.deepEqual(characters.parseCounterRange('0，100'), { min: 0, max: 100 });
  assert.deepEqual(characters.parseCounterRange('0–100'), { min: 0, max: 100 });
  assert.deepEqual(characters.parseCounterRange('-10~10'), { min: -10, max: 10 });
  assert.deepEqual(characters.parseCounterRange('-10-10'), { min: -10, max: 10 });
  assert.deepEqual(characters.parseCounterRange('100'), { min: null, max: 100 }, '单值 = 上限');
  assert.deepEqual(characters.parseCounterRange(''), { min: null, max: null });
  assert.deepEqual(characters.parseCounterRange('120,0'), { min: 0, max: 120 }, '写反了自动纠正');
});

test('parseCounterSpecs：名字后面可以跟说明，说明不进名字', () => {
  const specs = characters.parseCounterSpecs('##Counter：理智[0,100] 低于 20 会失控');
  assert.equal(specs.length, 1);
  assert.equal(specs[0].name, '理智');
  assert.equal(specs[0].desc, '低于 20 会失控');
});

test('parseCounterSpecs：`##Counter` 行优先于旧「## 计数器」小节', () => {
  const md = '## 计数器\n- 旧写法：0-100\n##Counter：好感度[0,100]';
  assert.deepEqual(characters.parseDeclaredCounters(md), ['好感度'], '新语法赢了就只认新的');
});

test('characterCounterSpecs：persona / 背景 / 外表 任一一处写的都能扫到', () => {
  const c = characters.normalizeCharacter({
    id: 'CHR1',
    persona: '##Counter：好感度[0,100]',
    background: '##Counter：声望[]',
    appearance: '##Counter：伤痕[0,10]',
  });
  const specs = characters.characterCounterSpecs(c);
  assert.deepEqual(specs.map((s) => s.name), ['好感度', '声望', '伤痕']);
  assert.equal(characters.findCounterSpec(specs, '好感度').max, 100);
  assert.equal(characters.findCounterSpec(specs, '声望').max, null);
  assert.equal(characters.findCounterSpec(specs, '不存在'), null);
});

test('clampCounterValue：越界收敛到边界，没越界就原样通过', () => {
  const spec = { name: '好感度', min: 0, max: 100 };
  assert.deepEqual(characters.clampCounterValue(spec, 130), { value: 100, clamped: true, min: 0, max: 100 });
  assert.deepEqual(characters.clampCounterValue(spec, -5), { value: 0, clamped: true, min: 0, max: 100 });
  assert.deepEqual(characters.clampCounterValue(spec, 60), { value: 60, clamped: false, min: 0, max: 100 });
  assert.equal(characters.clampCounterValue(null, 9999).clamped, false, '没有规格 = 不限');
});

test('projectCounters：增量按范围收敛，且与实际落盘用的是同一套算法', () => {
  const specs = [{ name: '好感度', min: 0, max: 100 }];
  const { applied, clamped } = characters.projectCounters({ 好感度: 95 }, { 好感度: 20 }, specs);
  assert.deepEqual(applied, { 好感度: 5 }, '95 + 20 越过 100 → 只加 5');
  assert.equal(clamped.length, 1);
  assert.equal(clamped[0].want, 115);
  assert.equal(clamped[0].value, 100);
});

test('commitExperience：带 specs 时把结果压回范围，applied 报的是**实际生效**的增量', () => {
  const pool = [];
  const c = characters.create(pool, { id: 'CHR1', name: '银', persona: '##Counter：好感度[0,100]' }, 'user');
  const specs = characters.characterCounterSpecs(c);
  const r = characters.commitExperience(pool, c.id, { text: '被救了一次', counters: { 好感度: 200 } }, specs);
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, { 好感度: 100 }, '0 + 200 → 收敛到 100');
  assert.equal(r.clamped.length, 1);
  assert.equal(r.clamped[0].value, 100);
  assert.equal(characters.find(pool, c.id).counters.好感度, 100);
  // 经历条目上记的也是实际增量，不能记成 200
  assert.deepEqual(r.entry.counters, { 好感度: 100 });
});

test('setCounter：绝对值同样按范围收敛（管理员面板/接口直接打也逃不掉）', () => {
  const pool = [];
  const c = characters.create(pool, { id: 'CHR1', name: '银', persona: '##Counter：好感度[0,50]' }, 'user');
  const specs = characters.characterCounterSpecs(c);
  const r = characters.setCounter(pool, c.id, '好感度', 80, specs);
  assert.equal(r.after, 50);
  assert.equal(r.clamped.length, 1);
  assert.equal(characters.find(pool, c.id).counters.好感度, 50);
});

test('describeCounterSpec / describeCounterRange：可读形式', () => {
  assert.equal(characters.describeCounterSpec({ name: '好感度', min: 0, max: 100 }), '好感度（0~100）');
  assert.equal(characters.describeCounterSpec({ name: '秘密', min: null, max: null }), '秘密（不限）');
  assert.equal(characters.describeCounterRange({ min: null, max: 100 }), '≤100');
  assert.equal(characters.describeCounterRange({ min: 0, max: null }), '≥0');
});

// ---------- 沉淀经历 ----------

test('commitExperience：增量累加计数器 + 追加一条经历（带 by）', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  characters.commitExperience(pool, c.id, { text: '第一次', counters: { 好感度: 5 }, by: 'BOT1' });
  const r = characters.commitExperience(pool, c.id, { text: '第二次', counters: { 好感度: 3 }, by: 'BOT1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, { 好感度: 3 }, 'applied 报的是增量');
  const cur = characters.find(pool, c.id);
  assert.equal(cur.counters['好感度'], 8);
  assert.equal(cur.experiences.length, 2);
  assert.equal(cur.experiences[1].by, 'BOT1');
  assert.deepEqual(cur.experiences[1].counters, { 好感度: 3 });
});

test('commitExperience：只给计数器不给正文 → 改值但**不**留经历条目', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  const r = characters.commitExperience(pool, c.id, { counters: { 好感度: -2 } });
  assert.equal(r.ok, true);
  assert.equal(r.entry, null);
  assert.equal(characters.find(pool, c.id).counters['好感度'], -2, '计数器允许负数');
  assert.equal(characters.find(pool, c.id).experiences.length, 0);
});

test('commitExperience：正文与计数器都空 → 回绝（不写空条目）', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  const r = characters.commitExperience(pool, c.id, { text: '   ', counters: {} });
  assert.equal(r.ok, false);
  assert.equal(characters.find(pool, c.id).experiences.length, 0);
});

test('commitExperience：角色不存在 → 报错而不是新建', () => {
  const pool = [];
  assert.equal(characters.commitExperience(pool, 'CHRnone', { text: 'x' }).ok, false);
});

test('★ counters / experiences 不进版本档（流水塞进去会冲垮 MAX_HISTORY）', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  characters.commitExperience(pool, c.id, { text: '第一次', counters: { 好感度: 5 } });
  characters.update(pool, c.id, { persona: '改过设定' }, 'user');
  const cur = characters.find(pool, c.id);
  const snap = cur.history[cur.history.length - 1];
  assert.equal(snap.counters, undefined);
  assert.equal(snap.experiences, undefined);
  // 但角色卡上确实带着这两样
  assert.equal(cur.counters['好感度'], 5);
  assert.equal(cur.experiences.length, 1);
});

// ---------- 管理员侧的计数器 / 经历读写 ----------

test('setCounter：写绝对值，并回报改前改后', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  characters.commitExperience(pool, c.id, { counters: { 好感度: 5 } });
  const r = characters.setCounter(pool, c.id, '好感度', 35);
  assert.equal(r.ok, true);
  assert.equal(r.before, 5);
  assert.equal(r.after, 35);
  assert.equal(characters.find(pool, c.id).counters['好感度'], 35);
});

test('setCounter：值不是数字 / 名字为空 → 回绝', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  assert.equal(characters.setCounter(pool, c.id, '好感度', 'abc').ok, false);
  assert.equal(characters.setCounter(pool, c.id, '', 1).ok, false);
  assert.deepEqual(characters.find(pool, c.id).counters, {});
});

test('removeCounter：删得掉；删不存在的报错', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  characters.setCounter(pool, c.id, '好感度', 1);
  assert.equal(characters.removeCounter(pool, c.id, '好感度').ok, true);
  assert.deepEqual(characters.find(pool, c.id).counters, {});
  assert.equal(characters.removeCounter(pool, c.id, '好感度').ok, false);
});

test('appendExperience：只加经历不动计数器', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  characters.setCounter(pool, c.id, '好感度', 7);
  const r = characters.appendExperience(pool, c.id, { text: '在渡口与老张结盟', by: 'admin' });
  assert.equal(r.ok, true);
  assert.equal(r.entry.by, 'admin');
  assert.equal(characters.find(pool, c.id).counters['好感度'], 7);
  assert.equal(characters.find(pool, c.id).experiences.length, 1);
});

test('appendExperience：空文本回绝', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  assert.equal(characters.appendExperience(pool, c.id, { text: ' ' }).ok, false);
});

test('removeExperience：按 id 删（同毫秒的两条也不会误伤）', () => {
  const pool = [];
  const c = characters.create(pool, { name: '银' }, 'user');
  const a = characters.appendExperience(pool, c.id, { text: 'A' }).entry;
  const b = characters.appendExperience(pool, c.id, { text: 'B' }).entry;
  assert.notEqual(a.id, b.id);
  assert.equal(characters.removeExperience(pool, c.id, a.id).ok, true);
  const left = characters.find(pool, c.id).experiences;
  assert.equal(left.length, 1);
  assert.equal(left[0].text, 'B');
  assert.equal(characters.removeExperience(pool, c.id, a.id).ok, false);
});

// ---------- 给写手的 prompt 文本 ----------

test('stateBrief：只显示允许名单里的计数器（名单外的别家私有值不出现）', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1', name: '银', counters: { 好感度: 5, 别家的: 99 } });
  const s = characters.stateBrief(c, ['好感度']);
  assert.ok(s.includes('好感度 5'));
  assert.ok(!s.includes('别家的'));
});

test('stateBrief：名单为空但卡上有值 → 明确说「不归你管」，并指出两处声明处', () => {
  const c = characters.normalizeCharacter({ id: 'CHR1', name: '银', counters: { 好感度: 5 } });
  const s = characters.stateBrief(c, []);
  assert.ok(!s.includes('好感度'), '名字本身不出现');
  assert.ok(s.includes('不显示、也不改动计数'), '明确告诉它别去猜');
  assert.ok(s.includes('##Counter：'), '告诉它怎么启用（角色卡正文写一行）');
});

test('stateBrief：带出最近经历，且只取最后 N 条', () => {
  const c = characters.normalizeCharacter({
    id: 'CHR1', name: '银',
    experiences: [{ text: '旧事' }, { text: '中事' }, { text: '新事' }],
  });
  const s = characters.stateBrief(c, ['好感度'], { recent: 2 });
  assert.ok(s.includes('新事'));
  assert.ok(s.includes('中事'));
  assert.ok(!s.includes('旧事'));
});

// ---------- 计数器声明的**来源**（用户决策 2026-10-05）----------
// 计数器的「设计」搬到「② 标准要求」里了，但老写手把它写在「写手设定」(persona.md) 里。
// 两处都得认 —— 这里测的是**解析侧**（parseDeclaredCounters），
// 「新文件优先、旧文件回退」的调度在 server.js 的 declaredCountersOf，由真机脚本覆盖。

test('计数器声明：标准要求里的写法照样解析（不只是 persona 专用）', () => {
  const decl = characters.parseDeclaredCounters([
    '# 标准要求', '',
    '## 输出头尾',
    '- 开头：以「【第一幕】」起始', '',
    '## 计数器',
    '- 好感度：范围 0–100 / 初始 0',
    '- 信任：范围 0–10',
  ].join('\n'));
  assert.deepEqual(decl, ['好感度', '信任'], '标准要求里的计数器小节要能解析出来');
});

test('计数器声明：只认「计数」小节，输出头尾那几条不混入', () => {
  const decl = characters.parseDeclaredCounters('## 输出头尾\n- 开头：xxx\n## 计数器\n- 好感度：0-100\n');
  assert.deepEqual(decl, ['好感度'], '「开头」不该被当成计数器名');
});

// ---------- ★ 角色卡模板（设置 → 角色卡）----------

test('applyCharTemplate：替换 {{名字}} / {{name}} 占位（大小写与空格都认）', () => {
  const out = characters.applyCharTemplate('# {{名字}}\n\n她是 {{ name }}。', '银');
  assert.ok(out.includes('# 银'));
  assert.ok(out.includes('她是 银。'));
  assert.ok(!out.includes('{{'));
});

test('applyCharTemplate：模板为空 → 空串（不强行塞默认模板）', () => {
  assert.equal(characters.applyCharTemplate('', '银'), '');
  assert.equal(characters.applyCharTemplate('   \n  ', '银'), '');
  assert.equal(characters.applyCharTemplate(null, '银'), '');
});

test('applyCharTemplate：没有占位时原样返回（不擅自插名字）', () => {
  assert.equal(characters.applyCharTemplate('# 卡片\n## 背景', '银'), '# 卡片\n## 背景');
});

test('DEFAULT_CHAR_TEMPLATE：自带一条计数器声明，且不含图片正文', () => {
  const t = characters.DEFAULT_CHAR_TEMPLATE;
  const specs = characters.parseCounterSpecs(characters.applyCharTemplate(t, '银'));
  assert.equal(specs.length, 1, '默认模板里应恰好有一条 ##Counter 声明');
  assert.equal(specs[0].name, '好感度');
  assert.equal(specs[0].max, 100);
  assert.ok(!/!\[/.test(t), '角色设定是纯文本，模板里不该有 markdown 图片语法');
});

test('角色头像：avatar 是链接字段，不参与 buildEditPatch 之外的正文', () => {
  // avatar 在 EDITABLE_FIELDS 里（能存链接），但写手侧默认禁改（它属于形象库）
  assert.ok(characters.EDITABLE_FIELDS.includes('avatar'));
  assert.equal(characters.buildEditPatch({ avatar: 'u.png', name: 'x' }).avatar, undefined);
});
