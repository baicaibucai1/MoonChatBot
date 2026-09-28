// 「角色对话」流式输出的端到端测试。
//
// 为什么值得占一个浏览器测试：这条链路（模型 SSE → chatStreamCollect → chatWithBot.onDelta
// → POST /api/bots/:id/chat/stream → 气泡逐字渲染）此前**整条是断的** ——
// chatWithBot 早就支持 opts.onDelta，QQ 侧与管理员面板都接了，唯独面板里跟角色说话
// 走的是一次性 POST /chat。单元测试抓不到这种「能力存在但没接上」的缺口，
// 只有真的把字吐出来、并观察气泡有没有逐字长，才能守住。
//
// 零外部依赖、零费用：这里起一个本地的 OpenAI 兼容假模型，按固定节奏吐分片。
// 真调外部模型既慢又不稳，还无法控制吐字节奏 —— 而「逐字增长」恰恰需要一个
// 可控节奏才能被断言，而不是靠「看起来挺快」。
//
// 沙箱说明见 scripts/lib/sandbox.mjs（所有写操作只落在临时副本内）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  REPO_ROOT, sleep, makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, pickFreePort,
} from '../scripts/lib/sandbox.mjs';

// 浏览器内核装在项目内，与 lib/search.js 保持同一份配置
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ||
  path.join(REPO_ROOT, 'playwright-browsers');
// 动态 import：确保上面的环境变量在此之前已生效
const { chromium } = await import('playwright');

// 假模型的台词：23 片 × 80ms ≈ 1.8s，足够采样出十几个不同的中间长度
const CHUNKS = [
  '这是', '一次', '流式', '输出', '的', '端到端', '验证', '：',
  '模型', '每吐', '出一', '个分', '片，', '气泡', '就应', '当立', '刻长', '一截',
  '，而', '不是', '等全', '文到', '齐。',
];
const FULL = CHUNKS.join('');
const CHUNK_MS = 80;

let mockServer = null;
let sandboxDir = null;
let srv = null;
let browser = null;
let page = null;
let botId = '';
let mockBase = '';
const pageErrors = [];

/** 起一个 OpenAI 兼容端点：流式按固定节奏吐分片，非流式一次性给全文。 */
async function startMockLLM() {
  const port = await pickFreePort();
  const srvr = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      let j = {};
      try { j = JSON.parse(body); } catch { /* 忽略非 JSON */ }
      const id = 'chatcmpl-mock';
      if (!j.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id, object: 'chat.completion', model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: FULL }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      // 每片单独写、不合并 —— 这样「逐字到达」才是真的（合并写入会让断言失去意义）
      const raw = (s) => { try { res.write(s); } catch { /* 客户端可能已断开 */ } };
      const frame = (o) => raw('data: ' + JSON.stringify(o) + '\n\n');
      frame({ id, object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      for (const c of CHUNKS) {
        await sleep(CHUNK_MS);
        frame({ id, object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: c }, finish_reason: null }] });
      }
      frame({ id, object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      if (j.stream_options && j.stream_options.include_usage) {
        frame({ id, object: 'chat.completion.chunk', model: 'mock', choices: [], usage: { prompt_tokens: 1, completion_tokens: CHUNKS.length, total_tokens: CHUNKS.length + 1 } });
      }
      raw('data: [DONE]\n\n');   // 必须原样，不能 JSON 化
      try { res.end(); } catch { /* 忽略 */ }
    });
  });
  await new Promise((r) => srvr.listen(port, '127.0.0.1', r));
  return { srvr, base: `http://127.0.0.1:${port}/v1` };
}

before(async () => {
  const mock = await startMockLLM();
  mockServer = mock.srvr;
  mockBase = mock.base;

  sandboxDir = makeSandbox();
  const info = await patchSandboxConfig(sandboxDir);
  botId = info.botId;

  // 把所有模型指向假端点：既保证零费用，也让「说几片就是几片」可控
  const cfgPath = path.join(sandboxDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  for (const m of cfg.models || []) {
    m.baseURL = mockBase;
    m.apiKey = 'sk-mock';
    m.webSearch = false;
  }
  cfg.webSearch = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  srv = await startServer(sandboxDir, info.port);

  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = (typeof m.location === 'function' ? m.location() : null) || {};
    if (loc.url && loc.url.includes('/favicon.ico')) return;   // 浏览器自动请求，项目本就没提供
    pageErrors.push(`console.error: ${m.text()}${loc.url ? ' @ ' + loc.url : ''}`);
  });
  await page.goto(srv.base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.md === 'function', null, { timeout: 15000 });
});

