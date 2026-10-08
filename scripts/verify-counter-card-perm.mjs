// 真机验证：角色卡正文的 `##Counter：名字[范围]` **本身就是一处声明**（= 允许权限）
//
// 用户决策 2026-10-08：「角色的计数器应该是绑定在角色身上的，但是写手可以根据提示词的
//   计数器创建计数器」→ 角色卡上写了 `##Counter：好感度[0,10]`，那位写手（哪怕自己
//   一个字都没在「标准要求」里声明）就应该**看得见、改得动**这个计数器。
//
// 为什么必须真机跑（而不是只靠 characters.test.mjs）：
//   单测只能证明 counterNamesFor 这个**函数**返回对了；真正会坏的是**六处调用点**各自
//   有没有把它接上 —— 只要有一处漏了，写手要么看不见、要么提议被静默丢掉，
//   而单测全绿。这条链路只有把服务真起起来、让假模型真提一次议才能证：
//     角色卡 persona 里写 `##Counter：好感度[0,10]`
//       → buildWriterBlock 的 stateBrief 把「好感度 0（0–10）」列给模型（看得见）
//       → 模型提 {好感度:+50} → filterDeclared(counterNamesFor(ch, [])) 不再丢（改得动）
//       → 提议阶段收敛成 +10 → 确认条写「好感度 +10（0 → 10）」
//       → 点确认 → 角色卡 counters.好感度 === 10
//
// 验证点：
//   ① 写手**没声明任何计数器**的前提下，系统提示词里就列出了角色卡的「好感度」
//   ② ★ 模型给的增量**没有被丢**：确认条出现且写 +10（旧代码会丢掉 → 数值不出现）
//   ③ ★ 确认后角色卡 counters.好感度 === 10（旧代码会一个数都不写）
//   ④ 范围以角色卡为准（[0,10] 赢过默认 0–100）
//   ⑤ ★★ 不越权：同名池里「别人选定的角色」卡上的计数器（秘密）不出现、也改不动
//   ⑥ 全程无 JS 错误
//
// 用法：node scripts/verify-counter-card-perm.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox,
  pickFreePort, REPO_ROOT, findProbeCharacter, putProbeCharacter,
} from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const CHAR_ID = 'CHRprobe0001';            // 写手选定的角色：卡上声明了「好感度」
const OTHER_ID = 'CHRprobe0077';           // 同池但**没被选定**的角色：卡上声明了「秘密」
const EXP_TEXT = '在渡口替老张挡了一刀';
const DELTA = 50;                          // 模型想加这么多
const MAXV = 10;                           // 角色卡上的上限
const SECRET = '秘密';

