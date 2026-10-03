// 真机验证：面板管理员 AI 适配「写手卡 + 角色池」新机制
//
// 为什么必须真机跑，而不是只靠单测：
//   单测能证明 runAdminTool('list_characters') 返回的字符串里含角色名，
//   但证明不了这条链路真的通：
//     模型输出 tool_calls → streamAdminAgent 执行 → emit({type:'pending'})
//       → SSE 下发 → 前端 renderEditBar 画出确认条 → 点确认 → POST /api/characters
//   任何一环错位（比如 pending 事件没进 SSE、前端漏了 character_create 分支），
//   单测都照过，页面却是死的。所以这里用**假 LLM 按剧本吐 tool_calls**，
//   把整条链路钉死。
//
// 三个剧本（按用户消息关键词分派）：
//   ① 列角色池   → 模型调 list_characters，管理员应把角色名/被谁选用回给用户
//   ② 改角色设定 → 模型调 propose_character_edit，前端出确认条 → 确认 → traits 真变
//   ③ 新建角色   → 模型调 propose_character_create，前端出确认条 → 确认 → 池里多一个
//
// 用法：node scripts/verify-admin-characters.mjs

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
const NEW_CHAR_NAME = '真机验证新角色';

// ── 假 LLM：按剧本吐 tool_calls ──
// ⚠️ 管理员 agent 走的是 **流式** 端点（models.chatStream → adminStreamRound），
//    所以无论有没有 tool_calls，响应都必须是 SSE（`data: {...}\n\n`），
//    返回一次性 JSON 的话 adminStreamRound 一个 delta 都读不到 → 静默空转。
// ⚠️ 循环逻辑：「模型给 tool_calls → 服务端执行 → 回填 role:'tool' → 再问一轮」。
//    第一轮给 tool_calls，第二轮（消息里已有 tool 结果）必须给纯文本收尾，
//    否则会一直循环到 guard 上限 8 轮。
function fakeLLM() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON，按空处理 */ }
      const msgs = payload.messages || [];
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      const ask = String(lastUser?.content || '');
      console.log(`[fake-llm] hasToolResult=${hasToolResult} ask=${JSON.stringify(ask.slice(0, 40))}`);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };
      const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');

      // 第二轮：纯文本收尾。
      // ★ 把工具结果里的关键信息回述一遍 —— 管理员最终的「气泡文本」是**模型**说的话，
      //   不是工具输出。如果这里只回一句「处理完毕」，就没法验证「工具结果真的到了模型手里」。
      //   真实模型会转述，所以假模型也转述：把最近的 tool 结果截一段带出来。
      if (hasToolResult) {
        const lastTool = [...msgs].reverse().find((m) => m.role === 'tool');
        const snippet = String(lastTool?.content || '').slice(0, 200);
        const text = '已处理。工具返回如下：' + snippet;
        sse({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // 第一轮：按关键词决定调哪个工具
      let name, args;
      if (/新建|创建|加一个|新增/.test(ask)) {
        name = 'propose_character_create';
        args = {
          name: NEW_CHAR_NAME, persona: '真机验证用的新角色设定。', traits: '好奇', age: '20',
          tags: ['验证'], reason: '验证管理员能提议新建角色',
        };
      } else if (/改|调整|修改/.test(ask)) {
        name = 'propose_character_edit';
        args = { characterId: CHAR_ID, traits: '真机验证改写后的性格', reason: '验证管理员能提议改角色' };
      } else {
        name = 'list_characters';
        args = {};
      }
      // tool_calls 按增量下发（index=0，先 id+name，再 arguments 分片），贴近真实模型行为
      sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
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

// 在管理员面板里发一条消息，等回复落地
// ⚠️ 发送按钮没有 id（就一个 .admin-modal .admin-input-row .primary），按这个选。
async function askAdmin(page, text) {
  await page.fill('#admin-input', text);
  await page.evaluate(() => window.adminSend());
  await page.waitForTimeout(2500);
}

// 点二次确认弹窗的「确认应用」按钮（★ 按钮是 #cf-ok，不是 .primary —— 
// 管理员操作条自己也有个 .primary，误点会点到被遮住的那颗）
async function confirmDialog(page) {
  const ok = await page.$('#ui-confirm #cf-ok');
  if (ok) { await ok.click(); await page.waitForTimeout(1500); return true; }
  return false;
}

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  const dir = makeSandbox();
  let srv = null, llm = null, browser = null;
  try {
    const { port } = await patchSandboxConfig(dir);

    // 假 LLM 起在另一个端口，沙箱所有模型指过去
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
    // 确保有一个可用的管理员模型：把默认模型指向第一个
    cfg.bots[0].enabled = false;
    cfg.bots[0].appId = '__probe__';
    cfg.bots[0].appSecret = '__probe__';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    // 同步前端产物（沙箱是拷贝）
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

    // ── 打开管理员面板 ──
    const opened = await page.evaluate(() => {
      if (typeof window.openAdminPanel === 'function') { window.openAdminPanel(); return true; }
      return false;
    });
    check('管理员面板入口可打开', opened);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOT, 'admin-open.png') });

    const hasInput = await page.$('#admin-input');
    check('管理员输入框存在', !!hasInput);
    if (!hasInput) throw new Error('管理员面板没打开，后续无法验证');

    // ── 验证 1：角色池 chip + header 文案 ──
    const headTxt = await page.textContent('.admin-modal').catch(() => '');
    check('header 文案含「角色池」', /角色池/.test(headTxt), headTxt.slice(0, 80));
    const hasChip = await page.evaluate(() =>
      [...document.querySelectorAll('.admin-modal [onclick*="adminQuick"]')]
        .some((el) => /角色池/.test(el.textContent || '')));
    check('存在「角色池」快捷 chip', hasChip);

    // ── 验证 2：list_characters ──
    console.log('\n[1] 管理员列出角色池');
    await askAdmin(page, '请看一下现在角色池里有哪些角色');
    // ★ 校验两处：① 工具真的被调用了（chips 里有「角色池」）；
    //   ② 工具结果真的回到了模型手里（假模型把结果转述进了气泡文本）。
    const body1 = await page.textContent('#admin-msgs').catch(() => '');
    check('气泡里带出探针角色名「探针角色」', /探针角色/.test(body1), body1.slice(0, 120));
    check('气泡点出该角色被哪位写手选用（或未被选用）', /选用|暂未被/.test(body1));
    const toolChip = await page.evaluate(() =>
      [...document.querySelectorAll('#admin-msgs [class*="chip"], #admin-msgs [class*="tool"]')]
        .map((el) => el.textContent || '').join('|'));
    check('工具调用记录里出现「角色池」', /角色池/.test(toolChip), toolChip.slice(0, 120));
    await page.screenshot({ path: path.join(SHOT, 'admin-list-characters.png') });

    // ── 验证 3：propose_character_edit → 确认条 → 落盘 ──
    console.log('\n[2] 管理员提议修改角色设定');
    const before = (await getState(srv.base)).characters.find((c) => c.id === CHAR_ID);
    await askAdmin(page, '帮我把这个角色的性格改一下');
    await page.waitForTimeout(600);
    const hasEditBar = await page.$('.admin-action');
    check('前端画出「待确认」操作条', !!hasEditBar);
    const barTxt = hasEditBar ? await hasEditBar.textContent() : '';
    check('操作条文案说清了改的是「角色」', /角色/.test(barTxt), barTxt.slice(0, 100));
    await page.screenshot({ path: path.join(SHOT, 'admin-propose-character-edit.png') });

    // 点「查看」预览
    if (hasEditBar) {
      const previewBtn = await hasEditBar.$('button[onclick*="previewEdit"]');
      if (previewBtn) {
        await previewBtn.click();
        await page.waitForTimeout(400);
        const pvTxt = await page.textContent('#edit-preview, .preview-modal, body').catch(() => '');
        check('预览里用「改前 → 改后」对照', /改前/.test(pvTxt) && /改后/.test(pvTxt));
        await page.screenshot({ path: path.join(SHOT, 'admin-character-edit-preview.png') });
        await page.evaluate(() => document.getElementById('edit-preview')?.remove());
        await page.waitForTimeout(200);
      }
    }

    // 点「确认应用」→ 二次确认
    if (hasEditBar) {
      const confirmBtn = await hasEditBar.$('button[onclick*="confirmEdit"]');
      if (confirmBtn) {
        await confirmBtn.click();
        await page.waitForTimeout(600);
        const used = await confirmDialog(page);
        check('二次确认弹窗出现并被确认', used);
        const after = (await getState(srv.base)).characters.find((c) => c.id === CHAR_ID);
        check('确认后角色 traits 真的变了', after.traits !== before.traits,
          `${JSON.stringify(before.traits)} → ${JSON.stringify(after.traits)}`);
        check('改动留了版本档（可回滚）', (after.history || []).length > (before.history || []).length);
      } else {
        check('找到 character_edit 的确认按钮', false);
      }
    }
    await page.screenshot({ path: path.join(SHOT, 'admin-character-edit-applied.png') });

    // ── 验证 4：propose_character_create → 确认 → 池里多一个 ──
    console.log('\n[3] 管理员提议新建角色');
    const beforeCount = (await getState(srv.base)).characters.length;
    await askAdmin(page, '帮我新建一个角色吧');
    await page.waitForTimeout(600);
    // ★ 取**最后一个**操作条：旧的那条（改角色）已在上面确认过，
    //   $('.admin-action') 会返回第一条（或其被移除后的残留），文案自然不含新角色名。
    const createBar = await page.evaluateHandle(() => {
      const bars = [...document.querySelectorAll('.admin-action')];
      return bars[bars.length - 1] || null;
    });
    const createEl = createBar.asElement();
    check('前端画出「新建角色」确认条', !!createEl);
    const cbarTxt = createEl ? await createEl.textContent() : '';
    check('文案含角色名', cbarTxt.includes(NEW_CHAR_NAME), cbarTxt.slice(0, 120));
    await page.screenshot({ path: path.join(SHOT, 'admin-propose-character-create.png') });

    if (createEl) {
      const previewBtn = await createEl.$('button[onclick*="previewEdit"]');
      if (previewBtn) {
        await previewBtn.click();
        await page.waitForTimeout(400);
        const pv = await page.textContent('#edit-preview, .preview-modal, body').catch(() => '');
        check('新建预览把将写入的字段摊开', /角色设定|性格/.test(pv));
        await page.evaluate(() => document.getElementById('edit-preview')?.remove());
        await page.waitForTimeout(200);
      }
      const confirmBtn = await createEl.$('button[onclick*="confirmEdit"]');
      if (confirmBtn) {
        await confirmBtn.click();
        await page.waitForTimeout(600);
        const used = await confirmDialog(page);
        check('新建二次确认弹窗出现并被确认', used);
        const st = await getState(srv.base);
        check('池里多了一位角色', st.characters.length === beforeCount + 1,
          `${beforeCount} → ${st.characters.length}`);
        const created = st.characters.find((c) => c.name === NEW_CHAR_NAME);
        check('新角色的名字/字段正确写入', !!created && created.persona.includes('真机验证'),
          created ? JSON.stringify({ name: created.name, traits: created.traits }) : '未找到');
        check('新角色首版进了历史档', !!created && (created.history || []).length >= 1);
      } else {
        check('找到 character_create 的确认按钮', false);
      }
    }

    // ── 验证 5：无 JS 错误 ──
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
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
