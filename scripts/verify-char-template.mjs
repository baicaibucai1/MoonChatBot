// 真机验证：角色卡模板 + 形象链接（角色卡是纯文本，图片只以链接挂在卡上）
//
// 为什么必须真机跑：
//   纯逻辑有 characters.test.mjs 兜着（applyCharTemplate / DEFAULT_CHAR_TEMPLATE 5 条），
//   但「模板能不能真的落到新建的角色卡上」只能靠浏览器证明：
//     设置页改模板 → PUT /api/config → config.json
//       → 角色池「新建角色」→ 弹窗预填模板正文（{{名字}} 已换掉）
//       → 保存 → POST /api/characters → 角色卡 persona 就是模板骨架
//       → ★ 模板里的 `##Counter：好感度[0,100]` 被引擎读到 → 该角色立刻有范围（无需再写标准要求）
//       → 形象链接填 URL → 角色池卡片上真的显示图片
//   任一环没接上，单测全绿而用户点「新建」看到的是空白的卡片。
//
// 验证点：
//   ① 设置 → 角色卡：改模板并保存，写进 config.json
//   ② 新建角色弹窗预填模板正文（不是空白）
//   ③ 保存后角色卡 persona = 模板骨架，且 {{名字}} 已换成实际角色名
//   ④ ★ 模板里的 ##Counter 被引擎读到：写手侧计数器范围立即生效（不用另写标准要求）
//   ⑤ 形象链接存进 avatar、角色池卡片真的 <img>
//   ⑥ 全程无 JS 错误
//
// 用法：node scripts/verify-char-template.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, pickFreePort, REPO_ROOT } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const TPL_MARK = '## 形象';
const NEW_NAME = '探针新角色';
const EXP_TEXT = '初遇那天她替我挡了雨';
const DELTA = 500;   // 故意越界：模板里上限 100

