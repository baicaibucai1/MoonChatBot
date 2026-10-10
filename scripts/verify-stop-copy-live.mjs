// 对「正在运行的」面板（默认 http://127.0.0.1:4357）做真实浏览器验证。
//
// 只覆盖用户提的三件事（2026-10-09 的截图反馈）：
//   一、待确认卡片 / 进度条是不是在**右栏**，且宽度够、看得清（不是被挤成一条竖排文字）
//   二、发送按钮能不能变成「停止」、点了能不能把这一轮停掉
//   三、输出气泡与输入框有没有复制按钮，复制出来的是不是 **Markdown 原文**
//
// ★ 与 tests/stream.test.mjs 的分工（别把两边的结论混为一谈）：
//   服务端那半步 ——「按 runId 把模型连接真正掐断」+「半截正文不落库」—— 由
//   tests/stream.test.mjs 在沙箱里端到端证明（真服务 + 真浏览器 + 真 SSE 分片）。
//   本脚本要证的是另一半：**用户实际打开的这个面板**是不是已经跑上了新代码、
//   看得见、点得动。所以它只打 4357 这一个实例，零模型调用、零费用。
//
// 用法：node scripts/verify-stop-copy-live.mjs   （PANEL=… 可换地址）
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
  if (cond) { pass++; console.log('  ok   -', name, extra ? '｜' + extra : ''); }
  else { fail++; console.log('  FAIL -', name, extra ? '｜' + extra : ''); }
};

async function api(p, method = 'GET', body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

const st = await api('/api/state');
const bot = (st.bots || [])[0];
if (!bot) { console.log('没有写手，无法验证'); process.exit(1); }
const BID = encodeURIComponent(bot.id);
console.log(`面板 ${BASE}　写手：${bot.name || bot.id}（模型 ${bot.modelId || '未绑定'}）`);

const sse = (events) => events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('');
const SSE_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' };

// ─────────────────────────────────────────────────────────────
// 零、运行中的服务是不是新代码（否则后面全是白测）
// ─────────────────────────────────────────────────────────────
console.log('\n== 零、运行中的服务跑的是新代码吗 ==');
{
  const appjs = await (await fetch(`${BASE}/app.js`)).text();
  ok(appjs.includes('function abortRun'), 'app.js 里有 abortRun()');
  ok(appjs.includes('IC_STOP'), 'app.js 里有停止图标');
  ok(appjs.includes('function copyInput'), 'app.js 里有 copyInput()');
  ok(appjs.includes('bubbleCopyBtn'), 'app.js 里有气泡复制按钮');
  const css = await (await fetch(`${BASE}/design.css`)).text();
  ok(css.includes('.bubble-copy'), 'design.css 里有 .bubble-copy');
  ok(css.includes('button.primary.stop'), 'design.css 里有停止态（红色）');

  const r400 = await fetch(`${BASE}/api/bots/${BID}/chat/abort`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  ok(r400.status === 400, '终止接口已上线（缺 runId → 400）', 'HTTP ' + r400.status);
  const rIdem = await fetch(`${BASE}/api/bots/${BID}/chat/abort`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'never' }),
  });
  const jIdem = await rIdem.json();
  ok(rIdem.status === 200 && jIdem.stopped === false, '终止不存在的 runId 幂等（200 + stopped:false）');
}

// ─────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 940 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'load' });
// ★ 不能用 window.state 就绪判断：app.js 里是 `let state`（顶层 let/const 不挂 window）
await page.waitForFunction(() => typeof window.selectBot === 'function', null, { timeout: 20000 });
await page.waitForTimeout(600);
await page.evaluate((id) => window.selectBot(id, 'chat'), bot.id);
await page.waitForSelector('#chat-caps', { timeout: 10000 });
await page.waitForTimeout(500);

