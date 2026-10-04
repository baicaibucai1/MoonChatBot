// 真机验证：计数器新语法 `##Counter：名字[范围]` + 引擎 clamp
//
// 为什么必须真机跑：
//   纯逻辑有 characters.test.mjs 兜着（parseCounterSpecs / projectCounters 等 10 条），
//   但「范围从哪来、在**提议阶段**就收敛、收敛后用户看到什么」这条链路只能靠浏览器证明：
//     角色卡正文写 `##Counter：好感度[0,10]`
//       → counterSpecsFor 取角色卡规格（胜过写手「标准要求」里写的 [0,100]）
//       → 模型提 +50 → projectCounters 收敛成 +10
//       → 待确认条显示「好感度 +10（0 → 10）」而不是 +50
//       → 点确认 → POST /commit 再收敛一次（防前端绕过）→ 角色卡 = 10
//   任一环没接上，单测全绿而用户看到的数是错的。
//
// 验证点：
//   ① 角色卡上的范围**优先于**写手标准要求里的范围
//   ② ★ 提议阶段就收敛：确认条写 +10，不是 +50
//   ③ 确认后角色卡 counters.好感度 === 10（压在上限，不是 50）
//   ④ 经历条目上记的也是实际增量 +10（不能记成 +50）
//   ⑤ 标准要求弹窗里出现计数器语法提示条
//   ⑥ 全程无 JS 错误
//
// 用法：node scripts/verify-counter-spec.mjs

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
const EXP_TEXT = '在渡口替老张挡了一刀';
const DELTA = 50;     // 模型想加这么多
const MAXV = 10;      // 角色卡上的上限

