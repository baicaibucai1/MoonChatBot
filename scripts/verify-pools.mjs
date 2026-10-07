// 真机验证：多角色池的 HTTP 层（/api/pools/* 与 /api/bots/:id/pools）
//
// 为什么必须跑 HTTP 而不只是跑单测：
//   tests/pools.test.mjs 直接调 lib/characters.js 的纯函数，绕过整个路由层。
//   而本轮新增的 lib/routes/pools.js 是**全新文件**，风险恰恰都在路由层：
//     · 路由顺序 —— /api/pools/move 必须排在 /api/pools/:id 之前（否则被通配吃掉）
//     · 域顺序   —— 'pools' 必须排在 'bots' 之前（否则 /api/bots/:id 截走 /pools）
//     · 请求体   —— 上下文里没有 c.query，drop 只能从 body 读
//     · 落盘     —— 每条写接口都要真的存进 config.json 并能读回来
//   这四类单测一条都碰不到，只有起真服务才暴露。
//
// 验证点：
//   ① 老 config（单池 cfg.characters）→ 启动后自动落进「默认池」
//   ② GET /api/pools 形状（id/name/count/characters/usedBy）+ /api/state 带 pools 与 poolId
//   ③ 新建池：成功 / 重名 400 / 空名 400
//   ④ 改名：成功 / 改成重名 400 / 不存在的池 404
//   ⑤ 在指定池里新建角色（落到那个池，不是第一个池）
//   ⑥ 角色换池：唯一归属（原池少一个、新池多一个）
//   ⑦ ★ 绑池 = 批量：整池角色一次性进 activeCharacterIds
//   ⑧ ★ 持续同步：绑池后往池里加人，写手自动拿到
//   ⑨ ★ 解绑撤回：池给的撤回、手动勾的留下
//   ⑩ ★ 绕过池接口直接 PUT /api/config 也丢不掉池给的角色（meta.js 里的兜底同步）
//   ⑪ 删池：默认把角色搬到剩余池 / drop=true 连角色一起删
//   ⑫ ★ 删不掉最后一个池（400）—— 否则等于把角色体系清空
//
// 用法：node scripts/verify-pools.mjs

import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox } from './lib/sandbox.mjs';

const fails = [];
let n = 0;
function check(name, cond, extra = '') {
  n++;
  if (cond) { console.log(`  ✓ ${name}`); return true; }
  fails.push(name);
  console.log(`  ✗ ${name}${extra ? '  ← ' + extra : ''}`);
  return false;
}

let base = '';
const get = async (url) => (await fetch(base + url)).json();
const send = async (url, method, body) => (await fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body === undefined ? {} : body),
})).json();
const code = async (url, method, body) => (await fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body === undefined ? {} : body),
})).status;

// 常用查询：拿 state / pools
const st = () => get('/api/state');
const pools = async () => (await get('/api/pools')).pools || [];
const bot1 = async () => (await st()).bots.find((b) => b.id === 'BOT1') || {};

