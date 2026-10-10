// 截「刚打开面板」的样子：默认落到的那一页，以及点开第一个写手后的对话页。
// 只是给用户看的图，不做断言。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PANEL || 'http://127.0.0.1:4357';
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const api = async (p) => (await fetch(BASE + p)).json();
const st = await api('/api/state');
const bot = st.bots[0];
console.log('默认写手：', bot.name || bot.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
// 等到前端把首屏画完（不是只等到 DOM 就绪）
await page.waitForFunction(
  () => typeof window.selectBot === 'function' && document.querySelector('#main'),
  null, { timeout: 15000 },
);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(SHOTS, 'startup-home.png') });

// 侧边栏单独一张，看得清入口
const side = await page.$('#sidebar, .sidebar, aside, nav');
if (side) await side.screenshot({ path: path.join(SHOTS, 'startup-sidebar.png') });

console.log('截图完成 → scripts/shots/startup-home.png');
await browser.close();
