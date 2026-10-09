// 真机验证：**角色池 ↔ 写手 1:1 的隔离**（用户 2026-10-08 报的严肃 bug）
//
// 用户原话：「角色池中的角色会干扰写手，应该改为角色池对应写手，
//   写手不能查阅角色池之外的角色，写手可以写如角色池」。
//
// 修好之前的样子（本探针就是要钉死它）：
//   · buildWriterBlock 用 allOf(cfg)（**全局**名单）当写手视野 →
//     写手 A 的提示词里带着写手 B 的角色名和 id；
//   · list_characters 也交出全局名单 → 写手能"查阅"别人的角色；
//   · propose_character_edit / propose_experience_commit 先在全局 find 再判权限 →
//     拒绝回执里**回显**了别人角色的名字（"查找限定在自己池里"才是对的）。
//
// 为什么必须真机跑（单测碰不到）：
//   tests/pools.test.mjs 只测 lib/characters.js 的纯函数。而本轮改动落在
//   server.js 的**六处调用点** + 前端筛法上 —— 只要有一处漏了，写手就又能看见
//   别家的人，而单测全绿。这条链路只有真起服务、让假模型真说一次话才能证。
//
// 验证点：
//   ① 写手 A 的 system 提示词里**只有自己池里的人**（名字 + id），B 的人一个都不出现
//   ② ★ 提示词里不再有「池中 N 位」这种**全局总数**（那是"外面还有人"的暗示）
//   ③ ★ list_characters 的工具回执只列自己池里的人
//   ④ ★★ 拿 B 的角色 id 去 propose_character_edit：被拒，且回执里**没有 B 角色的名字**
//   ⑤ 无主池里的角色同样任何人都看不见（无主 = 没人认领，不是"公共"）
//   ⑥ 写手可以写进自己的池：换池进来后，下一轮提示词里就出现了他
//   ⑦ 管理员视角仍是全局的（角色池页要能编辑所有人的角色）—— 别把隔离做过了头
//   ⑧ 入口收敛：POST /api/characters 带 botId 落进那位写手的池；旧的逐个勾选接口拒收
//   ⑨ 面板：写手「角色」标签页只渲染自己池里的人；侧栏池列表标出「归谁 / 无主」
//   ⑩ 全程无 JS 错误
//
// 用法：node scripts/verify-writer-isolation.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox,
  pickFreePort, REPO_ROOT,
} from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

// ── 夹具：两位写手、两个有主的池、一个无主池、四个人 ──
const BOTA = 'BOT1';            // 阿岩
const BOTB = 'BOT2';            // 阿雪
const BOTC = 'BOT3';            // 阿空（池是空的）—— 复现用户报的那个症状
const POOL_A = 'POOLrock';      // 归 BOT1
const POOL_B = 'POOLsnow';      // 归 BOT2
const POOL_EMPTY = 'POOLempty'; // 归 BOT3（空池）
const POOL_ORPHAN = 'POOLorphan'; // 无主（旧数据遗留）
const CH_A1 = 'CHRrock0001';    // 岩甲（BOT1 的）
const CH_A2 = 'CHRrock0002';    // 岩乙（BOT1 的）
const CH_B1 = 'CHRsnow0001';    // 雪见（BOT2 的）★ 只有 BOT2 能看到
const CH_ORPHAN = 'CHRorphan001'; // 无主之人（谁都不该看到）

// ★ 只在别人身上出现的记号 —— 阿岩那边出现任何一个都算泄露
const LEAK_WORDS = ['雪见', CH_B1, '绝密指数', '无主之人', CH_ORPHAN];
// ★ 阿空（空池写手）的提示词里，**这四个人一个都不该出现**
const ALL_OTHERS = ['岩甲', '岩乙', '雪见', '无主之人', CH_A1, CH_A2, CH_B1, CH_ORPHAN];

const cloneChar = (c) => ({ ...c, history: [{ ...c, by: 'user', ts: c.ts }] });
const mkChar = (id, name, persona) => cloneChar({
  id, ts: 1700000000000, name, persona,
  traits: '', age: '', appearance: '', background: '', tags: ['探针'], avatar: '',
  source: 'probe', counters: {}, experiences: [],
});

