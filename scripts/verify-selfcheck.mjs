// 真机验证：输出后自检 + 底部文件同步状态
//
// 为什么必须真机跑：
//   纯逻辑有 selfcheck.test.mjs 兜着（开关三态 / 解析 / 取样 / 提示词 / 短句 14 条），
//   但「自检是不是真的被接起来了」只能靠浏览器证明：
//     写手正文写完 → runSelfCheck 再调一次模型（非流式）
//       → 计数器 → onPending → SSE pending 事件 → 确认条
//       → 世界改变 → onPending → 确认条
//       → 剧情要点 → 直接写 events.jsonl
//       → sync 事件 → 前端 pushSync → 输入框上方那行灰字
//   任一环没接上，单测全绿而界面上什么都看不见。
//
// 验证点：
//   ① 一轮对话后：底部出现「剧情记录 +1」（事件真的写进 events.jsonl）
//   ② 底部出现计数器那条（待你确认）+ 世界改变那条（待你确认）
//   ③ 确认条真的出现（计数器 + 世界改变各一条）
//   ④ ★ 未声明的计数器被丢掉、越界的被收敛（自检同样受权限与范围约束）
//   ⑤ ★ 确认后底部补一条「已更新」（状态闭环）
//   ⑥ 关掉自检后：不再有 sync 行（开关真的生效）
//   ⑦ 全程无 JS 错误
//
// 用法：node scripts/verify-selfcheck.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, pickFreePort, REPO_ROOT, findProbeCharacter } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const CHAR_ID = 'CHRprobe0001';
const EVENT_TEXT = '银在渡口替主角挡下了那一刀';
const WORLD_TEXT = '渡口在战乱中被烧成了废墟';
const MAXV = 60;