// ── 假 LLM ──
// ⚠️ 写手对话走**流式**端点，必须回 SSE；一次性 JSON 会静默空转。
// ⚠️ 第一轮给 tool_calls，第二轮（有 role:'tool'）必须纯文本收尾。
function fakeLLM() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON */ }
      const msgs = payload.messages || [];
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      console.log(`[fake-llm] hasToolResult=${hasToolResult}`);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };
      const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');

      if (hasToolResult) {
        const text = '（提议已交给用户确认）这一幕我写到这里。';
        sse({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const args = {
        characterId: CHAR_ID,
        text: EXP_TEXT,
        counters: { 好感度: DELTA },
        reason: '验证：超出上限的增量应被收敛',
      };
      sse({
        ...base,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'propose_experience_commit', arguments: '' } }] },
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

const getChar = async (base) => {
  const st = await (await fetch(`${base}/api/state`)).json();
  return st.characters.find((c) => c.id === CHAR_ID) || {};
};

// 二次确认弹窗（★ 用 #ui-confirm #cf-ok：操作条自己也有 .primary）
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

    // ★ 写手「标准要求」里声明范围 [0,100] —— 故意比角色卡的 [0,10] 宽松，
    //   用来验证「角色卡优先」。
    const standards = [
      '# 标准要求', '',
      '## 输出头尾',
      '- 开头：（留空）',
      '- 结尾：（留空）', '',
      '## 计数器',
      '##Counter：好感度[0,100]', '',
    ].join('\n');
    fs.mkdirSync(path.join(dir, 'memory', 'BOT1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'BOT1', 'standards.md'), standards, 'utf8');

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
    if (!Array.isArray(cfg.bots[0].activeCharacterIds) || !cfg.bots[0].activeCharacterIds.includes(CHAR_ID)) {
      cfg.bots[0].activeCharacterIds = [CHAR_ID];
    }
    // ★ 角色卡正文里写死范围 [0,10] —— 这才是权威来源
    const chr = (cfg.characters || []).find((c) => c.id === CHAR_ID);
    if (chr) chr.persona = `沙箱探针用的角色设定。\n\n##Counter：好感度[0,${MAXV}]\n`;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

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
    await page.waitForTimeout(1500);
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.evaluate(() => window.selectBot && window.selectBot('BOT1', 'chat'));
    await page.waitForTimeout(900);

    const before = await getChar(srv.base);
    console.log(`[0] 初始：好感度=${(before.counters || {})['好感度'] ?? '（无）'}　角色卡 persona 含 ${/##Counter/.test(before.persona || '') ? '##Counter' : '（没有！）'}\n`);

    // ── ① 写手提议 +50 ──
    console.log('[1] 让写手跑一段剧情（模型给 好感度 +50）');
    await page.fill('#f-chat', '继续写渡口那场戏');
    await page.evaluate(() => window.directChat('BOT1'));
    await page.waitForTimeout(3000);

    const bar = await page.$('#pending-strip .admin-action');
    check('对话页画出「待确认」确认条', !!bar);
    const barTxt = bar ? (await bar.textContent()) : '';
    console.log('    确认条文案：', barTxt.replace(/\s+/g, ' ').slice(0, 160));
    // ★ 关键：应该是 +10（0 → 10），不能是 +50（0 → 50）
    check(`★ 提议阶段就被收敛：文案写「好感度 +${MAXV}（0 → ${MAXV}）」而不是 +${DELTA}`,
      new RegExp(`好感度\\s*\\+${MAXV}`).test(barTxt) && new RegExp(`0\\s*→\\s*${MAXV}`).test(barTxt),
      barTxt.replace(/\s+/g, ' ').slice(0, 200));
    check(`★ 角色卡的范围 [0,${MAXV}] 赢了写手标准要求的 [0,100]`,
      !new RegExp(`→\\s*${DELTA}`).test(barTxt), barTxt.replace(/\s+/g, ' ').slice(0, 200));
    await page.screenshot({ path: path.join(SHOT, 'counter-pending-bar.png') });

    // ── ② 点确认 → 真落盘 ──
    console.log('\n[2] 点「确认应用」');
    if (bar) {
      const okBtn = await bar.$('button[onclick*="confirmEdit"]');
      if (okBtn) {
        await okBtn.click();
        await page.waitForTimeout(600);
        check('二次确认弹窗出现并被确认', await confirmDialog(page));
      } else {
        check('找到确认按钮', false);
      }
    }
    await page.waitForTimeout(800);

    const after = await getChar(srv.base);
    check(`★★ 计数器压在上限 ${MAXV}（不是 ${DELTA}）`,
      after.counters && after.counters['好感度'] === MAXV, JSON.stringify(after.counters));
    const exp = (after.experiences || []).find((e) => e.text === EXP_TEXT);
    check('★ 经历条目上记的也是**实际生效**的增量 +10（不是 +50）',
      exp && exp.counters && exp.counters['好感度'] === MAXV, JSON.stringify(exp && exp.counters));
    await page.screenshot({ path: path.join(SHOT, 'counter-applied.png') });

    // ── ③ 角色池卡片上应显示范围 ──
    console.log('\n[3] 角色池页面显示');
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(900);
    const poolTxt = await page.textContent('.ch-card').catch(() => '');
    check('角色卡上显示计数器与值', /好感度/.test(poolTxt) && new RegExp(String(MAXV)).test(poolTxt),
      poolTxt.replace(/\s+/g, ' ').slice(0, 200));
    await page.screenshot({ path: path.join(SHOT, 'counter-pool-card.png') });

    // ── ④ 标准要求弹窗里的语法提示条 ──
    console.log('\n[4] 记忆文件弹窗的语法提示');
    await page.evaluate(() => window.selectBot && window.selectBot('BOT1', 'memory'));
    await page.waitForTimeout(900);
    await page.evaluate(() => window.openMemFile && window.openMemFile('BOT1', 'standards'));
    await page.waitForTimeout(700);
    const hint = await page.textContent('#memfile-modal .mf-syntax').catch(() => '');
    check('★ 标准要求弹窗里出现计数器语法提示条', /##Counter/.test(hint) && /不限/.test(hint), hint.slice(0, 160));
    await page.screenshot({ path: path.join(SHOT, 'counter-syntax-hint.png') });

    // ── ⑤ 无 JS 错误 ──
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
  // ★ 别用 process.exit()：stdout 重定向到文件时会丢未 flush 的日志（表现为空输出、exit 0）
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