// ── 假 LLM：三轮工具循环 + 无 tools 的请求一律纯文本 ──
// ⚠️ 写手对话走**流式**端点，必须回 SSE。
// ⚠️ 长文规划 / 输出自检 / 蒸馏这些调用**不带 tools** —— 给它们 tool_calls 会把
//    它们引到「解析不出东西」的降级路径上，噪音很大。所以按 tools 在不在分流。
let allSystems = [];        // 本次跑动里出现过的每一份 system 提示词
let lastToolContents = [];  // 最后一次请求里带回来的全部 role:'tool' 内容（= 本轮所有工具回执）
let turn = 0;

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
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      if (toolMsgs.length) lastToolContents = toolMsgs.map((m) => String(m.content || ''));
      const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
      console.log(`[fake-llm] tools=${hasTools ? payload.tools.length : 0} toolResults=${toolMsgs.length} sys=${sys.length}字`);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };
      const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const textOut = (t) => {
        sse({ ...base, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      const toolOut = (name, args) => {
        sse({
          ...base,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] },
            finish_reason: null,
          }],
        });
        const s = JSON.stringify(args);
        for (let i = 0; i < s.length; i += 24) {
          sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: s.slice(i, i + 24) } }] }, finish_reason: null }] });
        }
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
      };

      if (!hasTools) { textOut('（未配置工具的后台调用，直接返回。这是一句用来占位的话。）'); return; }
      // 第 1 轮：让写手去查自己的角色名单（好断言回执里有什么）
      if (!toolMsgs.length) { toolOut('list_characters', {}); return; }
      // 第 2 轮：拿**别人**的角色 id 去改（好断言回执里没有别人的名字）
      if (toolMsgs.length === 1) {
        toolOut('propose_character_edit', {
          characterId: CH_B1,
          persona: '我想偷偷改掉别人家的角色。',
          reason: '验证隔离：池外角色应当改不动、也查不到',
        });
        return;
      }
      // 第 3 轮：收尾
      textOut('（这一轮我查过名单了）这一幕先写到这里。');
    });
  });
}

