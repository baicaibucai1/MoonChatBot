// 对「正在运行的」面板（http://127.0.0.1:4357）做真实浏览器验证。
// ★ 与沙箱验证不同：这里打的是用户实际打开的那个服务，
//   所以它能证明「用户刷新后到底看不看得到」，而不是「代码看起来对」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PANEL || 'http://127.0.0.1:4357';
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   -', name, extra); }
  else { fail++; console.log('  FAIL -', name, extra); }
};

async function api(pathname, method = 'GET', body) {
  const r = await fetch(BASE + pathname, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

const st = await api('/api/state');
const bots = st.bots || [];
if (!bots.length) { console.log('没有写手，无法验证'); process.exit(1); }
// 优先挑「测试账号」这类非主力写手，避免验证过程动到在用的配置
const bot = bots.find((b) => /测试/.test(b.name || b.id)) || bots[0];
console.log(`面板 ${BASE}　验证写手：${bot.name || bot.id}（当前模型 ${bot.modelId || '未绑定'}）`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
// ★ 不能用 window.state 判断就绪：app.js 里是 `let state`（顶层 let/const 不挂 window），
//   只能改成等侧栏渲染出来 + 等函数声明可用（function 声明才在 window 上）。
await page.waitForFunction(() => typeof window.selectBot === 'function' && document.querySelector('#sidebar, .sidebar, nav, aside'), null, { timeout: 20000 });
await page.waitForTimeout(800);
// 进对话页
await page.evaluate((id) => window.selectBot(id, 'chat'), bot.id);
await page.waitForSelector('#chat-caps', { timeout: 10000 });
await page.waitForTimeout(600);

console.log('\n== 一、三块是否已搬进右栏 ==');
const where = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const caps = q('#chat-caps');
  const p = q('#chat-progress'), ps = q('#pending-strip'), sl = q('#sync-line');
  return {
    hasCaps: !!caps,
    parents: [p, ps, sl].map((n) => (n ? n.parentElement.id || n.parentElement.className : '(不存在)')),
    inMain: !!document.querySelector('.chat-main #chat-progress, .chat-main #pending-strip, .chat-main #sync-line'),
    capsChildren: caps ? Array.from(caps.children).map((c) => c.id || c.className) : [],
  };
});
ok(where.hasCaps, '#chat-caps 存在');
ok(where.parents.every((x) => x === 'chat-caps'), '三块的父节点都是 #chat-caps', where.parents.join(' / '));
ok(!where.inMain, '.chat-main 里已经没有这三块了', where.capsChildren.join(' , '));

console.log('\n== 二、写内容后是否真的渲染在右栏 ==');
await page.evaluate(() => {
  window.setProgress({ phase: 'write', pct: 37, seg: 2, segTotal: 5, chars: 1083, target: 1200 });
});
// ★ 必须等一下再量高度：max-height 0 → 56px 是 .22s 过渡，加 class 的瞬间量到的是 0
await page.waitForTimeout(500);
const prog = await page.evaluate(() => {
  const box = document.querySelector('#chat-progress');
  const fill = box.querySelector('.cp-fill');
  return { on: box.classList.contains('on'), text: box.querySelector('.cp-text').textContent, h: box.getBoundingClientRect().height, w: fill.style.width };
});
ok(prog.on && prog.h > 8, '进度条可见（有高度）', `高=${Math.round(prog.h)}`);
ok(/正在写/.test(prog.text), '进度条文案正确', prog.text);
ok(prog.w === '37%', '进度条宽度 = 37%', prog.w);

const sync = await page.evaluate((id) => {
  window.pushSync(id, [
    { kind: 'counter', text: '好感度计数器已更新（+2）' },
    { kind: 'world', text: '世界「东境」已改写' },
    { kind: 'plot', text: '剧情要点已记录：夜谈' },
  ]);
  const el = document.querySelector('#sync-line');
  const rows = Array.from(el.querySelectorAll('.sl-row'));
  return {
    n: rows.length,
    kinds: rows.map((r) => (r.className.match(/k-(\w+)/) || [])[1]),
    texts: rows.map((r) => r.textContent.trim().slice(0, 20)),
    overflowX: el.scrollWidth > el.clientWidth + 1,
  };
}, bot.id);
ok(sync.n === 3, '同步状态渲染 3 行', `${sync.n} 行`);
ok(sync.kinds.join(',') === 'counter,world,plot', '三类的 k-* 配色类正确', sync.kinds.join(','));
ok(!sync.overflowX, '右栏内没有横向溢出');

console.log('\n== 三、屏幕坐标：是不是真的在主区右边 ==');
const geo = await page.evaluate(() => {
  const main = document.querySelector('.chat-main').getBoundingClientRect();
  const sl = document.querySelector('#sync-line').getBoundingClientRect();
  const pr = document.querySelector('#chat-progress').getBoundingClientRect();
  return { mainRight: Math.round(main.right), slX: Math.round(sl.x), prX: Math.round(pr.x) };
});
ok(geo.slX >= geo.mainRight - 2, '同步状态行在屏幕上位于主区右侧', `主区右边=${geo.mainRight}　同步行 x=${geo.slX}`);
ok(geo.prX >= geo.mainRight - 2, '进度条在屏幕上位于主区右侧', `主区右边=${geo.mainRight}　进度条 x=${geo.prX}`);

await page.screenshot({ path: path.join(SHOTS, 'live-chat-rightbar.png'), fullPage: true });
const capsEl = await page.$('#chat-caps');
if (capsEl) await capsEl.screenshot({ path: path.join(SHOTS, 'live-rightbar-only.png') });

console.log('\n== 四、输出设置里的模型选择 ==');
await page.evaluate((id) => window.openOutputSheet(id), bot.id);
await page.waitForSelector('#output-sheet', { timeout: 5000 });
const sheet = await page.evaluate(() => {
  const sel = document.querySelector('#os-model');
  return { has: !!sel, opts: sel ? Array.from(sel.options).map((o) => o.value) : [], value: sel ? sel.value : null, disabled: sel ? sel.disabled : null };
});
ok(sheet.has, '输出设置里有 #os-model');
ok(sheet.opts.includes(''), '有「不绑定」空选项');

// 前端给 #os-model 的默认值，必须等于服务端 config 里这个写手当前绑定的模型
ok(sheet.value === (bot.modelId || ''), '下拉默认值 == 服务端当前绑定', `下拉=${sheet.value || '(空)'}　服务端=${bot.modelId || '(空)'}`);

await page.screenshot({ path: path.join(SHOTS, 'live-output-sheet.png') });

console.log('\n== 五、运行期报错 ==');
ok(errors.length === 0, '页面没有 JS 报错', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n截图：\n  ${path.join(SHOTS, 'live-chat-rightbar.png')}\n  ${path.join(SHOTS, 'live-rightbar-only.png')}\n  ${path.join(SHOTS, 'live-output-sheet.png')}`);
console.log(fail ? `\n✗ ${fail} 项失败（${pass} 项通过）` : `\n✓ 全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