// ─────────────────────────────────────────────────────────────
// 一、待确认卡片 + 进度条：在右栏、宽度够、可读
// ─────────────────────────────────────────────────────────────
console.log('\n== 一、待确认卡片与进度条在右栏、宽度够不够 ==');
// 走**真实的 SSE 管道**注入待确认提议：panding 事件 → onPending → _pendingEdits → renderPendingStrip。
// （_pendingEdits 是顶层 let，不挂 window，从外部赋值是做不到的；只能让它自己流进来。）
await page.route('**/chat/stream', (route) => route.fulfill({
  status: 200,
  headers: SSE_HEADERS,
  body: sse([
    { type: 'start', threadId: '' },
    { type: 'pending', edit: {
      type: 'character_edit',
      payload: {
        botId: bot.id, characterId: 'CHRprobe', name: '小星',
        patch: { persona: '更沉默一些', traits: '坚韧' },
        reason: '本轮对话里他的态度变了，值得沉淀',
      },
    } },
    { type: 'sync', items: [{ kind: 'counter', text: '好感度 +2' }, { kind: 'world', text: '世界「东境」已改写' }] },
    { type: 'done', reply: '好。', pushed: false, threadId: '' },
  ]),
}));
await page.fill('#f-chat', '（布局探针，不会真的发给模型）');
await page.click('.chat-input .primary');
await page.waitForSelector('#pending-strip .admin-action', { timeout: 10000 });
await page.waitForTimeout(500);

const measure = () => page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
  const main = r('.chat-main'), caps = r('#chat-caps'), strip = r('#pending-strip'), card = r('#pending-strip .admin-action');
  const stripEl = document.querySelector('#pending-strip');
  return {
    mainRight: main ? Math.round(main.right) : null,
    capsX: caps ? Math.round(caps.x) : null, capsW: caps ? Math.round(caps.width) : null,
    cardX: card ? Math.round(card.x) : null, cardW: card ? Math.round(card.width) : null, cardH: card ? Math.round(card.height) : null,
    label: (document.querySelector('#pending-strip .admin-action-label') || {}).textContent?.trim().slice(0, 24) || '',
    sub: (document.querySelector('#pending-strip .admin-action-sub') || {}).textContent?.trim().slice(0, 40) || '',
    overflowX: stripEl ? stripEl.scrollWidth > stripEl.clientWidth + 1 : null,
    inCaps: !!(document.querySelector('#chat-caps #pending-strip')),
    inMain: !!(document.querySelector('.chat-main #pending-strip')),
  };
});

let g = await measure();
console.log(`  视口 1360：右栏 x=${g.capsX} 宽=${g.capsW}　卡片 ${g.cardW}×${g.cardH} @x=${g.cardX}（主区右边 ${g.mainRight}）`);
ok(g.inCaps, '#pending-strip 住在 #chat-caps 里');
ok(!g.inMain, '#pending-strip 已不在 .chat-main 里');
ok(g.cardX >= g.mainRight - 2, '卡片在屏幕上位于主区**右侧**', `卡片 x=${g.cardX}　主区右边=${g.mainRight}`);
ok(g.cardW >= 118, '卡片宽度够读（不再被挤成竖条）', `${g.cardW}px（改前实测 99px）`);
ok(g.cardH < 240, '卡片没有被抻成细长竖排', `${g.cardW}×${g.cardH}`);
ok(g.label.includes('是否同意此更改'), '确认文案在（用户在截图里指的就是这一块）', g.label);
ok(!g.overflowX, '右栏内没有横向溢出');

// 「写手提议把…等你确认」这行提示若被右栏宽度截断，用户看到的是半句话 —— 等于没提示。
// 它不是卡片，没有换行容器，是最容易被窄栏悄悄吃掉的一块。
const headClip = await page.evaluate(() => {
  const h = document.querySelector('#pending-strip .ps-head');
  const strip = document.querySelector('#pending-strip');
  if (!h || !strip) return null;
  const hr = h.getBoundingClientRect(), sr = strip.getBoundingClientRect();
  return { hw: Math.round(hr.width), sw: Math.round(sr.width), clipped: hr.right > sr.right + 1, text: h.textContent.trim() };
});
ok(headClip && !headClip.clipped, '「写手提议…」提示行没有被右栏截断',
  headClip ? `${headClip.hw}px 装于 ${headClip.sw}px｜“${headClip.text}”` : '(元素不存在)');

