// 真机验证：写手的角色池（只读展示 / 就地新建 / 写手 propose_character_create / 权限边界）
//
// ★★ 2026-10-08 语义变更：池 ↔ 写手 **1:1**（用户：「角色池对应写手，写手不能查阅角色池
//   之外的角色」）。这份脚本原先验证的是「写手设置里勾选角色 → activeCharacterIds」——
//   那个交互**已经删掉**了：写手的角色 = 它专属池里的角色，改归属只能靠「换池」。
//   所以本轮把 ①②③ 换成「只读展示 + 保存设置动不了池成员」。
//
// 为什么必须真机跑：
//   本轮改动横跨三处，任何一处没接上都会「看着有、实际不生效」：
//     ① 写手设置弹窗里的「它的专属角色池」区块（**只读**，不再有勾选框）
//     ② 该区块的「新建角色」按钮 → 建完**直接落进**写手的专属池（POST 带 botId）
//     ③ 写手侧 propose_character_create 工具 → pending 确认条 → 确认后落盘 + 进池
//     ④ 权限边界：写手只能改**自己池里**的角色（改池外的必须被工具拒绝，不出现在确认条里）
//   单测碰不到 DOM 与 SSE，只有浏览器能证明这条链真的通。
//
// 验证点：
//   ① 写手设置里有「它的专属角色池」区块，只列自己池里的人、**没有勾选框**
//   ② ★ 保存写手设置**动不了**池成员（池是权威，表单不再能改归属）
//   ③ ★ 池外的角色不出现在这块里（不再有「勾进来」这条路）
//   ④ 「新建角色」→ 建完**直接落进**这位写手的专属池（poolId 就是它的池）
//   ⑤ 写手 propose_character_create → 确认条写明「写手…建议…并加入自己的角色池」→ 确认 → 落盘 + 进池
//   ⑥ ★ 权限边界：写手改池外角色 → 工具拒绝（回执含「你的角色池里没有」），**不**出确认条
//   ⑦ 全程无 JS 错误
//
// 用法：node scripts/verify-writer-pool.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, pickFreePort, REPO_ROOT, putProbeCharacter, probeCharacters } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

// ★ 写手 id 不写死：沙箱只在 bots 为空时才造「BOT1」，副本里若已有真实写手，
//   bots[0].id 就不是它 —— 脚本按实际配置取，否则整轮验证会静默跑在错误的写手上。
let WRITER_ID = 'BOT1';
let WRITER_NAME = '探针写手';
const CHAR_IN = 'CHRprobe0001';   // 这位写手专属池里的人
const CHAR_OUT = 'CHRprobe0002';  // **别的池**里的人 —— ⑥ 的越权用例需要它存在
const OTHER_POOL = 'POOLother';   // 一个无主池（谁都不该看见它里面的人）
const NEW_NAME = '墨';            // 写手提议新建的角色

const state = { mode: 'create', toolResults: [], system: '' };

// ── 假 LLM ──
// ⚠️ 写手对话走**流式**端点：响应必须是 SSE，回一次性 JSON 会静默空转。
// ⚠️ 循环语义：第一轮给 tool_calls，第二轮（已有 role:'tool'）必须纯文本收尾。
// ⚠️ 第二轮顺手把 tool result 记下来 —— 权限拒绝发生在工具回执里，页面上不显示，
//    只能从这一侧取证（否则「改池外角色被拒」这件事根本无法断言）。
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
      // ★ 只认**写手对话**那份 system：对话之后还会有一串后处理调用
      //   （蒸馏核心卡 / 提炼精彩时刻 …），它们的 system 完全不同，会把记录冲掉。
      const sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
      if (sys.includes('【你的身份：写手】')) state.system = sys;
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

      const args = state.mode === 'create'
        ? { name: NEW_NAME, persona: '渡口摆渡人的女儿，话少，认死理。', traits: '话少、认死理', reason: '渡口这场戏需要一个本地人' }
        : { characterId: CHAR_OUT, persona: '越权改写尝试', reason: '验证权限边界' };
      const fnName = state.mode === 'create' ? 'propose_character_create' : 'propose_character_edit';

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
const poolOf = (st) => ((st.bots || []).find((b) => b.id === WRITER_ID) || {}).activeCharacterIds || [];

