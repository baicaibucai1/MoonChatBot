// 输出后自检：纯逻辑单测（不碰盘、不调模型）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sc = require('../lib/selfcheck.js');

// ---------- 三态开关 ----------

test('isEnabled：写手覆盖 > 全局；全局默认开', () => {
  assert.equal(sc.isEnabled({ selfCheck: true }, { selfCheck: false }), true, '写手开 = 开');
  assert.equal(sc.isEnabled({ selfCheck: false }, { selfCheck: true }), false, '写手关 = 关');
  assert.equal(sc.isEnabled({}, { selfCheck: true }), true);
  assert.equal(sc.isEnabled({}, { selfCheck: false }), false);
  assert.equal(sc.isEnabled({}, {}), true, '★ 默认开：没配过也要自检');
  assert.equal(sc.isEnabled(null, null), true);
  assert.equal(sc.isEnabled({ selfCheck: undefined }, { selfCheck: undefined }), true);
});

// ---------- 解析 ----------

test('parseResult：正常 JSON', () => {
  const r = sc.parseResult(JSON.stringify({
    counters: [{ characterId: 'CHR1', deltas: { 好感度: 5 }, why: '被救' }],
    world: [{ text: '渡口被烧了', why: '战乱' }],
    events: [{ actors: ['银'], event: '银在渡口救了主角', emotion: '紧张', importance: 4 }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.counters.length, 1);
  assert.deepEqual(r.counters[0].deltas, { 好感度: 5 });
  assert.equal(r.world[0].text, '渡口被烧了');
  assert.equal(r.events[0].importance, 4);
});

test('parseResult：容忍 ```json 围栏与前后废话', () => {
  const raw = '好的，这是结果：\n```json\n{"counters":[],"world":[],"events":[{"event":"过了一夜","importance":3}]}\n```\n以上。';
  const r = sc.parseResult(raw);
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 1);
});

test('parseResult：坏 JSON → ok=false 且各数组为空（上层据此跳过）', () => {
  const r = sc.parseResult('模型今天不想输出 JSON');
  assert.equal(r.ok, false);
  assert.deepEqual(r.counters, []);
  assert.deepEqual(r.world, []);
  assert.deepEqual(r.events, []);
  assert.equal(sc.parseResult('').ok, false);
  assert.equal(sc.parseResult(null).ok, false);
});

test('parseResult：增量里 0 与非数字被丢掉（0 是无意义的变更）', () => {
  const r = sc.parseResult('{"counters":[{"characterId":"CHR1","deltas":{"好感度":0,"信任":"abc","羁绊":3}}]}');
  assert.deepEqual(r.counters[0].deltas, { 羁绊: 3 });
});

test('parseResult：缺 characterId / 空 deltas 的条目整条丢掉', () => {
  const r = sc.parseResult('{"counters":[{"deltas":{"好感度":5}},{"characterId":"CHR1","deltas":{}}]}');
  assert.equal(r.counters.length, 0);
});

test('parseResult：importance 夹到 1~5；event 为空丢掉', () => {
  const r = sc.parseResult('{"events":[{"event":"a","importance":99},{"event":"","importance":3},{"event":"b","importance":-3}]}');
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].importance, 5);
  assert.equal(r.events[1].importance, 1);
});

test('parseResult：条数上限（世界最多 3 条，防模型一口气报一屏）', () => {
  const world = Array.from({ length: 10 }, (_, i) => ({ text: 'w' + i }));
  const r = sc.parseResult(JSON.stringify({ world }));
  assert.equal(r.world.length, sc.MAX_WORLD_ITEMS);
});

// ---------- 正文取样 ----------

test('sampleReply：短文本原样返回', () => {
  assert.equal(sc.sampleReply('短正文'), '短正文');
});

test('sampleReply：长文本保留**开头与结尾**（只截前面会丢掉结局）', () => {
  const long = 'A'.repeat(3000) + '中'.repeat(9000) + 'Z'.repeat(3000);
  const out = sc.sampleReply(long);
  assert.ok(out.startsWith('AAAA'), '开头要在');
  assert.ok(out.endsWith('ZZZZ'), '★ 结尾必须在 —— 该记的事往往发生在最后');
  assert.ok(out.includes('省略'), '省略提示');
  assert.ok(out.length < long.length, '确实截短了');
});

// ---------- messages ----------

test('buildMessages：带上角色 id、当前值、可改的计数器名与范围', () => {
  const msgs = sc.buildMessages({
    reply: '正文',
    characters: [{
      id: 'CHR1', name: '银',
      counters: { 好感度: 10 },
      declared: [{ name: '好感度', range: '0~100' }],
    }],
    world: { changes: [{ text: '渡口被烧' }] },
  });
  const sys = msgs[0].content;
  assert.ok(sys.includes('CHR1'), '必须给出 id，否则模型只能靠名字猜');
  assert.ok(sys.includes('好感度=10'), '当前值要给出，否则它算不对增量');
  assert.ok(sys.includes('0~100'), '范围要给出');
  assert.ok(sys.includes('渡口被烧'), '世界卡现状要给出');
  assert.ok(sys.includes('增量'), '必须强调是增量不是绝对值');
});

test('buildMessages：没有角色时明说 counts/events 留空（别让它编人）', () => {
  const sys = sc.buildMessages({ reply: 'x', characters: [], world: {} })[0].content;
  assert.ok(/没有角色可选/.test(sys));
});

test('buildMessages：没声明计数器的角色被标成「必须留空」', () => {
  const sys = sc.buildMessages({
    reply: 'x', characters: [{ id: 'CHR1', name: '银', counters: {}, declared: [] }], world: {},
  })[0].content;
  assert.ok(/counters 必须留空/.test(sys));
});

// ---------- 同步短句 ----------

test('syncItemsOf：把三类结果翻成给用户扫一眼的短句', () => {
  const items = sc.syncItemsOf({
    events: [{ event: '银在渡口救了主角' }],
    counters: [{ characterId: 'CHR1', deltas: { 好感度: 5 } }],
    world: [{ text: '渡口被烧了' }],
  }, (id) => (id === 'CHR1' ? '银' : ''));
  assert.equal(items.length, 3);
  assert.ok(items[0].text.includes('剧情记录 +1'));
  assert.ok(items[1].text.includes('银') && items[1].text.includes('好感度 +5'));
  assert.ok(items[1].text.includes('待你确认'), '计数器是待确认，不能写成已更新');
  assert.ok(items[2].text.includes('世界改变'));
});
