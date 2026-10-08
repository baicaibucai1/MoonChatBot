// 真机验证：写手改角色卡 —— 提议 → 待确认 → 落盘 + 版本档
//
// 为什么必须真机跑而不是只靠单测：
//   buildEditPatch / update / rollback 的单测能证明「算得对」，但证明不了：
//     ① 模型吐出的 tool_calls **真的被服务端执行**，而不是被当成正文写进气泡
//     ② SSE 的 pending 帧**真的从后端走到了前端**（隔着 readAdminSSE / 流式循环两层）
//     ③ 确认条**真的出现在屏幕上**、点「确认应用」**真的写进 config.json**
//     ④ 写入**真的产生了版本档** —— 这是「可回滚」承诺的实质，只在配置里能验
//   这四条只能靠真服务端（+ 真浏览器）才能钉死。
//
// 做法：起沙箱副本 → 把 models[].baseURL 指向本地假 LLM → 假 LLM 对带工具的第一轮
//      返回一个 propose_character_edit 的 tool_call，对第二轮（工具结果已回传）返回
//      一段像样的提议文本 → 采样 SSE 帧 + 点确认 + 读回 config.json 比对 history。
//
// 用法：node scripts/verify-character-edit.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, REPO_ROOT, setProbeCharacters, findProbeCharacter } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 假 LLM 剧本 ────────────────────────────────────────────────────────
// 第一次带 tools 的请求 → 回一个 tool_call（提议改「银」的 persona）。
// 工具执行完，服务端把 tool 结果回传 → 第二轮 → 回一段像样的「提议」正文。
// ★ 关键：第二轮不能再回 tool_call，否则 MAX_ROUNDS 耗尽、reply 为空。
const CHR_ID = 'CHRwritertest0001';
const NEW_PERSONA = '# 人格\n\n## 基本信息\n- 银，来自未来的仿真机器人男孩。\n\n## 经历\n在雾港与主人重逢后学会了用笨拙的方式表达依恋。';

