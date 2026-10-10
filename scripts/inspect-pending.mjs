// 临时探针：注入一条「待确认」，看它和进度条到底渲染在哪儿。
import { chromium } from 'playwright';

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 940 } });
await p.goto('http://127.0.0.1:4357', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof window.selectBot === 'function' && document.querySelector('#main'), null, { timeout: 15000 });
await p.waitForTimeout(1000);

const botId = await p.evaluate(() => state.bots[0].id);
await p.evaluate((id) => window.selectBot(id), botId);
await p.waitForTimeout(1200);

const info = await p.evaluate((id) => {
  _pendingEdits[id] = [{
    type: 'experience_commit',
    payload: { name: '小星', counters: { 好感度: 5, 信任: 5 }, counterFrom: { 好感度: 3, 信任: 0 },
      text: '小星主动递出两个塑料瓶给阿木作为回礼', reason: '体现出对阿木的初步信任和友好，好感度与信任均有所提升。' },
  }];
  renderPendingStrip(id);
  setProgress(id, 37);
  pushSync(id, [{ kind: 'counter', text: '小星 好感度 3 → 8' }]);
  const g = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const strip = document.getElementById('pending-strip');
  const card = document.querySelector('#pending-strip .admin-action');
  const main = document.querySelector('.chat-main').getBoundingClientRect();
  const caps = document.querySelector('#chat-caps').getBoundingClientRect();
  return {
    viewport: [window.innerWidth, window.innerHeight],
    chat_main: g('.chat-main'), chat_input: g('.chat-input'), session_list: g('#session-list'),
    chat_caps: g('#chat-caps'), pending_strip: g('#pending-strip'), chat_progress: g('#chat-progress'),
    card: card ? { w: Math.round(card.getBoundingClientRect().width), h: Math.round(card.getBoundingClientRect().height) } : null,
    卡片在右栏: !!(strip && strip.closest('#chat-caps')),
    卡片在正文: !!(card && card.closest('#session-list')),
    右栏在正文右侧: caps.x >= main.right - 1,
    窄屏模式: window.innerWidth <= 1180,
  };
}, botId);
console.log(JSON.stringify(info, null, 1));
await p.screenshot({ path: 'scripts/shots/inspect-pending.png' });
await b.close();