after(async () => {
  await browser?.close().catch(() => {});
  stopServer(srv?.child);
  await sleep(400);
  if (mockServer) mockServer.close();
  if (sandboxDir) removeSandbox(sandboxDir);
});

// ─────────────────────────────────────────────────────────────
// 接口层：SSE 契约
// ─────────────────────────────────────────────────────────────

/** 打一次流式接口，把 SSE 解析成事件数组 */
async function rawStream(extraHeaders = {}, content = '探针') {
  const res = await fetch(`${srv.base}/api/bots/${botId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...extraHeaders },
    body: JSON.stringify({ content }),
  });
  const text = await res.text();
  const events = text.split('\n\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l.replace(/^data:\s*/, '')); } catch { return { type: 'parse-error' }; }
  });
  return { res, events, text };
}

test('流式接口返回 text/event-stream 且事件序为 start → text… → done', async () => {
  const { res, events } = await rawStream();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  assert.equal(events[0].type, 'start', '首帧应是 start（已写入 user 消息）');
  assert.equal(events[events.length - 1].type, 'done', '末帧应是 done');
  assert.ok(events.slice(1, -1).every((e) => e.type === 'text'), '中间应全是 text 帧');
});

test('每个模型分片对应一帧 text（后端没把流攒成一次性返回）', async () => {
  const { events } = await rawStream();
  const texts = events.filter((e) => e.type === 'text');
  assert.equal(texts.length, CHUNKS.length, `应收到 ${CHUNKS.length} 帧 text`);
});

test('text.d 是累积全文而非增量（前端据此做整体替换）', async () => {
  const { events } = await rawStream();
  const texts = events.filter((e) => e.type === 'text').map((e) => e.d);
  assert.equal(texts[0], CHUNKS[0], '首帧应只有第一片');
  assert.equal(texts[texts.length - 1], FULL, '末帧应是完整台词');
  // 逐帧校验：每帧都等于前 n 片的拼接
  const mismatch = texts.findIndex((t, i) => t !== CHUNKS.slice(0, i + 1).join(''));
  assert.equal(mismatch, -1, `第 ${mismatch + 1} 帧不是前 n 片的前缀拼接`);
});

test('done 帧带回 reply / threadId / pushed（与一次性 /chat 同构的收尾语义）', async () => {
  const { events } = await rawStream();
  const done = events[events.length - 1];
  assert.equal(done.reply, FULL);
  assert.equal(done.pushed, false, '沙箱副本没设主 ID，不应触发推送');
  assert.ok(done.threadId, 'done 必须带上选定的线程 id');
});

test('缺 content 时在写 SSE 头之前就 400 早退（不落库、不建流）', async () => {
  const res = await fetch(`${srv.base}/api/bots/${botId}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.equal((await res.json()).err, '缺少 content');
});

test('SSE 响应带 CORS 头（桌面壳跨源也要能读流）', async () => {
  const { res } = await rawStream({ Origin: 'http://tauri.localhost' });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
});

// ─────────────────────────────────────────────────────────────
// 浏览器层：气泡逐字增长
// ─────────────────────────────────────────────────────────────

/**
 * 点角色 → 打字 → 发送，全程按 120ms 采样气泡状态。
 * 返回采样数组：{ t, len, cls, caret, thinking }
 */
async function sendAndSample(content) {
  await page.click('#bot-list .side-item');
  await page.waitForSelector('#f-chat', { timeout: 10000 });
  await page.waitForSelector('#session-list .session', { timeout: 10000 });
  await page.fill('#f-chat', content);

  // 采样器先跑起来（此刻还没点发送，所以会先采到「思考中」的那几帧）
  const sampler = page.evaluate(async () => {
    const out = [];
    const t0 = Date.now();
    let seenText = false;
    while (Date.now() - t0 < 15000) {
      const el = document.querySelector('#session-list .session:last-child .bubble');
      const caret = !!(el && el.querySelector('.caret'));
      const len = el ? el.textContent.length : -1;
      out.push({ t: Date.now() - t0, len, cls: el ? el.className : '', caret, thinking: !!(el && el.classList.contains('thinking')) });
      if (len > 0 && !caret) { if (seenText) break; }
      if (caret) seenText = true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return out;
  });
  await page.click('.chat-input .primary');
  return sampler;
}

/** 读 #session-list 最后一条气泡的正文（摘掉时间戳与操作按钮） */
function lastBubbleText() {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('#session-list .session')];
    const b = els.length ? els[els.length - 1].querySelector('.bubble') : null;
    if (!b) return '';
    const clone = b.cloneNode(true);
    clone.querySelectorAll('.time, .s-ops').forEach((n) => n.remove());
    return clone.textContent.trim();
  });
}