// 假 LLM：第一轮回 tool_call，第二轮回「提议」正文。
// ★ 这里不能像普通假 LLM 那样一次性写完 —— chatStreamCollect 需要能看到
//   tool_calls 的 delta 累积，所以两轮的剧本必须分开写清楚。
function fakeLLMWithTools(log) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON，按空处理 */ }
      const msgs = payload.messages || [];
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      const toolNames = (payload.tools || []).map((t) => t?.function?.name).filter(Boolean);
      const wantsStream = payload.stream === true;
      log.push(`kind=${hasToolResult ? 'after-tool' : 'first'} stream=${wantsStream} tools=${toolNames.length}`);
      // 记下 system prompt：验证「写手块真的拼进 system」只能从这里看
      const sysMsg = msgs.find((m) => m.role === 'system');
      if (sysMsg && String(sysMsg.content || '').length > seenSystem.length) seenSystem = String(sysMsg.content);

      if (!wantsStream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', created: Date.now() / 1000, model: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: '（非流式兜底）' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };

      if (!hasToolResult) {
        // 第一轮：只回 tool_call（正文为空是合规的 —— 模型先要工具再动笔）
        sse({ ...base, choices: [{ index: 0, delta: {
          tool_calls: [{ index: 0, id: 'call_1', type: 'function',
            function: { name: 'propose_character_edit',
              arguments: JSON.stringify({ characterId: CHR_ID, persona: NEW_PERSONA, reason: '角色在剧情里成长了' }) } }],
        }, finish_reason: null }] });
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // 第二轮：工具已执行，写「提议」口吻的正文
      const text = '我建议把「银」的设定补一笔：雾港重逢之后，他学会用很笨的方式表达依恋。这只是提议，你确认了我再改。';
      const step = Math.max(1, Math.ceil(text.length / 4));
      const pieces = [];
      for (let i = 0; i < text.length; i += step) pieces.push(text.slice(i, i + step));
      (async () => {
        for (const p of pieces) {
          sse({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
          await new Promise((r) => setTimeout(r, 40));
        }
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
      })();
    });
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────
const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : ' —— ' + detail}`);
  if (!ok) fails.push(name);
};

const sandbox = makeSandbox();
let srv = null;
let llm = null;
const llmLog = [];
let seenSystem = '';   // 捕获到的 system prompt（供核对写手块注入）
let browser = null;
try {
  // 1) 沙箱配置：端口、断 QQ、清 Key
  const { port, botId } = await patchSandboxConfig(sandbox);

  // 2) 起假 LLM，把模型 baseURL 指过去
  const llmPort = await new Promise((resolve) => {
    const s = fakeLLMWithTools(llmLog);
    s.listen(0, '127.0.0.1', () => { llm = s; resolve(s.address().port); });
  });
  const cfgPath = path.join(sandbox, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // 造一个已知 id 的角色，塞进池子；并让第一个写手选定它
  //   ★ 必须走 setProbeCharacters（默认池），不能写顶层 cfg.characters ——
  //     后者已退役，服务器读不到，症状是「写手选了个不存在的角色 → 提议帧根本不下发」。
  setProbeCharacters(cfg, [{
    id: CHR_ID, ts: Date.now(), name: '银', persona: '# 人格\n\n## 基本信息\n- 银，来自未来的仿真机器人男孩。',
    traits: '', age: '', appearance: '', background: '', tags: ['主角'], history: [],
  }]);
  cfg.bots[0].activeCharacterIds = [CHR_ID];
  cfg.bots[0].modelId = cfg.models[0].id;
  for (const m of cfg.models) {
    m.baseURL = `http://127.0.0.1:${llmPort}/v1`;
    m.apiKey = 'fake-key';
    m.apiKeyEnv = undefined;
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  // 3) 起沙箱服务
  srv = await startServer(sandbox, port);
  console.log(`沙箱就绪：${srv.base}（bot=${botId}）\n`);

  // 4) 直连 SSE：验证 pending 帧真的下发
  const seen = { text: '', pending: [], done: null, err: null };
  const resp = await fetch(`${srv.base}/api/bots/${botId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '继续写下去，让银成长一点' }),
  });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!raw.startsWith('data: ')) continue;
      let ev = null;
      try { ev = JSON.parse(raw.slice(6)); } catch { continue; }
      if (ev.type === 'text') seen.text = ev.d;
      else if (ev.type === 'pending') seen.pending.push(ev);
      else if (ev.type === 'done') seen.done = ev;
      else if (ev.type === 'err') seen.err = ev.err;
    }
  }

  console.log(`假 LLM 请求序列：${llmLog.join(' | ')}\n`);
  check('SSE 无错误帧', !seen.err, seen.err || '');
  check('发起了两轮模型请求（工具轮 + 正文轮）', llmLog.length >= 2, `实际 ${llmLog.length} 轮`);
  check('收到 pending 帧（提议已下发到前端）', seen.pending.length === 1, `实际 ${seen.pending.length} 条`);
  const p = seen.pending[0]?.edit;
  check('pending 类型为 character_edit', p?.type === 'character_edit', JSON.stringify(p?.type));
  check('pending 带正确的 characterId', p?.payload?.characterId === CHR_ID, String(p?.payload?.characterId));
  check('pending 的 patch 只含被提议的字段', Object.keys(p?.payload?.patch || {}).join() === 'persona',
    Object.keys(p?.payload?.patch || {}).join());
  check('正文以「提议」口吻收尾（没有谎称已改）', /提议|确认/.test(seen.text), seen.text.slice(0, 80));

  // 5) ★ 关键：提议阶段 config.json 必须纹丝不动
  //    这里要读**磁盘原文件**（比走接口更严），但角色在池里 —— 顶层 cfg.characters
  //    已退役，按旧字段找会一直拿到 undefined，把「没落盘」和「找错地方」混为一谈。
  const mid = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const midChr = findProbeCharacter(mid, CHR_ID);
  check('★ 提议阶段未落盘（persona 仍是原值）', midChr?.persona.includes('来自未来的仿真机器人男孩') && !midChr.persona.includes('雾港'),
    String(midChr?.persona).slice(0, 60));
  check('★ 提议阶段无版本档（history 仍为空）', (midChr?.history || []).length === 0,
    `history=${(midChr?.history || []).length}`);

  // 6) 模拟用户点「确认应用」：前端 confirmEdit 走的就是这条
  const putRes = await fetch(`${srv.base}/api/characters/${encodeURIComponent(CHR_ID)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p.payload.patch),
  });
  const putJson = await putRes.json();
  check('确认写入返回 ok', putJson.ok === true, JSON.stringify(putJson).slice(0, 120));
  check('写入回执标出 changed=[persona]', (putJson.changed || []).join() === 'persona', (putJson.changed || []).join());

  // 7) 落盘核对：persona 已更新 + 产生了版本档（可回滚的实质）
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const aChr = findProbeCharacter(after, CHR_ID);
  check('★ 确认后 persona 已更新落盘', String(aChr?.persona).includes('雾港'), String(aChr?.persona).slice(0, 60));
  check('★ 确认后产生版本档（history 长度 1）', (aChr?.history || []).length === 1, `history=${(aChr?.history || []).length}`);
  check('★ 版本档记的是「改之前」的内容（回滚有意义）',
    String(aChr?.history?.[0]?.persona || '').includes('来自未来的仿真机器人男孩')
      && !String(aChr?.history?.[0]?.persona || '').includes('雾港'),
    String(aChr?.history?.[0]?.persona || '').slice(0, 60));

  // 8) 接口侧：history 能读、回滚能回到原值
  const histRes = await fetch(`${srv.base}/api/characters/${encodeURIComponent(CHR_ID)}/history`);
  const histJson = await histRes.json();
  check('history 接口返回 1 条', (histJson.history || []).length === 1, `实际 ${(histJson.history || []).length}`);
  const rbRes = await fetch(`${srv.base}/api/characters/${encodeURIComponent(CHR_ID)}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: 0 }),
  });
  const rbJson = await rbRes.json();
  check('回滚返回 ok', rbJson.ok === true, JSON.stringify(rbJson).slice(0, 120));

  const rolled = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const rChr = findProbeCharacter(rolled, CHR_ID);
  check('★ 回滚后 persona 回到原值', String(rChr?.persona).includes('来自未来的仿真机器人男孩')
    && !String(rChr?.persona).includes('雾港'), String(rChr?.persona).slice(0, 60));
  check('★ 回滚本身也留档（支持「回滚的回滚」）', (rChr?.history || []).length === 2,
    `history=${(rChr?.history || []).length}`);

  // 9) 浏览器侧：确认条真的能渲染出来（不是只有 JSON 通道通）
  const { chromium } = await import('playwright');
  const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');
  const launchOpts = fs.existsSync(CHROME) ? { executablePath: CHROME } : {};
  browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrs = [];
  page.on('pageerror', (e) => pageErrs.push(e.message));
  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  check('页面加载无 JS 错误', pageErrs.length === 0, pageErrs.slice(0, 2).join(' / '));

  // 直接调用渲染函数，确认 character_edit 分支产出可读文案（不必真跑一轮对话）
  // ⚠️ 这里在**页面上下文**里执行，renderEditBar 是页面上的顶层函数；
  //   用 window[...] 取（顶层 function 声明会挂到 window），eslint 才不会报 no-undef。
  const barHtml = await page.evaluate((edit) => {
    const fn = window['renderEditBar'];
    if (typeof fn !== 'function') return '__no_renderEditBar__';
    const box = document.createElement('div');
    box.innerHTML = fn(edit);
    return box.innerHTML;
  }, { type: 'character_edit', payload: { characterId: CHR_ID, name: '银', patch: { persona: NEW_PERSONA }, reason: '角色成长' } });
  check('确认条渲染成功', !String(barHtml).includes('__no_renderEditBar__'), String(barHtml).slice(0, 80));
  check('确认条文案含角色名与字段', /银/.test(String(barHtml)) && /persona/.test(String(barHtml)), '');
  check('确认条含「确认应用」按钮', /confirmEdit/.test(String(barHtml)), '');

  // ★ 布局：文案变长后按钮不能排成参差的阶梯（实测踩过）
  const barBox = await page.evaluate((html) => {
    const d = document.createElement('div');
    d.id = 'verify-edit-bar';
    d.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:99999;width:520px';
    d.innerHTML = html;
    document.body.appendChild(d);
    const btns = [...d.querySelectorAll('.admin-action button')].map((b) => b.getBoundingClientRect());
    return { tops: btns.map((r) => Math.round(r.top)), count: btns.length };
  }, String(barHtml));
  check('确认条有 3 个按钮', barBox.count === 3, `实际 ${barBox.count}`);
  check('★ 按钮竖直对齐（不参差）', new Set(barBox.tops).size === 1, `tops=${barBox.tops.join(',')}`);

  // ---- 写手 prompt 注入（task #56：输出模式三档 + 角色池 + 改写约定）----
  // 从假 LLM 收到的请求里把 system prompt 捞出来逐段核对（见 fakeLLMWithTools 的 seenSystem）。
  // ★ 这是唯一能证明「写手块真的拼进了 system」的手段 —— 单测碰不到 chatWithBot 内部。
  const sysText = seenSystem;
  check('system 含【你的身份：写手】', sysText.includes('【你的身份：写手】'), `len=${sysText.length}`);
  check('system 含输出方式三档（叙述/对白/自主判断）',
    sysText.includes('叙述：') && sysText.includes('对白：') && sysText.includes('自己判断，直接写'),
    '');
  // ★ 池 ↔ 写手 1:1 之后池标题只报**自己池**的人数（不再有「池中 N 位」的全局总数）
  check('system 含角色池段并带角色 id', /【你的角色池（\d+ 位）】/.test(sysText) && sysText.includes(CHR_ID), '');
  check('system 含改写 + 新建的写权限说明',
    sysText.includes('propose_character_edit') && sysText.includes('propose_character_create')
    && sysText.includes('直接进你的角色池') && sysText.includes('只能改你自己角色池里的角色'), '');

  const shots = path.join(HERE, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, 'character-edit-bar.png'), fullPage: false });
  console.log(`\n截图：${path.join(shots, 'character-edit-bar.png')}`);
} catch (err) {
  check('脚本自身未抛异常', false, err.stack || err.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (srv) stopServer(srv.child);
  if (llm) llm.close();
  removeSandbox(sandbox);
}

console.log(`\n${fails.length ? `❌ ${fails.length} 项未通过：${fails.join('、')}` : '✅ 全部通过'}`);
process.exit(fails.length ? 1 : 0);
