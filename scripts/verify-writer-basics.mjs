// 真机验证：写手六段式组成里的 ②③⑤（世界卡 / 标准要求 / 剧情概览）
//
// 为什么必须真机跑：这三块都跨「模型 → 工具 → 待确认 → REST → 磁盘 / system」，
// 单测只能守住纯函数（parseWorldCard / parseHeadTail），接没接上只有浏览器能证明。
//
// 验证点：
//   ① 写手记忆文件里真的多了「② 标准要求」与「③ 世界卡」，且面板按六段式分组展示
//   ② 写手 propose_world_change → 面板出确认条（写明是「写手」提议、含改变正文）
//   ③ 点确认 → world.md 真的多一行「世界的改变」，且**世界设定底稿原样保留**
//   ④ 世界卡上的改变会进写手 system（它下一轮才知道世界被改过）
//   ⑤ ② 标准要求里的「输出头尾」：首段提示带开头要求、中间段不带、末段带结尾要求
//      —— 这是「长文分段时套话只出现一次」的引擎保证，只靠提示词做不到
//   ⑥ 剧情概览：events_summary 展示名是「剧情概览」，不是 events_summary
//   ⑦ 全程无 JS 错误
//
// 用法：node scripts/verify-writer-basics.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, pickFreePort, REPO_ROOT } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

// ★ 写手 id 不写死：沙箱恒用 fixture，但脚本仍按实际配置取，避免以后改 fixture 就静默跑偏
let WRITER_ID = 'BOT1';
let WRITER_NAME = '探针写手';

const WORLD_CHANGE = '渡口木桥被烧毁，南北商道就此断绝';
const HEAD_REQ = '以「【第一幕】」起始';
const TAIL_REQ = '最后一行写（未完待续）';

// 假 LLM 收到的每段提示语都记下来 —— ⑤ 的断言全靠这个（页面上看不到发给模型的指令）
const state = { mode: 'world', prompts: [], systems: [], toolResults: [] };

