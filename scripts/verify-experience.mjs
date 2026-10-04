// 真机验证：经历 / 计数器机制（写手提议沉淀 → 面板确认 → 角色卡真落盘）
//
// 为什么必须真机跑：
//   纯逻辑有 characters.test.mjs 兜着（commitExperience / filterDeclared 等 20 条），
//   但那条链路是否被**真的接起来**只能靠浏览器证明：
//     模型吐 tool_calls propose_experience_commit
//       → chatWithBot 工具执行 → opts.onPending
//       → /chat/stream 的 pending 事件 → 前端 streamBotChat 第三条信道
//       → renderPendingStrip 画出确认条 → 点确认
//       → POST /api/characters/:id/commit → config.json 真写入
//   任一环没接上（比如前端压根没消费 pending 事件），单测全绿而页面是死的。
//
// 验证点：
//   ① 写手提议「沉淀经历 + 好感度+5」→ 面板出现确认条
//   ② ★ 异名不引用：同一次提议里混进未声明的「仇恨」，必须被丢掉并写进「已忽略」
//   ③ 确认后：角色卡 counters.好感度 === 5、没有 仇恨、多一条经历、by 是写手名
//   ④ ★ counters / experiences 不进版本档（history 长度不变）
//   ⑤ 角色卡 UI 上真的把计数器和最近经历显示出来了
//   ⑥ 全程无 JS 错误
//
// 用法：node scripts/verify-experience.mjs

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
const EXP_TEXT = '在渡口与老张结盟，答应替他找船';
const WRITER_NAME = '探针写手';

