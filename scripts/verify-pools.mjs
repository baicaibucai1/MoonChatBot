// 真机验证：角色池的 HTTP 层（/api/pools/* 与 /api/bots/:id/pools）—— **1:1 语义**
//
// ★★ 2026-10-08 语义变更（用户：「角色池中的角色会干扰写手，应该改为角色池对应写手」）：
//   池 ↔ 写手 **一一对应**。权威是 `characterPools[i].botId`；
//   bot.poolIds / activeCharacterIds / poolCharacterIds 全是**派生镜像**。
//   写手只看得到自己池里的角色；没有「公共池」「手动勾选」「绑多个池」这些概念了。
//   这份脚本原先验证的是「绑池 = 批量 / 解绑撤回 / 手动勾的留着」——那些语义已取消，
//   本轮整段改写。旧语义的历史留在 git 里（verify-pools.mjs 的上一个版本）。
//
// 为什么必须跑 HTTP 而不只是跑单测：
//   tests/pools.test.mjs 直接调 lib/characters.js 的纯函数，绕过整个路由层。
//   而 lib/routes/pools.js 的风险恰恰都在路由层：
//     · 路由顺序 —— /api/pools/move 必须排在 /api/pools/:id 之前（否则被通配吃掉）
//     · 域顺序   —— 'pools' 必须排在 'bots' 之前（否则 /api/bots/:id 截走 /pools）
//     · 请求体   —— 上下文里没有 c.query，drop 只能从 body 读
//     · 落盘     —— 每条写接口都要真的存进 config.json 并能读回来
//   这四类单测一条都碰不到，只有起真服务才暴露。
//
// 验证点：
//   ① 老 config（单池 cfg.characters）→ 启动后自动落进「默认池」
//   ② 形状：/api/pools 带 botId/botName/usedBy；/api/state 的角色带 poolId/poolName
//   ③ 新建池：必须带 botId；已有池的写手再建 → 400；新写手**不会**自动获得池
//      （写手可以没有池，给它建池是显式操作）
//   ④ 改名：成功 / 重名 400 / 不存在 404
//   ⑤ 在指定池里新建角色（落那个池，不是第一个池）
//   ⑥ 角色换池：唯一归属 + ★ 幂等（换到自己已经在的池 → 200 moved:false，不能 500）
//   ⑦ 写手 ↔ 池：认领无主池 / 释放 / 最多一个 / 抢别人的池被拒
//   ⑧ ★ 严格按池：绕过接口往 activeCharacterIds 塞池外角色 → 被重算掉
//   ⑨ 删池：**有主的池也删得掉**（用户 2026-10-08「删了就真没了」）——
//      删完写手变「没有池」，且**不会被自动补回来**；无主池也能删（默认搬走 / drop 连人删）
//   ⑩ 真的落盘了（config.json 里 characterPools 带 botId）
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

