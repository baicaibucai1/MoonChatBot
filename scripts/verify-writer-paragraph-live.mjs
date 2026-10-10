// 对「正在运行的」面板（默认 http://127.0.0.1:4357）验证：
//   写手的输出已经是**通栏正文**，不再是聊天气泡；而用户自己的输入仍然是气泡。
//
// 为什么值得单开一个脚本：这类「去掉一个视觉容器」的改动，最典型的翻车是
//   · 只在某一个主题/某一层样式表里生效（亮色没了、暗色又长回灰底）；
//   · 通栏之后横向溢出，列表多出一条滚动条；
//   · 顺手把用户消息的气泡也一起去掉了 —— 那就分不清「谁在说话」。
// 三条都不是肉眼看一眼截图能确认的，所以这里逐条断言 computed style。
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

const api = async (p) => (await fetch(BASE + p)).json();
const st = await api('/api/state');
const bot = (st.bots || [])[0];
if (!bot) { console.log('没有写手'); process.exit(1); }
const BID = encodeURIComponent(bot.id);
console.log(`面板 ${BASE}　写手：${bot.name || bot.id}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.selectBot === 'function', null, { timeout: 20000 });
await page.waitForTimeout(600);
await page.evaluate((id) => window.selectBot(id, 'chat'), bot.id);
await page.waitForSelector('#session-list .session.bot', { timeout: 10000 });
await page.waitForTimeout(800);

/** 一次性量出写手输出 / 用户输入的关键计算样式 */
const probe = () => page.evaluate(() => {
  const list = document.querySelector('#session-list');
  const bot = [...document.querySelectorAll('#session-list .session.bot')].pop();
  const usr = [...document.querySelectorAll('#session-list .session.user')].pop();
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const bb = bot ? bot.querySelector('.bubble') : null;
  const ub = usr ? usr.querySelector('.bubble') : null;
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right) }; };
  return {
    listInner: Math.round(list.clientWidth - 4),   // 减掉左右各 2px padding
    listOverflowX: list.scrollWidth > list.clientWidth + 1,
    botBubble: bb ? {
      bg: cs(bb).backgroundColor, radius: cs(bb).borderTopLeftRadius,
      maxW: cs(bb).maxWidth, padTop: cs(bb).paddingTop, padLeft: cs(bb).paddingLeft,
      borderLeftW: cs(bb).borderLeftWidth, borderLeftColor: cs(bb).borderLeftColor,
      ...r(bb),
    } : null,
    botWho: bot ? cs(bot.querySelector('.who')).display : null,
    usrBubble: ub ? { bg: cs(ub).backgroundColor, radius: cs(ub).borderTopLeftRadius, ...r(ub) } : null,
    usrWho: usr ? cs(usr.querySelector('.who')).display : null,
    theme: document.documentElement.getAttribute('data-theme') || '(未设置)',
  };
});

const isTransparent = (c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent';

console.log('\n== 一、写手的输出：通栏正文，没有气泡 ==');
let p = await probe();
console.log(`  主题=${p.theme}　列表内宽=${p.listInner}　写手气泡 w=${p.botBubble?.w} x=${p.botBubble?.x}`);
ok(!!p.botBubble, '找得到写手输出节点');
ok(isTransparent(p.botBubble.bg), '去掉了气泡底色', p.botBubble.bg);
ok(parseFloat(p.botBubble.radius) === 0, '去掉了圆角', p.botBubble.radius);
ok(p.botBubble.maxW === 'none', '解除了 70% 宽度封顶', p.botBubble.maxW);
ok(parseFloat(p.botBubble.padTop) === 0, '去掉了上下内边距', 'padding-top=' + p.botBubble.padTop);
ok(p.botBubble.w >= p.listInner * 0.97, '正文通栏（几乎占满内容区）', `${p.botBubble.w} / ${p.listInner}`);
ok(p.botWho === 'none', '写手输出前的头像列已去掉', p.botWho);

// ★ 「通栏」不能只看容器的宽度：容器通栏、里面的 <p> 却带着自己的 max-width 或
//   padding 时，正文照样只占半栏 —— 那种情况下上面的断言会全绿而用户看到没变。
// ★ 而且**不能用 p.getClientRects() 去量行宽**：块级元素返回的是它自己的盒子（一行），
//   不是逐行的行盒 —— 那样量出来永远等于盒宽，等于没量。要用 Range 选中文字内容，
//   它给出来的才是真正的行盒。
const lines = await page.evaluate(() => {
  // 挑**最长的一条**来量：短句（「好。」）本来就只有一行，
  // 拿它去验「行宽铺满」等于什么都没验。
  const all = [...document.querySelectorAll('#session-list .session.bot .bubble')];
  const b = all.sort((x, y) => y.textContent.length - x.textContent.length)[0];
  if (!b) return null;
  const rows = [];
  for (const p of b.querySelectorAll('p')) {
    const r = document.createRange();
    r.selectNodeContents(p);
    for (const x of r.getClientRects()) rows.push({ w: Math.round(x.width), text: p.textContent.slice(0, 12) });
  }
  return { boxW: Math.round(b.getBoundingClientRect().width), textLen: b.textContent.length, rows };
});
const widest = lines.rows.reduce((a, b) => (b.w > a.w ? b : a), { w: 0, text: '' });
console.log(`  正文盒宽=${lines.boxW}　行盒 ${lines.rows.length} 个　最宽一行=${widest.w}px（“${widest.text}…”）`);
ok(lines.boxW >= p.listInner * 0.97, '正文盒子铺满通栏', `${lines.boxW} / ${p.listInner}`);
ok(widest.w >= p.listInner * 0.85, '★ 文字行真的铺开了（不是容器通栏、正文还挤在半栏）',
  `最宽 ${widest.w} / ${p.listInner}`);

console.log('\n== 二、用户自己的输入：气泡还在（不能一起改掉）==');
if (p.usrBubble) {
  ok(!isTransparent(p.usrBubble.bg), '用户气泡仍有底色', p.usrBubble.bg);
  ok(parseFloat(p.usrBubble.radius) > 0, '用户气泡仍是圆角', p.usrBubble.radius);
  ok(p.usrWho !== 'none', '用户头像仍在', p.usrWho);
  ok(p.usrBubble.w < p.listInner * 0.9, '用户气泡不是通栏（仍有「一句话」的形态）', `${p.usrBubble.w} / ${p.listInner}`);
} else {
  ok(false, '会话里应有至少一条用户消息可供对照');
}

console.log('\n== 三、通栏之后不能把列表撑出横向滚动条 ==');
ok(!p.listOverflowX, '会话列表没有横向溢出');

console.log('\n== 四、流式态：左边 gutter 点亮，且不改动正文位置 ==');
const stream = await page.evaluate(() => {
  const b = [...document.querySelectorAll('#session-list .session.bot .bubble')].pop();
  const before = b.getBoundingClientRect();
  const beforeText = b.firstElementChild ? b.firstElementChild.getBoundingClientRect().x : b.getBoundingClientRect().x;
  b.classList.add('streaming');
  const cs = getComputedStyle(b);
  const after = b.getBoundingClientRect();
  const afterText = b.firstElementChild ? b.firstElementChild.getBoundingClientRect().x : after.x;
  const color = cs.borderLeftColor;
  b.classList.remove('streaming');
  return { color, dx: Math.round(after.x - before.x), dw: Math.round(after.width - before.width), dText: Math.round(afterText - beforeText) };
});
ok(!isTransparent(stream.color), '流式中左边 gutter 点亮（替代原气泡描边）', stream.color);
ok(stream.dx === 0 && stream.dw === 0 && stream.dText === 0, '进出流式态时正文一个像素都不跳',
  `x${stream.dx >= 0 ? '+' : ''}${stream.dx} w${stream.dw >= 0 ? '+' : ''}${stream.dw} 正文x${stream.dText >= 0 ? '+' : ''}${stream.dText}`);

await page.screenshot({ path: path.join(SHOTS, 'live-writer-paragraph.png') });

console.log('\n== 五、亮色主题下同样成立 ==');
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await page.waitForTimeout(350);
p = await probe();
ok(p.theme === 'light', '已切到亮色');
ok(isTransparent(p.botBubble.bg), '亮色下写手输出仍然没有底色', p.botBubble.bg);
ok(p.botBubble.maxW === 'none' && p.botBubble.w >= p.listInner * 0.97, '亮色下仍然通栏', `${p.botBubble.w} / ${p.listInner}`);
ok(p.usrBubble && !isTransparent(p.usrBubble.bg), '亮色下用户气泡仍保留');
await page.screenshot({ path: path.join(SHOTS, 'live-writer-paragraph-light.png') });

console.log('\n== 六、暗色主题 ==');
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
await page.waitForTimeout(350);
p = await probe();
ok(p.theme === 'dark', '已切到暗色');
const dk = await page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const card = document.querySelector('#session-list')?.closest('.card');
  return {
    body: getComputedStyle(document.body).backgroundColor,
    card: card ? getComputedStyle(card).backgroundColor : '(找不到卡片)',
    tokSurface: root.getPropertyValue('--surface').trim(),
    tokPanel: root.getPropertyValue('--panel-solid').trim(),
    tokBg: root.getPropertyValue('--bg').trim(),
  };
});
console.log(`  暗色 token：--bg=${dk.tokBg} --surface=${dk.tokSurface} --panel-solid=${dk.tokPanel}`);
console.log(`  暗色实测：body=${dk.body}　卡片=${dk.card}`);
ok(dk.tokSurface === '#1c1d21' && dk.tokBg === '#121316', '★ 暗色 token 确实被换成了暗色（不是只挂了个属性）',
  `--surface=${dk.tokSurface} --bg=${dk.tokBg}`);
ok(isTransparent(p.botBubble.bg), '★ 暗色下也没长回灰底（style.css 里那条 [data-theme=dark] 规则）', p.botBubble.bg);
ok(p.botBubble.w >= p.listInner * 0.97, '暗色下仍然通栏');
const streamDark = await page.evaluate(() => {
  const b = [...document.querySelectorAll('#session-list .session.bot .bubble')].pop();
  b.classList.add('streaming');
  const c = getComputedStyle(b).borderLeftColor;
  b.classList.remove('streaming');
  return c;
});
ok(!isTransparent(streamDark), '暗色下流式 gutter 也点亮', streamDark);
await page.screenshot({ path: path.join(SHOTS, 'live-writer-paragraph-dark.png') });

// ★ 计算样式说「暗色」不等于**画出来**是暗色：某处一句写死的 #fff、
//   或者一个不随主题走的变量（比如 --panel-solid 只在 :root 定义过），
//   都会让「token 已经换掉了」和「屏幕上还是白的」同时成立。
//   所以直接把刚存下来的截图喂回浏览器解码，采样真实像素。
//   （Chromium 的 createImageBitmap + canvas 自带 PNG 解码，不用引任何图像库。）
const px = await page.evaluate(async (b64) => {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const c2d = cv.getContext('2d');
  c2d.drawImage(bmp, 0, 0);
  const at = (x, y) => { const d = c2d.getImageData(x, y, 1, 1).data; return { r: d[0], g: d[1], b: d[2] }; };
  const lum = (c) => Math.round(0.299 * c.r + 0.587 * c.g + 0.114 * c.b);
  const pts = { '页面背景': at(20, 20), '列表空白处': at(660, 700), '输入行': at(330, 680) };
  return { w: bmp.width, h: bmp.height, pts: Object.fromEntries(Object.entries(pts).map(([k, v]) => [k, { ...v, lum: lum(v) }])) };
}, fs.readFileSync(path.join(SHOTS, 'live-writer-paragraph-dark.png')).toString('base64'));
console.log('  暗色截图实测像素：' + Object.entries(px.pts).map(([k, v]) => `${k}=rgb(${v.r},${v.g},${v.b})/亮度${v.lum}`).join('　'));
const bright = Object.entries(px.pts).filter(([, v]) => v.lum > 140);
ok(bright.length === 0, '★ 暗色截图的像素确实是暗的（不是只有 token 换了、画面还是白的）',
  bright.length ? '仍偏亮：' + bright.map(([k, v]) => `${k}(${v.lum})`).join(',') : '三处采样亮度均 ≤140');

console.log('\n== 七、复制按钮在这个新形态下仍然可用 ==');
const BTN = '#session-list .session.bot .bubble .bubble-copy';
ok(await page.locator(BTN).count() > 0, '通栏正文上仍有复制按钮', `${await page.locator(BTN).count()} 个`);
const lastBtn = page.locator(BTN).last();
await lastBtn.scrollIntoViewIfNeeded();
await lastBtn.hover();
await page.waitForTimeout(400);
const oHover = await lastBtn.evaluate((el) => getComputedStyle(el).opacity);
ok(Number(oHover) >= 0.9, '悬停后显示出来', 'opacity=' + oHover);
const raw = await lastBtn.getAttribute('data-raw');
// ★ 通栏之后必须查的一件事：按钮是**绝对定位**在块的右上角，而内边距已经归零，
//   正文会一直折行到右边框 —— 于是第一行的末尾很可能被这颗按钮盖住。
//   气泡时代有 14px 右内边距兜着，去掉内边距就把这层缓冲也去掉了。
//   这里用 Range 拿到每一行的真实行盒，逐个和按钮比矩形相交。
const overlap = await page.evaluate(() => {
  const all = [...document.querySelectorAll('#session-list .session.bot .bubble')];
  const worst = { hits: 0, sample: '', gap: Infinity };
  for (const b of all) {
    const btn = b.querySelector('.bubble-copy');
    if (!btn) continue;
    const br = btn.getBoundingClientRect();
    for (const p of b.querySelectorAll('p')) {
      const r = document.createRange();
      r.selectNodeContents(p);
      for (const line of r.getClientRects()) {
        if (line.width < 1 || line.height < 1) continue;
        const hit = !(line.right <= br.left || line.left >= br.right || line.bottom <= br.top || line.top >= br.bottom);
        if (hit) { worst.hits++; if (!worst.sample) worst.sample = p.textContent.slice(0, 18); }
        // 同一行水平方向离按钮多近（正数=在按钮左边）
        if (line.top < br.bottom && line.bottom > br.top) worst.gap = Math.min(worst.gap, Math.round(br.left - line.right));
      }
    }
  }
  return { ...worst, gap: worst.gap === Infinity ? null : worst.gap };
});
console.log(`  按钮与正文行盒相交次数=${overlap.hits}${overlap.sample ? `（如“${overlap.sample}…”）` : ''}　同行最近间距=${overlap.gap}px`);
ok(overlap.hits === 0, '复制按钮没有压住正文的任何一行', overlap.hits ? `${overlap.hits} 行被盖住` : '');
await lastBtn.click();
await page.waitForTimeout(400);
const clip = await page.evaluate(() => navigator.clipboard.readText());
const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');
ok(norm(clip) === norm(raw), '复制到的仍是 Markdown 原文', `${clip.length} / ${raw.length} 字符`);

console.log('\n== 八、运行期报错 ==');
ok(errors.length === 0, '页面没有 JS 报错', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n截图：${path.join(SHOTS, 'live-writer-paragraph.png')}\n      ${path.join(SHOTS, 'live-writer-paragraph-light.png')}\n      ${path.join(SHOTS, 'live-writer-paragraph-dark.png')}`);
console.log(fail ? `\n✗ ${fail} 项失败（${pass} 项通过）` : `\n✓ 全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
