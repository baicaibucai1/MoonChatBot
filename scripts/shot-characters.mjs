/* eslint-disable no-undef -- page.evaluate 的回调在浏览器里跑，window/document 是合法的 */
// 截图：角色标签页 + 全局角色池（跑在副本自己的服务上，端口 4358）
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

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// ★ 不能读 window.state —— 它是顶层 const，不挂 window（本项目踩过的坑）。
//   页面内的操作要用页面上真实存在的入口函数，数据从 /api/state 自己取。
const st = await (await fetch(`${BASE}/api/state`)).json();
const botId = (st.bots || [])[0].id;
const charId = (st.characters || [])[0]?.id;

// 第一个写手的「角色」标签页
await page.evaluate((id) => {
  window.selectBot(id);
  window.switchBotTab('characters');
}, botId);
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(SHOT, 'ui-characters-tab.png') });

// 全局角色池页
await page.evaluate(() => window.openCharacterPool());
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(SHOT, 'ui-character-pool.png') });

// 版本档弹窗（先造一个历史版本才有东西看）
if (charId) {
  await fetch(`${BASE}/api/characters/${encodeURIComponent(charId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ traits: '表面冷淡、内里依恋（截图用）' }),
  });
  await page.evaluate(async () => { if (window.loadCharacters) await window.loadCharacters(); });
  await page.waitForTimeout(600);
  await page.evaluate((id) => window.characterHistory(id), charId);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOT, 'ui-character-history.png') });
}

console.log('JS 错误：', errs.length ? errs.slice(0, 5) : '（无）');
console.log('截图已写入', SHOT);
await browser.close();
