// 真机验证：多角色池的前端 UI（角色栏 + 写手标签页 + 写手设置弹窗）
//
// 为什么必须用真浏览器：
//   本轮前端改的是**模板字符串 + 内联 onclick**，语法检查（node --check）只能证明
//   「文件能解析」，证明不了：
//     · poolBarHtml 真的被插进了卡片头部（不是写了函数却忘了用）
//     · 池切换后重绘的是列表而不是整个页面（否则搜索框每敲一个字就失焦）
//     · 行尾「换池」下拉真的把角色搬过去了（POST /api/pools/move 走了没）
//     · 池给的勾选项**真的被锁死**（disabled + checked）—— 否则用户取消勾选保存后
//       同步又把它加回来，看起来像「取消勾选没用」
//     · 删池的三选一弹窗真的出来了（池非空时必须让人明确选「搬走」还是「一起删」）
//   这些只有真机点一遍才知道。
//
// 验证点：
//   ① 角色栏顶部池切换条：全部 / 每个池 / 新建池，计数正确
//   ② 新建池（走真弹窗输入，不是直接调 API）
//   ③ 池空时的空状态文案 + 「新建角色」落在**当前池**（不是第一个池）
//   ④ 行尾「换池」下拉把角色搬走，两边计数同步变化
//   ⑤ 写手「角色」标签页：绑定条存在、点一下即批量绑池、池给的角色标「池 · xxx」且不可单独移除
//   ⑥ 写手设置弹窗：池给的勾选项被锁死（disabled + checked），勾选集里也有绑定条
//   ⑦ 删池：空池走确认框；非空池走三选一（搬走 / 一起删）
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

    const getState = async () => (await fetch(`${BASE}/api/state`)).json();
    const getPools = async () => ((await (await fetch(`${BASE}/api/pools`)).json()).pools) || [];

    browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME } : {});
    const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);

    const st0 = await getState();
    const botId = (st0.bots || [])[0].id;
    // 取文本的「可能不存在」版本：断言失败时要报 ✗，不能因为选择器等不到而直接抛异常
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
    check('有「新建池」按钮', !!(await page.$('.pool-chip.pool-add')));
    const allChip = await page.textContent('.pool-chip.active');
    check('「全部」默认高亮（_curPoolId 为空）', /全部/.test(allChip), allChip.trim());
    const defChipTxt = await page.locator('.pool-chip', { hasText: '默认池' }).first().textContent();
    check('默认池 chip 带计数 1', /1/.test(defChipTxt), defChipTxt.trim());
    check('「全部」视图下能看到探针角色', /探针角色/.test(await page.textContent('#main')));
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-1-bar.png') });

    // ───────────────────── ①b 侧栏池列表 ─────────────────────
    // 侧栏原本只有一条写死的「角色池」，多池之后必须按池列出来。
    console.log('\n[1b] 侧栏池列表');
    check('侧栏有 #pool-list 容器', !!(await page.$('#pool-list')));
    const sideRows1 = await page.$$('#pool-list .side-item');
    check('1 个池时只列 1 条（不显示冗余的「全部角色」）', sideRows1.length === 1, `实际 ${sideRows1.length}`);
    let sideTxt = await page.textContent('#pool-list');
    check('侧栏列出「默认池」', /默认池/.test(sideTxt), sideTxt.replace(/\s+/g, ' ').trim());
    check('侧栏条目带角色数', /1 位角色/.test(sideTxt), sideTxt.replace(/\s+/g, ' ').trim());
    check('侧栏有「新建池」按钮 #btn-add-pool', !!(await page.$('#btn-add-pool')));
    check('侧栏仍有「新建角色」按钮 #btn-add-char', !!(await page.$('#btn-add-char')));
    // 侧栏的新建池按钮要真的接上（打开后取消，不留副作用）
    await page.click('#btn-add-pool');
    await page.waitForTimeout(500);
    check('★ 侧栏「新建池」按钮真的弹出输入框', !!(await page.$('#ui-prompt')));
    await page.click('#pf-no');
    await page.waitForTimeout(400);

    // ───────────────────── ② 新建池（真弹窗）─────────────────────
    console.log('\n[2] 新建池（真弹窗输入）');
    await page.click('.pool-chip.pool-add');
    await page.waitForTimeout(400);
    check('弹出输入框 #ui-prompt', !!(await page.$('#ui-prompt')));
    await page.fill('#pf-input', '校园组');
    await page.click('#pf-ok');
    await page.waitForTimeout(1000);
    check('新池出现在切换条', /校园组/.test(await page.textContent('.pool-bar')));
    const active2 = await page.textContent('.pool-chip.active');
    check('★ 新建后自动切到新池（不是留在「全部」）', /校园组/.test(active2), active2.trim());
    const pools2 = await getPools();
    check('后端真的多了一个池（共 2 个）', pools2.length === 2, `实际 ${pools2.length}`);
    const CAMP = (pools2.find((p) => p.name === '校园组') || {}).id;
    check('新池是空的（count 0）', pools2.find((p) => p.name === '校园组').count === 0);
    const sideRows2 = await page.$$('#pool-list .side-item');
    check('★ 多于 1 个池后侧栏变 3 条（全部角色 + 默认池 + 校园组）', sideRows2.length === 3, `实际 ${sideRows2.length}`);
    sideTxt = await page.textContent('#pool-list');
    check('侧栏出现「全部角色」总览', /全部角色/.test(sideTxt));
    check('★ 侧栏也跟着高亮当前池（校园组）', /校园组/.test(await activeSideItem()),
      (await activeSideItem()).trim());
    // ★ 点侧栏跳池：顶部切换条必须同步 —— 两处读的是同一份 _curPoolId，不能各说各话
    await page.locator('#pool-list .side-item', { hasText: '默认池' }).first().click();
    await page.waitForTimeout(700);
    check('★ 点侧栏「默认池」→ 顶部切换条同步高亮', /默认池/.test(await activePoolChip()),
      (await activePoolChip()).trim());
    check('★ 侧栏该条也高亮', /默认池/.test(await activeSideItem()));
    await page.locator('#pool-list .side-item', { hasText: '全部角色' }).first().click();
    await page.waitForTimeout(700);
    check('★ 点侧栏「全部角色」→ 切回跨池总览',
      /全部/.test(await activePoolChip())
      && /探针角色/.test(await page.textContent('#main')));
    // 切回校园组，保持后续用例的前置状态
    await page.locator('#pool-list .side-item', { hasText: '校园组' }).first().click();
    await page.waitForTimeout(700);
    check('★ 切回校园组（后续用例的前置状态）', /校园组/.test(await activePoolChip()));
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-1b-sidebar.png') });

    // ───────────────────── ③ 空状态 + 在池内新建角色 ─────────────────────
    console.log('\n[3] 空池状态 + 「新建角色」落在当前池');
    const mainTxt = await page.textContent('#main');
    check('★ 空状态文案说的是「这个池还是空的」', /这个池还是空的/.test(mainTxt));
    check('空状态引导「换池搬过来」', /换池/.test(mainTxt));
    // 点卡片标题里的「新建角色」
    await page.locator('.ch-card .card-title .primary').first().click();
    await page.waitForTimeout(700);
    check('弹出角色编辑弹窗', !!(await page.$('#chr-edit-modal')));
    await page.fill('#chr-name', '小满');
    await page.fill('#chr-persona', '# 人格\n\n活泼的小满。');
    await page.locator('#chr-edit-modal .chr-modal-acts .primary').click();
    await page.waitForTimeout(1200);
    check('弹窗已关闭', !(await page.$('#chr-edit-modal')));
    const st3 = await getState();
    const xiaoman = (st3.characters || []).find((c) => c.name === '小满');
    check('角色已创建', !!xiaoman);
    check('★ 落在当前池「校园组」而不是第一个池', !!xiaoman && xiaoman.poolId === CAMP,
      xiaoman && `poolId=${xiaoman.poolId} 期望=${CAMP}`);
    check('当前池 chip 计数变成 1',
      /1/.test(await page.locator('.pool-chip', { hasText: '校园组' }).first().textContent()));
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-2-newchar.png') });

    // ───────────────────── ④ 换池下拉 ─────────────────────
    console.log('\n[4] 行尾「换池」下拉');
    check('有 .pool-sel 下拉（池数 > 1 才出现）', !!(await page.$('.pool-sel')));
    const defId = (await getPools()).find((p) => p.name === '默认池').id;
    // 选中「默认池」触发 onchange → poolMoveChar
    await page.locator('.ch-item .pool-sel').first().selectOption(defId);
    await page.waitForTimeout(1200);
    const pools4 = await getPools();
    check('★ 角色换池成功：默认池变 2 位', pools4.find((p) => p.id === defId).count === 2,
      `count=${pools4.find((p) => p.id === defId).count}`);
    check('★ 原池「校园组」变空', pools4.find((p) => p.id === CAMP).count === 0);
    const st4 = await getState();
    check('角色归属已改到默认池',
      (st4.characters.find((c) => c.name === '小满') || {}).poolId === defId);

    // ───────────────────── ⑤ 写手标签页：绑池 ─────────────────────
    console.log('\n[5] 写手「角色」标签页绑池');
    await page.evaluate((id) => { window.selectBot(id); window.switchBotTab('characters'); }, botId);
    await page.waitForTimeout(1000);
    check('出现绑定条 .pool-bind', !!(await page.$('.pool-bind')));
    const chips = await page.$$('.pool-bind-chip');
    check('绑定条里每个池一个 chip', chips.length === 2, `实际 ${chips.length}`);
    // 绑「默认池」（此时有 2 位：探针角色 + 小满）
    await page.locator('.pool-bind-chip', { hasText: '默认池' }).first().click();
    await page.waitForTimeout(1400);
    const st5 = await getState();
    const b5 = st5.bots.find((x) => x.id === botId);
    check('★ 绑池成功：poolIds 含默认池', (b5.poolIds || []).includes(defId), JSON.stringify(b5.poolIds));
    check('★ 整池角色一次性进 activeCharacterIds（2 位）',
      (b5.activeCharacterIds || []).length === 2, JSON.stringify(b5.activeCharacterIds));
    check('绑上的 chip 有 .on 高亮',
      /默认池/.test(await page.textContent('.pool-bind-chip.on')), '');
    const tabTxt = await page.textContent('#main');
    check('★ 池给的两位带「池 · 默认池」标记', (await page.$$('.ch-pool-src')).length === 2,
      `实际 ${(await page.$$('.ch-pool-src')).length} 个`);
    const disabledActs = await page.$$('.ch-acts button[disabled]');
    check('★ 池给的角色没有「移除」按钮（点也没用，会被同步回来）', disabledActs.length === 2,
      `实际 ${disabledActs.length} 个禁用按钮`);
    check('禁用按钮的说明写了「池给的」', /池给的/.test(tabTxt));
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-3-bind.png') });

    // ───────────────────── ⑥ 写手设置弹窗：锁死勾选 ─────────────────────
    console.log('\n[6] 写手设置弹窗里池给的勾选项被锁死');
    await page.evaluate((id) => window.openBotSettings(id), botId);
    await page.waitForTimeout(1100);
    check('设置弹窗已打开', !!(await page.$('#bot-settings-modal')));
    check('设置里有角色池区块', !!(await page.$('#bot-settings-modal .chr-pool')));
    check('设置里也有绑定条', !!(await page.$('#bot-settings-modal .chr-pool .pool-bind')));
    const locked = await page.$$('#bot-settings-modal .chr-pick.locked');
    check('★ 池给的两位被标 locked', locked.length === 2, `实际 ${locked.length}`);
    const lockedBoxState = await page.$$eval('#bot-settings-modal .chr-pick.locked input[type=checkbox]',
      (els) => els.map((e) => ({ checked: e.checked, disabled: e.disabled })));
    check('★ locked 的勾选框是 checked + disabled（取消不掉，避免「取消勾选没用」）',
      lockedBoxState.length === 2 && lockedBoxState.every((s) => s.checked && s.disabled),
      JSON.stringify(lockedBoxState));
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-4-settings.png') });
    await page.evaluate(() => window.closeBotSettings());
    await page.waitForTimeout(500);

    // ───────────────────── ⑦ 删池 ─────────────────────
    console.log('\n[7] 删池（空池走确认框 / 非空池走三选一）');
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(900);
    // 7a：校园组此刻是空的 → 走普通确认框
    await page.locator('.pool-chip', { hasText: '校园组' }).first().click();
    await page.waitForTimeout(700);
    check('切到校园组后出现「删除池」按钮', /删除池/.test(await page.textContent('.pool-bar')));
    await page.locator('.pool-bar button', { hasText: '删除池' }).first().click();
    await page.waitForTimeout(500);
    check('空池走普通确认框 #ui-confirm', !!(await page.$('#ui-confirm')));
    await page.click('#cf-ok');
    await page.waitForTimeout(1200);
    check('校园组已从切换条消失', !/校园组/.test(await page.textContent('.pool-bar')));
    check('后端只剩 1 个池', (await getPools()).length === 1, `实际 ${(await getPools()).length}`);

    // 7b：建一个有角色的池，删的时候必须弹三选一
    await page.click('.pool-chip.pool-add');
    await page.waitForTimeout(400);
    await page.fill('#pf-input', '临时组');
    await page.click('#pf-ok');
    await page.waitForTimeout(1000);
    const TMP = (await getPools()).find((p) => p.name === '临时组').id;
    await page.locator('.ch-card .card-title .primary').first().click();
    await page.waitForTimeout(700);
    await page.fill('#chr-name', '待搬角色');
    await page.locator('#chr-edit-modal .chr-modal-acts .primary').click();
    await page.waitForTimeout(1200);
    check('临时组里有 1 位', (await getPools()).find((p) => p.id === TMP).count === 1);
    await page.locator('.pool-bar button', { hasText: '删除池' }).first().click();
    await page.waitForTimeout(500);
    check('★ 非空池弹出三选一 #pool-del-modal', !!(await page.$('#pool-del-modal')));
    const opts = await page.$$('#pool-del-modal .pool-del-opt');
    check('三选一里有两个选项（搬走 / 一起删）', opts.length === 2, `实际 ${opts.length}`);
    check('默认选中「搬走」（安全的那条）',
      await page.isChecked('#pool-del-modal input[value=move]'));
    await page.screenshot({ path: path.join(SHOT, 'verify-pools-5-delmodal.png') });
    await page.click('#pd-ok');
    await page.waitForTimeout(1400);
    const afterDel = await getPools();
    check('临时组已删除', !afterDel.some((p) => p.id === TMP));
    check('★ 角色被搬到剩余池（没丢）',
      afterDel[0].characters.some((c) => c.name === '待搬角色'),
      JSON.stringify(afterDel[0].characters.map((c) => c.name)));

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
