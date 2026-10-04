// 真机探针（前端）：在真实面板里发一句话，看管理员到底输出到哪儿断掉 / 有没有触发二次模型调用
// 用法：node scripts/probe-admin-ui.mjs "问的话"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { REPO_ROOT } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const ASK = process.argv[2] || '帮我看一下现在面板的整体状态，再给我三条改进建议';
const BASE = process.argv[3] || 'http://127.0.0.1:4358';

fs.mkdirSync(SHOT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
const reqs = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('/api/admin/')) reqs.push({ t: Date.now(), url: u.replace(BASE, '') });
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => window.openAdminPanel && window.openAdminPanel());
await page.waitForTimeout(1000);

const t0 = Date.now();
await page.fill('#admin-input', ASK);
await page.evaluate(() => window.adminSend());

// 每 500ms 采样一次「已渲染的正文长度」，直到 30s
const samples = [];
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  const len = await page.evaluate(() => {
    const el = document.querySelector('#admin-msgs .admin-msg.ai .admin-bubble.md');
    return el ? el.textContent.length : 0;
  });
  samples.push({ ms: Date.now() - t0, len });
  if (i > 4 && samples.length > 4 && len > 0 && samples[samples.length - 2].len === len && Date.now() - t0 > 8000) break;
}

const finalText = await page.evaluate(() => {
  const el = document.querySelector('#admin-msgs .admin-msg.ai .admin-bubble.md');
  return el ? el.textContent : '(无气泡)';
});
console.log('\n=== 管理员请求记录 ===');
for (const r of reqs) console.log('  +' + (r.t - t0) + 'ms  ' + r.url);
console.log('\n=== 正文长度采样（前 20）===');
console.log(samples.slice(0, 20).map((s) => `${s.ms}ms:${s.len}`).join('  '));
console.log('\n=== 最终气泡文本（末尾 300 字）===');
console.log(finalText.slice(-300));
console.log('\n=== JS 错误 ===');
console.log(errs.length ? errs.slice(0, 5).join('\n') : '(无)');
await page.screenshot({ path: path.join(SHOT, 'probe-admin-ui.png'), fullPage: false });
console.log('\n截图：' + path.join(SHOT, 'probe-admin-ui.png'));
await browser.close();
process.exit(0);
