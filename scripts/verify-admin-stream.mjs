// 真机验证：流式可靠性 —— 不误杀 + 不重复执行工具 + 心跳（修「调用模型就返回成功然后断掉」）
//
// ★ 覆盖**两条**流式链路：
//     · 管理员 /api/admin/chat/stream（多轮工具循环，最容易踩误杀）
//     · 写手   /api/bots/:id/chat/stream（长文写作，静默期靠心跳保活）
//   两条共用 lib/constants.js 里的同一个心跳常量与同一套「无进展」看门狗语义。
//
// 复现的 bug（2026-10-05）：
//   前端看门狗是 `setTimeout(abort, 5000)` —— 从请求发出起算，5 秒后**无条件** abort，
//   而注释写的是「5s 内无进展即放弃」（代码里根本没有重置逻辑）。
//   管理员 Agent 是**多轮工具循环**（读记忆库 → 读会话 → 再产出），
//   模型首字十几秒、几十秒都属正常，且工具轮期间后端一个字节都不发
//   → 每一次正常的长思考都被误杀。误杀之后还会：
//     ① 删掉已经流出来的气泡（用户看到文字突然消失 = 他说的「断掉」）
//     ② 回落一次性 POST /api/admin/chat **重发同一请求**
//        → 服务端 Agent 已经在跑、工具副作用已经产生 → 同一批工具跑第二遍
//     ③ 零事件时马上 adminForceNormal()，把流式**永久关掉**（之后全是一分钟起步的普通模式）
//
// 修复：
//   后端：SSE 头之后立刻发 `open`，之后每 15s 发一帧 `ping`（lib/routes/admin.js）
//   前端：看门狗改成「无进展」语义（收到任何一帧就重置）；收到过帧的连接被掐断时
//         **保留正文、绝不重发**；连续两次零事件才判定「本环境不支持流式」
//
// 验证点：
//   ① 心跳链路：管理员 `open`+`ping`、写手 `start`+`ping`，都在 15s 内到
//   ② ★★ 模型首字 8s（> 旧的 5s 阈值）→ 仍能拿到完整回复
//   ③ ★★ 该场景下**普通模式一次都没被调用**（旧代码会重发 → 这段就是防重复副作用的断言）
//   ④ ★ 连续两次零事件才降级（单次抖动不永久关流式）
//   ⑤ 全程无 JS 错误
//
// 用法：node scripts/verify-admin-stream.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, pickFreePort, REPO_ROOT } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

// 假 LLM 的节奏：首字延迟必须**大于旧的 5s 阈值**，否则复现不出 bug
const FIRST_DELAY_MS = 8000;
const PINGTEST_DELAY_MS = 20000;   // 心跳测试用：故意拖长，好让 15s 的 ping 有机会出现
const REPLY = '我已经看过了角色池，建议把「银」的经历补一条。';

// 计数：用来证明「有没有被重发」
const counters = { streamAdmin: 0, normalAdmin: 0, openSeen: 0 };