// ── 假 LLM ──
// ⚠️ 写手对话走**流式**端点，必须回 SSE；一次性 JSON 会静默空转。
// ⚠️ 第一轮给 tool_calls，第二轮（有 role:'tool'）必须纯文本收尾。
let allSystems = [];       // 本次跑动里出现过的每一份 system 提示词（拿来断言「看不看得见」）
function fakeLLM() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON */ }
      const msgs = payload.messages || [];
      const sys = msgs.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
      if (sys) allSystems.push(sys);
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      console.log(`[fake-llm] ${req.url} roles=[${msgs.map((m) => m.role).join(',')}] sys=${sys.length}字`);

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

      // ★ 故意混进一个「这张卡上没声明、只写在**别人的**卡上」的名字（秘密）：
      //   它必须被丢掉 —— 证明修好①之后**没有把权限全放开**。
      const args = {
        characterId: CHAR_ID,
        text: EXP_TEXT,
        counters: { 好感度: DELTA, [SECRET]: 5 },
        reason: '验证：角色卡上写了的计数器，写手不用再声明也能改',
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

const getChar = async (base, id = CHAR_ID) => {
  const st = await (await fetch(`${base}/api/state`)).json();
  return st.characters.find((c) => c.id === id) || {};
};

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

    // ★ 写手「标准要求」里**一个字都不声明**计数器 —— 这正是本次要修的处境。
    //   （只留一个无关小节，证明文件存在、只是没有计数器声明。）
    const standards = ['# 标准要求', '', '## 输出头尾', '- 开头：（留空）', '- 结尾：（留空）', ''].join('\n');
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
    cfg.bots[0].activeCharacterIds = [CHAR_ID];   // 只选定探针角色（0077 留在池里、没选定）

    // ★ 角色卡正文写死 `##Counter：好感度[0,10]` —— 这才是本次要认的那处声明
    const chr = findProbeCharacter(cfg, CHAR_ID);
    if (chr) chr.persona = `沙箱探针用的角色设定。\n\n##Counter：好感度[0,${MAXV}]\n`;
    // ★ 同池第二位角色：卡上声明了「秘密」，但它**没被选定** → 写手不该看得见
    putProbeCharacter(cfg, {
      id: OTHER_ID, ts: 1700000000099, name: '隔壁角色',
      persona: `别的角色。\n\n##Counter：${SECRET}[0,100]\n`,
      traits: '', age: '', appearance: '', background: '', tags: ['探针'], avatar: '',
      source: 'probe', counters: {}, experiences: [],
      history: [{
        by: 'user', ts: 1700000000099, name: '隔壁角色',
        persona: `别的角色。\n\n##Counter：${SECRET}[0,100]\n`,
        traits: '', age: '', appearance: '', background: '', tags: ['探针'], avatar: '',
      }],
    });
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
    console.log(`[0] 初始：好感度=${(before.counters || {})['好感度'] ?? '（无）'}　`
      + `角色卡 persona 含 ${/##Counter/.test(before.persona || '') ? '##Counter' : '（没有！）'}\n`);

    // ── ① 让写手跑一段剧情 ──
    console.log('[1] 让写手跑一段剧情（模型给 好感度 +50，另外塞一个「秘密」）');
    await page.fill('#f-chat', '继续写渡口那场戏');
    await page.evaluate(() => window.directChat('BOT1'));
    await page.waitForTimeout(3000);

    // ★ 先看「看不看得见」：写手那一轮的 system 提示词里，**【计数器】那一行**应列出
    //   角色卡的「好感度 0（0~10）」—— 只搜「好感度」三个字会被角色卡正文里的
    //   `##Counter：好感度[0,10]` 蒙混过关（那是 brief(full)，不是权限）。所以只认 【计数器】行。
    const writerSys = allSystems.filter((s) => s.includes('【关于角色经历与计数器】')
      || s.includes('【计数器】') || s.includes('探针角色'));
    const counterLines = writerSys.flatMap((s) => s.split('\n')).filter((l) => l.includes('【计数器】'));
    check('① ★ 写手没声明任何计数器，【计数器】行里仍列出了角色卡的「好感度（0~10）」',
      counterLines.some((l) => l.includes('好感度') && l.includes('0~10')),
      `共 ${allSystems.length} 份 system 提示词、${counterLines.length} 行【计数器】：`
      + (counterLines.join(' ／ ').slice(0, 200) || '（一行都没有）'));
    check('①b ★★ 不越权：同池「没被选定」的卡上的「秘密」不出现在任何提示词里',
      !allSystems.some((s) => s.includes(SECRET)),
      '提示词里出现了别人的「秘密」—— 隔离被放开了');

    const bar = await page.$('#pending-strip .admin-action');
    // ★ 有牙齿的一条：旧代码会把 好感度 静默丢掉（declared 为空 → kept 为空），
    //   确认条里就只剩经历文字、数值完全不出现。
    check('② ★ 模型给的增量没有被丢：确认条里出现「好感度」', !!bar && /好感度/.test(await bar.textContent()),
      bar ? (await bar.textContent()).replace(/\s+/g, ' ').slice(0, 200) : '（压根没有确认条）');

    const barTxt = bar ? (await bar.textContent()) : '';
    console.log('    确认条文案：', barTxt.replace(/\s+/g, ' ').slice(0, 160));
    check(`④ 范围以角色卡为准：文案写「好感度 +${MAXV}（0 → ${MAXV}）」而不是 +${DELTA}`,
      new RegExp(`好感度\\s*\\+${MAXV}`).test(barTxt) && new RegExp(`0\\s*→\\s*${MAXV}`).test(barTxt),
      barTxt.replace(/\s+/g, ' ').slice(0, 200));
    check('⑤ 越权的「秘密」不出现在确认条里', !barTxt.includes(SECRET),
      barTxt.replace(/\s+/g, ' ').slice(0, 200));
    await page.screenshot({ path: path.join(SHOT, 'counter-card-perm-bar.png') });

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
    check(`③ ★★ 确认后角色卡 counters.好感度 === ${MAXV}（旧代码这里会是空的）`,
      after.counters && after.counters['好感度'] === MAXV, JSON.stringify(after.counters));
    check('⑤b 角色卡上没有越权的「秘密」',
      !after.counters || !(SECRET in after.counters), JSON.stringify(after.counters));
    const exp = (after.experiences || []).find((e) => e.text === EXP_TEXT);
    check(`经历条目上记的也是实际增量 +${MAXV}`,
      exp && exp.counters && exp.counters['好感度'] === MAXV, JSON.stringify(exp && exp.counters));
    await page.screenshot({ path: path.join(SHOT, 'counter-card-perm-applied.png') });

    // ── ③ 角色池卡片上应显示范围 ──
    console.log('\n[3] 角色池页面显示');
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(900);
    const poolTxt = await page.textContent('.ch-card').catch(() => '');
    check('角色卡上显示计数器与值', /好感度/.test(poolTxt) && new RegExp(String(MAXV)).test(poolTxt),
      poolTxt.replace(/\s+/g, ' ').slice(0, 200));
    await page.screenshot({ path: path.join(SHOT, 'counter-card-perm-pool.png') });

    // ── ④ 无 JS 错误 ──
    console.log('\n[4] JS 错误');
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