for (const w of [1920, 1440, 1280]) {
  await page.setViewportSize({ width: w, height: 1000 });
  await page.waitForTimeout(320);
  const m = await measure();
  console.log(`  视口 ${w}：右栏宽=${m.capsW}　卡片 ${m.cardW}×${m.cardH} @x=${m.cardX}（主区右边 ${m.mainRight}）`);
  ok(m.cardX >= m.mainRight - 2, `${w} 宽下卡片仍在主区右侧`);
  ok(m.cardW >= 118, `${w} 宽下卡片宽度 ≥118px`, `${m.cardW}px`);
}
await page.setViewportSize({ width: 1360, height: 940 });
await page.waitForTimeout(300);

// 进度条：直接调真实入口 setProgress（进度条是流式期间的瞬态，没法事后量）
await page.evaluate(() => {
  window.setProgress({ phase: 'write', pct: 42, seg: 2, segTotal: 6, chars: 1180, target: 1500 });
});
await page.waitForTimeout(520);   // max-height 0→56px 是 .22s 过渡，加 class 的瞬间量到的是 0
const pg = await page.evaluate(() => {
  const box = document.querySelector('#chat-progress');
  const b = box.getBoundingClientRect();
  const main = document.querySelector('.chat-main').getBoundingClientRect();
  return {
    on: box.classList.contains('on'), x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height),
    mainRight: Math.round(main.right), fill: (box.querySelector('.cp-fill') || {}).style?.width,
    text: (box.querySelector('.cp-text') || {}).textContent || '',
  };
});
ok(pg.on && pg.h > 8, '进度条可见（有高度）', `高=${pg.h}`);
ok(pg.x >= pg.mainRight - 2, '进度条在屏幕上位于主区**右侧**', `进度条 x=${pg.x}　主区右边=${pg.mainRight}`);
ok(pg.fill === '42%', '进度条宽度 = 42%', pg.fill);
ok(/正在写/.test(pg.text), '进度条文案正确', pg.text);

await page.screenshot({ path: path.join(SHOTS, 'live-rightbar-pending.png') });
const capsEl = await page.$('#chat-caps');
if (capsEl) await capsEl.screenshot({ path: path.join(SHOTS, 'live-rightbar-only2.png') });

// ─────────────────────────────────────────────────────────────
// 二、发送 → 停止
// ─────────────────────────────────────────────────────────────
console.log('\n== 二、发送按钮变「停止」，点它能把这一轮停掉 ==');
await page.unroute('**/chat/stream');
await page.evaluate(() => window.hideProgress());

let abortBody = null;
page.on('request', (r) => { if (r.url().includes('/chat/abort')) abortBody = r.postData(); });

// 让流式接口「迟迟不回响应」：这几秒里那一轮确实在跑 —— 正是用户会去点停止的窗口。
// 这样测的是**真的把在途请求掐断**（fetch 收到 AbortError），不是改个按钮文字。
await page.route('**/chat/stream', async (route) => {
  await new Promise((r) => setTimeout(r, 3000));
  try { await route.fulfill({ status: 200, headers: SSE_HEADERS, body: sse([{ type: 'done', reply: '（不该出现）', pushed: false, threadId: '' }]) }); } catch { /* 已被前端 abort */ }
});

const sendLabel = () => page.evaluate(() => {
  const b = document.querySelector('.chat-input .primary');
  return b ? b.textContent.trim() : '(没有按钮)';
});