const st = () => get('/api/state');
const pools = async () => (await get('/api/pools')).pools || [];
const bot = async (id) => (await st()).bots.find((b) => b.id === id) || {};
const poolById = async (id) => (await pools()).find((p) => p.id === id) || {};
const poolOfBot = async (id) => ((await bot(id)).poolIds || [])[0] || '';
const saveBots = async (bots) => send('/api/config', 'PUT', { bots });

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
    check('★ 池视图带 botId / botName（1:1 的权威 + 给人看的名字）',
      p0.botId === 'BOT1' && p0.botName === '探针写手', JSON.stringify([p0.botId, p0.botName]));
    check('★ usedBy = 主人（最多一位）', p0.usedBy.length === 1 && p0.usedBy[0].id === 'BOT1',
      JSON.stringify(p0.usedBy));
    check('池视图里的角色已被裁成列表态（有 historyCount、没有 history 全文）',
      p0.characters[0] && typeof p0.characters[0].historyCount === 'number' && !('history' in p0.characters[0]));
    let s = await st();
    check('/api/state 带 pools 数组', Array.isArray(s.pools) && s.pools.length === 1);
    check('/api/state 的角色带 poolId / poolName',
      !!s.characters.find((c) => c.id === 'CHRprobe0001' && c.poolId === DEF && c.poolName === '默认池'),
      JSON.stringify(s.characters.map((c) => [c.id, c.poolId])));
    check('★ 写手只绑一个池（derived mirror）',
      (await bot('BOT1')).poolIds.join(',') === DEF, JSON.stringify((await bot('BOT1')).poolIds));

    // ───────────────────────── ③ 新建池（1:1，必须指定写手）─────────────────────────
    console.log('\n[3] 新建池：必须指定归属写手');
    let r = await send('/api/pools', 'POST', { name: '凭空建的池' });
    check('不带 botId 被拒（400）—— 没有「公共池」', r.ok === false, JSON.stringify(r).slice(0, 140));
    check('不带 botId 时错误信息指路（说明池要归写手）', /写手/.test(String(r.err)), String(r.err).slice(0, 140));
    check('带不存在的写手（404）', await code('/api/pools', 'POST', { name: 'x', botId: 'BOTnope' }) === 404);
    r = await send('/api/pools', 'POST', { name: '重复的池', botId: 'BOT1' });
    check('已经有池的写手再建池被拒（400）', r.ok === false, JSON.stringify(r).slice(0, 140));
    check('空名被拒（400）', await code('/api/pools', 'POST', { name: '   ', botId: 'BOT1' }) === 400);

    // ★ 新写手**不会**自动获得专属池（2026-10-08 用户：「删除角色池 → 删了就真没了」）
    //   走 PUT /api/config 加一位（写手是整份覆盖新增的），然后确认它没有池。
    const bots0 = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).bots;
    const b2 = {
      ...JSON.parse(JSON.stringify(bots0[0])),
      id: 'BOT2', name: '阿雪', poolIds: [], activeCharacterIds: [], poolCharacterIds: [],
    };
    r = await saveBots([bots0[0], b2]);
    check('/api/config 加一位新写手成功', r.ok === true, JSON.stringify(r));
    check('★★ 新写手不会自动获得池（没有池就是没有池）',
      ((await bot('BOT2')).poolIds || []).length === 0, JSON.stringify((await bot('BOT2')).poolIds));
    check('池数没变（还是只有默认池）', (await pools()).length === 1, `实际 ${(await pools()).length}`);

    // 显式给这位没有池的写手建一个（面板「新建池」走的就是这条）
    r = await send('/api/pools', 'POST', { name: '阿雪的池', botId: 'BOT2' });
    check('★ 给没有池的写手显式建池成功', r.ok === true, JSON.stringify(r).slice(0, 140));
    const P2 = r.pool && r.pool.id;
    check('★ 新池归它（botId=BOT2）',
      (await poolById(P2)).botId === 'BOT2' && (await poolById(P2)).botName === '阿雪',
      JSON.stringify(await poolById(P2)));
    check('新池是空的', (await poolById(P2)).count === 0);
    check('池数变成 2', (await pools()).length === 2, `实际 ${(await pools()).length}`);

    // ───────────────────────── ④ 改名 ─────────────────────────
    console.log('\n[4] 改名 / 改描述');
    r = await send(`/api/pools/${DEF}`, 'PUT', { name: '默认池★', desc: '主校区那几位' });
    check('改名成功', r.ok === true && r.pool.name === '默认池★', JSON.stringify(r).slice(0, 140));
    check('描述写进去了', r.ok && r.pool.desc === '主校区那几位');
    check('★ 改名不改归属', r.ok && r.pool.botId === 'BOT1', JSON.stringify([r.pool.botId, r.pool.botName]));
    check('改成重名被拒（400）', await code(`/api/pools/${DEF}`, 'PUT', { name: '阿雪的池' }) === 400);
    check('不存在的池（404）', await code('/api/pools/POOLnosuch', 'PUT', { name: 'x' }) === 404);

    // ───────────────────────── ⑤ 在指定池里新建角色 ─────────────────────────
    console.log('\n[5] 在指定池里新建角色');
    r = await send(`/api/pools/${DEF}/characters`, 'POST', { name: '小满', persona: '# 人格\n\n活泼。' });
    check('角色创建成功', r.ok === true, JSON.stringify(r).slice(0, 140));
    const XIAOMAN = r.character && r.character.id;
    check('返回的角色是刚建的那位', r.ok && r.character.name === '小满');
    s = await st();
    check('★ 落在「默认池★」而不是第一个池',
      !!s.characters.find((c) => c.id === XIAOMAN && c.poolId === DEF),
      JSON.stringify(s.characters.find((c) => c.id === XIAOMAN)?.poolId));
    check('★ 新角色直接进了池主（BOT1）的名单',
      ((await bot('BOT1')).activeCharacterIds || []).includes(XIAOMAN),
      JSON.stringify((await bot('BOT1')).activeCharacterIds));
    check('另一个池（阿雪的池）没被塞进去', (await poolById(P2)).count === 0);
    check('往不存在的池建角色（404）', await code('/api/pools/POOLnosuch/characters', 'POST', { name: 'x' }) === 404);
    check('空角色名（400）', await code(`/api/pools/${DEF}/characters`, 'POST', { name: '' }) === 400);

    // ───────────────────────── ⑥ 角色换池（唯一归属 + 幂等）─────────────────────────
    console.log('\n[6] 角色换池（唯一归属 + 幂等）');
    r = await send('/api/pools/move', 'POST', { characterId: 'CHRprobe0001', toPoolId: P2 });
    check('换池成功', r.ok === true, JSON.stringify(r).slice(0, 140));
    ps = await pools();
    check('原池（默认池★）少了一位', ps.find((p) => p.id === DEF).count === 1,
      `count=${ps.find((p) => p.id === DEF).count}`);
    check('新池（阿雪的池）多了那位',
      ps.find((p) => p.id === P2).characters.some((c) => c.id === 'CHRprobe0001'));
    check('★ 换池走的是 move 精确路由（没被 :id 通配吃掉）', r.ok !== false && !/不存在/.test(String(r.err)));
    check('★ 归属跟着池走：BOT1 少一位、BOT2 多一位',
      !((await bot('BOT1')).activeCharacterIds || []).includes('CHRprobe0001')
      && ((await bot('BOT2')).activeCharacterIds || []).includes('CHRprobe0001'),
      JSON.stringify({ b1: (await bot('BOT1')).activeCharacterIds, b2: (await bot('BOT2')).activeCharacterIds }));
    check('缺参数（400）', await code('/api/pools/move', 'POST', { characterId: 'CHRprobe0001' }) === 400);
    check('目标池不存在（404）', await code('/api/pools/move', 'POST', { characterId: 'CHRprobe0001', toPoolId: 'POOLnosuch' }) === 404);

    // ★★ 幂等：换到自己已经在的池 —— 这是个很正常的操作（下拉提交当前值），
    //    必须 200。以前这里会 500：moveCharacter 短路时只回 pool 不回 character，
    //    路由却直接 bare(r.character) → 抛 TypeError。
    r = await send('/api/pools/move', 'POST', { characterId: 'CHRprobe0001', toPoolId: P2 });
    check('★★ 换到自己已经在的池：200 且 moved:false（曾经是 500）',
      r.ok === true && r.moved === false, JSON.stringify(r).slice(0, 160));
    check('★ 且仍然回带角色（回执形状不因短路而缺字段）',
      !!r.character && r.character.id === 'CHRprobe0001', JSON.stringify(r.character && r.character.id));
    check('池计数没变（幂等无副作用）', (await poolById(P2)).count === 1);

    // ───────────────────────── ⑦ 写手 ↔ 池 ─────────────────────────
    console.log('\n[7] 写手 ↔ 池：认领 / 释放 / 最多一个');
    r = await send('/api/bots/BOT1/pools', 'PUT', { poolIds: [P2] });
    check('★ 抢别人的池被拒（400）', r.ok === false, JSON.stringify(r).slice(0, 160));
    check('BOT1 仍然守着它自己的池', (await poolOfBot('BOT1')) === DEF, await poolOfBot('BOT1'));
    check('最多一个（给两个 → 400）', await code('/api/bots/BOT1/pools', 'PUT', { poolIds: [DEF, P2] }) === 400);
    check('poolIds 非数组（400）', await code('/api/bots/BOT1/pools', 'PUT', { poolIds: 'x' }) === 400);
    check('写手不存在（404）', await code('/api/bots/NOPE/pools', 'PUT', { poolIds: [] }) === 404);
    check('认领不存在的池（404）', await code('/api/bots/BOT1/pools', 'PUT', { poolIds: ['POOLnosuch'] }) === 404);
    r = await send('/api/bots/BOT1/pools', 'PUT', { poolIds: [] });
    check('释放当前池成功', r.ok === true, JSON.stringify(r));
    const P1B = await poolOfBot('BOT1');
    // ★ 语义变更（2026-10-08 用户「删了就真没了」）：释放 / 删掉池之后
    //   **不再自动补一个**。早先这里补池，正是「删除角色池按钮失灵」的根因。
    check('★★ 释放后 BOT1 **没有池**了（不再自动补一个）', P1B === '', JSON.stringify(P1B));
    check('★★ 写手身上 poolIds / 名单都为 0（没有池 = 看不见任何角色）',
      ((await bot('BOT1')).poolIds || []).length === 0
      && ((await bot('BOT1')).activeCharacterIds || []).length === 0,
      JSON.stringify((await bot('BOT1')).poolIds));
    check('★ 释放掉的池变无主（角色一个没删）',
      (await poolById(DEF)).botId === '' && (await poolById(DEF)).count === 1,
      JSON.stringify({ botId: (await poolById(DEF)).botId, count: (await poolById(DEF)).count }));

    // 认领无主池：把 DEF 认回来（没有池的写手「重新有池」的两条路之一）
    r = await send('/api/bots/BOT1/pools', 'PUT', { poolIds: [DEF] });
    check('★ 认领无主池成功（换个池也是一次调用）', r.ok === true, JSON.stringify(r).slice(0, 160));
    check('认领后 DEF 归 BOT1', (await poolById(DEF)).botId === 'BOT1', JSON.stringify(await poolById(DEF)));
    check('★ 换池即换归属：新老池的名单各自重算',
      ((await bot('BOT1')).activeCharacterIds || []).includes(XIAOMAN)
      && !((await bot('BOT1')).activeCharacterIds || []).includes('CHRprobe0001'),
      JSON.stringify((await bot('BOT1')).activeCharacterIds));

    // ───────────────────────── ⑧ 严格按池（绕过接口也塞不进池外角色）─────────────────────────
    console.log('\n[8] ★ 严格按池：绕过池接口直接 PUT /api/config 塞池外角色');
    // 故意把「阿雪池里的 CHRprobe0001」写进 BOT1 的 activeCharacterIds
    // —— 模拟旧前端 / 手动改配置。改归属只能靠换池，所以它必须被重算掉。
    const cfgNow = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    r = await saveBots(cfgNow.bots.map((x) => (x.id === 'BOT1'
      ? { ...x, activeCharacterIds: [...(x.activeCharacterIds || []), 'CHRprobe0001'] }
      : x)));
    check('/api/config 保存成功', r.ok === true, JSON.stringify(r));
    const back = (await bot('BOT1')).activeCharacterIds || [];
    check('★★ 池外的角色被重算掉（不会被塞进写手身上）',
      !back.includes('CHRprobe0001'), JSON.stringify(back));
    check('★ 池内的角色还在', back.includes(XIAOMAN), JSON.stringify(back));

    // ───────────────────────── ⑨ 删池 ─────────────────────────
    // ★★ 语义变更（2026-10-08 用户：「删除角色池的功能没有做」→「删了就真没了」）：
    //   以前有主的池删不掉（400），用户点删除按钮毫无反应；现在**任何池都能删**，
    //   删完那位写手变成「没有池」，而且**不会再自动补回来**。
    console.log('\n[9] 删池：有主的也删得掉（删了就真没了）');
    const rOwned = await send(`/api/pools/${DEF}`, 'DELETE', {});
    check('★★ 删有主的专属池成功（曾经 400）', rOwned.ok === true, JSON.stringify(rOwned).slice(0, 160));
    check('★ 默认把池里角色搬走（moved=1, dropped=0）',
      rOwned.moved === 1 && rOwned.dropped === 0, JSON.stringify(rOwned).slice(0, 160));
    check('DEF 已消失', !(await pools()).some((p) => p.id === DEF));
    check('★ 原写手 BOT1 变成「没有池」', ((await bot('BOT1')).poolIds || []).length === 0,
      JSON.stringify((await bot('BOT1')).poolIds));
    check('★ 但角色没丢（搬到别的池了）',
      (await st()).characters.some((c) => c.id === XIAOMAN),
      JSON.stringify((await st()).characters.map((c) => c.name)));

    // ★★ 关键回归：走一遍**写路径**（PUT /api/config 内部会 syncPoolCharacters），
    //    确认那个池**不会**被自动补回来 —— 旧实现就是在这里补的，用户以为按钮失灵。
    const cfgDel = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    r = await saveBots(cfgDel.bots);
    check('/api/config 保存成功', r.ok === true, JSON.stringify(r));
    check('★★ 走完写路径后 BOT1 仍然没有池（不会自动长出来）',
      ((await bot('BOT1')).poolIds || []).length === 0, JSON.stringify((await bot('BOT1')).poolIds));
    check('★ 池数没有变多', (await pools()).length === 1, `实际 ${(await pools()).length}`);

    // 给「没有池」的 BOT1 显式建一个新池 —— 这就是面板上「给未分配写手新建空池」那条路，
    // 顺便把池数拉回 2（「不许删最后一个池」这条不变量还守着，后面才删得掉无主池）。
    r = await send('/api/pools', 'POST', { name: '回收站', botId: 'BOT1' });
    const P3 = r.pool && r.pool.id;
    check('★ 删池后可以再给同一位写手建新池（面板「新建池」）', !!P3, JSON.stringify(r).slice(0, 140));
    check('★ 建完又有池了（显式建，不是自动补）',
      (await poolOfBot('BOT1')) === P3, await poolOfBot('BOT1'));
    check('池数回到 2', (await pools()).length === 2, `实际 ${(await pools()).length}`);

    // 造一个无主池：先给 BOT2 的池建个角色，再释放它的池（释放后池归无主、人留在池里）
    await send(`/api/pools/${P2}/characters`, 'POST', { name: '待搬角色' });
    await send('/api/bots/BOT2/pools', 'PUT', { poolIds: [] });
    check('★ BOT2 释放后也没有池（不再补）', (await poolOfBot('BOT2')) === '', await poolOfBot('BOT2'));
    check('P2 现在无主（botId 空）', (await poolById(P2)).botId === '', JSON.stringify(await poolById(P2)));
    // P2 里原有 CHRprobe0001（步骤⑥搬来的）+ 刚被「删 DEF」搬来的 小满 = 2，再加 1 = 3
    const p2n = (await poolById(P2)).count;
    check('无主池里的角色还在（释放不清人）', p2n === 3, `count=${p2n}`);
    r = await send(`/api/pools/${P2}`, 'DELETE', {});
    check('★ 删无主池成功', r.ok === true, JSON.stringify(r));
    check('★ 默认把角色搬走（moved=3, dropped=0）', r.moved === 3 && r.dropped === 0, JSON.stringify(r));
    check('P2 已消失', !(await pools()).some((p) => p.id === P2));
    const names = (await st()).characters.map((c) => c.name);
    check('那两位角色还在（只是换了个池）',
      names.includes('探针角色') && names.includes('待搬角色'), JSON.stringify(names));

    // drop=true：连角色一起删（给 BOT2 显式建一个池再删掉它）
    r = await send('/api/pools', 'POST', { name: '待删池', botId: 'BOT2' });
    const PZ = r.pool && r.pool.id;
    check('给没有池的 BOT2 又建了一个池', !!PZ, JSON.stringify(r).slice(0, 140));
    await send(`/api/pools/${PZ}/characters`, 'POST', { name: '待删甲' });
    await send(`/api/pools/${PZ}/characters`, 'POST', { name: '待删乙' });
    check('PZ 里 2 位', (await poolById(PZ)).count === 2, `count=${(await poolById(PZ)).count}`);
    r = await send(`/api/pools/${PZ}`, 'DELETE', { drop: true });
    check('drop=true 删池成功', r.ok === true, JSON.stringify(r));
    check('★ 连角色一起删（dropped=2）', r.dropped === 2 && r.moved === 0, JSON.stringify(r));
    s = await st();
    check('这两位角色真的没了', !s.characters.some((c) => c.name === '待删甲' || c.name === '待删乙'));
    check('删不存在的池（404）', await code('/api/pools/POOLnosuch', 'DELETE', {}) === 404);

    // ───────────────────────── ⑩ 落盘 ─────────────────────────
    console.log('\n[10] 真的落盘了（config.json）');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    check('config.json 有 characterPools', Array.isArray(raw.characterPools));
    check('config.json 里没有残留的旧 characters 字段', raw.characters === undefined);
    check('★ 每个池都有 botId 字段（无主写空串）',
      raw.characterPools.every((p) => typeof p.botId === 'string'),
      JSON.stringify(raw.characterPools.map((p) => [p.id, p.botId])));
    check('★ 一位写手最多拥有一个池',
      raw.characterPools.filter((p) => p.botId === 'BOT1').length <= 1
      && raw.characterPools.filter((p) => p.botId === 'BOT2').length <= 1,
      JSON.stringify(raw.characterPools.map((p) => [p.id, p.botId])));
    check('写手身上 poolIds 只有一个', (raw.bots[0].poolIds || []).length === 1,
      JSON.stringify(raw.bots[0].poolIds));
    check('写手身上有 poolCharacterIds 账本',
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
