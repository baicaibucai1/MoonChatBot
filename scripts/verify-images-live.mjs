// 对「正在运行的」面板（http://127.0.0.1:4357）做图床全链路的真实浏览器验证：
//   上传（点选 / 拖拽 / 粘贴）→ 图库页显示 → 角色卡选图并落盘 → 引用保护 → 删除 → 现场还原
// ★ 与沙箱验证的区别：打的是用户实际打开的那个服务，而且走的是**真实点击**，
//   能证明「用户刷新后点得动」，而不只是「接口返回对」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PANEL || 'http://127.0.0.1:4357';
const SHOTS = path.join(HERE, 'shots');
const TMP = path.join(HERE, 'tmpimg');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   -', name, extra); }
  else { fail++; console.log('  FAIL -', name, extra); }
};

let lastStatus = 0;
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  lastStatus = r.status;
  return r.json();
};
const toDataUrl = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(TMP, f)).toString('base64');

// ---------- 前置：清掉上一轮可能残留的测试图，保证从空库开始 ----------
const before = await api('/api/images');
for (const it of (before.items || [])) {
  if (/^(测试形象|拖进来的|粘贴的)-/.test(it.name)) await api(`/api/images/${encodeURIComponent(it.name)}?force=1`, 'DELETE');
}
const st0 = await api('/api/state');
// ★ /api/state 的 pools 只给 count 不给成员；完整成员在 /api/pools，扁平列表在 state.characters
const pools = (await api('/api/pools').catch(() => ({}))).pools || [];
let allChars = pools.flatMap((p) => (p.characters || []).map((c) => ({ ...c, pool: p.id || p.name })));
if (!allChars.length) allChars.push(...(st0.characters || []));
if (!allChars.length) { console.log('没有角色，无法验证「角色卡选图」'); process.exit(1); }
const char = allChars[allChars.length - 1];   // 取最后一个，尽量不动正在用的
const origAvatar = char.avatar || '';
console.log(`面板 ${BASE}\n验证角色：${char.name}（${char.id}）　原形象：${origAvatar || '（无）'}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const errors = [];
// ★ 只收真正的 JS 报错。浏览器会把「接口故意返回的 409/404」也记成 console error，
//   那是本次验证自己制造出来的预期结果，不算 bug。
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Failed to load resource/.test(t)) return;
  errors.push('console: ' + t);
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => typeof window.openImages === 'function' && document.querySelector('#main'),
  null, { timeout: 15000 },
);

// ---------- 1. 图库入口 ----------
const entryBtn = page.locator('.settings-btn', { hasText: '图库' });
ok(await entryBtn.count() > 0, '左侧有「图库」入口按钮', `（${await entryBtn.count()} 个）`);
await entryBtn.first().click();
await page.waitForSelector('#img-drop', { timeout: 5000 });
ok(await page.locator('#img-drop').count() === 1, '图库页渲染出拖拽区 #img-drop');
ok((await page.locator('h2').first().innerText()).includes('图库'), '页面标题是「图库」');
const cards0 = await page.locator('.img-card').count();
ok(cards0 === 0, '起始是空库', `（${cards0} 张）`);

// ---------- 2. 上传方式一：点选 ----------
await page.setInputFiles('#img-file', path.join(TMP, '测试形象.png'));
await page.waitForFunction(() => document.querySelectorAll('.img-card').length >= 1, null, { timeout: 10000 });
await page.waitForTimeout(300);
let cards = await page.locator('.img-card').count();
ok(cards === 1, '点选上传后出现 1 张图', `（${cards} 张）`);
const nameA = (await page.locator('.img-card .img-name').first().innerText()).trim();
ok(/^测试形象-/.test(nameA) && nameA.endsWith('.png'), '中文文件名保留、后缀正确', `→ ${nameA}`);
const metaA = await page.locator('.img-card .img-sub').first().innerText();
ok(/96\s*×\s*96/.test(metaA), '读出图片尺寸', `→ ${metaA.replace(/\s+/g, ' ')}`);
const imgOk = await page.locator('.img-card .img-thumb img').first().evaluate((el) => el.complete && el.naturalWidth === 96);
ok(imgOk, '缩略图真的加载出来了（不是碎图）');
await page.screenshot({ path: path.join(SHOTS, 'live-images-1-uploaded.png') });

// ---------- 3. 上传方式二：拖拽 ----------
await page.evaluate(async ({ fname, dataUrl }) => {
  const bin = atob(dataUrl.split(',')[1]);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const file = new File([u8], fname, { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const el = document.getElementById('img-drop');
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const on = el.classList.contains('dz-on');
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return on;
}, { fname: '拖进来的.png', dataUrl: toDataUrl('拖进来的.png') });
await page.waitForFunction(() => document.querySelectorAll('.img-card').length >= 2, null, { timeout: 10000 });
ok(true, '拖拽上传成功（第 2 张）');

// ---------- 4. 上传方式三：粘贴 ----------
await page.evaluate(async ({ fname, dataUrl }) => {
  const bin = atob(dataUrl.split(',')[1]);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const file = new File([u8], fname, { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
}, { fname: '粘贴的.png', dataUrl: toDataUrl('粘贴的.png') });
await page.waitForFunction(() => document.querySelectorAll('.img-card').length >= 3, null, { timeout: 10000 });
cards = await page.locator('.img-card').count();
ok(cards === 3, '粘贴上传成功（第 3 张）', `（共 ${cards} 张）`);
await page.screenshot({ path: path.join(SHOTS, 'live-images-3-three.png') });

// ---------- 5. 搜索过滤 ----------
await page.fill('#img-search', '拖进来');
await page.waitForTimeout(200);
const filtered = await page.locator('.img-card').count();
ok(filtered === 1, '搜索框按文件名过滤（不重新拉接口）', `（剩 ${filtered} 张）`);
await page.fill('#img-search', '');
await page.waitForTimeout(200);

// ---------- 6. 角色卡：从图库选 → 保存落盘 ----------
await page.evaluate((id) => window.openCharacterEditModal(id), char.id);
await page.waitForSelector('#chr-edit-modal', { timeout: 5000 });
ok(await page.locator('#chr-avatar').count() === 1, '角色卡里有「形象链接」输入框');
ok(await page.locator('#chr-edit-modal button:has-text("从图库选")').count() === 1, '角色卡里有「从图库选」按钮');
await page.locator('#chr-edit-modal button:has-text("从图库选")').click();
await page.waitForSelector('#image-picker .img-card', { timeout: 8000 });
const pickCards = await page.locator('#image-picker .img-card').count();
ok(pickCards === 3, '选图弹窗列出全部 3 张', `（${pickCards} 张）`);
await page.screenshot({ path: path.join(SHOTS, 'live-images-picker.png') });

const targetName = nameA;
await page.locator('#image-picker .img-card', { hasText: targetName }).locator('.img-thumb').click();
await page.waitForTimeout(400);
const avVal = await page.inputValue('#chr-avatar');
ok(avVal === '/images/' + targetName, '选完把链接填进输入框', `→ ${avVal}`);
ok(await page.locator('#chr-avatar-pv img').count() === 1, '输入框旁边出现预览小图');
ok(await page.locator('#image-picker').count() === 0, '选完弹窗自动关闭');

await page.locator('#chr-edit-modal button:has-text("保存修改")').click();
await page.waitForTimeout(900);
const after = await api('/api/characters/' + encodeURIComponent(char.id));
ok(after.character && after.character.avatar === '/images/' + targetName,
  '点「保存修改」后真的落盘了', `→ ${after.character && after.character.avatar}`);
await page.screenshot({ path: path.join(SHOTS, 'live-images-charsaved.png') });
await page.evaluate(() => { const m = document.getElementById('chr-edit-modal'); if (m) m.remove(); });

// ---------- 7. 引用保护 ----------
await page.evaluate(() => window.openImages());
await page.waitForSelector('#img-drop', { timeout: 5000 });
await page.waitForFunction(() => document.querySelectorAll('.img-card').length >= 3, null, { timeout: 8000 });
const inUse = await page.locator('.img-card.in-use').count();
ok(inUse === 1, '被角色卡引用的那张有「使用中」标记', `（${inUse} 张）`);
const refsTxt = await page.locator('.img-card.in-use .img-refs').first().innerText();
ok(refsTxt.includes(char.name), '标记里写清楚了是谁在用', `→ ${refsTxt.trim()}`);

// API 侧：不带 force 删除应被拦下
const guarded = await api(`/api/images/${encodeURIComponent(targetName)}`, 'DELETE');
ok(lastStatus === 409 && guarded.ok === false && (guarded.refs || []).length === 1,
  '不带 force 的删除被 409 拦下', `（HTTP ${lastStatus}）`);

// UI 侧：点删除 → 弹「这张图还在用」→ 确认 → 才真删
await page.locator('.img-card.in-use button:has-text("删除")').click();
await page.waitForSelector('#ui-confirm', { timeout: 5000 });
const cfText = await page.locator('#ui-confirm .confirm-text').innerText();
ok(cfText.includes('死链'), '删除前先警告会变成死链', `→ ${cfText.split('\n')[1] || cfText.slice(0, 30)}`);
ok(await page.locator('#ui-confirm #cf-ok').innerText() === '仍然删除', '确认按钮是「仍然删除」（不是普通确定）');
await page.screenshot({ path: path.join(SHOTS, 'live-images-delguard.png') });
await page.locator('#ui-confirm #cf-ok').click();
await page.waitForFunction(() => document.querySelectorAll('.img-card').length === 2, null, { timeout: 8000 });
ok(true, '确认后确实删除了');
const gone = await api('/api/images/' + encodeURIComponent(targetName));
ok(gone.ok === false, '文件在服务端也没了');
// ★ 自动摘引用 = 偷偷改用户数据，这里必须保持「死链」而不是被清空
const stillRef = await api('/api/characters/' + encodeURIComponent(char.id));
ok(stillRef.character && stillRef.character.avatar === '/images/' + targetName,
  '没有偷偷把角色卡的引用摘掉（留成死链，由用户自己改）');

// ---------- 8. 还原角色卡 + 清空测试图 ----------
await page.evaluate((id) => window.openCharacterEditModal(id), char.id);
await page.waitForSelector('#chr-edit-modal', { timeout: 5000 });
await page.fill('#chr-avatar', origAvatar);
await page.locator('#chr-edit-modal button:has-text("保存修改")').click();
await page.waitForTimeout(900);
const restored = await api('/api/characters/' + encodeURIComponent(char.id));
ok(restored.character && (restored.character.avatar || '') === origAvatar, '角色卡形象已还原', `→ ${restored.character && (restored.character.avatar || '（无）')}`);
await page.evaluate(() => { const m = document.getElementById('chr-edit-modal'); if (m) m.remove(); });

await page.evaluate(() => window.openImages());
await page.waitForSelector('#img-drop', { timeout: 5000 });
await page.waitForTimeout(400);
for (let i = 0; i < 5; i++) {
  const n = await page.locator('.img-card').count();
  if (!n) break;
  await page.locator('.img-card button:has-text("删除")').first().click();
  await page.waitForTimeout(700);
}
const left = await page.locator('.img-card').count();
ok(left === 0, '测试图已全部清掉，图库回到空', `（剩 ${left} 张）`);
const diskLeft = fs.readdirSync(path.join(HERE, '..', 'images')).length;
ok(diskLeft === 0, 'images/ 目录里也没留残余文件', `（${diskLeft} 个）`);

// ---------- 9. 收尾 ----------
ok(errors.length === 0, '整轮操作没有 JS 报错', errors.length ? `→ ${errors.slice(0, 3).join(' | ')}` : '');
await page.screenshot({ path: path.join(SHOTS, 'live-images-final.png') });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