test('浏览器里气泡逐字增长，且期间带光标 / .streaming 描边、定稿后两者摘掉', async () => {
  const samples = await sendAndSample('流式增长测试');
  const streaming = samples.filter((s) => !s.thinking && s.caret && s.len > 0);
  const lens = streaming.map((s) => s.len);
  const distinct = new Set(lens);
  // 23 片 × 120ms 采样 → 正常情况下能采到十几个不同长度；>6 已是极强的「确实是流式」证据
  assert.ok(distinct.size > 6, `流式期间只采到 ${distinct.size} 个不同长度，疑似一次性到达：${[...distinct].join(',')}`);
  assert.ok(lens.every((v, i) => i === 0 || v >= lens[i - 1]), `气泡文本出现回退（不是单调增长）：${lens.join(',')}`);
  // 末帧与「最后一帧 text」之间只隔一个微任务，采样多半抓不到收尾那一刻，
  // 所以这里只要求「流式期间已逼近全文长度」，精确的收尾一致性交给下一条用例。
  assert.ok(Math.max(...lens) >= FULL.length - 8, `流式最长只到 ${Math.max(...lens)} 字，全文 ${FULL.length} 字 —— 疑似中途截断`);

  // 同一次流式过程里顺带验证样式态：正在流式时必须有光标与 .streaming 描边
  assert.ok(streaming.length > 0, '整个流式过程中没采到一次带光标的帧');
  assert.ok(streaming.some((s) => /\bstreaming\b/.test(s.cls)), '未挂上 .streaming 描边类');

  await sleep(900);
  const after = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#session-list .session')];
    const b = els.length ? els[els.length - 1].querySelector('.bubble') : null;
    return { caret: !!(b && b.querySelector('.caret')), cls: b ? b.className : '' };
  });
  assert.equal(after.caret, false, '定稿后仍残留光标');
  assert.ok(!/\bstreaming\b/.test(after.cls), '定稿后仍残留 .streaming：' + after.cls);
});

test('定稿后气泡内容与落库的 assistant 记录一致（流式预览不覆盖真相）', async () => {
  await sendAndSample('落库一致性测试');
  await sleep(1000);
  assert.equal(await lastBubbleText(), FULL, '气泡正文与模型台词不一致');

  const r = await (await fetch(`${srv.base}/api/memory/${botId}/sessions`)).json();
  const last = [...(r.sessions || [])].reverse().find((s) => s.role === 'assistant');
  assert.ok(last, '没有落库的 assistant 记录');
  assert.equal(last.content, FULL, '落库的回复与模型台词不一致');
});

test('整个流式过程页面无 JS 运行时错误', () => {
  assert.deepEqual(pageErrors, [], '页面出现 JS 错误：\n' + pageErrors.join('\n'));
});

// ─────────────────────────────────────────────────────────────
// 降级路径：SSE 被环境掐断时仍要能对话，且不得重复写消息
// ─────────────────────────────────────────────────────────────

test('SSE 被掐断 → 自动回落一次性 /chat，且 user 消息只写一次', async () => {
  const countUsers = async () => {
    const r = await (await fetch(`${srv.base}/api/memory/${botId}/sessions`)).json();
    return (r.sessions || []).filter((s) => s.role === 'user').length;
  };
  const before = await countUsers();

  await page.route('**/chat/stream', (route) => route.abort());   // 模拟本环境掐断 SSE 长连接
  try {
    await page.click('#bot-list .side-item');
    await page.waitForSelector('#f-chat', { timeout: 10000 });
    await page.fill('#f-chat', '降级路径测试');
    await page.click('.chat-input .primary');
    await sleep(3000);

    const after = await countUsers();
    // 关键：降级不能把同一条 user 消息写两遍 —— 这是「流式路由先落库、失败后重放」
    // 最典型的翻车方式，也是本测试存在的首要理由。
    assert.equal(after, before + 1, `user 消息应只多 1 条，实际 ${before} → ${after}`);
    assert.equal(await lastBubbleText(), FULL, '降级路径没拿到完整回复');

    const r = await (await fetch(`${srv.base}/api/memory/${botId}/sessions`)).json();
    const full = (r.sessions || []).filter((s) => s.content === FULL).length;
    assert.ok(full >= 1, '降级路径的回复没落库');
  } finally {
    await page.unroute('**/chat/stream');
  }
});
