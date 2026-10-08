// 真机验证：角色池的前端 UI（角色栏 + 写手标签页 + 写手设置弹窗）—— **1:1 语义**
//
// ★★ 2026-10-08 语义变更（用户：「角色池中的角色会干扰写手，应该改为角色池对应写手」）：
//   池 ↔ 写手 **一一对应**，写手只看得到自己池里的角色。
//   于是这份脚本原先验证的三样东西**已经不存在**，整段换掉：
//     · 「新建池」按钮（池跟着写手生，不跟着按钮生）
//     · 写手标签页的「绑定条」+ 点一下批量绑池
//     · 写手设置里「池给的勾选项锁死」（勾选框本身没了；池给的 = 全部，只读展示）
//   换成了：池归谁的展示、只读的专属池、换池是唯一改归属的入口、有主的池删不掉。
//
// 为什么必须用真浏览器：
//   本轮前端改的是**模板字符串 + 内联 onclick**，语法检查（node --check）只能证明
//   「文件能解析」，证明不了：
//     · poolBarHtml 真的被插进了卡片头部（不是写了函数却忘了用）
//     · 侧栏 / 池 chip 真的标出了「归谁 / 无主」（用错数据源就会全写「无主」）
//     · 写手「角色」页真的只渲染自己池里的人（这是用户报的那个 bug 的界面侧）
//     · 行尾「换池」下拉真的把角色搬过去了（POST /api/pools/move 走了没）
//     · 有主的池 UI 上真的没有「删除池」按钮（服务端 400 只是兜底）
//   这些只有真机点一遍才知道。
//
// 验证点：
//   ① 角色栏顶部池切换条：全部 / 每个池（带归属）/ **没有**「新建池」
//   ①b 侧栏池列表：每池一条 + 「归 X / 无主」+ 没有 #btn-add-pool
//   ② 加一位写手后，它自动有池，侧栏与切换条都跟着长出「归 阿雪」那条
//   ③ 池空时的空状态文案 + 「新建角色」落在**当前池**（不是第一个池）
//   ④ 行尾「换池」下拉：选项标出每个池归谁；换池后两边计数同步
//   ⑤ 写手「角色」标签页：只列自己池里的人、只有一块只读的专属池、没有可点绑定条 / 移除按钮
//   ⑥ 写手设置弹窗：专属池只读展示，**没有勾选框**
//   ⑦ 删池：有主的池没有「删除池」按钮；无主池有，非空时走二选一（搬走 / 一起删）
//   ⑧ 全程无 JS 错误
//
// 用法：node scripts/verify-pools-ui.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, REPO_ROOT } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const fails = [];
let n = 0;
function check(name, cond, extra = '') {
  n++;
  if (cond) { console.log(`  ✓ ${name}`); return true; }
  fails.push(name);
  console.log(`  ✗ ${name}${extra ? '  ← ' + extra : ''}`);
  return false;
}

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  const dir = makeSandbox();
  let srv = null; let browser = null;
  try {
    const { port } = await patchSandboxConfig(dir);
    srv = await startServer(dir, port);
    const BASE = srv.base;
    console.log(`沙箱已启动 ${BASE}\n`);

    const cfgPath = path.join(dir, 'config.json');
    const getState = async () => (await fetch(`${BASE}/api/state`)).json();
    const getPools = async () => ((await (await fetch(`${BASE}/api/pools`)).json()).pools) || [];
    const put = async (url, body) => (await fetch(BASE + url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();

    browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME } : {});
    const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);

    const st0 = await getState();
    const botId = (st0.bots || [])[0].id;
    const txtOf = async (sel) => { const el = await page.$(sel); return el ? (await el.textContent()) : ''; };
    const activePoolChip = () => txtOf('.pool-chip.active');
    const activeSideItem = () => txtOf('#pool-list .side-item.active');

    // ───────────────────── ① 池切换条 ─────────────────────
    console.log('[1] 角色栏顶部池切换条');
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(900);
    check('出现了池切换条 .pool-bar', !!(await page.$('.pool-bar')));
    check('有「全部」chip', /全部/.test(await page.textContent('.pool-bar')));
    check('有「默认池」chip', /默认池/.test(await page.textContent('.pool-bar')));
    check('★★ 没有「新建池」按钮（池跟着写手生，不跟着按钮生）', !(await page.$('.pool-chip.pool-add')));
    const defChip = await page.locator('.pool-chip', { hasText: '默认池' }).first();
    check('默认池 chip 带计数 1', /1/.test(await defChip.textContent()), (await defChip.textContent()).trim());
    check('★ 默认池 chip 的 title 标出归谁',
      /归|专属池|探针写手/.test(await defChip.getAttribute('title')),
      await defChip.getAttribute('title'));
    check('「全部」默认高亮（_curPoolId 为空）', /全部/.test(await activePoolChip()),
      (await activePoolChip()).trim());
    check('「全部」视图下能看到探针角色', /探针角色/.test(await page.textContent('#main')));
    check('★ 页头说明写清「池 ↔ 写手一一对应」',
      /一一对应/.test(await page.textContent('.ch-card')), '');
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-1-bar.png') });

    // ───────────────────── ①b 侧栏池列表 ─────────────────────
    console.log('\n[1b] 侧栏池列表');
    check('侧栏有 #pool-list 容器', !!(await page.$('#pool-list')));
    const sideRows1 = await page.$$('#pool-list .side-item');
    check('1 个池时只列 1 条（不显示冗余的「全部角色」）', sideRows1.length === 1, `实际 ${sideRows1.length}`);
    let sideTxt = await page.textContent('#pool-list');
    check('侧栏列出「默认池」', /默认池/.test(sideTxt), sideTxt.replace(/\s+/g, ' ').trim());
    check('侧栏条目带角色数', /1 位角色/.test(sideTxt), sideTxt.replace(/\s+/g, ' ').trim());
    check('★★ 侧栏条目标出「归 探针写手」', /归\s*探针写手/.test(sideTxt), sideTxt.replace(/\s+/g, ' ').trim());
    check('★★ 没有「新建池」按钮 #btn-add-pool', !(await page.$('#btn-add-pool')));
    check('侧栏仍有「新建角色」按钮 #btn-add-char', !!(await page.$('#btn-add-char')));

    // ───────────────────── ② 加一位写手 → 自动有池 ─────────────────────
    console.log('\n[2] 加一位写手（走 API）→ 它自动获得专属池');
    const rawCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const b2 = {
      ...JSON.parse(JSON.stringify(rawCfg.bots[0])),
      id: 'BOT2', name: '阿雪', poolIds: [], activeCharacterIds: [], poolCharacterIds: [],
    };
    await put('/api/config', { bots: [rawCfg.bots[0], b2] });
    await page.evaluate(() => window.loadState && window.loadState());
    await page.waitForTimeout(1000);
    const P2 = ((await getPools()).find((p) => p.botName === '阿雪') || {}).id;
    check('★ 新写手自动有池（用户不用手点）', !!P2, JSON.stringify((await getPools()).map((p) => [p.id, p.botName])));
    // 切到「全部」再检查两处列表
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(800);
    const barTxt = await page.textContent('.pool-bar');
    check('切换条长出「阿雪的池」', /阿雪的池/.test(barTxt), barTxt.replace(/\s+/g, ' ').trim());
    const sideRows2 = await page.$$('#pool-list .side-item');
    check('★ 多于 1 个池后侧栏变 3 条（全部角色 + 两个池）', sideRows2.length === 3, `实际 ${sideRows2.length}`);
    sideTxt = await page.textContent('#pool-list');
    check('侧栏同时标出两位写手的名字',
      /归\s*探针写手/.test(sideTxt) && /归\s*阿雪/.test(sideTxt), sideTxt.replace(/\s+/g, ' ').trim());
    // 点侧栏跳池：顶部切换条必须同步（两处读同一份 _curPoolId）
    await page.locator('#pool-list .side-item', { hasText: '默认池' }).first().click();
    await page.waitForTimeout(700);
    check('★ 点侧栏「默认池」→ 顶部切换条同步高亮', /默认池/.test(await activePoolChip()),
      (await activePoolChip()).trim());
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-1b-sidebar.png') });

    // ───────────────────── ③ 空池 + 在当前池新建角色 ─────────────────────
    console.log('\n[3] 空池状态 + 「新建角色」落在当前池');
    await page.locator('.pool-chip', { hasText: '阿雪的池' }).first().click();
    await page.waitForTimeout(700);
    check('★ 切到阿雪的池且高亮', /阿雪的池/.test(await activePoolChip()), (await activePoolChip()).trim());
    const mainTxt = await page.textContent('#main');
    check('★ 空状态文案说的是「这个池还是空的」', /这个池还是空的/.test(mainTxt));
    check('空状态引导「换池搬过来」', /换池/.test(mainTxt));
    await page.locator('.ch-card .card-title .primary').first().click();
    await page.waitForTimeout(700);
    check('弹出角色编辑弹窗', !!(await page.$('#chr-edit-modal')));
    await page.fill('#chr-name', '小满');
    await page.fill('#chr-persona', '# 人格\n\n活泼的小满。');
    await page.locator('#chr-edit-modal .chr-modal-acts .primary').click();
    await page.waitForTimeout(1400);
    check('弹窗已关闭', !(await page.$('#chr-edit-modal')));
    const st3 = await getState();
    const xiaoman = (st3.characters || []).find((c) => c.name === '小满');
    check('角色已创建', !!xiaoman);
    check('★ 落在当前池「阿雪的池」而不是第一个池', !!xiaoman && xiaoman.poolId === P2,
      xiaoman && `poolId=${xiaoman.poolId} 期望=${P2}`);
    check('★ 归属显示成「归写手阿雪」',
      /归写手「阿雪」/.test(await page.textContent('.ch-card')),
      (await page.textContent('.ch-list')).replace(/\s+/g, ' ').slice(0, 160));
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-2-newchar.png') });

    // ───────────────────── ④ 换池下拉 ─────────────────────
    console.log('\n[4] 行尾「换池」下拉');
    check('有 .pool-sel 下拉（池数 > 1 才出现）', !!(await page.$('.pool-sel')));
    const opts = await page.$$eval('.ch-item .pool-sel option', (els) => els.map((e) => e.textContent));
    check('★ 下拉选项标出每个池归谁（否则看不出「给哪位写手」）',
      opts.some((t) => /归\s*阿雪/.test(t)) && opts.some((t) => /归\s*探针写手/.test(t)),
      JSON.stringify(opts));
    const defId = (await getPools()).find((p) => p.name === '默认池').id;
    await page.locator('.ch-item .pool-sel').first().selectOption(defId);
    await page.waitForTimeout(1400);
    const pools4 = await getPools();
    check('★ 角色换池成功：默认池变 2 位', pools4.find((p) => p.id === defId).count === 2,
      `count=${pools4.find((p) => p.id === defId).count}`);
    check('★ 原池「阿雪的池」变空', pools4.find((p) => p.id === P2).count === 0);
    const st4 = await getState();
    check('角色归属已改到默认池',
      (st4.characters.find((c) => c.name === '小满') || {}).poolId === defId);

    // ───────────────────── ⑤ 写手「角色」标签页（只读专属池）─────────────────────
    console.log('\n[5] 写手「角色」标签页：只看得到自己池里的人');
    await page.evaluate((id) => { window.selectBot(id); window.switchBotTab('characters'); }, botId);
    await page.waitForTimeout(1000);
    check('出现专属池区块 .pool-bind', !!(await page.$('.pool-bind')));
    check('★★ 没有「可点的绑定 chip」（归属不由这里决定）',
      (await page.$$('.pool-bind .pool-bind-chip')).length === 0
      || (await page.$$eval('.pool-bind .pool-bind-chip', (e) => e.map((x) => x.tagName.toLowerCase()))).every((t) => t === 'span'),
      JSON.stringify(await page.$$eval('.pool-bind .pool-bind-chip', (e) => e.map((x) => x.tagName))));
    check('专属池 chip 写的是它自己的池名',
      /默认池/.test(await page.textContent('.pool-bind')), (await page.textContent('.pool-bind')).replace(/\s+/g, ' ').slice(0, 160));
    const tabTxt = await page.textContent('#main');
    check('★ 自己池里的人都在（探针角色 / 小满）',
      /探针角色/.test(tabTxt) && /小满/.test(tabTxt), tabTxt.replace(/\s+/g, ' ').slice(0, 200));
    check('★ 池来源标记「池 · 默认池」出现两次', (await page.$$('.ch-pool-src')).length === 2,
      `实际 ${(await page.$$('.ch-pool-src')).length}`);
    check('★★ 没有「移除」按钮（角色不能不属于任何池，改归属只能换池）',
      (await page.$$('.ch-acts button[disabled]')).length === 0
      && !/移除/.test(tabTxt), tabTxt.replace(/\s+/g, ' ').slice(0, 200));
    check('★ 副标题说明「池 ↔ 写手一一对应」', /一一对应/.test(tabTxt), '');
    // 阿雪那边必须只有它自己的人（此刻它的池是空的）
    await page.evaluate(() => { window.selectBot('BOT2'); window.switchBotTab('characters'); });
    await page.waitForTimeout(900);
    const tabB = await page.textContent('#main');
    check('★★ 阿雪的角色页是空的（看不到别人的角色）',
      !/探针角色/.test(tabB) && !/小满/.test(tabB), tabB.replace(/\s+/g, ' ').slice(0, 200));
    await page.evaluate((id) => { window.selectBot(id); window.switchBotTab('characters'); }, botId);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-3-ownpool.png') });

    // ───────────────────── ⑥ 写手设置弹窗（只读，无勾选框）─────────────────────
    console.log('\n[6] 写手设置弹窗：专属池只读展示');
    await page.evaluate((id) => window.openBotSettings(id), botId);
    await page.waitForTimeout(1100);
    check('设置弹窗已打开', !!(await page.$('#bot-settings-modal')));
    const setPool = await page.$('#bot-settings-modal .chr-pool');
    check('设置里有专属角色池区块', !!setPool);
    const setTxt = setPool ? await setPool.textContent() : '';
    check('★★ 一个勾选框都没有了', (await page.$$('#bot-settings-modal .chr-pick-box')).length === 0,
      `实际 ${(await page.$$('#bot-settings-modal .chr-pick-box')).length} 个`);
    check('池里两位以只读条列出（.chr-pick.locked）',
      (await page.$$('#bot-settings-modal .chr-pick.locked')).length === 2,
      `实际 ${(await page.$$('#bot-settings-modal .chr-pick.locked')).length}`);
    check('★ 文案写清「它也只看得见这些」', /只看得见这些/.test(setTxt), setTxt.replace(/\s+/g, ' ').slice(0, 200));
    check('★ 给出「换池」入口（改归属的唯一方式）',
      /换池/.test(setTxt), setTxt.replace(/\s+/g, ' ').slice(0, 200));
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-4-settings.png') });
    await page.evaluate(() => window.closeBotSettings());
    await page.waitForTimeout(500);

    // ───────────────────── ⑦ 删池 ─────────────────────
    console.log('\n[7] 删池：有主的删不掉 / 无主的能删');
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(900);
    await page.locator('.pool-chip', { hasText: '默认池' }).first().click();
    await page.waitForTimeout(700);
    const barOwned = await page.textContent('.pool-bar');
    check('★ 有主的池：有「改名」但没有「删除池」', /改名/.test(barOwned) && !/删除池/.test(barOwned),
      barOwned.replace(/\s+/g, ' ').trim());

    // 造一个无主池：让 BOT2 释放它的池，并往池里放一位角色
    const P2b = (await getPools()).find((p) => p.name === '阿雪的池');
    await fetch(`${BASE}/api/pools/${P2b.id}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '待搬角色' }),
    });
    await put('/api/bots/BOT2/pools', { poolIds: [] });
    await page.evaluate(() => window.loadState && window.loadState());
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(800);
    const orphanRow = await page.locator('.pool-chip', { hasText: '阿雪的池' }).count();
    check('★ 释放后的池仍在切换条上（无主，不是被删了）', orphanRow >= 1, String(orphanRow));
    const sideOrphan = await page.textContent('#pool-list');
    check('★ 侧栏把它标成「无主」', /无主/.test(sideOrphan), sideOrphan.replace(/\s+/g, ' ').trim());
    await page.locator('.pool-chip', { hasText: '阿雪的池' }).first().click();
    await page.waitForTimeout(700);
    const barOrphan = await page.textContent('.pool-bar');
    check('★ 无主池：出现「删除池」按钮', /删除池/.test(barOrphan), barOrphan.replace(/\s+/g, ' ').trim());
    await page.locator('.pool-bar button', { hasText: '删除池' }).first().click();
    await page.waitForTimeout(500);
    check('★ 非空的无主池走二选一 #pool-del-modal', !!(await page.$('#pool-del-modal')));
    const delOpts = await page.$$('#pool-del-modal .pool-del-opt');
    check('二选一里有两个选项（搬走 / 一起删）', delOpts.length === 2, `实际 ${delOpts.length}`);
    check('默认选中「搬走」（安全的那条）', await page.isChecked('#pool-del-modal input[value=move]'));
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-5-delmodal.png') });
    await page.click('#pd-ok');
    await page.waitForTimeout(1600);
    const afterDel = await getPools();
    check('无主池已删除', !afterDel.some((p) => p.id === P2b.id));
    check('★ 角色被搬到别的池（没丢）',
      (await getState()).characters.some((c) => c.name === '待搬角色'),
      JSON.stringify((await getState()).characters.map((c) => c.name)));

    // ───────────────────── ⑧ JS 错误 ─────────────────────
    console.log('\n[8] JS 错误');
    check('全程无 JS 错误', errs.length === 0, errs.slice(0, 3).join(' | '));

    console.log(`\n结果：${fails.length ? '❌ ' + fails.length + ' / ' + n + ' 项失败' : '✅ 全部通过（' + n + ' 项）'}`);
    if (fails.length) console.log('失败项：', fails.join('、'));
    console.log('截图写入', SHOT);
  } finally {
    if (browser) await browser.close();
    if (srv) stopServer(srv.child);
    removeSandbox(dir);
  }
}

main()
  .then(() => { process.exitCode = fails.length ? 1 : 0; })
  .catch((e) => { console.error(e); process.exitCode = 1; });