// ── 假 LLM：只服务「写手消息流」那一轮（提议沉淀 +500 好感度）──
function fakeLLM() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON */ }
      const msgs = payload.messages || [];
      const hasToolResult = msgs.some((m) => m.role === 'tool');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };
      const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');

      if (hasToolResult) {
        sse({ ...base, choices: [{ index: 0, delta: { content: '（提议已交给用户确认）' }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const args = { characterId: NEW_CHAR_ID_HOLDER.value, text: EXP_TEXT, counters: { 好感度: DELTA }, reason: '验证模板里的 ##Counter 范围生效' };
      sse({
        ...base,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'propose_experience_commit', arguments: '' } }] },
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
    });
  });
}
// 新建角色的 id 要到运行时才知道（后端生成）→ 用一个盒子在两步之间传值
const NEW_CHAR_ID_HOLDER = { value: '' };

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : ' —— ' + detail}`);
  if (!ok) fails.push(name);
};

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
    await page.waitForTimeout(1600);
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.evaluate(() => window.loadState && window.loadState(false));
    await page.waitForTimeout(900);

    // ── ① 设置 → 角色卡：改模板 ──
    console.log('[1] 设置 → 角色卡：写入自定义模板');
    // ★ openSettings() 不吃参数，分页从 localStorage 的 qqbot-stab 读
    await page.evaluate(() => { try { localStorage.setItem('qqbot-stab', 'character'); } catch {} });
    await page.evaluate(() => window.openSettings && window.openSettings());
    await page.waitForTimeout(1200);
    const preTpl = await page.inputValue('#chr-tpl').catch(() => '');
    check('角色卡模板页预填了默认模板（含 ##Counter 与 {{名字}}）',
      /##Counter/.test(preTpl) && /\{\{名字\}\}/.test(preTpl), preTpl.slice(0, 120));
    await page.screenshot({ path: path.join(SHOT, 'tpl-settings.png') });

    const myTpl = [
      '# {{名字}}',
      '',
      TPL_MARK,
      '- 外表：',
      '',
      '## 基本设定',
      '- 身份：',
      '',
      '##Counter：好感度[0,100]',
      '##Counter：信任[]',
      '',
    ].join('\n');
    await page.fill('#chr-tpl', myTpl);
    await page.evaluate(() => window.saveCharTemplate && window.saveCharTemplate());
    await page.waitForTimeout(900);
    const cfgNow = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('★ 模板已写进 config.json', String(cfgNow.characterTemplate || '').includes(TPL_MARK),
      String(cfgNow.characterTemplate || '').slice(0, 80));

    // ── ② 新建角色：应预填模板 ──
    console.log('\n[2] 角色池 → 新建角色');
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.openCharacterEditModal && window.openCharacterEditModal(null));
    await page.waitForTimeout(900);
    const filled = await page.inputValue('#chr-persona').catch(() => '');
    check('★ 新建弹窗预填了模板正文（不是空白）', filled.includes(TPL_MARK), filled.slice(0, 120));
    check('弹窗里有「形象链接」输入框', !!(await page.$('#chr-avatar')));
    await page.screenshot({ path: path.join(SHOT, 'tpl-new-modal.png') });

    await page.fill('#chr-name', NEW_NAME);
    // ★ 形象链接指向**沙箱内真实存在**的文件（/logo.svg）。
    //   用 example.com 那种外网地址的话，图片 404 → 前端 onerror 会退回名字首字，
    //   断言 <img> 就永远看不到（这不是 bug，是降级行为，得用能加载的地址去验）
    await page.fill('#chr-avatar', '/logo.svg');
    // 模板里 {{名字}} 的替换发生在保存时（此时姓名才可知）
    await page.evaluate(() => window.saveCharacter(null));
    await page.waitForTimeout(1600);

    const st = await (await fetch(`${srv.base}/api/state`)).json();
    const created = (st.characters || []).find((c) => c.name === NEW_NAME);
    check('角色已创建', !!created, JSON.stringify((st.characters || []).map((c) => c.name)));
    check('★ 角色卡正文 = 模板骨架（含小节）', !!created && created.persona.includes(TPL_MARK),
      String(created && created.persona).slice(0, 140));
    check('★★ 模板里的 {{名字}} 已换成实际角色名',
      !!created && created.persona.includes(`# ${NEW_NAME}`) && !created.persona.includes('{{'),
      String(created && created.persona).slice(0, 80));
    check('形象链接存进 avatar', !!created && created.avatar === '/logo.svg',
      String(created && created.avatar));

    // ── ③ ★ 模板里的 ##Counter 应立刻成为该角色的计数器范围 ──
    console.log('\n[3] ★ 模板里的 ##Counter 被引擎读到（无需再写标准要求）');
    NEW_CHAR_ID_HOLDER.value = created ? created.id : '';
    // 把新角色挂给写手，让写手能对它沉淀经历
    // ★ 这个接口收的是 characterIds（**数组**，整份覆盖），不是单个 characterId
    const cur = ((st.bots || []).find((b) => b.id === 'BOT1') || {}).activeCharacterIds || [];
    const attach = await (await fetch(`${srv.base}/api/bots/BOT1/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterIds: [...new Set([...cur, NEW_CHAR_ID_HOLDER.value])] }),
    })).json();
    check('新角色已挂进写手的角色池', attach.ok && attach.activeCharacterIds.includes(NEW_CHAR_ID_HOLDER.value),
      JSON.stringify(attach));
    await page.evaluate(() => window.loadState && window.loadState(false));
    await page.waitForTimeout(800);
    await page.evaluate(() => window.selectBot && window.selectBot('BOT1', 'chat'));
    await page.waitForTimeout(800);

    await page.fill('#f-chat', '写一段初遇');
    await page.evaluate(() => window.directChat('BOT1'));
    await page.waitForTimeout(3200);
    const bar = await page.$('#pending-strip .admin-action');
    const barTxt = bar ? (await bar.textContent()).replace(/\s+/g, ' ') : '';
    console.log('    确认条：', barTxt.slice(0, 170));
    check('★ 写手提议的越界值被收敛到模板里的上限 100（不是 500）',
      /好感度/.test(barTxt) && /\+100/.test(barTxt) && !/\+500/.test(barTxt), barTxt.slice(0, 200));

    // ── ④ 角色池卡片上真的显示图片 ──
    console.log('\n[4] 角色池卡片上的形象');
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(1000);
    const hasImg = await page.$('.ch-card .ch-avatar img');
    check('★ 角色卡上的形象是 <img>（链接渲染成图）', !!hasImg);
    await page.screenshot({ path: path.join(SHOT, 'tpl-pool-avatar.png') });

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
  // ★ 别用 process.exit()：stdout 重定向时会丢未 flush 的日志（空输出 + exit 0）
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
