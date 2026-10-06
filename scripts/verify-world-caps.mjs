// 真机验证：多世界 + 对话页右侧胶囊（活跃世界 / 活跃角色）
//
// 为什么必须真机跑：
//   listWorlds / appendWorldChange 的纯逻辑有 worldcard.test.mjs 兜着（18 条），
//   但「胶囊是不是真的挂上了、点了能不能换」只能靠浏览器证明：
//     world.md 里的 `## 世界：中原 / 异界`
//       → GET /api/memory/:id/worlds → 胶囊显示
//       → 点胶囊 → 弹窗 → 选「异界」→ POST worlds/active → config.json 的 bot.activeWorld
//       → 胶囊文字跟着变
//       → 写手 system prompt 里「当前活跃世界是「异界」」
//       → 世界改变条目带【异界】前缀
//   任一环没接上，单测全绿而界面上什么都看不见。
//
// 验证点：
//   ① 两个世界 → 胶囊显示首个小节为活跃（没有显式选择时的默认口径）
//   ② 点胶囊换世界 → config.json 真写入 bot.activeWorld
//   ③ 换完之后写手 system prompt 里说的是新世界
//   ④ ★ 确认一条世界改变后，条目带【世界名】前缀（多世界流水不混淆）
//   ⑤ 世界卡里没有 `## 世界：` 小节时**不显示**世界胶囊（不装作有世界）
//   ⑥ 活跃角色胶囊列出来（点一下能进角色卡）
//   ⑦ 全程无 JS 错误
//
// 用法：node scripts/verify-world-caps.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, pickFreePort, REPO_ROOT } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const CHAR_ID = 'CHRprobe0001';
const W1 = '中原';
const W2 = '异界';
const CHANGE_TEXT = '异界的城门被攻破了';

// 假 LLM 里捕获到的 system（同一进程，直接读数组）
const seen = { systems: [] };