// 点二次确认弹窗的「确认应用」（★ 用 #ui-confirm #cf-ok：
// 操作条自己也有 .primary，直接选 .primary 会点到被遮住的那颗）
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

    // ★ 角色要放进池里，不能写顶层的 cfg.characters —— 后者已退役，
    //   服务器只读 characterPools，往旧字段写等于没写（角色永远不会出现）。
    //   见 scripts/lib/sandbox.mjs 里 probePoolOf 的说明。
    // ★ CHAR_OUT 必须放进**另一个池**（默认池归 BOT1）：1:1 之后「看不见」的判据是
    //   池的归属，扔在同一个池里就等于它的人，⑥ 的越权用例会假通过。
    const cfgPath = path.join(dir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    putProbeCharacter(cfg, {
      id: CHAR_OUT, ts: 1700000000000, name: '池外角色', persona: '不属于任何写手，用来验证权限边界。',
      traits: '冷淡', age: '20', appearance: '灰衣', background: '来历不明', tags: ['边界'], avatar: '',
      source: 'probe', history: [],
    }, OTHER_POOL);
    // 探针角色必须存在（沙箱夹具已经在默认池里造好了同 id 的一位，这里是幂等合并）
    putProbeCharacter(cfg, {
      id: CHAR_IN, ts: 1700000000000, name: '探针角色', persona: '沙箱探针用的角色设定。',
      traits: '沉稳', age: '18', appearance: '黑发', background: '来历不明', tags: ['探针'], avatar: '',
      source: 'probe', history: [],
    });
    WRITER_ID = (cfg.bots || [])[0]?.id || 'BOT1';
    WRITER_NAME = (cfg.bots || [])[0]?.name || WRITER_ID;
    // ★ 1:1：写手只绑它自己那个池，池那侧的 botId 才是权威（夹具已设好 POOLdefault → BOT1）
    cfg.bots[0].poolIds = ['POOLdefault'];
    cfg.bots[0].activeCharacterIds = [CHAR_IN];
    cfg.bots[0].poolCharacterIds = [CHAR_IN];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    console.log(`探针写手：${WRITER_ID}（${WRITER_NAME}）　角色池：${probeCharacters(cfg).map((c) => c.name).join('、')}`);

    const llmPort = await pickFreePort();
    llm = fakeLLM();
    await new Promise((r) => llm.listen(llmPort, '127.0.0.1', r));
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    for (const m of cfg2.models || []) {
      m.baseURL = `http://127.0.0.1:${llmPort}/v1`;
      m.apiKey = 'sk-fake';
      delete m.apiKeyEnv;
    }
    // 关掉长文续写：否则写手正文会被拆成 N 段、来回请求十几轮，验证脚本干等
    cfg2.longReply = false;
    cfg2.longReplyAuto = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2), 'utf8');

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
    await page.evaluate((id) => window.selectBot && window.selectBot(id, 'chat'), WRITER_ID);
    await page.waitForTimeout(800);

    // ── ① 写手设置里出现「它的专属角色池」区块（只读）──
    console.log('[1] 写手设置 → 专属角色池区块（只读）');
    await page.evaluate((id) => window.openBotSettings(id), WRITER_ID);
    await page.waitForTimeout(700);
    const hasPool = await page.$('#bot-settings-modal .chr-pool');
    check('设置弹窗里有专属角色池区块', !!hasPool);
    const poolTxt = hasPool ? await hasPool.textContent() : '';
    check('区块标题写清是它的专属池', /专属角色池/.test(poolTxt), poolTxt.slice(0, 80));
    check('计数写「N 位 · 「池名」」（只算自己池里的人）',
      /1\s*位\s*·\s*「默认池」/.test(poolTxt), poolTxt.slice(0, 140));
    const chips = await page.$$('#bot-settings-modal .chr-pool-list .chr-pick');
    check('只列自己池里那 1 位', chips.length === 1, `实际 ${chips.length}`);
    const chipTxt = chips.length ? await chips[0].textContent() : '';
    check('列出的正是自己池里的角色', chipTxt.includes('探针角色'), chipTxt.slice(0, 80));
    const boxesN = await page.$$eval('#bot-settings-modal .chr-pick-box', (e) => e.length);
    check('★★ 没有勾选框了（归属不由这张表单决定）', boxesN === 0, `实际 ${boxesN} 个`);
    check('★★ 池外角色不出现在这块里（没有「勾进来」这条路）', !poolTxt.includes('池外角色'), poolTxt.slice(0, 140));
    await page.screenshot({ path: path.join(SHOT, 'wpool-settings.png') });

    // ── ② 保存写手设置动不了池成员 ──
    console.log('\n[2] 保存写手设置 → 池成员不变');
    const beforeSave = poolOf(await getState(srv.base)).slice().sort();
    await page.click('#bot-settings-modal .modal-foot .primary');
    await page.waitForTimeout(1400);
    let st = await getState(srv.base);
    check('★ 保存前后池成员完全一致（表单不再能改归属）',
      JSON.stringify(poolOf(st).slice().sort()) === JSON.stringify(beforeSave),
      `${JSON.stringify(beforeSave)} → ${JSON.stringify(poolOf(st))}`);

    // ── ③ 池外角色仍然不在池里 ──
    console.log('\n[3] 池外角色仍在别的池里');
    await page.evaluate((id) => window.openBotSettings(id), WRITER_ID);
    await page.waitForTimeout(600);
    const stTxt = await page.textContent('#bot-settings-modal .chr-pool');
    check('★ 池外角色没被带进来', !stTxt.includes('池外角色'), stTxt.slice(0, 140));
    await page.evaluate(() => window.closeBotSettings());
    await page.waitForTimeout(300);

    // ── ④ 「新建角色」→ 直接落进这位写手的专属池 ──
    console.log('\n[4] 设置里点「新建角色」');
    await page.evaluate((id) => window.openBotSettings(id), WRITER_ID);
    await page.waitForTimeout(700);
    await page.click('#bot-settings-modal .chr-pool-head button');
    await page.waitForTimeout(600);
    const hasModal = await page.$('#chr-edit-modal');
    check('弹出新建角色弹窗', !!hasModal);
    await page.fill('#chr-name', '阿霁');
    await page.fill('#chr-persona', '渡口卖伞的姑娘。');
    await page.click('#chr-edit-modal .chr-modal-acts button.primary');
    await page.waitForTimeout(1600);
    st = await getState(srv.base);
    const made = (st.characters || []).find((c) => c.name === '阿霁');
    check('★ 角色真的建出来了', !!made, JSON.stringify((st.characters || []).map((c) => c.name)));
    check(`★★ 新角色直接落进它的专属池（poolId=POOLdefault）`,
      !!(made && made.poolId === 'POOLdefault'),
      JSON.stringify({ made: made && made.id, poolId: made && made.poolId }));
    check('★★ 池成员里跟着多了一位', !!(made && poolOf(st).includes(made.id)),
      JSON.stringify({ made: made && made.id, pool: poolOf(st) }));
    // ★ 设置弹窗里那块列表要跟着刷新，否则用户会以为没建成功
    const listNow = await page.textContent('#bot-settings-modal .chr-pool-list').catch(() => '');
    check('★ 设置里的池列表已刷新（含刚建的角色）', /阿霁/.test(listNow), listNow.slice(0, 140));
    await page.screenshot({ path: path.join(SHOT, 'wpool-created.png') });
    await page.evaluate(() => window.closeBotSettings());
    await page.waitForTimeout(300);

    // ── ⑤ 写手 propose_character_create → 确认条 → 落盘 + 进池 ──
    console.log('\n[5] 写手在对话里提议新建角色');
    state.mode = 'create';
    await page.evaluate((id) => window.selectBot && window.selectBot(id, 'chat'), WRITER_ID);
    await page.waitForTimeout(700);
    await page.fill('#f-chat', '渡口这场戏还差一个本地人');
    await page.evaluate((id) => window.directChat(id), WRITER_ID);
    await page.waitForTimeout(3000);
    const bar = await page.$('#pending-strip .admin-action');
    check('对话页画出「待确认」确认条', !!bar);
    const barTxt = bar ? await bar.textContent() : '';
    check('★ 文案说明是「写手」提议新建', /写手/.test(barTxt) && /新建角色/.test(barTxt), barTxt.slice(0, 140));
    check('★ 文案说明会加入自己的角色池', /加入自己的角色池/.test(barTxt), barTxt.slice(0, 160));
    check('文案带出角色名', barTxt.includes(NEW_NAME), barTxt.slice(0, 160));
    await page.screenshot({ path: path.join(SHOT, 'wpool-pending.png') });

    const before = await getState(srv.base);
    check('提议阶段不落盘（池子里还没有他）',
      !(before.characters || []).some((c) => c.name === NEW_NAME),
      JSON.stringify((before.characters || []).map((c) => c.name)));

    console.log('\n[6] 点「确认应用」');
    if (bar) {
      const okBtn = await bar.$('button[onclick*="confirmEdit"]');
      if (okBtn) {
        await okBtn.click();
        await page.waitForTimeout(600);
        check('二次确认弹窗出现并被确认', await confirmDialog(page));
      } else check('找到确认按钮', false);
    }
    await page.waitForTimeout(1000);
    st = await getState(srv.base);
    const created = (st.characters || []).find((c) => c.name === NEW_NAME);
    check('★ 角色真的落盘', !!created, JSON.stringify((st.characters || []).map((c) => c.name)));
    check('★ 落盘内容带 persona', !!(created && /摆渡人/.test(created.persona || '')),
      String(created && created.persona).slice(0, 60));
    check('★★ 直接落进它的专属池（poolId=POOLdefault）', !!(created && created.poolId === 'POOLdefault'),
      JSON.stringify({ id: created && created.id, poolId: created && created.poolId }));
    check('★★ 池成员里跟着多了一位', !!(created && poolOf(st).includes(created.id)),
      JSON.stringify({ id: created && created.id, pool: poolOf(st) }));
    await page.screenshot({ path: path.join(SHOT, 'wpool-applied.png') });

    // ── ⑥ 权限边界：写手改池外角色 → 工具拒绝、不出确认条 ──
    console.log('\n[7] 权限边界：写手改「池外角色」');
    state.mode = 'edit-outside';
    state.toolResults = [];
    await page.fill('#f-chat', '把池外角色的设定改一下');
    await page.evaluate((id) => window.directChat(id), WRITER_ID);
    await page.waitForTimeout(3000);
    const bar2 = await page.$('#pending-strip .admin-action');
    check('★★ 越权改写**不**产生确认条', !bar2);
    const seen = await (await fetch(`http://127.0.0.1:${llmPort}/__seen`)).json();
    const results = (seen.toolResults || []).join('\n');
    check('★ 工具回执明确拒绝（你的角色池里没有这个 id）', /你的角色池里没有/.test(results),
      results.slice(0, 200));
    check('★ 拒绝回执里不回显池外角色的名字（找全池再拒绝就会漏）', !/池外角色/.test(results),
      results.slice(0, 200));
    st = await getState(srv.base);
    const outside = (st.characters || []).find((c) => c.id === CHAR_OUT);
    check('池外角色设定没被改动', !/越权改写尝试/.test(String(outside && outside.persona)),
      String(outside && outside.persona).slice(0, 60));

    // ── 提示词里讲清了写权限 ──
    check('★ 写手 system 含新建权限说明', /直接进你的角色池/.test(seen.system || ''), (seen.system || '').slice(-260));
    check('★ 写手 system 含「只能改自己池里」的边界',
      /只能改你自己角色池里的角色/.test(seen.system || ''), '');

    // ── ⑦ 无 JS 错误 ──
    console.log('\n[8] JS 错误');
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
  // ★ 用 exitCode 而不是 process.exit()：重定向到文件/管道时 stdout 是异步的，
  //   process.exit() 会把还没 flush 的日志整段丢掉（表现为空输出，极难排查）。
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
