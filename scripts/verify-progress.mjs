// 真机验证：长文进度条 + 输出设置弹层（C19-g）
//
// 为什么必须真机跑而不是只靠单测：
//   progressOf 的纯逻辑单测能证明「算得对」，但证明不了：
//     ① SSE 的 progress 帧**真的从后端走到了前端**（中间隔着 readAdminSSE 的解析）
//     ② 进度条**真的出现在屏幕上**（CSS max-height 过渡写错就永远看不见）
//     ③ 输出弹层的四个控件**真的能读写配置**（PUT 是全量覆盖，少带字段会抹掉别的设置）
//   这三条只能靠真浏览器 + 真服务端才能钉死。
//
// 做法：起沙箱副本 → 把 models[].baseURL 指向本地假 LLM → 假 LLM 按「第一次短、
// 后续接续写指令」的剧本吐出够长的多段内容 → 触发长文 → 采样进度条 → 截图。
//
// 用法：node scripts/verify-progress.mjs

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, pickFreePort, sleep, REPO_ROOT } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

// 每段都要够长：段太短永远够不到目标 → 撞段数上限，看起来像实现失控
const SEG = '江面上起了雾，渡口的老船工把缆绳一圈圈绕上木桩，动作慢得像在数自己的年岁。';
const FILLER = '岸边的芦苇被风吹得倒向一边，远处的钟声隔着水汽传过来，闷闷的，像是从很深的地方浮上来，一下，又一下，落在水面上荡开细碎的纹路。';
// 每段 FILLER 重复的次数：要能累积过目标（大纲 4 段 × 800 字），否则「大纲走完」时字数远不够
const REPEAT = 14;