// ★ 两类调用必须分流：
//   ① 写手正文：**流式** SSE（回一次性 JSON 会静默空转）
//   ② 输出后自检 / 规划：**非流式** JSON
//   自检用「messages 里有没有『剧情校对员』」精确识别，其余非流式一律当规划给空答案。
function fakeLLM() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON */ }
      const msgs = payload.messages || [];
      for (const m of msgs) {
        if (m.role === 'system' && String(m.content || '').includes('【你的身份：写手】')) {
          seen.systems.push(String(m.content));
        }
      }
      const isSelfCheck = msgs.some((m) => String(m.content || '').includes('剧情校对员'));

      if (isSelfCheck) {
        const out = JSON.stringify({ counters: [], world: [{ text: CHANGE_TEXT, why: '战火烧到了异界' }], events: [] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', model: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
        }));
        return;
      }

      if (payload.stream === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };
        const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
        sse({ ...base, choices: [{ index: 0, delta: { content: '城门在夜里塌了。' }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

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
    cfg.selfCheck = true;              // 用自检产出一条世界改变，顺便验证条目带世界前缀
    delete cfg.bots[0].activeWorld;    // 从「没选过」开始
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    // 世界卡：两个世界小节（底稿）+ 一条已存在的流水
    const worldMd = [
      '# 世界卡', '',
      `## 世界：${W1}`,
      '门派林立，灵气稀薄。修行者以剑为尊。', '',
      `## 世界：${W2}`,
      '钢铁与蒸汽的城市，天空终年灰黄。', '',
      '## 世界的改变',
      '- [2026-10-05 10:00] 【中原】渡口被烧成了废墟　— 探针写手 <!--WCold-->',
      '',
    ].join('\n');
    fs.mkdirSync(path.join(dir, 'memory', 'BOT1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'BOT1', 'world.md'), worldMd, 'utf8');

    for (const f of ['app.js', 'style.css', 'design.css', 'index.html']) {
      const src = path.join(REPO_ROOT, 'public', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'public', f));
    }

    srv = await startServer(dir, port);
    const base = srv.base;
    console.log(`沙箱已启动 ${base}（假 LLM :${llmPort}）\n`);

    // ── 接口层先确认（省得把接口问题算到前端头上）──
    const wr = await (await fetch(`${base}/api/memory/BOT1/worlds`)).json();
    check('GET /worlds 解析出两个世界', wr.ok && (wr.worlds || []).length === 2,
      JSON.stringify((wr.worlds || []).map((w) => w.name)));
    check('★ 没显式选过时，活跃世界 = 首个小节', wr.effective === W1, String(wr.effective));
    check('世界小节正文归到各自名下',
      (wr.worlds[0].body || '').includes('门派林立') && (wr.worlds[1].body || '').includes('钢铁'),
      JSON.stringify((wr.worlds || []).map((w) => (w.body || '').slice(0, 12))));

    browser = await chromium.launch({ executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.evaluate(() => window.selectBot && window.selectBot('BOT1', 'chat'));
    await page.waitForTimeout(1500);

    // ── ① 胶囊显示 ──
    console.log('\n[1] 对话页右侧胶囊');
    const capsTxt = (await page.textContent('#chat-caps').catch(() => '')) || '';
    console.log('    胶囊：', capsTxt.replace(/\s+/g, ' ').slice(0, 160));
    check('★ 出现「活跃世界」胶囊（默认首个小节）', /活跃世界/.test(capsTxt) && new RegExp(W1).test(capsTxt), capsTxt.slice(0, 140));
    check('出现「活跃角色」胶囊', /活跃角色/.test(capsTxt) && /探针角色/.test(capsTxt), capsTxt.slice(0, 160));
    check('多世界时标出了世界数量（提示可点开换）', /2/.test(capsTxt));
    const worldPill = await page.$('#chat-caps .cap-world');
    const charPill = await page.$('#chat-caps .cap-char');
    check('世界胶囊是可点的按钮', !!worldPill);
    check('角色胶囊是可点的按钮', !!charPill);
    await page.screenshot({ path: path.join(SHOT, 'caps-chat.png') });

    // ── ② 点胶囊换世界 ──
    console.log('\n[2] 点世界胶囊 → 换成「异界」');
    await worldPill.click();
    await page.waitForTimeout(600);
    const opts = await page.$$('#world-pick .world-opt');
    check('弹出世界列表（两个）', opts.length === 2, String(opts.length));
    const pickTxt = (await page.textContent('#world-pick').catch(() => '')) || '';
    check('列表里当前活跃那个被标成「当前」', /当前/.test(pickTxt) && new RegExp(W1).test(pickTxt), pickTxt.slice(0, 160));
    await page.screenshot({ path: path.join(SHOT, 'caps-world-pick.png') });
    // 按名字定位（★ 别按索引点：顺序会变）
    await page.evaluate((nm) => {
      const el = [...document.querySelectorAll('#world-pick .world-opt')].find((x) => x.dataset.name === nm);
      if (el) el.click();
    }, W2);
    await page.waitForTimeout(1400);

    const cfgAfter = readCfg(dir);
    check('★★ bot.activeWorld 真的写进 config.json', cfgAfter.bots[0].activeWorld === W2,
      String(cfgAfter.bots[0].activeWorld));
    const capsTxt2 = (await page.textContent('#chat-caps').catch(() => '')) || '';
    check('胶囊文字换成新世界', new RegExp(W2).test(capsTxt2) && !new RegExp(`活跃世界[\\s\\S]{0,20}${W1}`).test(capsTxt2),
      capsTxt2.replace(/\s+/g, ' ').slice(0, 140));
    check('切换后弹窗自动关闭', !(await page.$('#world-pick')));

    // 世界小节名不存在时必须被拒（防悬空引用）
    const bad = await (await fetch(`${base}/api/memory/BOT1/worlds/active`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '不存在的世界' }),
    })).json();
    check('★ 切到世界卡里没有的名字 → 被拒绝', bad.ok === false, JSON.stringify(bad));

    // ── ③ 写手 system prompt 说的是新世界 ──
    console.log('\n[3] 写手提示词里的活跃世界');
    seen.systems.length = 0;
    await page.fill('#f-chat', '继续写异界那场戏');
    await page.evaluate(() => window.directChat('BOT1'));
    await page.waitForTimeout(6000);
    const sys = seen.systems.join('\n');
    check('★ 提示词里写明「当前活跃世界是异界」',
      new RegExp(`当前活跃世界是\\*\\*「${W2}」\\*\\*`).test(sys), sys.match(/当前活跃世界[^\n]*/)?.[0] || '（没找到）');
    check('提示词里带上了该世界的设定正文', /钢铁与蒸汽/.test(sys));
    check('提示词里列出世界卡里有几个世界', new RegExp(`${W1}、${W2}`).test(sys), sys.match(/世界卡里有[^\n]*/)?.[0] || '');

    // ── ④ 世界改变条目带【世界名】 ──
    console.log('\n[4] 自检产出的世界改变');
    const bars = await page.$$('#pending-strip .admin-action');
    const texts = [];
    for (const b of bars) texts.push((await b.textContent()).replace(/\s+/g, ' '));
    const wBar = texts.find((t) => /世界/.test(t)) || '';
    check('出现世界改变确认条', new RegExp(CHANGE_TEXT.slice(0, 6)).test(wBar), wBar.slice(0, 160));
    if (wBar) {
      const target = bars[texts.indexOf(wBar)];
      // 世界改变那条的确认按钮后面还有一步 toast；点它即可
      const ok = await target.$('button[onclick*="confirmEdit"]');
      if (ok) {
        await ok.click();
        await page.waitForTimeout(600);
        const cf = await page.$('#ui-confirm #cf-ok');
        if (cf) { await cf.click(); await page.waitForTimeout(1500); }
      }
    }
    const worldAfter = fs.readFileSync(path.join(dir, 'memory', 'BOT1', 'world.md'), 'utf8');
    check('★★ 世界改变条目带【异界】前缀（多世界流水不混淆）',
      worldAfter.includes(`【${W2}】${CHANGE_TEXT}`), worldAfter.split('\n').filter((l) => l.includes(CHANGE_TEXT)).join('|'));
    check('★ 两个世界小节在追加后**原样保留**',
      worldAfter.includes(`## 世界：${W1}\n门派林立`) && worldAfter.includes(`## 世界：${W2}\n钢铁与蒸汽`));

    // ── ⑤ 没有 `## 世界：` 小节 → 不显示世界胶囊 ──
    console.log('\n[5] 世界卡里没有 `## 世界：` 小节');
    fs.writeFileSync(path.join(dir, 'memory', 'BOT1', 'world.md'),
      '# 世界卡\n\n## 世界设定\n-\n\n## 世界的改变\n', 'utf8');
    await page.evaluate(() => window.loadWorlds && window.loadWorlds('BOT1'));
    await page.waitForTimeout(1200);
    const capsTxt3 = (await page.textContent('#chat-caps').catch(() => '')) || '';
    check('★ 不显示「活跃世界」标题（没得选就别装作有得选）', !/活跃世界/.test(capsTxt3), capsTxt3.slice(0, 140));
    check('角色胶囊还在（世界没了不影响角色）', /活跃角色/.test(capsTxt3), capsTxt3.slice(0, 140));
    await page.screenshot({ path: path.join(SHOT, 'caps-no-world.png') });

    // ── ⑥ 无 JS 错误 ──
    console.log('\n[6] JS 错误');
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