function fakeLLM() {
  return http.createServer((req, res) => {
    if (req.url.startsWith('/__seen')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON，按空处理 */ }
      const msgs = payload.messages || [];
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      const sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
      if (sys.includes('【你的身份：写手】')) state.systems.push(sys);
      // ★ 只记录**写手对话**那条链的最后一条 user 消息（补充规划/蒸馏的请求不算）
      if (sys.includes('【你的身份：写手】')) {
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
        if (lastUser) state.prompts.push(String(lastUser.content || ''));
      }
      if (hasToolResult) {
        for (const m of msgs) if (m.role === 'tool') state.toolResults.push(String(m.content || ''));
      }
      console.log(`[fake-llm] mode=${state.mode} hasToolResult=${hasToolResult}`);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };
      const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');

      if (hasToolResult) {
        const text = '（这是提议，等用户确认）';
        sse({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const args = state.mode === 'world'
        ? { text: WORLD_CHANGE, reason: '桥烧了，商道断绝' }
        : { characterId: 'CHRprobe0001', text: '顺手记一条', reason: '验证另一条链路' };
      const fnName = state.mode === 'world' ? 'propose_world_change' : 'propose_experience_commit';

      sse({
        ...base,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: fnName, arguments: '' } }] },
          finish_reason: null,
        }],
      });
      const argStr = JSON.stringify(args);
      for (let i = 0; i < argStr.length; i += 24) {
        sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(i, i + 24) } }] }, finish_reason: null }] });
      }
      sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
}

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : ' —— ' + detail}`);
  if (!ok) fails.push(name);
};

const getState = async (base) => (await fetch(`${base}/api/state`)).json();

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
    const cfgPath = path.join(dir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    WRITER_ID = (cfg.bots || [])[0]?.id || 'BOT1';
    WRITER_NAME = (cfg.bots || [])[0]?.name || WRITER_ID;

    const llmPort = await pickFreePort();
    llm = fakeLLM();
    await new Promise((r) => llm.listen(llmPort, '127.0.0.1', r));
    for (const m of cfg.models || []) {
      m.baseURL = `http://127.0.0.1:${llmPort}/v1`;
      m.apiKey = 'sk-fake';
      delete m.apiKeyEnv;
    }
    // 关长文续写：本轮验证重点是提示语内容，不是真的写几千字
    cfg.longReply = false;
    cfg.longReplyAuto = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    // ② 标准要求：输出头尾 + 计数器　③ 世界卡：先给一份底稿
    const memDir = path.join(dir, 'memory', WRITER_ID);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'standards.md'), [
      '# 标准要求', '',
      '## 输出头尾',
      `- 开头：${HEAD_REQ}`,
      `- 结尾：${TAIL_REQ}`, '',
      '## 计数器',
      '- 好感度：范围 0–100 / 初始 0', '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(memDir, 'world.md'), [
      '# 世界卡', '',
      '## 世界设定',
      '- 架空古代，三城并立，渡口是南北唯一的通路。', '',
      '## 世界的改变',
      '',
    ].join('\n'), 'utf8');

    // ★ ④⑤ 是系统生成文件，首次压缩前磁盘上并不存在 —— 这里先种上，
    //   否则面板里「自动生成」分组是空的，命名断言无从验证。⑥ 同理（用户自建的 .md）。
    fs.writeFileSync(path.join(memDir, 'events_summary.md'), '（初始剧情概览：主角刚抵达渡口。）\n', 'utf8');
    fs.writeFileSync(path.join(memDir, 'events_archive.md'), '- [2026/10/1 09:00] (P3) 主角抵达渡口\n', 'utf8');
    fs.writeFileSync(path.join(memDir, 'extra_prompt.md'), '# 附加提示词\n每章结尾留一个钩子。\n', 'utf8');

    const seenPort = llmPort;
    for (const f of ['app.js', 'style.css', 'design.css', 'index.html']) {
      const src = path.join(REPO_ROOT, 'public', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'public', f));
    }

    srv = await startServer(dir, port);
    console.log(`沙箱已启动 ${srv.base}（假 LLM :${seenPort}）　写手 ${WRITER_ID}（${WRITER_NAME}）\n`);

    browser = await chromium.launch({ executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

    await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });

    // ── ① 六段式文件与面板分组 ──
    console.log('[1] 写手档案：六段式');
    const files = await (await fetch(`${srv.base}/api/memory/${WRITER_ID}/files`)).json();
    const keys = (files.files || []).map((f) => f.key);
    check('② 标准要求 standards 存在', keys.includes('standards'), JSON.stringify(keys));
    check('③ 世界卡 world 存在', keys.includes('world'), JSON.stringify(keys));
    const named = Object.fromEntries((files.files || []).map((f) => [f.key, f.name]));
    check('展示名是「标准要求」而不是 standards', named.standards === '标准要求', String(named.standards));
    check('展示名是「世界卡」而不是 world', named.world === '世界卡', String(named.world));
    check('⑥ 旧预设改名（世界观/背景 · 资料库 · 写作特征）',
      named.plot === '世界观/背景' && named.content === '资料库' && named.traits === '写作特征',
      JSON.stringify({ plot: named.plot, content: named.content, traits: named.traits }));

    await page.evaluate((id) => window.selectBot && window.selectBot(id, 'memory'), WRITER_ID);
    await page.waitForTimeout(1200);
    const memTxt = await page.textContent('.mem-card').catch(() => '');
    check('★ 面板出现「写手档案」分组', /写手档案/.test(memTxt), memTxt.slice(0, 120));
    check('★ 面板出现「附加提示词（自建）」分组说明', /附加提示词/.test(memTxt));
    check('★ 面板出现「自动生成」分组（④⑤）', /自动生成/.test(memTxt));
    await page.screenshot({ path: path.join(SHOT, 'wb-memory-groups.png') });

    // ── ②③ 写手提议世界改变 → 确认条 ──
    console.log('\n[2] 写手提议「世界改变」');
    state.mode = 'world';
    await page.evaluate((id) => window.selectBot && window.selectBot(id, 'chat'), WRITER_ID);
    await page.waitForTimeout(800);
    await page.fill('#f-chat', '把渡口那场戏写完，桥烧了');
    await page.evaluate((id) => window.directChat(id), WRITER_ID);
    await page.waitForTimeout(3000);
    const bar = await page.$('#pending-strip .admin-action');
    check('对话页画出「待确认」确认条', !!bar);
    const barTxt = bar ? await bar.textContent() : '';
    check('★ 文案说明是「写手」提议记世界改变',
      /写手/.test(barTxt) && /世界改变/.test(barTxt), barTxt.slice(0, 140));
    check('文案带出改变正文', barTxt.includes(WORLD_CHANGE.slice(0, 10)), barTxt.slice(0, 160));
    await page.screenshot({ path: path.join(SHOT, 'wb-pending.png') });

    const before = fs.readFileSync(path.join(memDir, 'world.md'), 'utf8');
    check('★ 提议阶段不落盘（world.md 还没变）', !before.includes(WORLD_CHANGE));

    console.log('\n[3] 点「确认应用」');
    if (bar) {
      const okBtn = await bar.$('button[onclick*="confirmEdit"]');
      if (okBtn) {
        await okBtn.click();
        await page.waitForTimeout(600);
        check('二次确认弹窗出现并被确认', await confirmDialog(page));
      } else check('找到确认按钮', false);
    }
    await page.waitForTimeout(1000);
    const after = fs.readFileSync(path.join(memDir, 'world.md'), 'utf8');
    check('★★ world.md 追加了这条世界改变', after.includes(WORLD_CHANGE), after.slice(0, 200));
    check('★★ 世界设定底稿原样保留（不是整份覆盖）',
      after.includes('三城并立，渡口是南北唯一的通路'), after.slice(0, 160));
    check('条目记下了提议者', after.includes(WRITER_NAME), after.slice(-160));
    await page.screenshot({ path: path.join(SHOT, 'wb-applied.png') });

    // ── ④ 改变会进写手 system ──
    const seen = await (await fetch(`http://127.0.0.1:${seenPort}/__seen`)).json();
    const sysAll = (seen.systems || []).join('\n');
    check('★ 写手 system 含【你的世界卡】段', /【你的世界卡】/.test(sysAll), sysAll.slice(-200));
    check('★ 写手 system 说明了 propose_world_change 的用途',
      /propose_world_change/.test(sysAll) && /世界层面/.test(sysAll));

    // ── ⑤ 输出头尾：引擎保证只套一次 ──
    console.log('\n[4] ② 输出头尾要求');
    // 长文开着才会分段：临时打开长文（目标 3000 → 触发续写），再让写手跑一段
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg2.longReply = true;
    cfg2.longReplyTarget = 3000;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2), 'utf8');
    state.prompts = [];
    state.mode = 'idle';
    await page.fill('#f-chat', '写一段长文');
    await page.evaluate((id) => window.directChat(id), WRITER_ID);
    await page.waitForTimeout(6000);
    const seen2 = await (await fetch(`http://127.0.0.1:${seenPort}/__seen`)).json();
    // ★ 去重：工具循环里 round2 会把同一条 messages 再发一遍（role:'tool' 不是 user），
    //   所以同一条指令会出现两次 —— 那是同一次往返，不是「第二段又套了一次开头」。
    const prompts = [...new Set(seen2.prompts || [])];
    const withHead = prompts.filter((p) => p.includes('整篇开头要求'));
    const withTail = prompts.filter((p) => p.includes('整篇结尾要求'));
    const withNoTail = prompts.filter((p) => p.includes('这一段**不要**写结尾套话'));
    check('★ 首段提示带「开头要求」且带出要求原文',
      withHead.length >= 1 && withHead[0].includes(HEAD_REQ), JSON.stringify(withHead.slice(0, 1)));
    check('★★ 开头要求只出现一次（不是每段都套）', withHead.length === 1, `出现 ${withHead.length} 次`);
    check('★ 结尾要求只给末段', withTail.length <= 1, `出现 ${withTail.length} 次`);
    check('★ 中间段被明确告知「还没到结尾，别写结尾套话」', withNoTail.length >= 1,
      JSON.stringify(prompts.slice(0, 3)));
    await page.screenshot({ path: path.join(SHOT, 'wb-headtail.png') });

    // ── ⑥ 剧情概览命名 ──
    console.log('\n[5] ④⑤ 剧情概览 / 剧情记录');
    const files2 = await (await fetch(`${srv.base}/api/memory/${WRITER_ID}/files`)).json();
    const genNames = Object.fromEntries((files2.files || []).filter((f) => f.sys).map((f) => [f.key, f.name]));
    check('★ events_summary 展示为「剧情概览」', genNames.events_summary === '剧情概览', JSON.stringify(genNames));
    check('★ events_archive 展示为「剧情归档（原文）」', /剧情归档/.test(String(genNames.events_archive)), String(genNames.events_archive));

    // ── ⑦ 无 JS 错误 ──
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