function fakeLLM() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON */ }
      const msgs = payload.messages || [];
      const isAdmin = msgs.some((m) => String(m.content || '').includes('面板管理员'));
      if (!isAdmin) {
        // 非管理员请求（角色对话 / 蒸馏等）。
        // ★ 「写手链路心跳」那一测要一条长时间不产正文的连接，所以带 PINGTEST 的写手续写要拖长。
        const isWriter = msgs.some((m) => String(m.content || '').includes('【你的身份：写手】'));
        const lastU = [...msgs].reverse().find((m) => m.role === 'user');
        if (isWriter && String(lastU?.content || '').includes('PINGTEST') && payload.stream === true) {
          console.log('[fake-llm] writer-stream PINGTEST：故意拖 20s 不产正文');
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          await new Promise((r) => setTimeout(r, PINGTEST_DELAY_MS));
          try { res.write('data: ' + JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: '（慢回复）' }, finish_reason: null }] }) + '\n\n'); res.end(); } catch {}
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', model: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"sections":[]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }));
        return;
      }

      const hasToolResult = msgs.some((m) => m.role === 'tool');
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      const ask = String(lastUser?.content || '');

      // ---- 流式路径 ----
      if (payload.stream === true) {
        counters.streamAdmin++;
        console.log(`[fake-llm] streamAdmin#${counters.streamAdmin} hasToolResult=${hasToolResult} ask=${JSON.stringify(ask.slice(0, 24))}`);
        // ★ 首字延迟：大于旧的 5s 误杀线。工具轮（第 2 轮）不延迟，避免整体太慢。
        if (!hasToolResult) {
          const wait = ask.includes('PINGTEST') ? PINGTEST_DELAY_MS : FIRST_DELAY_MS;
          await new Promise((r) => setTimeout(r, wait));
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };
        const sse = (o) => { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch {} };

        if (hasToolResult) {
          // 第 2 轮：纯文本收尾
          sse({ ...base, choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }] });
          sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
          try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
          return;
        }
        // 第 1 轮：调一个**只读**工具（不会真的产生副作用，纯粹把工具轮拉起来）
        sse({
          ...base,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_robots', arguments: '' } }] },
            finish_reason: null,
          }],
        });
        sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
        return;
      }

      // ---- 非流式路径 ----
      // ★ 这里就是「有没有重发」的计量器：正常路径下**一次都不该出现**
      //   （ensure-edits 只在「有文字但没调工具」时触发，我们第 1 轮给了工具 → 不会触发）
      counters.normalAdmin++;
      console.log(`[fake-llm] ★ normalAdmin#${counters.normalAdmin}（出现即说明发生了重发）`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
    });
  });
}

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
    // 关掉自检，别让它的额外调用混进计数
    cfg.selfCheck = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    for (const f of ['app.js', 'style.css', 'design.css', 'index.html']) {
      const src = path.join(REPO_ROOT, 'public', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'public', f));
    }

    srv = await startServer(dir, port);
    const base = srv.base;
    console.log(`沙箱已启动 ${base}（假 LLM :${llmPort}）\n`);

    // ── ① 心跳链路（直连接口，**两条流式链路都要验**）──
    // 为什么两条都要：管理员链路靠心跳续看门狗；写手链路是「长文写作几分钟不产正文」，
    // 没有心跳就会被中间代理按空闲超时掐断。两条共用 lib/constants.js 的同一个常量。
    //
    // ★ 通用collector：发起一次 SSE 请求，收 `ms` 毫秒的事件后主动断开。
    async function collectStream(path, bodyObj, ms) {
      const ac = new AbortController();
      const resp = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
        signal: ac.signal,
      });
      const seen = [];
      const done = (async () => {
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).replace(/\r$/, '');
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const d = line.slice(5).trim();
              if (!d || d === '[DONE]') continue;
              try { seen.push(JSON.parse(d)); } catch {}
            }
          }
        } catch { /* 我们主动 abort */ }
      })();
      // 18s：够 15s 那一拍 ping 出现，又不用等 PINGTEST 的 20s 长延迟
      await new Promise((r) => setTimeout(r, ms));
      ac.abort();
      await done;
      return seen.map((e) => e.type);
    }

    console.log('[1] SSE 心跳（管理员链路）：open 立刻到、ping 在 15s 内到');
    let kinds = await collectStream('/api/admin/chat/stream', { content: 'PINGTEST 心跳测试' }, 18000);
    console.log('    收到事件类型：', JSON.stringify(kinds));
    check('★ 第一帧是 open（连接已建立）', kinds[0] === 'open', JSON.stringify(kinds.slice(0, 3)));
    check('★★ 15s 内收到过 ping（心跳活着 → 前端看门狗有东西可续）',
      kinds.includes('ping'), JSON.stringify(kinds));

    console.log('\n[1b] SSE 心跳（写手链路）：start 之后也要周期性 ping');
    kinds = await collectStream('/api/bots/BOT1/chat/stream', { content: 'PINGTEST 长文' }, 18000);
    console.log('    收到事件类型：', JSON.stringify(kinds));
    check('写手链路第一帧是 start', kinds[0] === 'start', JSON.stringify(kinds.slice(0, 3)));
    check('★★ 写手链路 15s 内也收到 ping（长文静默期不会被中间层掐断）',
      kinds.includes('ping'), JSON.stringify(kinds));

    // ── ② 长首字不误杀 ──
    browser = await chromium.launch({ executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    // 清掉可能残留的「流式被禁」标记，保证从「可用流式」的干净状态开始
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.evaluate(() => window.loadState && window.loadState(false));
    await page.waitForTimeout(900);

    console.log('\n[2] UI 上发消息（模型首字 8s > 旧的 5s 阈值）');
    // ★★ 判据必须是**前端发出的 HTTP 端点**，不能是「LLM 请求带没带 stream:true」——
    //    因为普通模式 POST /api/admin/chat 内部**同样**用流式调 LLM（要解析 tool_calls），
    //    两者在假 LLM 眼里长得一模一样。按端点计数才分得清「走了哪条路」。
    const reqs = { stream: 0, normal: 0 };
    page.on('request', (r) => {
      const u = r.url();
      if (!u.includes('/api/admin/chat')) return;
      if (u.includes('/api/admin/chat/stream')) reqs.stream++;
      else reqs.normal++;
    });
    await page.evaluate(() => window.openAdminPanel && window.openAdminPanel());
    await page.waitForTimeout(1200);
    const hasPanel = await page.$('#admin-modal');
    check('管理员面板已打开', !!hasPanel);
    await page.evaluate(() => window.adminSend && window.adminSend('看看角色池，给点建议'));

    // 等回复落定（首字 8s + 工具轮 + 收尾），最多 30s
    let replied = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const t = await page.textContent('#admin-msgs').catch(() => '');
      if (t && t.includes(REPLY.slice(0, 12))) { replied = true; break; }
    }
    check(`★★ 首字 8s 的场景下仍拿到完整回复（旧代码 5s 就掐断了）`, replied);
    const msgsTxt = (await page.textContent('#admin-msgs').catch(() => '')) || '';
    check('回复正文完整出现在对话里（气泡没被删掉）', msgsTxt.includes(REPLY), msgsTxt.slice(-200));
    await page.screenshot({ path: path.join(SHOT, 'admin-stream-ok.png') });

    console.log(`    前端发出的请求：/chat/stream ${reqs.stream} 次，/chat（回落）${reqs.normal} 次`);
    check('★ 走的是流式端点', reqs.stream === 1, String(reqs.stream));
    check('★★★ 没有回落普通模式重发（回落端点请求数必须为 0 —— 这是防重复副作用的断言）',
      reqs.normal === 0, `${reqs.normal} 次`);

    // ── ③ 连续两次零事件才降级 ──
    console.log('\n[3] 零事件：单次抖动不该永久关掉流式');
    await page.close();
    const page2 = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    page2.on('pageerror', (e) => pageErrors.push(String(e.message)));
    await page2.goto(base, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(1600);
    await page2.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page2.evaluate(() => window.loadState && window.loadState(false));
    await page2.waitForTimeout(900);

    // ★ 制造「零事件」的手法：在页面里把 fetch 换掉，让流式请求**立刻 reject**。
    //
    //   为什么不用 `page.route(...).abort()`：实测它会漏（请求仍然打到了服务端，
    //   LLM 那边能看到 streamAdmin 计数上涨）—— 那样「零事件」的成因就说不清了，
    //   断言即便通过也是**假通过**。换成页内覆写 fetch 之后：
    //     · 流式请求 100% 到不了服务端（可断言 LLM 侧零流式调用）
    //     · 普通模式 `/api/admin/chat` 照常走 → 正好用来断言「降级链路真的走通了」
    await page2.evaluate(() => {
      const orig = window.fetch;
      window.__streamTried = 0;
      window.fetch = (url, opts) => {
        if (String(url).includes('/api/admin/chat/stream')) {
          window.__streamTried++;
          return Promise.reject(new TypeError('模拟 SSE 连接失败'));
        }
        return orig(url, opts);
      };
    });

    const reqs2 = { stream: 0, normal: 0 };
    page2.on('request', (r) => {
      const u = r.url();
      if (!u.includes('/api/admin/chat')) return;
      if (u.includes('/api/admin/chat/stream')) reqs2.stream++;
      else reqs2.normal++;
    });
    const blockedAfter = async () => page2.evaluate(() => {
      try { return localStorage.getItem('qqbot-stream-blocked'); } catch { return 'n/a'; }
    });

    await page2.evaluate(() => window.openAdminPanel && window.openAdminPanel());
    await page2.waitForTimeout(1000);

    // ① adminSend 是 async 且 page.evaluate 会 await 它返回的 promise
    //    → evaluate 返回时这一轮已经彻底跑完（含回落的普通模式），不用再猜等待时长
    await page2.evaluate(() => window.adminSend && window.adminSend('第一次'));
    await page2.waitForTimeout(1500);
    const tried1 = await page2.evaluate(() => window.__streamTried);
    const afterFirst = await blockedAfter();
    check('★ 流式请求确实被拦下（零事件的前提成立：前端试了流式但没发出网络请求）',
      tried1 === 1 && reqs2.stream === 0, `tried=${tried1} 实际发出 stream 请求=${reqs2.stream}`);
    check('零事件后回落了普通模式（降级链路真的走通，而不是什么都没发生）',
      reqs2.normal === 1, `回落端点请求数=${reqs2.normal}`);
    check('★ 第一次零事件**不**降级（单次抖动不该永久关流式）', afterFirst !== '1', String(afterFirst));

    await page2.evaluate(() => window.adminSend && window.adminSend('第二次'));
    await page2.waitForTimeout(2000);
    const afterSecond = await blockedAfter();
    check('第二次也回落了普通模式', reqs2.normal === 2, `回落端点请求数=${reqs2.normal}`);
    check('★ 连续第二次零事件才降级为普通模式', afterSecond === '1', String(afterSecond));
    await page2.screenshot({ path: path.join(SHOT, 'admin-stream-degrade.png') });

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
  // ★ 别用 process.exit()：stdout 重定向时会丢未 flush 的日志（空输出 + exit 0）
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
