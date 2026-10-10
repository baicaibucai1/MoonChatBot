// 只用来给用户看图库页长什么样：上传 4 张 → 截图 → 再把引用挂上 → 截图 → 清理还原。
// 它不是断言脚本（那个是 verify-images-live.mjs），所以不做 ok/fail 统计。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PANEL || 'http://127.0.0.1:4357';
const SHOTS = path.join(HERE, 'shots');
const TMP = path.join(HERE, 'tmpimg');
const api = async (p, m = 'GET', b) => (await fetch(BASE + p, {
  method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined,
})).json();
const toDataUrl = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(TMP, f)).toString('base64');

// 先清干净
for (const it of ((await api('/api/images')).items || [])) await api(`/api/images/${encodeURIComponent(it.name)}?force=1`, 'DELETE');

const st = await api('/api/state');
const pools = (await api('/api/pools')).pools || [];
const chars = pools.flatMap((p) => p.characters || []);
const char = st.characters[st.characters.length - 1];
const origAvatar = (chars.find((c) => c.id === char.id) || {}).avatar || '';

for (const f of ['测试形象.png', '拖进来的.png', '粘贴的.png']) {
  await api('/api/images', 'POST', { name: f, data: toDataUrl(f).split(',')[1] });
}
const list = (await api('/api/images')).items || [];
// 把其中一张挂到角色卡上，好让「使用中」标记和引用文案出现在截图里
const useIt = list.find((x) => /测试形象/.test(x.name));
await api('/api/characters/' + encodeURIComponent(char.id), 'PUT', { avatar: useIt.url });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.openImages === 'function' && document.querySelector('#main'), null, { timeout: 15000 });
await page.evaluate(() => window.openImages());
await page.waitForFunction(() => document.querySelectorAll('.img-card').length >= 3, null, { timeout: 10000 });
await page.waitForTimeout(1200);   // 等缩略图解码完，免得截出白块
await page.screenshot({ path: path.join(SHOTS, 'images-page.png') });

// 选图弹窗
await page.evaluate((id) => window.openCharacterEditModal(id), char.id);
await page.waitForSelector('#chr-edit-modal', { timeout: 5000 });
await page.locator('#chr-edit-modal button:has-text("从图库选")').click();
await page.waitForSelector('#image-picker .img-card', { timeout: 8000 });
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(SHOTS, 'images-picker.png') });

// 删除保护弹窗
await page.evaluate(() => { const m = document.getElementById('image-picker'); if (m) m.remove(); });
await page.evaluate(() => { const m = document.getElementById('chr-edit-modal'); if (m) m.remove(); });
await page.evaluate(() => window.openImages());
await page.waitForSelector('#img-drop', { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll('.img-card.in-use').length === 1, null, { timeout: 8000 });
await page.waitForTimeout(600);
await page.locator('.img-card.in-use button:has-text("删除")').click();
await page.waitForSelector('#ui-confirm', { timeout: 5000 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(SHOTS, 'images-delguard.png') });
await page.locator('#ui-confirm #cf-no').click();

// 还原：摘引用 + 清图
await api('/api/characters/' + encodeURIComponent(char.id), 'PUT', { avatar: origAvatar });
for (const it of ((await api('/api/images')).items || [])) await api(`/api/images/${encodeURIComponent(it.name)}?force=1`, 'DELETE');
const left = (await api('/api/images')).items.length;
console.log('截图完成，图库已还原为', left, '张；角色形象还原为', origAvatar || '（无）');
await browser.close();