// ── 假 LLM ──
// ⚠️ 写手对话走的是**流式**端点（models.chatStreamCollect），响应必须是 SSE，
//    回一次性 JSON 的话一个 delta 都读不到 → 静默空转。
// ⚠️ 循环语义：第一轮给 tool_calls，第二轮（消息里已有 role:'tool'）必须给纯文本收尾。
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

      if (hasToolResult) {
        const text = '（提议已交给用户确认）这一幕我先写到这里。';
        sse({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // ★ 混进一个**没有声明过**的计数器「仇恨」——用来验证「异名不引用」
      const args = {
        characterId: CHAR_ID,
        text: EXP_TEXT,
        counters: { 好感度: 5, 仇恨: 99 },
        reason: '验证：只有声明过的「好感度」应生效',
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

// 点二次确认弹窗的「确认应用」按钮（★ 用 #ui-confirm #cf-ok：
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

    // ★ 给写手种一份「写手设定」，里面用「## 计数器」小节声明「好感度」。
    //   这就是计数器的「规则所在地」——与本轮验证的「值在角色卡」相呼应。
    const persona = [
      '# 写手设定', '',
      '你是探针写手，笔下人物说话克制。', '',
      '## 计数器',
      '- 好感度：范围 0–100，初次见面 0，被善待时 +1~5',
      '',
    ].join('\n');
    fs.mkdirSync(path.join(dir, 'memory', 'BOT1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'BOT1', 'persona.md'), persona, 'utf8');

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
    // 确保写手选用了探针角色（对话里才有角色可沉淀）
    if (!Array.isArray(cfg.bots[0].activeCharacterIds) || !cfg.bots[0].activeCharacterIds.includes(CHAR_ID)) {
      cfg.bots[0].activeCharacterIds = [CHAR_ID];
    }
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
    console.log(`[0] 初始状态：好感度=${before.counters ? before.counters['好感度'] : '（无）'}　经历=${(before.experiences || []).length} 条　历史=${(before.history || []).length} 版\n`);

    // ── ① 写手提议沉淀经历 ──
    console.log('[1] 在对话页让写手跑一段剧情');
    await page.fill('#f-chat', '继续写渡口那场戏');
    await page.evaluate(() => window.directChat('BOT1'));
    await page.waitForTimeout(3000);

    const bar = await page.$('#pending-strip .admin-action');
    check('对话页画出「待确认」确认条', !!bar);
    const barTxt = bar ? (await bar.textContent()) : '';
    check('文案说清是「写手」提议沉淀「经历」', /写手/.test(barTxt) && /经历/.test(barTxt), barTxt.slice(0, 120));
    check('文案带出计数器变化 好感度 +5', /好感度\s*\+5/.test(barTxt), barTxt.slice(0, 160));
    await page.screenshot({ path: path.join(SHOT, 'exp-pending-bar.png') });

    // 提议后到确认前，角色卡必须纹丝不动（提议阶段不落盘）
    const mid = await getChar(srv.base);
    check('★ 提议阶段不落盘（角色卡还没变）',
      ((mid.counters || {})['好感度'] ?? null) === ((before.counters || {})['好感度'] ?? null)
      && (mid.experiences || []).length === (before.experiences || []).length,
      JSON.stringify({ before: before.counters, mid: mid.counters }));

    // ── ② 预览里应显示计数器变化 + 「已忽略」的异名计数器 ──
    if (bar) {
      const pvBtn = await bar.$('button[onclick*="previewEdit"]');
      if (pvBtn) {
        await pvBtn.click();
        await page.waitForTimeout(400);
        const pv = await page.textContent('#edit-preview').catch(() => '');
        check('预览列出经历正文', pv.includes(EXP_TEXT), pv.slice(0, 100));
        // 新格式：`好感度　0 → 5（+5）`（带变前/变后，被范围收敛时才看得出差别）
        check('预览列出计数器变化', /好感度/.test(pv) && /\+5/.test(pv) && /→/.test(pv), pv.slice(0, 200));
        check('★ 预览标出「已忽略」的未声明计数器「仇恨」', /仇恨/.test(pv) && /已忽略/.test(pv), pv.slice(0, 200));
        await page.screenshot({ path: path.join(SHOT, 'exp-preview.png') });
        await page.evaluate(() => document.getElementById('edit-preview')?.remove());
        await page.waitForTimeout(200);
      }
    }

    // ── ③ 点确认 → 真落盘 ──
    console.log('\n[2] 点「确认应用」');
    if (bar) {
      const okBtn = await bar.$('button[onclick*="confirmEdit"]');
      if (okBtn) {
        await okBtn.click();
        await page.waitForTimeout(600);
        const used = await confirmDialog(page);
        check('二次确认弹窗出现并被确认', used);
      } else {
        check('找到确认按钮', false);
      }
    }
    await page.waitForTimeout(800);

    const after = await getChar(srv.base);
    check('★ 计数器「好感度」真的写进角色卡', after.counters && after.counters['好感度'] === 5,
      JSON.stringify(after.counters));
    check('★★ 未声明的「仇恨」被丢掉（异名不引用）', !after.counters || !('仇恨' in after.counters),
      JSON.stringify(after.counters));
    check('多了一条经历', (after.experiences || []).length === (before.experiences || []).length + 1,
      `${(before.experiences || []).length} → ${(after.experiences || []).length}`);
    check('经历正文正确', (after.experiences || []).some((e) => e.text === EXP_TEXT));
    check('经历记下了提议者（by = 写手名）',
      (after.experiences || []).some((e) => e.by === WRITER_NAME),
      JSON.stringify((after.experiences || []).map((e) => e.by)));
    check('★ counters / experiences 不进版本档（history 长度不变）',
      (after.history || []).length === (before.history || []).length,
      `${(before.history || []).length} → ${(after.history || []).length}`);
    await page.screenshot({ path: path.join(SHOT, 'exp-applied.png') });

    // ── ④ 角色卡 UI 上显示计数器与最近经历 ──
    console.log('\n[3] 角色池页面显示');
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(900);
    const poolTxt = await page.textContent('.ch-card').catch(() => '');
    check('★ 角色卡上真的显示计数器名与值', /好感度/.test(poolTxt) && /5/.test(poolTxt), poolTxt.slice(0, 160));
    check('角色卡上显示最近经历', new RegExp(EXP_TEXT.slice(0, 8)).test(poolTxt), poolTxt.slice(0, 240));
    const hasCounterChip = await page.$('.ch-item .ch-counter');
    check('计数器以 chip 形式渲染', !!hasCounterChip);
    await page.screenshot({ path: path.join(SHOT, 'exp-pool-card.png') });

    // ── ⑤ 编辑弹窗里的「角色状态」区 ──
    await page.evaluate(() => window.characterEdit('CHRprobe0001'));
    await page.waitForTimeout(900);
    const modalTxt = await page.textContent('#chr-edit-modal').catch(() => '');
    check('编辑弹窗里有「角色状态」区', /计数器/.test(modalTxt) && /经历/.test(modalTxt), modalTxt.slice(0, 160));
    const hasDelBtn = await page.$('#chr-edit-modal .ch-x');
    check('状态区提供逐条删除入口', !!hasDelBtn);
    // 状态区在表单下方，弹窗体可滚动 —— 截图前滚到底，让证据可见
    await page.evaluate(() => {
      const mb = document.querySelector('#chr-edit-modal .modal-body');
      if (mb) mb.scrollTop = mb.scrollHeight;
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOT, 'exp-edit-modal-state.png') });

    // ── ⑥ 无 JS 错误 ──
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