await page.fill('#f-chat', '（终止探针，不会真的发给模型）');
await page.click('.chat-input .primary');
let running = '';
for (let i = 0; i < 40 && running !== '停止'; i++) { running = await sendLabel(); await new Promise((r) => setTimeout(r, 50)); }
ok(running === '停止', '这一轮在跑时按钮变成「停止」', `按钮文字=${running}`);
const stopCls = await page.evaluate(() => document.querySelector('.chat-input .primary').className);
ok(/\bstop\b/.test(stopCls), '按钮挂上了 .stop（红色）', stopCls);

await page.waitForTimeout(700);           // 让它真的在途一会儿
await page.click('.chat-input .primary'); // 同一个按钮：再点一次 = 停止

let back = '';
for (let i = 0; i < 60 && back !== '发送'; i++) { back = await sendLabel(); await new Promise((r) => setTimeout(r, 100)); }
ok(back === '发送', '终止后按钮恢复成「发送」（否则下一句发不出去）', `按钮文字=${back}`);

const toast = await page.evaluate(() => {
  const t = document.querySelector('#toast');
  return t ? { text: t.textContent.trim(), cls: t.className } : { text: '', cls: '' };
});
ok(/已终止/.test(toast.text), '给了「已终止」的提示（说清半截正文没进记录）', toast.text);
ok(/\bshow\b/.test(toast.cls), '提示条确实弹出来了');
ok(!!abortBody && /runId/.test(abortBody), '向服务端发了终止请求，且带上了 runId', String(abortBody).slice(0, 70));
await page.screenshot({ path: path.join(SHOTS, 'live-stop.png') });

// ─────────────────────────────────────────────────────────────
// 三、复制按钮：输出气泡 + 输入框
// ─────────────────────────────────────────────────────────────
console.log('\n== 三、输出气泡与输入框的复制按钮 ==');
await page.unroute('**/chat/stream');
// 回到这个写手的真实会话（服务端有 44 条真实记录，正好拿来验复制）
await page.evaluate((id) => window.selectBot(id, 'chat'), bot.id);
await page.waitForSelector('#session-list .session.bot', { timeout: 10000 });
await page.waitForTimeout(700);

const BTN = '#session-list .session.bot .bubble .bubble-copy';
ok(await page.locator(BTN).count() > 0, '输出气泡上有复制按钮', `${await page.locator(BTN).count()} 个`);
ok(await page.locator('#session-list .session.bot').count() > 0,
  '会话里有服务端的真实 assistant 记录', `${await page.locator('#session-list .session.bot').count()} 条`);

// 悬停才出现（不干扰阅读），但要真的能出现
const lastBtn = page.locator(BTN).last();
await lastBtn.scrollIntoViewIfNeeded();
const oIdle = await lastBtn.evaluate((el) => getComputedStyle(el).opacity);
await lastBtn.hover();
// ★ .bubble-copy 带 transition: opacity .18s —— 悬停后立刻读会读到过渡起点（还是 0），
//   必须等过渡走完再读，否则会误判成「悬停不显示」。
await page.waitForTimeout(400);
const oHover = await lastBtn.evaluate((el) => getComputedStyle(el).opacity);
ok(Number(oHover) >= 0.9, '复制按钮悬停时显示出来', `opacity ${oIdle} → ${oHover}（过渡 .18s）`);
// 留一张「悬停时按钮浮在气泡右上角」的图 —— 这正是用户要的那个「快速复制」。
// 顺序要紧：**先滚动、再悬停、最后截整屏**。反过来（截完再滚，或滚完再悬停错元素）
// 会让鼠标离开按钮、:hover 当场失效，截出来是一张没有按钮的图。
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#session-list .session.bot .bubble')].pop();
  b.scrollIntoView({ block: 'start' });
});
await page.waitForTimeout(300);
await lastBtn.hover();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(SHOTS, 'live-copy-bubble.png') });

