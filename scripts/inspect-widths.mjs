import { chromium } from 'playwright';
const b = await chromium.launch();
for (const w of [1920, 1440, 1280, 1200, 1160, 1100]) {
  const p = await b.newPage({ viewport: { width: w, height: 900 } });
  await p.goto('http://127.0.0.1:4357', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof window.selectBot === 'function' && document.querySelector('#main'), null, { timeout: 15000 });
  await p.waitForTimeout(800);
  const botId = await p.evaluate(() => state.bots[0].id);
  await p.evaluate((id) => window.selectBot(id), botId);
  await p.waitForTimeout(900);
  const r = await p.evaluate((id) => {
    _pendingEdits[id] = [{ type: 'experience_commit', payload: { name: '小星', counters: { 好感度: 5 }, counterFrom: { 好感度: 3 }, text: 'x', reason: 'y' } }];
    renderPendingStrip(id); setProgress(id, 37);
    const q = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const main = q('.chat-main'), caps = q('#chat-caps'), input = q('.chat-input');
    const card = document.querySelector('#pending-strip .admin-action');
    return { main, caps, input, 卡片: card ? { w: Math.round(card.getBoundingClientRect().width), h: Math.round(card.getBoundingClientRect().height) } : null,
      右栏在正文右边: caps.x >= main.x + main.w - 1,
      右栏在正文下边: caps.y >= main.y + main.h - 1,
      右栏在输入框上方: caps.y < input.y,
      flexWrap: getComputedStyle(document.querySelector('.chat-split')).flexWrap };
  }, botId);
  console.log(`宽 ${w}: 右栏 ${r.caps.w}×${r.caps.h}@(${r.caps.x},${r.caps.y})  正文右边界 ${r.main.x + r.main.w}  卡片 ${r.卡片 ? r.卡片.w + '×' + r.卡片.h : '无'}  在右=${r.右栏在正文右边} 在下方=${r.右栏在正文下边} 在输入框上方=${r.右栏在输入框上方} wrap=${r.flexWrap}`);
  await p.close();
}
await b.close();