const fails = [];
let n = 0;
const check = (name, ok, detail) => {
  n++;
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : ' —— ' + detail}`);
  if (!ok) fails.push(name);
};

async function confirmDialog(page) {
  const ok = await page.$('#ui-confirm #cf-ok');
  if (ok) { await ok.click(); await page.waitForTimeout(900); return true; }
  return false;
}

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  const dir = makeSandbox();
  let srv = null, llm = null, browser = null;
  try {
    const { port } = await patchSandboxConfig(dir);

    // ── 把夹具整段换成「两位写手 + 三个池」 ──
    const cfgPath = path.join(dir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

    const botA = {
      id: BOTA, name: '阿岩', kind: 'writer',
      modelId: (cfg.models || [])[0]?.id || '',
      enabled: false, sandbox: false, personaFile: 'persona', avatar: '',
      useGlobal: false, webSearch: false, searchMode: 'auto',
      historyLimit: 10, intents: ['probe-intent'],
      // ★ 派生镜像：1:1 之后必须与池的所有者一致（池那侧的 botId 才是权威）
      poolIds: [POOL_A],
      activeCharacterIds: [CH_A1, CH_A2],
      poolCharacterIds: [CH_A1, CH_A2],
      moments: [], heartbeats: [],
    };
    const botB = {
      ...JSON.parse(JSON.stringify(botA)),
      id: BOTB, name: '阿雪',
      poolIds: [POOL_B],
      activeCharacterIds: [CH_B1],
      poolCharacterIds: [CH_B1],
    };
    // ★ 阿空：池是空的。这是用户报的那个症状的现场 —— 旧代码在「写手一个角色都没选」时
    //   会打印「池中 4 位」并把**全局四人**当「可选」列出来（名字 + id 一起给）。
    const botC = {
      ...JSON.parse(JSON.stringify(botA)),
      id: BOTC, name: '阿空',
      poolIds: [POOL_EMPTY],
      activeCharacterIds: [],
      poolCharacterIds: [],
    };
    cfg.bots = [botA, botB, botC];

    cfg.characterPools = [
      {
        id: POOL_A, name: '阿岩的池', desc: '', ts: 1700000000000, botId: BOTA,
        characters: [
          mkChar(CH_A1, '岩甲', '岩甲的角色设定。\n\n##Counter：默契[0,10]\n'),
          mkChar(CH_A2, '岩乙', '岩乙的角色设定。'),
        ],
      },
      {
        id: POOL_B, name: '阿雪的池', desc: '', ts: 1700000000000, botId: BOTB,
        characters: [mkChar(CH_B1, '雪见', '雪见的角色设定。\n\n##Counter：绝密指数[0,100]\n')],
      },
      {
        // 空池：写手有，但一个人都还没有
        id: POOL_EMPTY, name: '阿空的池', desc: '', ts: 1700000000000, botId: BOTC,
        characters: [],
      },
      {
        // 无主池：旧数据遗留。里面的角色**没有写手看得见**（用户要的语义）
        id: POOL_ORPHAN, name: '无主池', desc: '', ts: 1700000000000, botId: '',
        characters: [mkChar(CH_ORPHAN, '无主之人', '无主池里的角色设定。')],
      },
    ];
    delete cfg.characters;

    for (const b of cfg.bots) { b.enabled = false; b.appId = '__probe__'; b.appSecret = '__probe__'; }
    const llmPort = await pickFreePort();
    llm = fakeLLM();
    await new Promise((r) => llm.listen(llmPort, '127.0.0.1', r));
    for (const m of cfg.models || []) {
      m.baseURL = `http://127.0.0.1:${llmPort}/v1`;
      m.apiKey = 'sk-fake';
      delete m.apiKeyEnv;
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    fs.mkdirSync(path.join(dir, 'memory', BOTA), { recursive: true });
    fs.mkdirSync(path.join(dir, 'memory', BOTB), { recursive: true });

    for (const f of ['app.js', 'style.css', 'design.css', 'index.html']) {
      const src = path.join(REPO_ROOT, 'public', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'public', f));
    }

    srv = await startServer(dir, port);
    const base = srv.base;
    console.log(`沙箱已启动 ${base}（假 LLM :${llmPort}）\n`);

    const json = async (url, method, body) => {
      const r = await fetch(base + url, {
        method: method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: method && method !== 'GET' ? JSON.stringify(body === undefined ? {} : body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const state = async () => (await json('/api/state')).body;

    // ───────────────── ① 数据层：归属 ─────────────────
    console.log('[1] 数据层：池 ↔ 写手 1:1');
    const s0 = await state();
    const bA = s0.bots.find((b) => b.id === BOTA) || {};
    const bB = s0.bots.find((b) => b.id === BOTB) || {};
    check('BOT1 只绑一个池，且是阿岩的池', JSON.stringify(bA.poolIds || []) === JSON.stringify([POOL_A]), JSON.stringify(bA.poolIds));
    check('BOT2 只绑一个池，且是阿雪的池', JSON.stringify(bB.poolIds || []) === JSON.stringify([POOL_B]), JSON.stringify(bB.poolIds));
    const poolsResp = (await json('/api/pools')).body.pools || [];
    check('池视图带 botId / botName（前端要知道池归谁）',
      poolsResp.some((p) => p.id === POOL_A && p.botId === BOTA && p.botName === '阿岩')
      && poolsResp.some((p) => p.id === POOL_ORPHAN && !p.botId),
      JSON.stringify(poolsResp.map((p) => [p.id, p.botId, p.botName])));
    check('★ 无主池里的角色没有任何 poolIds 指向它（= 谁都不认领）',
      !s0.bots.some((b) => (b.poolIds || []).includes(POOL_ORPHAN)),
      JSON.stringify(s0.bots.map((b) => [b.id, b.poolIds])));
    check('管理员视角仍是全局（角色池页要能编辑所有人的角色）',
      (await json('/api/characters')).body.characters.length === 4,
      String((await json('/api/characters')).body.characters.length));

    // ───────────────── ② 提示词隔离 ─────────────────
    browser = await chromium.launch({ executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1400);
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });

    console.log('\n[2] 让阿岩跑一轮（模型第一件事就是 list_characters）');
    allSystems = []; lastToolContents = []; turn = 0;
    await page.evaluate((id) => window.selectBot(id, 'chat'), BOTA);
    await page.waitForTimeout(800);
    await page.fill('#f-chat', '继续写渡口那场戏');
    await page.evaluate((id) => window.directChat(id), BOTA);
    await page.waitForTimeout(3500);
    turn = allSystems.length;

    const sysAll = allSystems.join('\n');
    const sysA = allSystems.filter((s) => s.includes('【你的角色池') || s.includes('【你的身份：写手】')).join('\n');
    check('假模型确实收到了写手提示词（不为空断言，否则后面全是假过）', sysA.length > 100, `${sysA.length} 字`);
    check('① 阿岩的提示词里列出了自己池里的两个人（含 id）',
      sysA.includes('岩甲') && sysA.includes(CH_A1) && sysA.includes('岩乙') && sysA.includes(CH_A2));
    const leaked = LEAK_WORDS.filter((w) => sysA.includes(w));
    check('①b ★★ 阿雪的「雪见」、无主池的「无主之人」一个字都没进阿岩的提示词',
      leaked.length === 0, `泄露了：${leaked.join('、')}`);
    check('② ★ 提示词里不再有「池中 N 位」这种全局总数',
      !sysA.includes('池中'), sysA.split('\n').filter((l) => l.includes('池中')).join(' ／ ').slice(0, 160));
    check('②b 池标题报的是**自己池**的人数（2 位）',
      /【你的角色池（2 位）】/.test(sysA),
      (sysA.split('\n').find((l) => l.startsWith('【你的角色池')) || '（没有这行）'));

    // ───────────────── ③ 工具回执 ─────────────────
    console.log('\n[3] 工具回执（list_characters / 越权 propose_character_edit）');
    const listOut = lastToolContents.find((t) => t.includes('【你的角色池'));
    check('③ ★ list_characters 只列自己池里的人',
      !!listOut && listOut.includes('岩甲') && listOut.includes('岩乙'),
      listOut ? listOut.slice(0, 120) : `（没抓到 list_characters 回执，共有 ${lastToolContents.length} 条）`);
    const listLeak = LEAK_WORDS.filter((w) => listOut && listOut.includes(w));
    check('③b ★★ list_characters 回执里没有别家写手 / 无主池的角色',
      !!listOut && listLeak.length === 0, `泄露了：${listLeak.join('、')}`);

    const denyOut = lastToolContents.find((t) => t.includes('你的角色池里没有'));
    check('④ ★★ 拿阿雪的角色 id 去改：被拒（回执说"你的池里没有这个 id"）',
      !!denyOut, denyOut ? denyOut.slice(0, 140) : JSON.stringify(lastToolContents.map((t) => t.slice(0, 60))));
    check('④b ★★ 拒绝回执里**没有回显**阿雪角色的名字（找全池再拒绝就会漏这个名字）',
      !!denyOut && !denyOut.includes('雪见') && !denyOut.includes('绝密指数'),
      denyOut ? denyOut.slice(0, 200) : '（没有回执）');
    check('④c 拒绝回执顺手列了自己池里的 id（帮模型自助纠错）',
      !!denyOut && denyOut.includes(CH_A1));

    // ───────────────── ③′ 用户报的那个症状：空池写手 ─────────────────
    console.log('\n[3′] 阿空（池里一个人都没有）跑一轮 —— 旧代码在这里把全局名单当「可选」列出来');
    allSystems = []; lastToolContents = [];
    await page.evaluate((id) => window.selectBot(id, 'chat'), BOTC);
    await page.waitForTimeout(700);
    await page.fill('#f-chat', '我该写谁？');
    await page.evaluate((id) => window.directChat(id), BOTC);
    await page.waitForTimeout(3500);
    const sysC = allSystems.filter((s) => s.includes('【你的身份：写手】')).join('\n');
    check('⑤a ★★ 空池写手的提示词是「【你的角色池（空）】」',
      /【你的角色池（空）】/.test(sysC), (sysC.split('\n').find((l) => l.startsWith('【你的角色池')) || '（没有这行）'));
    check('⑤b ★★ 空池写手看不到任何角色（名字 + id 一个都没有）—— 这是用户报的那个 bug',
      ALL_OTHERS.every((w) => !sysC.includes(w)),
      `泄露了：${ALL_OTHERS.filter((w) => sysC.includes(w)).join('、')}`);
    const emptyList = lastToolContents.find((t) => t.includes('【你的角色池（空）】'));
    check('⑤c list_characters 对空池写手也返回「空」，不返回任何人的名字',
      !!emptyList && ALL_OTHERS.every((w) => !emptyList.includes(w)),
      lastToolContents.map((t) => t.slice(0, 70)).join(' ／ '));

    // ───────────────── ④ 面板 ─────────────────
    console.log('\n[4] 面板：写手「角色」标签页 + 侧栏池列表');
    await page.evaluate((id) => window.selectBot(id, 'characters'), BOTA);
    await page.waitForTimeout(900);
    const tabA = await page.textContent('.bot-tab-body').catch(() => '');
    check('⑨ 阿岩的角色页里有「岩甲」、「岩乙」',
      tabA.includes('岩甲') && tabA.includes('岩乙'), tabA.replace(/\s+/g, ' ').slice(0, 160));
    const tabLeak = LEAK_WORDS.filter((w) => tabA.includes(w));
    check('⑨b ★★ 阿岩的角色页里没有「雪见」/「无主之人」', tabLeak.length === 0, `出现了：${tabLeak.join('、')}`);
    await page.screenshot({ path: path.join(SHOT, 'writer-isolation-bot-tab.png') });

    await page.evaluate((id) => window.selectBot(id, 'characters'), BOTB);
    await page.waitForTimeout(800);
    const tabB = await page.textContent('.bot-tab-body').catch(() => '');
    check('⑨c ★ 阿雪的角色页里只有「雪见」，没有「岩甲」',
      tabB.includes('雪见') && !tabB.includes('岩甲'), tabB.replace(/\s+/g, ' ').slice(0, 160));

    const sideTxt = await page.textContent('#pool-list').catch(() => '');
    check('⑨d 侧栏池列表标出「归 阿岩」/「归 阿雪」/「无主」',
      /归\s*阿岩/.test(sideTxt) && /归\s*阿雪/.test(sideTxt) && /无主/.test(sideTxt),
      sideTxt.replace(/\s+/g, ' ').slice(0, 200));
    await page.screenshot({ path: path.join(SHOT, 'writer-isolation-sidebar.png') });

    // ───────────────── ⑤ 入口收敛 ─────────────────
    console.log('\n[5] 入口收敛：新建角色 / 换池 / 旧接口');
    const created = await json('/api/characters', 'POST', { name: '岩丙', botId: BOTA, persona: '新建在人名下。' });
    check('⑧ POST /api/characters 带 botId 建角色成功', created.status === 200 && created.body.ok, JSON.stringify(created.body).slice(0, 160));
    check('⑧b 新角色落进了**阿岩的池**（不是第一个池）',
      created.body.character && created.body.character.poolId === POOL_A,
      JSON.stringify(created.body.character && created.body.character.poolId));
    const badBot = await json('/api/characters', 'POST', { name: '没人要', botId: 'BOTnope' });
    check('⑧c 带不存在的写手 id → 404（不静默落到第一个池）', badBot.status === 404, String(badBot.status));
    const legacy = await json(`/api/bots/${BOTA}/characters`, 'PUT', { characterIds: [CH_B1] });
    check('⑧d 旧的「逐个勾选」接口拒收，并指路 /api/pools/move',
      legacy.status === 400 && /pools\/move/.test(legacy.body.err || ''), `${legacy.status} ${legacy.body.err || ''}`);
    const mkPool = await json('/api/pools', 'POST', { name: '想凭空建的池' });
    check('⑧e 不带 botId 的「新建池」被拒（池没有"公共"这一说）', mkPool.status === 400, String(mkPool.status));
    const mkPool2 = await json('/api/pools', 'POST', { name: '重复的池', botId: BOTA });
    check('⑧f 已经有池的写手再建池被拒（一位写手一个池）', mkPool2.status === 400, String(mkPool2.status));
    // ★★ 语义变更（2026-10-08 用户：「删除角色池的功能没有做」→「删了就真没了」）：
    //   有主的池现在**删得掉**了 —— 以前服务端 400、前端连按钮都不画，用户点删除毫无反应。
    //   这里拿阿空的**空池**试（删它不会牵连别的用例），删完那位写手变成「没有池」。
    const delOwned = await json(`/api/pools/${POOL_EMPTY}`, 'DELETE', {});
    check('⑧g ★★ 有主的池现在删得掉（曾经 400）',
      delOwned.status === 200 && delOwned.body.ok,
      `${delOwned.status} ${JSON.stringify(delOwned.body).slice(0, 120)}`);
    const c0 = await state();
    const bC0 = c0.bots.find((b) => b.id === BOTC) || {};
    check('⑧h ★ 删完那位写手变成「没有池」（poolIds 空、看不见任何角色）',
      (bC0.poolIds || []).length === 0 && (bC0.activeCharacterIds || []).length === 0,
      JSON.stringify({ poolIds: bC0.poolIds, active: bC0.activeCharacterIds }));
    // ★★ 关键回归：走一遍**写路径**（PUT /api/config 内部会 syncPoolCharacters），
    //    确认池**不会**被自动补回来 —— 旧实现就是在这里补的，所以用户以为按钮失灵。
    const cfgBack = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    await json('/api/config', 'PUT', { bots: cfgBack.bots });
    const c1 = await state();
    check('⑧i ★★ 走完写路径后仍然没有池（不会自动长出来）',
      (((c1.bots.find((b) => b.id === BOTC)) || {}).poolIds || []).length === 0,
      JSON.stringify(((c1.bots.find((b) => b.id === BOTC)) || {}).poolIds));
    check('⑧j ★ 想再给它一个池，就得**显式**建（面板「新建池」走的就是这条）',
      (await json('/api/pools', 'POST', { name: '阿空的新池', botId: BOTC })).status === 200);

    // ───────────────── ⑥ 写手可以写进角色池 ─────────────────
    console.log('\n[6] 把「雪见」换池给阿岩 → 下一轮阿岩就看得见他');
    const moved = await json('/api/pools/move', 'POST', { characterId: CH_B1, toPoolId: POOL_A });
    check('⑥ 换池成功', moved.status === 200 && moved.body.ok, JSON.stringify(moved.body).slice(0, 160));
    const s1 = await state();
    const bA2 = s1.bots.find((b) => b.id === BOTA) || {};
    check('⑥b 换池后阿岩的派生名单里出现了雪见',
      (bA2.activeCharacterIds || []).includes(CH_B1), JSON.stringify(bA2.activeCharacterIds));
    const bB2 = s1.bots.find((b) => b.id === BOTB) || {};
    check('⑥c 同时从阿雪那边撤掉了', !(bB2.activeCharacterIds || []).includes(CH_B1), JSON.stringify(bB2.activeCharacterIds));

    allSystems = []; turn = 0;
    await page.evaluate((id) => window.selectBot(id, 'chat'), BOTA);
    await page.waitForTimeout(700);
    await page.fill('#f-chat', '再写一段');
    await page.evaluate((id) => window.directChat(id), BOTA);
    await page.waitForTimeout(3500);
    const sysA2 = allSystems.filter((s) => s.includes('【你的身份：写手】')).join('\n');
    check('⑥d ★★ 下一轮阿岩的提示词里出现了「雪见」（"写手可以写进角色池"落地）',
      sysA2.includes('雪见') && sysA2.includes(CH_B1),
      sysA2.split('\n').find((l) => l.startsWith('【你的角色池')) || '（没有池标题）');
    check('⑥e 但无主池的「无主之人」仍然谁都看不到', !sysA2.includes('无主之人'));

    check('⑩ 全程无 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    console.log(`\n结果：共 ${n} 项，${fails.length ? '❌ ' + fails.length + ' 项失败' : '✅ 全部通过'}`);
    if (fails.length) console.log('失败项：', fails.join('、'));
    console.log('截图写入', SHOT);
    void turn;
  } finally {
    if (browser) await browser.close();
    if (srv) stopServer(srv.child);
    if (llm) llm.close();
    removeSandbox(dir);
  }
  process.exitCode = fails.length ? 1 : 0;
}
void confirmDialog;

main().catch((e) => { console.error(e); process.exitCode = 1; });