const raw = await lastBtn.getAttribute('data-raw');
ok(!!raw && raw.length > 0, '按钮带着 data-raw（Markdown 原文）', `原文 ${(raw || '').length} 字符`);
// ★ 这里才是「复制」这条需求的核心：拿到的必须是**原文**。
//   若实现是抓 DOM 文本，markdown 渲染掉的 ** / # / 缩进就永远拿不回来了。
// ★ 比较前必须归一化换行：Windows 剪贴板会把 \n 存成 \r\n，
//   不归一化就会把「原文里有 178 个换行」误判成「复制出来多了一堆字符」。
const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');
await lastBtn.click();
await page.waitForTimeout(400);
const clip = await page.evaluate(() => navigator.clipboard.readText());
const nNewlines = (norm(raw).match(/\n/g) || []).length;
ok(norm(clip) === norm(raw), '剪贴板 == Markdown 原文（不是渲染后的文本）',
  `剪贴板 ${clip.length} / data-raw ${raw.length} 字符（差 ${clip.length - raw.length} = ${nNewlines} 个 \n 被剪贴板存成 \r\n）`);
const mdMarks = (/\*\*|(^|\n)#{1,6} |(^|\n)\s*[-*] /).test(raw);
console.log(`  说明：这段正文${mdMarks ? '含' : '不含'} Markdown 标记；渲染是把原文交给 md() 的结果`);

// 输入框
const INPUT_TXT = '输入框原文 **加粗** 与换行\n第二行';
await page.fill('#f-chat', INPUT_TXT);
await page.click('.chat-input button[onclick="copyInput()"]');
await page.waitForTimeout(400);
const clip2 = await page.evaluate(() => navigator.clipboard.readText());
ok(norm(clip2) === norm(INPUT_TXT), '输入框的复制按钮复制的是原文（含 ** 与换行）', JSON.stringify(clip2.slice(0, 24)));
await page.fill('#f-chat', '');

// 弹窗态（展开某条线程的全部记录）也有同一颗按钮 —— 那里是**另一个模板**，最容易漏。
// ★ 必须传对 tid：expandSessions 是从 _sessionsCache[cacheKey(id,tid)] 取的，
//   tid 不对就取到空数组，只会看到「暂无会话记录」——那不是「没有按钮」，是没数据。
const tinfo = await api(`/api/memory/${BID}/threads`);
const tid = tinfo.defaultThreadId || (tinfo.threads || [])[0]?.id || '';
await page.evaluate(([id, t]) => window.expandSessions(id, t), [bot.id, tid]);
await page.waitForTimeout(700);
const inModal = await page.evaluate(() => ({
  hasChat: !!document.querySelector('#m-chat'),
  copyBtn: !!document.querySelector('.modal-foot button[onclick*="copyInput"]'),
  bubbles: document.querySelectorAll('#session-modal .bubble').length,
  bubbleCopy: document.querySelectorAll('#session-modal .bubble-copy').length,
}));
ok(inModal.hasChat && inModal.copyBtn, '展开记录弹窗的输入区也有复制按钮');
ok(inModal.bubbleCopy > 0, '弹窗里的输出气泡也有复制按钮', `${inModal.bubbleCopy}/${inModal.bubbles} 个气泡带按钮`);
await page.screenshot({ path: path.join(SHOTS, 'live-copy-modal.png') });
await page.evaluate(() => window.closeSessionModal());
await page.waitForTimeout(400);

await page.screenshot({ path: path.join(SHOTS, 'live-copy.png'), fullPage: true });

// ─────────────────────────────────────────────────────────────
console.log('\n== 四、运行期报错 ==');
// 我们故意注入了假 SSE，前端可能因此产生与本次改动无关的提示；只要求没有**运行时异常**
const real = errors.filter((e) => !/favicon/.test(e));
ok(real.length === 0, '页面没有 JS 运行时错误', real.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n截图：\n  ${path.join(SHOTS, 'live-rightbar-pending.png')}\n  ${path.join(SHOTS, 'live-rightbar-only2.png')}\n  ${path.join(SHOTS, 'live-stop.png')}\n  ${path.join(SHOTS, 'live-copy.png')}`);
console.log(fail ? `\n✗ ${fail} 项失败（${pass} 项通过）` : `\n✓ 全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