async function main() {
  const dir = makeSandbox();
  let srv = null;
  try {
    const { port } = await patchSandboxConfig(dir);
    srv = await startServer(dir, port);
    base = srv.base;
    console.log(`沙箱已启动 ${base}\n`);

    // ───────────────────────── ① 老格式 → 默认池 ─────────────────────────
    console.log('[1] 老 config（单池）自动迁移');
    let ps = await pools();
    check('启动后有且只有 1 个池', ps.length === 1, `实际 ${ps.length}`);
    check('池名是「默认池」', ps[0] && ps[0].name === '默认池', ps[0] && ps[0].name);
    check('池 id 带 POOL 前缀', !!ps[0] && ps[0].id.startsWith('POOL'), ps[0] && ps[0].id);
    const DEF = ps[0].id;
    check('老角色 CHRprobe0001 已进默认池',
      !!ps[0] && ps[0].characters.some((c) => c.id === 'CHRprobe0001'),
      JSON.stringify((ps[0] || {}).characters?.map((c) => c.id)));

    // ───────────────────────── ② 对外形状 ─────────────────────────
    console.log('\n[2] /api/pools 与 /api/state 形状');
    const p0 = ps[0];
    check('池视图含 desc / ts / count / usedBy',
      'desc' in p0 && 'ts' in p0 && typeof p0.count === 'number' && Array.isArray(p0.usedBy));
    check('池视图里的角色已被裁成列表态（有 historyCount、没有 history 全文）',
      p0.characters[0] && typeof p0.characters[0].historyCount === 'number' && !('history' in p0.characters[0]));
    let s = await st();
    check('/api/state 带 pools 数组', Array.isArray(s.pools) && s.pools.length === 1);
    check('/api/state 的角色带 poolId / poolName',
      !!s.characters.find((c) => c.id === 'CHRprobe0001' && c.poolId === DEF && c.poolName === '默认池'),
      JSON.stringify(s.characters.map((c) => [c.id, c.poolId])));
    check('写手带 poolIds 字段（空数组）', Array.isArray((await bot1()).poolIds));

    // ───────────────────────── ③ 新建池 ─────────────────────────
    console.log('\n[3] 新建池');
    let r = await send('/api/pools', 'POST', { name: '校园组' });
    check('新建成功', r.ok === true, JSON.stringify(r));
    const CAMP = r.pool && r.pool.id;
    check('新池 id 带 POOL 前缀', !!CAMP && CAMP.startsWith('POOL'));
    check('池名原样保留', r.pool && r.pool.name === '校园组');
    check('池数变成 2', (await pools()).length === 2);
    check('重名被拒（400）', await code('/api/pools', 'POST', { name: '校园组' }) === 400);
    check('空名被拒（400）', await code('/api/pools', 'POST', { name: '   ' }) === 400);

    // ───────────────────────── ④ 改名 ─────────────────────────
    console.log('\n[4] 改名 / 改描述');
    r = await send(`/api/pools/${CAMP}`, 'PUT', { name: '校园组★', desc: '主校区那几位' });
    check('改名成功', r.ok === true && r.pool.name === '校园组★', JSON.stringify(r));
    check('描述写进去了', r.ok && r.pool.desc === '主校区那几位');
    check('改成重名被拒（400）', await code(`/api/pools/${CAMP}`, 'PUT', { name: '默认池' }) === 400);
    check('不存在的池（404）', await code('/api/pools/POOLnosuch', 'PUT', { name: 'x' }) === 404);

    // ───────────────────────── ⑤ 在指定池里新建角色 ─────────────────────────
    console.log('\n[5] 在指定池里新建角色');
    r = await send(`/api/pools/${CAMP}/characters`, 'POST', { name: '小满', persona: '# 人格\n\n活泼。' });
    check('角色创建成功', r.ok === true, JSON.stringify(r));
    const XIAOMAN = r.character && r.character.id;
    check('返回的角色是刚建的那位', r.ok && r.character.name === '小满');
    s = await st();
    check('★ 落在「校园组★」而不是第一个池',
      !!s.characters.find((c) => c.id === XIAOMAN && c.poolId === CAMP),
      JSON.stringify(s.characters.find((c) => c.id === XIAOMAN)?.poolId));
    check('默认池仍是 1 位（没被塞进去）',
      (await pools()).find((p) => p.id === DEF).count === 1);
    check('往不存在的池建角色（404）', await code('/api/pools/POOLnosuch/characters', 'POST', { name: 'x' }) === 404);
    check('空角色名（400）', await code(`/api/pools/${CAMP}/characters`, 'POST', { name: '' }) === 400);

    // ───────────────────────── ⑥ 角色换池 ─────────────────────────
    console.log('\n[6] 角色换池（唯一归属）');
    r = await send('/api/pools/move', 'POST', { characterId: 'CHRprobe0001', toPoolId: CAMP });
    check('换池成功', r.ok === true, JSON.stringify(r));
    ps = await pools();
    check('原池（默认池）少了一位', ps.find((p) => p.id === DEF).count === 0, `count=${ps.find((p) => p.id === DEF).count}`);
    check('新池（校园组★）多了那位',
      ps.find((p) => p.id === CAMP).characters.some((c) => c.id === 'CHRprobe0001'));
    check('★ 换池走的是 move 精确路由（没被 :id 通配吃掉）', r.ok !== false && !/不存在/.test(String(r.err)));
    check('缺参数（400）', await code('/api/pools/move', 'POST', { characterId: 'CHRprobe0001' }) === 400);
    check('目标池不存在（404）', await code('/api/pools/move', 'POST', { characterId: 'CHRprobe0001', toPoolId: 'POOLnosuch' }) === 404);

    // ───────────────────────── ⑦ 绑池 = 批量 ─────────────────────────
    console.log('\n[7] 绑池 = 批量拿到整池角色');
    r = await send('/api/bots/BOT1/pools', 'PUT', { poolIds: [CAMP] });
    check('绑定成功', r.ok === true, JSON.stringify(r));
    check('poolIds 已写入', Array.isArray(r.poolIds) && r.poolIds.includes(CAMP));
    check('★ 池里 2 位角色一次性进了 activeCharacterIds',
      r.activeCharacterIds.includes('CHRprobe0001') && r.activeCharacterIds.includes(XIAOMAN),
      JSON.stringify(r.activeCharacterIds));
    check('池视图的 usedBy 显示出这位写手',
      (await pools()).find((p) => p.id === CAMP).usedBy.some((u) => u.id === 'BOT1'));
    check('绑定不存在的池 → 被过滤掉（不出现在 poolIds）',
      (await send('/api/bots/BOT1/pools', 'PUT', { poolIds: [CAMP, 'POOLnosuch'] })).poolIds.join(',') === CAMP);
    check('poolIds 非数组（400）', await code('/api/bots/BOT1/pools', 'PUT', { poolIds: 'x' }) === 400);
    check('写手不存在（404）', await code('/api/bots/NOPE/pools', 'PUT', { poolIds: [] }) === 404);

    // ───────────────────────── ⑧ 持续同步 ─────────────────────────
    console.log('\n[8] 持续同步：往绑定的池里加人');
    r = await send(`/api/pools/${CAMP}/characters`, 'POST', { name: '阿霁' });
    const AJI = r.character && r.character.id;
    check('新角色已建进池子', r.ok === true);
    const b = await bot1();
    check('★ 写手自动拿到新角色（无需再绑一次）',
      b.activeCharacterIds.includes(AJI), JSON.stringify(b.activeCharacterIds));

    // ───────────────────────── ⑨ 解绑撤回 ─────────────────────────
    console.log('\n[9] 解绑撤回（池给的撤、手动勾的留）');
    // 先手动加一位「非池来源」的角色（默认池里的），再解绑
    r = await send(`/api/pools/${DEF}/characters`, 'POST', { name: '手点角色' });
    const MANUAL = r.character && r.character.id;
    check('默认池里建了一位（该池没绑给写手）', r.ok === true);
    const cur = (await bot1()).activeCharacterIds;
    r = await send('/api/bots/BOT1/characters', 'PUT', { characterIds: [...cur, MANUAL] });
    check('手动把这位加进写手', r.ok === true && (r.activeCharacterIds || []).includes(MANUAL));
    r = await send('/api/bots/BOT1/pools', 'PUT', { poolIds: [] });
    check('解绑成功', r.ok === true && r.poolIds.length === 0, JSON.stringify(r));
    check('★ 池给的三位已撤回',
      !r.activeCharacterIds.includes('CHRprobe0001')
      && !r.activeCharacterIds.includes(XIAOMAN)
      && !r.activeCharacterIds.includes(AJI),
      JSON.stringify(r.activeCharacterIds));
    check('★ 手动勾的那位被保留', r.activeCharacterIds.includes(MANUAL), JSON.stringify(r.activeCharacterIds));

    // ───────────────────────── ⑩ 绕过池接口直接写 /api/config ─────────────────────────
    console.log('\n[10] 绕过池接口直接 PUT /api/config（兜底同步）');
    r = await send('/api/bots/BOT1/pools', 'PUT', { poolIds: [CAMP] });
    check('重新绑池', r.ok === true);
    // ★ 直接从 config.json 取 bots 攒 payload：/api/state 的 bots 带派生字段，
    //   拿它回写会把状态数据混进配置（真实前端就是这么写的，但探针不该扩大这个面）。
    const cfgBots = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).bots
      .map((x) => (x.id === 'BOT1'
        // 故意只写「手点那位」—— 模拟写手设置弹窗把池给的角色漏掉
        ? { ...x, activeCharacterIds: [MANUAL] }
        : x));
    r = await send('/api/config', 'PUT', { bots: cfgBots });
    check('/api/config 保存成功', r.ok === true, JSON.stringify(r));
    const back = (await bot1()).activeCharacterIds;
    check('★ 池给的角色被自动补回来（配置接口也守住同步不变量）',
      back.includes(AJI) && back.includes(XIAOMAN) && back.includes('CHRprobe0001') && back.includes(MANUAL),
      JSON.stringify(back));

    // ───────────────────────── ⑪ 删池 ─────────────────────────
    console.log('\n[11] 删池（默认搬走 / drop 删掉）');
    // 校园组★ 目前 3 位（CHRprobe0001 / 小满 / 阿霁），默认池 1 位（手点角色）
    r = await send(`/api/pools/${CAMP}`, 'DELETE', {});
    check('删池成功', r.ok === true, JSON.stringify(r));
    check('★ 默认把 3 位角色搬走（moved=3, dropped=0）', r.moved === 3 && r.dropped === 0, JSON.stringify(r));
    ps = await pools();
    check('只剩 1 个池', ps.length === 1, `实际 ${ps.length}`);
    check('角色全落到默认池（1 + 3 = 4 位）', ps[0].count === 4, `count=${ps[0].count}`);
    check('写手身上对已删池的绑定被清掉', ((await bot1()).poolIds || []).length === 0);
    check('★ 解绑后池给的角色撤回，只剩手动那位',
      (await bot1()).activeCharacterIds.join(',') === MANUAL,
      JSON.stringify((await bot1()).activeCharacterIds));

    // drop=true：连角色一起删
    r = await send('/api/pools', 'POST', { name: '临时组' });
    const TMP = r.pool.id;
    await send(`/api/pools/${TMP}/characters`, 'POST', { name: '待删甲' });
    await send(`/api/pools/${TMP}/characters`, 'POST', { name: '待删乙' });
    check('临时组里有 2 位', (await pools()).find((p) => p.id === TMP).count === 2);
    r = await send(`/api/pools/${TMP}`, 'DELETE', { drop: true });
    check('drop=true 删池成功', r.ok === true, JSON.stringify(r));
    check('★ 连角色一起删（dropped=2）', r.dropped === 2 && r.moved === 0, JSON.stringify(r));
    s = await st();
    check('这两位角色真的没了', !s.characters.some((c) => c.name === '待删甲' || c.name === '待删乙'));

    // ───────────────────────── ⑫ 删不掉最后一个池 ─────────────────────────
    console.log('\n[12] 删不掉最后一个池');
    ps = await pools();
    check('此刻只剩 1 个池', ps.length === 1, `实际 ${ps.length}`);
    check('★ 删最后一个池被拒（400）', await code(`/api/pools/${ps[0].id}`, 'DELETE', {}) === 400);
    check('★ 池还在，角色也还在（没被清空）',
      (await pools()).length === 1 && (await st()).characters.length > 0);
    check('删不存在的池（404）', await code('/api/pools/POOLnosuch', 'DELETE', {}) === 404);

    // ───────────────────────── 落盘检查 ─────────────────────────
    console.log('\n[13] 真的落盘了（config.json 里是 characterPools）');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    check('config.json 有 characterPools', Array.isArray(raw.characterPools));
    check('config.json 里没有残留的旧 characters 字段', raw.characters === undefined);
    check('写手身上有 poolCharacterIds 账本（解绑撤回靠它）',
      Array.isArray(raw.bots[0].poolCharacterIds), JSON.stringify(raw.bots[0].poolCharacterIds));

    console.log(`\n结果：${fails.length ? '❌ ' + fails.length + ' / ' + n + ' 项失败' : '✅ 全部通过（' + n + ' 项）'}`);
    if (fails.length) console.log('失败项：', fails.join('、'));
  } finally {
    if (srv) stopServer(srv.child);
    removeSandbox(dir);
  }
}

main()
  .then(() => { process.exitCode = fails.length ? 1 : 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; });
