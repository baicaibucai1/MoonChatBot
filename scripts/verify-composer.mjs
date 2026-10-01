// 真机核对输入条三个元素的盒模型（C19-h：按钮没对齐）
// 用法：node scripts/verify-composer.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, sleep, REPO_ROOT } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? '✅' : '❌'} ${n}${ok || !d ? '' : ' —— ' + d}`); if (!ok) fails.push(n); };

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  const dir = makeSandbox();
  let srv = null, browser = null;
  try {
    const { port, botId } = await patchSandboxConfig(dir);
    // 同步前端产物（沙箱是拷贝）
    for (const f of ['app.js', 'style.css', 'design.css', 'index.html']) {
      const src = path.join(REPO_ROOT, 'public', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'public', f));
    }
    srv = await startServer(dir, port);
    browser = await chromium.launch({ executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#bot-list .side-item', { timeout: 15000 });
    await page.click(`#bot-list .side-item[onclick*="selectBot('${botId}')"]`);
    await page.waitForSelector('#f-chat', { timeout: 10000 });
    await sleep(400);

    // 量三个元素的实际几何：高度必须一致，垂直中心/底边必须齐平
    const geo = await page.evaluate(() => {
      const wrap = document.querySelector('.chat-input');
      const ta = document.querySelector('#f-chat');
      const out = wrap.querySelector('button[onclick*="openOutputSheet"]');
      const send = wrap.querySelector('button.primary');
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
        return { h: +b.height.toFixed(1), top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1),
                 cy: +((b.top + b.bottom) / 2).toFixed(1) }; };
      return { wrapH: +wrap.getBoundingClientRect().height.toFixed(1),
               ta: r(ta), out: r(out), send: r(send) };
    });
    console.log('几何：', JSON.stringify(geo, null, 1));

    check('输出按钮与发送按钮等高', geo.out && geo.send && Math.abs(geo.out.h - geo.send.h) < 1,
      `输出 ${geo.out && geo.out.h} vs 发送 ${geo.send && geo.send.h}`);
    check('三个元素垂直居中对齐', geo.out && geo.send && geo.ta
      && Math.abs(geo.out.cy - geo.send.cy) < 1 && Math.abs(geo.out.cy - geo.ta.cy) < 1,
      JSON.stringify({ out: geo.out && geo.out.cy, send: geo.send && geo.send.cy, ta: geo.ta && geo.ta.cy }));
    check('输出按钮与输入框等高（设计规范：输入条按钮 = 44）',
      geo.out && geo.ta && Math.abs(geo.out.h - geo.ta.h) < 1,
      `输出 ${geo.out && geo.out.h} vs 输入框 ${geo.ta && geo.ta.h}`);

    // 局部截图：只拍输入条，放大看清对齐
    const box = await page.evaluate(() => {
      const w = document.querySelector('.chat-input');
      const b = w.getBoundingClientRect();
      return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: b.width + 16, height: b.height + 16 };
    });
    await page.screenshot({ path: path.join(SHOT, 'composer.png'), clip: box });

    // 按「输出」按钮的文字/图标在按钮内的垂直位置再确认一次居中
    const inner = await page.evaluate(() => {
      const btn = document.querySelector('.chat-input button[onclick*="openOutputSheet"]');
      if (!btn) return null;
      const bb = btn.getBoundingClientRect();
      const svg = btn.querySelector('svg');
      const lb = btn.querySelector('.lb');
      const c = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return +((r.top + r.bottom) / 2 - (bb.top + bb.bottom) / 2).toFixed(1); };
      return { svgOff: c(svg), lbOff: c(lb) };
    });
    check('按钮内图标垂直居中（偏移 < 1.5px）', inner && Math.abs(inner.svgOff) < 1.5,
      JSON.stringify(inner));
    check('按钮内文字垂直居中（偏移 < 1.5px）', inner && Math.abs(inner.lbOff) < 1.5,
      JSON.stringify(inner));

    // 高倍局部图：只看按钮那一小块，肉眼核对图标/文字/圆角
    const btnShot = await page.evaluate(() => {
      const w = document.querySelector('.chat-input');
      const b = w.getBoundingClientRect();
      return { x: Math.max(0, b.right - 260), y: Math.max(0, b.y - 6), width: 260, height: b.height + 12 };
    });
    await page.screenshot({ path: path.join(SHOT, 'composer-btns.png'), clip: btnShot });

    // ★ 回归：新规则的作用域必须只到输入条 —— 别把弹窗底部 / 卡片标题栏的 .sm 按钮带跑
    await page.evaluate(() => window.openOutputSheet(
      document.querySelector('.chat-input button[onclick*="openOutputSheet"]').getAttribute('onclick').match(/'([^']+)'/)[1]));
    await page.waitForSelector('#output-sheet', { timeout: 5000 });
    await sleep(200);
    const sheetBtns = await page.evaluate(() => {
      const f = document.querySelector('#output-sheet .modal-foot');
      return [...f.querySelectorAll('button')].map((b) => ({ cls: b.className, h: +b.getBoundingClientRect().height.toFixed(1) }));
    });
    // ⚠️ 只盯 .ghost：弹窗底部的主按钮本来就是 44（design.css 的 .modal-foot .primary），
    //    那是原有设计不是被我带跑的。要验的是「.ghost.sm 的新规则没溢出到弹窗」。
    const ghostBtn = sheetBtns.find((b) => /ghost/.test(b.cls));
    check('弹窗底部 ghost 按钮高度未被误伤（仍是 32，没被输入条规则带成 44）',
      !!ghostBtn && ghostBtn.h === 32, JSON.stringify(sheetBtns));
    await page.screenshot({ path: path.join(SHOT, 'composer-full.png') });
    await page.evaluate(() => window.closeOutputSheet());
  } finally {
    if (browser) await browser.close();
    if (srv) stopServer(srv.child);
    await sleep(400);
    removeSandbox(dir);
  }
  console.log(fails.length ? `\n❌ ${fails.length} 项未通过：${fails.join('、')}` : '\n✅ 全部通过');
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