function fakeLLM() {
  let seq = 0;   // 段序号：段首唯一标记，防重复守卫误杀
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* 非 JSON 请求，按空处理 */ }
      const msgs = payload.messages || [];
      const last = msgs[msgs.length - 1] || {};
      const lastC = String(last.content || '');

      // 判据：最后一条 user 消息里有没有「接着写」的指令 —— 有就是续写段，没有就是首段。
      // ⚠️ 不能用「消息条数」判断：后台蒸馏/摘要也会打过来，计数全废。
      // ★ 判据必须**先排除首段**：segPromptFirst 里有一句「结构已经定好」，
      //   光看「规划/结构」会把首段请求也认成规划 → 返回大纲文本 → 大纲被当正文写进气泡。
      //   真正的规划请求以「先不要写正文，只做规划」开头，用这个特征串精确认。
      const isPlanReq = lastC.startsWith('（先不要写正文，只做规划。）');
      const isContinue = /接着|继续|续写|还没写够|还差|请直接开始写正文/.test(lastC);
      console.log(`[fake-llm] kind=${isPlanReq ? 'plan' : isContinue ? 'continue' : 'first'} ` +
        `lastC=${JSON.stringify(lastC.slice(0, 60))}`);

      let text;
      if (isPlanReq) {
        // ⚠️ 必须按 planPrompt 要求的格式（`序号｜要点：…｜字数：N`）——
        //   随手写「1. xxx｜400」会解析出 0 段，于是降级成「无大纲按目标续写」，
        //   进度条就退化成流动条（看不到「第 N/M 段」），看着像前端坏了。
        text = [
          '1｜要点：起雾的渡口，船工上场｜字数：800',
          '2｜要点：船工的往事，交代来由｜字数：800',
          '3｜要点：钟声响起，离别在即｜字数：700',
          '4｜要点：雾散，各自上路｜字数：700',
        ].join('\n');
      } else if (isContinue) {
        // ★ 段首放唯一标记：FILLER.repeat() 是**周期的**，任何旋转都是它的子串，
        //   不给唯一标记的话重复守卫会把所有续写段判成「原地打转」直接停。
        text = `（第 ${++seq} 段）` + SEG + FILLER.repeat(REPEAT);
      } else {
        text = SEG + FILLER.repeat(REPEAT);
      }

      // ★ 本服务端有两种调用：规划走 models.chat（**非流式**），正文/续写走 chatStreamCollect（流式）。
      //   假端点必须两种都给，否则规划那一支永远拿到空 content → 静默降级成「无大纲」，
      //   现象是进度条只剩流动条、看不到「第 N/M 段」—— 看着像前端 bug，其实是剧本不完整。
      const wantsStream = payload.stream === true;
      if (!wantsStream) {
        // 规划请求也拖一下：不拖的话「正在规划结构…」只存在几十毫秒，采样根本抓不到。
        // （回调本身不是 async，用 setTimeout 延迟而不是 await）
        return setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'x', object: 'chat.completion', created: Date.now() / 1000, model: 'fake',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
          }));
        }, 400);
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const base = { id: 'x', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fake' };
      // 分片下发：让前端能真的看到逐字增长（一次吐完的话进度条就没机会采样）
      // ⚠️ 每片之间要真等一下 —— 本地假 LLM 不睡眠的话 12 段能在一瞬间跑完，
      //   进度条只存在几十毫秒，采样窗口再密也可能整个错过（这不是前端 bug）。
      const step = Math.max(1, Math.ceil(text.length / 6));
      const pieces = [];
      for (let i = 0; i < text.length; i += step) pieces.push(text.slice(i, i + step));
      (async () => {
        for (const p of pieces) {
          sse({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
          await sleep(60);
        }
        sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 } });
        res.write('data: [DONE]\n\n');
        res.end();
      })();
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
    const { port, botId } = await patchSandboxConfig(dir);

    // 假 LLM：起在另一个空闲端口，把沙箱的所有模型都指过去
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
    // 长文开、目标 1500（够触发多段，又不至于跑太久）、听懂意图开
    cfg.bots[0].longReply = true;
    cfg.bots[0].longReplyTarget = 1500;
    cfg.bots[0].longReplyAuto = true;
    cfg.bots[0].enabled = false;
    cfg.bots[0].appId = '__probe__';
    cfg.bots[0].appSecret = '__probe__';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    // 同步前端产物（沙箱是拷贝，改过的 app.js / style.css 要盖过去）
    for (const f of ['app.js', 'style.css', 'design.css', 'index.html']) {
      const src = path.join(REPO_ROOT, 'public', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'public', f));
    }

    srv = await startServer(dir, port);
    console.log(`沙箱已启动 ${srv.base}（假 LLM :${llmPort}）\n`);

    browser = await chromium.launch({ executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));

    await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#bot-list .side-item', { timeout: 15000 });
    await page.click(`#bot-list .side-item[onclick*="selectBot('${botId}')"]`);
    await page.waitForSelector('#f-chat', { timeout: 10000 });

    // ---- 验证 1：输出设置按钮存在且在发送按钮左边 ----
    const btnInfo = await page.evaluate(() => {
      const wrap = document.querySelector('.chat-input');
      if (!wrap) return null;
      const btns = [...wrap.querySelectorAll('button')];
      return btns.map((b) => ({ text: b.textContent.trim(), cls: b.className, title: b.title }));
    });
    check('输入条有「输出」按钮', !!btnInfo && btnInfo.some((b) => /输出/.test(b.text)),
      JSON.stringify(btnInfo));
    check('「输出」按钮在「发送」之前（视觉上在左侧）',
      !!btnInfo && btnInfo.findIndex((b) => /输出/.test(b.text)) < btnInfo.findIndex((b) => /发送/.test(b.text)));

    // ---- 验证 2：点开输出弹层，四个控件齐全 ----
    await page.click('.chat-input button[onclick*="openOutputSheet"]');
    await page.waitForSelector('#output-sheet', { timeout: 5000 });
    await page.waitForTimeout(250);
    const sheetCtrls = await page.evaluate(() =>
      ['os-long', 'os-target', 'os-auto', 'os-perm'].map((id) => {
        const el = document.getElementById(id);
        return { id, found: !!el, tag: el ? el.tagName : null };
      }));
    check('输出弹层四个控件齐全', sheetCtrls.every((c) => c.found), JSON.stringify(sheetCtrls));
    // 弹层必须显示当前值（否则「跟随全局（当前：X）」是假的）
    const curVals = await page.evaluate(() => ({
      long: document.getElementById('os-long').value,
      target: document.getElementById('os-target').value,
      auto: document.getElementById('os-auto').value,
      perm: document.getElementById('os-perm').value,
    }));
    check('弹层读到了角色的当前值（长文=true / 目标=1500）',
      curVals.long === 'true' && curVals.target === '1500', JSON.stringify(curVals));

    await page.screenshot({ path: path.join(SHOT, 'os-sheet.png') });

    // ---- 验证 3：改「长度自主权」→ 保存 → 落库 ----
    await page.selectOption('#os-perm', 'full');
    await page.click('#output-sheet .primary');
    await page.waitForTimeout(1200);
    const saved = await (await fetch(`${srv.base}/api/state`)).json();
    const savedBot = (saved.bots || []).find((b) => b.id === botId);
    check('保存后 lengthPerm 落到该角色', savedBot && savedBot.lengthPerm === 'full',
      JSON.stringify({ lengthPerm: savedBot && savedBot.lengthPerm }));
    // ★ 关键回归：PUT 是全量覆盖，漏带字段会把同角色别的设置抹掉
    check('保存输出设置没抹掉其他字段（longReply 仍是 true）', savedBot && savedBot.longReply === true,
      JSON.stringify({ longReply: savedBot && savedBot.longReply }));

    // ---- 验证 4：先直连 SSE 确认 progress 帧确实下发了（把「后端问题」和「前端问题」分开）----
    {
      const r = await fetch(`${srv.base}/api/bots/${botId}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ content: '把故事写长一点' }),
      });
      const txt = await r.text();
      const evs = txt.split('\n\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l.replace(/^data:\s*/, '')); } catch { return null; } })
        .filter(Boolean);
      const prog = evs.filter((e) => e.type === 'progress');
      check('SSE 直连能看到 progress 帧（后端确实下发了）', prog.length > 0,
        `事件类型统计：${JSON.stringify(evs.reduce((a, e) => (a[e.type] = (a[e.type] || 0) + 1, a), {}))}`);
      check('progress 末帧是 done/100', prog.length > 0 && prog[prog.length - 1].p.phase === 'done',
        JSON.stringify(prog[prog.length - 1]));
    }

    // ---- 验证 5：发一句「写长一点」→ 采样进度条 ----
    await page.fill('#f-chat', '把我之前说的那个故事写长一点');
    await page.click('.chat-input .primary');

    // 采样：每 120ms 记一次进度条状态（是否可见 / 文案 / 宽度 / 是否流动条）
    const samples = [];
    const t0 = Date.now();
    let shotBar = false;
    while (Date.now() - t0 < 40000) {
      const s = await page.evaluate(() => {
        const box = document.getElementById('chat-progress');
        if (!box) return { err: 'no-progress-el' };
        const bar = box.querySelector('.cp-bar');
        const fill = box.querySelector('.cp-fill');
        return {
          on: box.classList.contains('on'),
          indet: bar ? bar.classList.contains('indeterminate') : null,
          w: fill ? fill.style.width : '',
          text: (box.querySelector('.cp-text') || {}).textContent || '',
        };
      });
      samples.push(s);
      // 出现确定进度就截一张（只截一次，避免覆盖成收尾态）
      if (!shotBar && !s.indet && /第 \d+\/\d+ 段/.test(s.text)) {
        shotBar = true;
        await page.screenshot({ path: path.join(SHOT, 'progress-bar.png') });
      }
      // ★ 结束判据要「曾经出现过」才收：只看最后 4 次会在一开始就误判（请求还没发出去就 4 连 off）。
      if (samples.length > 12 && samples.slice(-6).every((x) => !x.on)) break;
      await sleep(60);   // 采样要密：规划阶段可能只持续一两百毫秒，间隔大了整个错过
    }

    const shown = samples.filter((s) => s.on);
    if (!shown.length) {
      console.log('\n—— 服务端日志（排查进度条没出现）——');
      console.log(srv.getLog().slice(-2500));
      console.log('—— 日志结束 ——\n');
    }
    check('进度条真的出现过（on 态）', shown.length > 0, `采样 ${samples.length} 次，on 态 ${shown.length} 次`);
    const texts = [...new Set(shown.map((s) => s.text))];
    // 有大纲时必须显示段数进度（这是信息量最大的形态，也是 pct 唯一可信的来源）
    const withSeg = shown.filter((s) => /第 \d+\/\d+ 段/.test(s.text));
    check('出现「正在写第 N/M 段」的确定进度', withSeg.length > 0,
      '实际文案：' + JSON.stringify(texts));
    check('规划阶段有「正在规划结构…」提示', texts.some((t) => /规划结构/.test(t)),
      '实际文案：' + JSON.stringify(texts));
    const widths = [...new Set(shown.map((s) => Number(String(s.w).replace('%', ''))).filter((n) => !Number.isNaN(n)))];
    // ⚠️ 不要求采到 100%：收尾帧一到前端立刻收起条子，100% 只存在一瞬，
    //   采样窗口再密也可能整段错过（这是采样问题，不是实现问题）。
    //   「100% 一定发得出去」由后端单测（progressOf done→100）和 SSE 直连断言保证。
    check('进度条宽度分多档递增（不是只有 0% 一档）', widths.length >= 2, '出现过的宽度：' + JSON.stringify(widths));
    check('宽度序列不回头（进度不回退）',
      (() => {
        const ws = shown.map((s) => Number(String(s.w).replace('%', ''))).filter((n) => !Number.isNaN(n));
        return ws.every((w, i) => i === 0 || w >= ws[i - 1]);
      })(), JSON.stringify(shown.map((s) => s.w)));
    check('写完进度条自动收起（最终 off）', samples[samples.length - 1].on === false,
      JSON.stringify(samples.slice(-3)));

    check('页面无 JS 错误', pageErrors.length === 0, pageErrors.join(' | '));

    // 最终气泡确实写长了（否则进度条再好看也没意义）
    const bubble = await page.evaluate(() => {
      const els = [...document.querySelectorAll('#session-list .session.bot .bubble')];
      return els.length ? els[els.length - 1].textContent : '';
    });
    check('最终气泡确实是一篇长文（> 1500 字）', bubble.length > 1500, `实际 ${bubble.length} 字`);
    // ★ 大纲是「内部指令」，绝不能出现在给用户看的正文里 —— 出现就说明规划请求被当正文用
    check('气泡正文里不含大纲行（大纲不该泄露给用户）',
      !/要点：.*字数：/.test(bubble), '正文片段：' + JSON.stringify(bubble.slice(0, 120)));

    await page.screenshot({ path: path.join(SHOT, 'final.png') });
    await page.waitForTimeout(200);
  } finally {
    if (browser) await browser.close();
    if (srv) stopServer(srv.child);
    if (llm) llm.close();
    await sleep(400);
    removeSandbox(dir);
  }

  console.log(fails.length ? `\n❌ ${fails.length} 项未通过：${fails.join('、')}` : '\n✅ 全部通过');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('验证脚本异常：', e); process.exit(1); });