// ── 假 LLM ──
// ★ 这一轮要同时服务**两类**调用，必须分流：
//   ① 写手正文：流式 SSE（回一次性 JSON 会静默空转）
//   ② 输出后自检：**非流式**（payload.stream 是假的；自检走 models.chat）
//   另外规划请求也是非流式 → 用「messages 里有没有『剧情校对员』」精确识别自检。
function fakeLLM() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON */ }
      const msgs = payload.messages || [];
      const isSelfCheck = msgs.some((m) => String(m.content || '').includes('剧情校对员'));
      const isStream = payload.stream === true;
      console.log(`[fake-llm] stream=${isStream} selfcheck=${isSelfCheck}`);

      if (isSelfCheck) {
        const out = JSON.stringify({
          counters: [{ characterId: CHAR_ID, deltas: { 好感度: 999, 仇恨: 50 }, why: '她替主角挡了一刀，关系骤近' }],
          world: [{ text: WORLD_TEXT, why: '战火烧到了渡口' }],
          events: [{ actors: ['银'], event: EVENT_TEXT, emotion: '紧张', importance: 4 }],
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', model: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 60, total_tokens: 70 },
        }));
        return;
      }

      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };
        const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
        const text = '银一步跨上前，把主角挡在身后。刀锋擦过她的肩，血落在渡口的木板上。';
        sse({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // 其余非流式（规划 / 摘要 / 蒸馏等）：给个无害的空答案
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"sections":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));
    });
  });
}

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : ' —— ' + detail}`);
  if (!ok) fails.push(name);
};

const readCfg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

async function confirmDialog(page) {
  const ok = await page.$('#ui-confirm #cf-ok');
  if (ok) { await ok.click(); await page.waitForTimeout(1200); return true; }
  return false;
}

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  const dir = makeSandbox();
  let srv = null, llm = null, browser = null;
  try {
    const { port } = await patchSandboxConfig(dir);

    const llmPort = await pickFreePort();
    llm = fakeLLM();
    await new Promise((r) => llm.listen(llmPort, '127.0.0.1', r));
    const cfgPath = path.join(dir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    for (const m of cfg.models || []) {
      m.baseURL = `http://127.0.0.1:${llmPort}/v1`;
      m.apiKey = 'sk-fake';
      delete m.apiKeyEnv;
    }
    cfg.bots[0].enabled = false;
    cfg.bots[0].appId = '__probe__';
    cfg.bots[0].appSecret = '__probe__';
    cfg.bots[0].activeCharacterIds = [CHAR_ID];
    // 显式打开自检（全局默认就是开，这里写死避免将来默认值变化把脚本带偏）
    cfg.selfCheck = true;
    // 角色卡上带范围，用来验证自检的数值同样被收敛
    //   ★ 角色在池里，不能按退役的顶层 cfg.characters 找（找不到就静默跳过，
    //     症状是「越界值没被收敛」，看起来像自检坏了）
    const chr = findProbeCharacter(cfg, CHAR_ID);
    if (chr) chr.persona = `沙箱探针用的角色设定。\n\n##Counter：好感度[0,${MAXV}]\n`;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    // 写手「标准要求」里只声明「好感度」→ 自检报的「仇恨」必须被丢掉
    fs.mkdirSync(path.join(dir, 'memory', 'BOT1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'BOT1', 'standards.md'),
      '# 标准要求\n\n## 计数器\n##Counter：好感度[0,100]\n', 'utf8');

    for (const f of ['app.js', 'style.css', 'design.css', 'index.html']) {
      const src = path.join(REPO_ROOT, 'public', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'public', f));
    }

    srv = await startServer(dir, port);
    console.log(`沙箱已启动 ${srv.base}（假 LLM :${llmPort}）\n`);

    browser = await chromium.launch({ executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

    await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.evaluate(() => window.selectBot && window.selectBot('BOT1', 'chat'));
    await page.waitForTimeout(900);

    const eventsFile = path.join(dir, 'memory', 'BOT1', 'events.jsonl');
    const beforeEvents = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;

    // ── ① 跑一轮对话 ──
    console.log('[1] 跑一轮对话（正文 + 输出后自检）');
    await page.fill('#f-chat', '继续写渡口那场戏');
    await page.evaluate(() => window.directChat('BOT1'));
    await page.waitForTimeout(6000);

    // ── ② 底部同步状态 ──
    const syncTxt = (await page.textContent('#sync-line').catch(() => '')) || '';
    console.log('    同步状态：', syncTxt.replace(/\s+/g, ' ').slice(0, 200));
    check('★ 底部出现「剧情记录 +1」（灰字状态行）', /剧情记录\s*\+1/.test(syncTxt), syncTxt.slice(0, 160));
    check('底部出现计数器那条（待你确认）', /好感度/.test(syncTxt) && /待你确认/.test(syncTxt), syncTxt.slice(0, 160));
    check('底部出现世界改变那条', /世界改变/.test(syncTxt), syncTxt.slice(0, 160));
    const rows = await page.$$('#sync-line .sl-row');
    check('状态行是一行一条（不是挤成一坨）', rows.length >= 3, String(rows.length));
    await page.screenshot({ path: path.join(SHOT, 'selfcheck-sync-line.png') });

    // ── ③ 事件真的写进了 events.jsonl ──
    const afterEvents = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    check('★ 剧情要点真的写进 events.jsonl', afterEvents > beforeEvents, `${beforeEvents} → ${afterEvents}`);
    const rowsArr = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    const mine = rowsArr.find((r) => r.event === EVENT_TEXT);
    check('事件内容与语气正确（actors/emotion/importance 都在）',
      !!mine && mine.importance === 4 && (mine.actors || []).includes('银'), JSON.stringify(mine));

    // ── ④ 确认条出现（计数器 + 世界改变）──
    console.log('\n[2] 确认条');
    const bars = await page.$$('#pending-strip .admin-action');
    check('★ 出现至少两条待确认（计数器 + 世界改变）', bars.length >= 2, String(bars.length));
    const barTexts = [];
    for (const b of bars) barTexts.push((await b.textContent()).replace(/\s+/g, ' '));
    const cBar = barTexts.find((t) => /计数器/.test(t)) || '';
    const wBar = barTexts.find((t) => /世界/.test(t)) || '';
    check('计数器条文案正确', /好感度/.test(cBar), cBar.slice(0, 180));
    check('世界改变条文案正确', new RegExp(WORLD_TEXT.slice(0, 8)).test(wBar), wBar.slice(0, 180));
    // ★ 自检同样受权限与范围约束
    check('★★ 越界值被收敛（+60 而不是 +999）', /\+60/.test(cBar) && !/999/.test(cBar), cBar.slice(0, 200));
    check('★ 未声明的「仇恨」没有出现在确认条里', !/仇恨/.test(cBar), cBar.slice(0, 200));
    await page.screenshot({ path: path.join(SHOT, 'selfcheck-pending.png') });

    // 落盘前角色卡必须纹丝不动
    const st1 = await (await fetch(`${srv.base}/api/state`)).json();
    const c1 = (st1.characters || []).find((c) => c.id === CHAR_ID) || {};
    check('提议阶段不落盘（好感度还没写进角色卡）',
      !((c1.counters || {})['好感度']), JSON.stringify(c1.counters));

    // ── ⑤ 点确认 → 底部补一条「已更新」 ──
    console.log('\n[3] 确认计数器那条 → 底部应补一条「已更新」');
    if (cBar) {
      const bar = bars[barTexts.indexOf(cBar)];
      const okBtn = await bar.$('button[onclick*="confirmEdit"]');
      if (okBtn) {
        await okBtn.click();
        await page.waitForTimeout(600);
        check('二次确认弹窗出现并被确认', await confirmDialog(page));
      } else check('找到确认按钮', false);
    }
    await page.waitForTimeout(1200);
    const syncTxt2 = (await page.textContent('#sync-line').catch(() => '')) || '';
    console.log('    同步状态：', syncTxt2.replace(/\s+/g, ' ').slice(-160));
    check('★ 确认后底部补了「已更新」那条（状态闭环）', /已更新/.test(syncTxt2), syncTxt2.slice(-200));
    const st2 = await (await fetch(`${srv.base}/api/state`)).json();
    const c2 = (st2.characters || []).find((c) => c.id === CHAR_ID) || {};
    check('★ 确认后计数器真的落到角色卡（并压在上限）', (c2.counters || {})['好感度'] === MAXV, JSON.stringify(c2.counters));
    check('★ 未声明的「仇恨」始终没进角色卡', !(c2.counters || {})['仇恨'], JSON.stringify(c2.counters));
    await page.screenshot({ path: path.join(SHOT, 'selfcheck-applied.png') });

    // ── ⑥ 关掉自检 → 不再产生同步状态 ──
    console.log('\n[4] 关掉自检后应无同步状态');
    const cfg2 = readCfg(dir);
    cfg2.selfCheck = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2), 'utf8');
    await page.evaluate(() => window.loadState && window.loadState(false));
    await page.waitForTimeout(700);
    await page.evaluate(() => window.selectBot && window.selectBot('BOT1', 'chat'));
    await page.waitForTimeout(700);
    // 清掉上一轮的同步行：这一轮要证明「什么都没有新增」
    await page.evaluate(() => { window.__syncBefore = document.querySelectorAll('#sync-line .sl-row').length; });
    const evBefore2 = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    await page.fill('#f-chat', '再写一段');
    await page.evaluate(() => window.directChat('BOT1'));
    await page.waitForTimeout(4500);
    const rowsAfter = await page.$$eval('#sync-line .sl-row', (els) => els.length).catch(() => 0);
    const before2 = await page.evaluate(() => window.__syncBefore || 0);
    check('★ 自检关闭后不再新增同步行', rowsAfter === before2, `${before2} → ${rowsAfter}`);
    const evAfter2 = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    check('自检关闭后由 maintain 的异步提炼接管（事件流不回退）', evAfter2 >= evBefore2, `${evBefore2} → ${evAfter2}`);

    // ── ⑦ 无 JS 错误 ──
    console.log('\n[5] JS 错误');
    check('全程无 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    console.log(`\n结果：${fails.length ? '❌ ' + fails.length + ' 项失败' : '✅ 全部通过'}`);
    if (fails.length) console.log('失败项：', fails.join('、'));
    console.log('截图写入', SHOT);
  } finally {
    if (browser) await browser.close();
    if (srv) stopServer(srv.child);
    if (llm) llm.close();
    removeSandbox(dir);
  }
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
