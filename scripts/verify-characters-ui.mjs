// 真机验证：写手卡 / 角色池 UI 阶段
//   ① 侧栏措辞已改成「写手」（不再叫「角色」）
//   ② 写手卡的「角色」标签页：显示自己池里的人（只读，改归属走换池）
//   ③ 全局角色池页：搜索 / 新建 / 归谁（池 ↔ 写手 1:1）
//   ④ 版本档弹窗 + 回滚（回滚后角色设定真的变回去，且回滚本身也留档）
//   ⑤ 全程无 JS 错误
//
// 跑在副本服务上（端口 4358；服务已在跑，静态文件按请求读盘）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:4358';
const SHOT = path.join(HERE, 'shots');
fs.mkdirSync(SHOT, { recursive: true });

const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const launchOpts = fs.existsSync(CHROME) ? { executablePath: CHROME } : {};

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getState = async () => (await fetch(`${BASE}/api/state`)).json();
const putChar = async (id, body) => {
  const r = await fetch(`${BASE}/api/characters/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const st0 = await getState();
const botId = (st0.bots || [])[0].id;
let charId = (st0.characters || [])[0]?.id;

console.log('\n[1] 侧栏措辞：写手 / 角色池');
{
  const sideLabel = await page.textContent('.side-group .side-label span');
  ok(sideLabel.trim() === '写手', `左上角分组标题 = 「写手」（实际「${sideLabel.trim()}」）`);
  const addTitle = await page.getAttribute('#btn-add-bot', 'title');
  ok(addTitle === '添加写手', `添加按钮 title = 「添加写手」（实际「${addTitle}」）`);
  const sideText = await page.textContent('body');
  ok(!/暂无角色/.test(sideText), '不再出现「暂无角色」');
  const poolOk = /角色池/.test(sideText);
  ok(poolOk, '侧栏存在「角色池」分组');
}

console.log('\n[2] 写手卡的「角色」标签页');
{
  await page.evaluate((id) => { window.selectBot(id); window.switchBotTab('characters'); }, botId);
  await page.waitForTimeout(900);
  const body = await page.textContent('#main');
  ok(/写手的角色/.test(body), '标题 = 「写手的角色」');
  // ★ 1:1 之后这里报的是「自己池里 N 位 · 池「…」」——不再有「已选 x / 池中 y」
  //   （「池中」那个数是**全局**角色总数，等于告诉写手「你池子外还有别人的人物」）。
  ok(charId ? /\d+\s*位[\s\S]{0,6}池「/.test(body) : true,
    '显示角色计数（N 位 · 池「…」）');
  ok(charId ? !/已选|池中/.test(body) : true,
    '★ 不再出现「已选 / 池中」这类全局口径');
  // ★ 摘要里不该再出现 Markdown 井号（persona 常以 `# 人格` 开头）
  const snip = await page.$('.ch-snippet');
  if (snip) {
    const txt = (await snip.textContent()).trim();
    ok(!/^\s*#/.test(txt) && !/##/.test(txt), `简介摘要已剥掉 Markdown 井号（「${txt.slice(0, 24)}…」）`);
  }
  await page.screenshot({ path: path.join(SHOT, 'verify-writer-characters-tab.png') });
}

console.log('\n[3] 全局角色池页');
{
  await page.evaluate(() => window.openCharacterPool());
  await page.waitForTimeout(900);
  const body = await page.textContent('#main');
  ok(/角色池/.test(body), '标题 = 「角色池」');
  ok(!!(await page.$('#chr-search')), '有搜索框');
  ok(/写手/.test(body), '文案里说明了它跟写手的关系');

  // ★★ 回归（2026-10-08 实机抓到的 bug）：角色卡上的「归谁」必须对得上接口。
  //   成因：openCharacterPool() 只 loadPools() 却不 loadCharacters()，而 /api/state 那份
  //   characters **不带归属**（ownerName 只在 /api/characters 里）→ 每张卡都写
  //   「还没有写手选用」；更糟的是删一位正被写手用着的角色不弹警告，但接口照样会
  //   把它从池里摘掉。
  //   ★ 1:1 之后措辞从「被 X 使用」改成「归写手「X」」—— 每个角色只归一位写手，
  //     UI 读的是**池的主人**（不再读 usedBy，那是会被 /api/state 覆盖掉的旧字段）。
  //   ⚠ 本文件顶部的注释一直宣称覆盖「归谁」，可此前**一条断言都没有** ——
  //     空喊覆盖比不覆盖更坏。这里改成拿接口的值逐卡比对。
  const rich = await (await fetch(`${BASE}/api/characters`)).json();
  const wantUse = new Map((rich.characters || []).map((c) => [c.id, (c.usedBy || []).map((u) => u.name)]));
  const cards = await page.$$eval('#main .ch-item', (els) => els.map((e) => ({
    id: ((e.querySelector('.ch-id') || {}).textContent || '').trim(),
    used: ((e.querySelector('.ch-usedby') || {}).textContent || '').trim(),
  })));
  ok(cards.length > 0, `渲染出 ${cards.length} 张角色卡`);
  const usedCards = cards.filter((c) => (wantUse.get(c.id) || []).length);
  if (!usedCards.length) {
    console.log('  · 没有归写手的角色，跳过比对（先把角色换池给某位写手再跑）');
  } else {
    ok(usedCards.every((c) => /^归写手「.+」$/.test(c.used)),
      `归写手的角色卡写着「归写手「…」」（实际：${usedCards.map((c) => c.used).join(' / ')}）`);
    ok(usedCards.every((c) => (wantUse.get(c.id) || []).every((n) => c.used.includes(n))),
      '卡上列出的写手名与接口一致');
    const idle = cards.find((c) => !(wantUse.get(c.id) || []).length);
    if (idle) ok(/无主|没有写手看得见/.test(idle.used), `无主的角色标成「所属池无主」（实际：${idle.used}）`);

    // ★ 同一个根因的第二个症状，也是更危险的那个：删一位**归某位写手**的角色，
    //   确认框必须点出那位写手 —— 否则用户以为删了就删了，实际那个池里也被摘掉了。
    //   这里只打开确认框看一眼再取消，不真删。
    // ⚠ characterDelete() 返回的 Promise 要等用户点按钮才 resolve，所以这里
    //   绝不能把它的返回值交给 page.evaluate（那样会一直等下去 → 探针卡死）。
    //   用带花括号的箭头函数不返回任何东西，evaluate 立刻收工。
    await page.evaluate((id) => { window.characterDelete(id); }, usedCards[0].id);
    await page.waitForSelector('#ui-confirm', { timeout: 3000 }).catch(() => {});
    const dlg = ((await page.textContent('#ui-confirm').catch(() => '')) || '')
      .replace(/\s+/g, ' ');
    ok(/归写手/.test(dlg), `删除确认框点出了它的主人（实际：${dlg.slice(0, 90)}）`);
    const names = wantUse.get(usedCards[0].id) || [];
    ok(names.every((n) => dlg.includes(n)), `确认框列出的写手名与接口一致（${names.join('、')}）`);
    await page.click('#ui-confirm #cf-no').catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: path.join(SHOT, 'verify-character-pool.png') });
}

console.log('\n[4] 版本档 + 回滚');
if (!charId) {
  console.log('  · 池中无角色，跳过（先建一个再跑）');
} else {
  const before = (await getState()).characters.find(c => c.id === charId);
  const histBefore = (before.history || []).length;
  // 造一个历史版本（改 traits，与原值不同）
  const upd = await putChar(charId, { traits: '真机验证：改一次 traits' });
  ok(upd.ok === true, 'PUT 改 traits 成功');
  const afterUpd = (await getState()).characters.find(c => c.id === charId);
  ok((afterUpd.history || []).length === histBefore + 1,
    `改后版本档 +1（${histBefore} → ${(afterUpd.history || []).length}）`);
  const last = afterUpd.history[afterUpd.history.length - 1];
  ok(last.by === 'user', '版本档 by=user');
  ok(Array.isArray(last.changed) && last.changed.includes('traits'), '版本档记录了被改的字段 traits');

  // 打开版本档弹窗
  await page.evaluate(async (id) => { window.selectBot(id); await window.loadCharacters(); }, botId);
  await page.waitForTimeout(400);
  await page.evaluate((id) => window.characterHistory(id), charId);
  await page.waitForTimeout(900);
  ok(!!(await page.$('.chr-hist-modal')), '版本档弹窗可见');
  ok(!!(await page.$('.chr-hist-field')), '弹窗里按字段列出「改前是什么」');
  await page.screenshot({ path: path.join(SHOT, 'verify-character-history.png') });

  // 点最新一版的「回滚到此版本」
  const rb = await page.$('.chr-hist-modal button[onclick*="characterRollback"]');
  if (rb) {
    await rb.click();
    await page.waitForTimeout(500);
    // 回滚有二次确认弹窗
    const confirmBtn = await page.$('.modal-overlay:not(.chr-hist-modal) button.primary, #ui-confirm button.primary');
    if (confirmBtn) { await confirmBtn.click(); await page.waitForTimeout(1200); }
    const rolled = (await getState()).characters.find(c => c.id === charId);
    ok(rolled.traits !== afterUpd.traits, '回滚后 traits 变回历史值');
    ok((rolled.history || []).length > (afterUpd.history || []).length, '回滚本身也留了档');
  } else {
    ok(false, '找不到回滚按钮');
  }
}

console.log('\n[5] JS 错误');
ok(errs.length === 0, `无 JS 错误${errs.length ? '：' + errs.slice(0, 3).join(' | ') : ''}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log('截图写入', SHOT);
await browser.close();
process.exit(fail ? 1 : 0);
