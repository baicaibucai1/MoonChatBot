#!/usr/bin/env node
// 接口契约快照：在「临时副本沙箱」里起服务，按清单打全部接口，记录状态码 + 响应结构，
// 产出 api-baseline.json，作为架构拆分（批 1–5）逐批回归的行为验收依据。
//
// 用法：
//   node scripts/api-baseline.mjs                 采集并写入 scripts/api-baseline.json
//   node scripts/api-baseline.mjs --check         重新采集并与已存基线逐条比对（有差异 → 退出码 1）
//   node scripts/api-baseline.mjs --keep-sandbox  保留沙箱目录便于手工排查
//
// ─────────────────────────────────────────────────────────────────────────────
// 为什么必须在副本里跑，而不是直接打本机正在运行的服务
//
// 1. 面板里一大半接口是写操作：
//      PUT    /api/config                 回写 config.json 并热重载机器人
//      DELETE /api/memory/:id/events      清空经历事件流
//      DELETE /api/memory/:id/sessions    清空会话记录
//      POST   /api/bots/:id/send          真的往 QQ 发消息（外部副作用！）
//      POST   /api/bots/:id/open-folder   真的弹出系统资源管理器窗口
// 2. 更隐蔽的一处：lib/memory.js 的 botDir() 内含 fs.mkdirSync(recursive:true)
//    加「预设记忆文件自创建」。也就是说，哪怕只 GET 一次
//    /api/memory/<不存在的 id>/files，也会凭空造出一个记忆目录和一批模板文件。
// 3. 但 lib/store.js 与 lib/memory.js 的路径全由 path.join(__dirname, '..') 推导 ——
//    这意味着把源码复制到临时目录后，config.json / memory/ / avatars/ 会全部落在副本内。
//    副本天然隔离，可以放心打「成功路径」，这才拿得到真实的响应结构。
//
// 副本内额外做三件事，确保零外部副作用：
//   · bots[].enabled = false          → BotManager.sync() 直接 continue，不建立任何 QQ 连接
//   · bots 的 appId/appSecret 换占位符 → 万一走到发送路径，也只会认证失败
//   · 清空 models[].apiKey 且不复制 .env → 所有模型调用在「未配置 Key」处早退，不产生费用
// 唯一被主动跳过真实调用的是 POST /api/bots/:id/open-folder（会 spawn explorer 弹窗），
// 改用非法字符路径验证其正则边界。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT, sleep, makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox,
} from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(HERE, 'api-baseline.json');

// 探针用的固定标识：带下划线，落在路由字符类 [\w\u4e00-\u9fa5-] 内，保证能命中路由
const PROBE_KEY = '__baseline_probe__';
const PROBE_ID = '__nope__';
// 1×1 透明 PNG，用于走通头像上传的成功路径（仅写入副本）
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const argv = new Set(process.argv.slice(2));
const CHECK_ONLY = argv.has('--check');
const KEEP_SANDBOX = argv.has('--keep-sandbox');

// ── 沙箱（复制源码 → 改写配置 → 起隔离服务）见 scripts/lib/sandbox.mjs，
//    与 tests/frontend.test.mjs 共用同一份实现，避免两处漂移 ──

// ═══════════════════════════════════════════════════════════════════════════
// 二、探针清单
// ═══════════════════════════════════════════════════════════════════════════
//
// kind 语义：
//   entry     入口层（CORS 预检、静态资源、路径遍历防护）
//   read      只读接口，真打成功路径，记录完整响应结构 —— 最有价值的契约
//   write     写接口的成功路径。只在副本内生效，副本用完即删
//   reject    用「必然早退」的输入打（缺字段 / 非法值），验证校验分支与错误文案
//   probe     用不存在的实体打，验证「路由命中 + 参数提取」（响应必为 404 实体不存在）
//   boundary  非法字符路径，验证正则边界与 404 兜底不会相互误匹配
//
// 顺序敏感！后面的探针会改变副本状态，所以：
//   只读段 → 写段（创建 → 修改 → 删除）→ 清空段 → 边界段
// 顺序在两次运行间保持一致，因此结果可复现。
//
function buildProbes(botId) {
  const B = botId;
  const K = PROBE_KEY;
  const N = PROBE_ID;
  return [
    // ── 入口层：CORS 与静态资源（server.js:448-490）────────────────────
    { id: 'entry:preflight', kind: 'entry', method: 'OPTIONS', path: '/api/state', note: 'CORS 预检 → 204 空响应' },
    { id: 'entry:cors-allowed', kind: 'entry', method: 'GET', path: '/api/state', headers: { Origin: 'http://tauri.localhost' }, note: '壳内 origin 应回 Access-Control-Allow-Origin' },
    { id: 'entry:cors-denied', kind: 'entry', method: 'GET', path: '/api/state', headers: { Origin: 'http://evil.example.com' }, note: '非白名单 origin 不得回 ACAO' },
    { id: 'static:root', kind: 'entry', method: 'GET', path: '/', note: '→ index.html' },
    { id: 'static:index', kind: 'entry', method: 'GET', path: '/index.html' },
    { id: 'static:app-js', kind: 'entry', method: 'GET', path: '/app.js', note: '.js 应带 no-cache' },
    { id: 'static:style-css', kind: 'entry', method: 'GET', path: '/style.css' },
    { id: 'static:missing', kind: 'entry', method: 'GET', path: '/definitely-not-here.js' },
    { id: 'static:avatar-missing', kind: 'entry', method: 'GET', path: '/avatars/__nope__.png' },
    { id: 'static:traversal-literal', kind: 'entry', method: 'GET', path: '/..%2f..%2fserver.js', note: '解码后应被 startsWith(PUBLIC_DIR) 拦住' },
    { id: 'static:traversal-encoded', kind: 'entry', method: 'GET', path: '/%2e%2e%2f%2e%2e%2fserver.js', note: '同上，另一种编码形式' },

    // ── 只读接口：真打成功路径 ─────────────────────────────────────────
    { id: 'api:state', kind: 'read', method: 'GET', path: '/api/state' },
    { id: 'api:usage', kind: 'read', method: 'GET', path: '/api/usage' },
    { id: 'api:global-files', kind: 'read', method: 'GET', path: '/api/global/files' },
    { id: 'api:heartbeat-status', kind: 'read', method: 'GET', path: '/api/heartbeat/status' },
    { id: 'api:admin-sessions', kind: 'read', method: 'GET', path: '/api/admin/sessions' },
    { id: 'api:admin-session-one', kind: 'read', method: 'GET', path: '/api/admin/sessions/probe-session', note: '不存在的会话 id → 空消息列表' },
    { id: 'api:mem-files', kind: 'read', method: 'GET', path: `/api/memory/${B}/files` },
    { id: 'api:mem-layers', kind: 'read', method: 'GET', path: `/api/memory/${B}/layers` },
    { id: 'api:mem-sessions', kind: 'read', method: 'GET', path: `/api/memory/${B}/sessions` },
    { id: 'api:mem-branches', kind: 'read', method: 'GET', path: `/api/memory/${B}/branches` },
    // 对话线程（多线程 C1）。放在这里是因为前面的 /sessions 已经触发过一次迁移，
    // 到这里线程状态已稳定；副本每次都是同样的输入，因此结果可复现。
    { id: 'api:mem-threads', kind: 'read', method: 'GET', path: `/api/memory/${B}/threads`, note: '线程列表（老数据迁移后应非空）' },
    { id: 'api:mem-threads-nope', kind: 'read', method: 'GET', path: `/api/memory/${N}/threads`, note: '不存在的角色 → 空列表，且不产生目录副作用' },

    // ── 上传头像（校验分支 + 成功路径）────────────────────────────────
    { id: 'api:avatar-empty', kind: 'reject', method: 'POST', path: '/api/upload-avatar', json: {}, capture: ['err'] },
    { id: 'api:avatar-bad-ext', kind: 'reject', method: 'POST', path: '/api/upload-avatar', json: { botId: B, ext: 'exe', data: 'AAAA' }, capture: ['err'] },
    { id: 'api:avatar-ok', kind: 'write', method: 'POST', path: '/api/upload-avatar', json: { botId: B, ext: 'png', data: TINY_PNG }, note: '合法 1×1 PNG，仅写入副本 avatars/' },

    // ── 配置保存（副本内回写，内容不变）──────────────────────────────
    { id: 'api:config-put', kind: 'write', method: 'PUT', path: '/api/config', json: {}, note: '空 body → 原样回写 + 热重载' },
    { id: 'api:config-bad-bot-id', kind: 'reject', method: 'PUT', path: '/api/config', json: { bots: [{ id: 'bad id!!' }] }, capture: ['err'] },
    { id: 'api:config-bad-distill', kind: 'reject', method: 'PUT', path: '/api/config', json: { distillModel: '__nope__' }, capture: ['err'] },

    // ── 全局设定：创建 → 保存 → 开关 → 删除（顺序敏感）──────────────
    { id: 'api:global-create-no-key', kind: 'reject', method: 'POST', path: '/api/global/files', json: {}, capture: ['err'] },
    { id: 'api:global-create', kind: 'write', method: 'POST', path: '/api/global/files', json: { key: K } },
    { id: 'api:global-put', kind: 'write', method: 'PUT', path: `/api/global/files/${K}`, json: { content: 'baseline probe' } },
    { id: 'api:global-enabled', kind: 'write', method: 'PUT', path: `/api/global/files/${K}/enabled`, json: { enabled: false } },
    { id: 'api:global-delete', kind: 'write', method: 'DELETE', path: `/api/global/files/${K}` },

    // ── 记忆文件：创建 → 改名备注 → 分层 → 开关 → 删除（顺序敏感）──
    { id: 'api:mem-create-no-key', kind: 'reject', method: 'POST', path: `/api/memory/${B}/files`, json: {}, capture: ['err'] },
    { id: 'api:mem-create', kind: 'write', method: 'POST', path: `/api/memory/${B}/files`, json: { key: K } },
    { id: 'api:mem-put', kind: 'write', method: 'PUT', path: `/api/memory/${B}/files/${K}`, json: { content: 'baseline probe' } },
    { id: 'api:mem-desc', kind: 'write', method: 'PUT', path: `/api/memory/${B}/files/${K}/desc`, json: { desc: 'baseline probe' } },
    { id: 'api:mem-tier', kind: 'write', method: 'PUT', path: `/api/memory/${B}/files/${K}/tier`, json: { tier: 2 } },
    { id: 'api:mem-enabled', kind: 'write', method: 'PUT', path: `/api/memory/${B}/files/${K}/enabled`, json: { enabled: false } },
    { id: 'api:mem-order', kind: 'write', method: 'PUT', path: `/api/memory/${B}/files/order`, json: { keys: [] }, note: '验证 /files/order 优先于通配 /files/:key 匹配' },
    { id: 'api:mem-delete', kind: 'write', method: 'DELETE', path: `/api/memory/${B}/files/${K}` },

    // ── 记忆上传与核心卡（副本内真实写入）────────────────────────────
    { id: 'api:mem-upload-empty', kind: 'reject', method: 'POST', path: `/api/memory/${B}/upload`, json: {}, capture: ['err'] },
    { id: 'api:mem-upload-ok', kind: 'write', method: 'POST', path: `/api/memory/${B}/upload`, json: { name: '__probe__.md', content: 'baseline probe', tier: 1 } },
    { id: 'api:mem-key-event', kind: 'write', method: 'POST', path: `/api/memory/${B}/key-events`, json: { event: 'baseline probe' } },
    { id: 'api:mem-core-put', kind: 'write', method: 'PUT', path: `/api/memory/${B}/core`, json: { core: { identity: 'probe' } }, note: '覆盖人格核心卡（仅副本）' },
    { id: 'api:mem-seed-from-core', kind: 'write', method: 'POST', path: `/api/memory/${B}/seed-from-core` },

    // ── 清理类（放最后，会真正改变数据）──────────────────────────────
    { id: 'api:mem-event-delete-one', kind: 'write', method: 'DELETE', path: `/api/memory/${B}/events/9999999999` },
    { id: 'api:mem-session-delete-one', kind: 'write', method: 'DELETE', path: `/api/memory/${B}/sessions/9999999999` },
    { id: 'api:mem-events-clear', kind: 'write', method: 'DELETE', path: `/api/memory/${B}/events` },
    { id: 'api:mem-events-summary-clear', kind: 'write', method: 'DELETE', path: `/api/memory/${B}/events-summary` },
    { id: 'api:mem-branch-fork', kind: 'write', method: 'POST', path: `/api/memory/${B}/sessions/branch`, json: { fromTs: 9999999999 } },
    { id: 'api:mem-branch-restore', kind: 'write', method: 'POST', path: `/api/memory/${B}/branches/restore`, json: { fromTs: 9999999999 } },
    { id: 'api:mem-sessions-clear', kind: 'write', method: 'DELETE', path: `/api/memory/${B}/sessions` },
    // ── 对话线程（多线程 C1）：失败路径 + 成功创建 ──────────────────────
    { id: 'api:mem-thread-one-404', kind: 'probe', method: 'GET', path: `/api/memory/${B}/threads/9999999999`, capture: ['err'] },
    { id: 'api:mem-thread-rename-404', kind: 'probe', method: 'PUT', path: `/api/memory/${B}/threads/9999999999`, json: { title: 'probe' }, capture: ['err'] },
    { id: 'api:mem-thread-delete-404', kind: 'probe', method: 'DELETE', path: `/api/memory/${B}/threads/9999999999`, capture: ['err'] },
    { id: 'api:mem-thread-fork-404', kind: 'probe', method: 'POST', path: `/api/memory/${B}/threads/9999999999/fork`, json: { fromTs: 9999999999 }, capture: ['err'] },
    { id: 'api:mem-thread-clear-404', kind: 'probe', method: 'DELETE', path: `/api/memory/${B}/threads/9999999999/messages`, capture: ['err'], note: '清空指定对话的消息（C2）；不存在的 tid → 404，无副作用' },
    { id: 'api:mem-thread-create', kind: 'write', method: 'POST', path: `/api/memory/${B}/threads`, json: { title: '__baseline_probe__' }, note: '新建线程，仅写入副本' },
    { id: 'api:admin-session-delete', kind: 'write', method: 'DELETE', path: '/api/admin/sessions/probe-session' },

    // ── 需要外部副作用 → 只验证「路由命中 + 参数提取」────────────────
    { id: 'api:bot-restart-404', kind: 'probe', method: 'POST', path: `/api/bots/${N}/restart`, capture: ['err'], note: '不存在的 id，避免用假凭证去连 QQ' },
    { id: 'api:bot-send-404', kind: 'probe', method: 'POST', path: `/api/bots/${N}/send`, json: { targetId: '1', content: 'x' }, capture: ['err'], note: '不存在的 id，避免真的发 QQ 消息' },
    { id: 'api:bot-ingest-404', kind: 'probe', method: 'POST', path: `/api/bots/${N}/ingest`, json: { text: 'x' }, capture: ['err'] },
    // ⚠️ 发现：这条路由没有前置实体校验 —— 它先 memory.appendSession(m[1], ...) 再进
    // chatWithBot（后者才抛「机器人不存在」），异常被 catch 成 200 {ok:false}。
    // 后果是一条带任意 id 的请求就会在 memory/ 下凭空造出目录和会话记录。
    // 副本内无害，但这是真实的纵深防御缺口，已记入本基线（预期 200 而非 404）。
    { id: 'api:bot-chat-nope', kind: 'probe', method: 'POST', path: `/api/bots/${N}/chat`, json: { content: 'x' }, capture: ['ok', 'err'], note: '无前置实体校验：会写 memory/<id>/ 后返回 200 {ok:false}' },
    // 流式对话（C6）。同样无前置实体校验，所以响应是 SSE 而不是 JSON：
    //   bodyKind 记 'text'，只留长度量级，正文不入基线（含可变的时间/内容迟早会漂）。
    // 这里刻意只验证「路由命中 + 参数提取 + 事件流形态（start→err 两帧）」，不碰真模型。
    { id: 'api:bot-chat-stream-nope', kind: 'probe', method: 'POST', path: `/api/bots/${N}/chat/stream`, json: { content: 'x' }, headers: { Accept: 'text/event-stream' }, note: 'SSE：start 后因「机器人不存在」发 err 帧并收尾，HTTP 仍为 200' },
    { id: 'api:bot-chat-stream-empty', kind: 'reject', method: 'POST', path: `/api/bots/${N}/chat/stream`, json: {}, capture: ['err'], note: '缺 content → 在写 SSE 头之前就 400 早退，不落库' },
    { id: 'api:model-test-404', kind: 'probe', method: 'POST', path: `/api/models/${N}/test`, capture: ['err'], note: '不存在的 id，避免真实调用模型' },
    { id: 'api:mem-distill-404', kind: 'probe', method: 'POST', path: `/api/memory/${N}/distill`, capture: ['err'], note: '不存在的 id，避免真实调用模型' },
    { id: 'api:moments-post-404', kind: 'probe', method: 'POST', path: `/api/moments/${N}`, capture: ['err'] },
    { id: 'api:moments-delete-404', kind: 'probe', method: 'DELETE', path: `/api/moments/${N}`, json: {}, capture: ['err'] },
    { id: 'api:admin-chat-empty', kind: 'reject', method: 'POST', path: '/api/admin/chat', json: {}, capture: ['err'] },
    { id: 'api:admin-stream-empty', kind: 'reject', method: 'POST', path: '/api/admin/chat/stream', json: {}, capture: ['err'] },

    // ── 边界：正则字符类与 404 兜底 ──────────────────────────────────
    { id: 'bound:404-fallback', kind: 'boundary', method: 'GET', path: '/api/__totally_nonexistent__', capture: ['err'] },
    { id: 'bound:mem-dot', kind: 'boundary', method: 'GET', path: '/api/memory/a.b/files', capture: ['err'], note: '「.」不在字符类内 → 应落 404 兜底' },
    { id: 'bound:mem-slash', kind: 'boundary', method: 'GET', path: '/api/memory/a/b/files', capture: ['err'], note: '「/」不在字符类内 → 应落 404 兜底' },
    { id: 'bound:mem-thread-nonnumeric', kind: 'boundary', method: 'GET', path: `/api/memory/${B}/threads/abc`, capture: ['err'], note: 'tid 必须是纯数字 → 不命中，落 404 兜底' },
    { id: 'bound:mem-thread-vs-branch', kind: 'boundary', method: 'GET', path: `/api/memory/${B}/threads/order`, capture: ['err'], note: 'threads 段不接受非数字，避免与 files 域的顺序约束混淆' },
    { id: 'bound:bot-exclaim', kind: 'boundary', method: 'POST', path: '/api/bots/BAD!!/restart', capture: ['err'], note: '「!」不在字符类内 → 应落 404 兜底' },
    { id: 'bound:open-folder-illegal', kind: 'boundary', method: 'POST', path: '/api/bots/BAD!!/open-folder', capture: ['err'], note: 'open-folder 无实体校验、会弹资源管理器，故只用非法字符验证正则边界' },
    { id: 'charset:mem-cn', kind: 'boundary', method: 'GET', path: `/api/memory/${encodeURIComponent('测试')}/files`, capture: ['err'], note: '中文 id → 走字符类的 \\u4e00-\\u9fa5 分支' },
    { id: 'charset:mem-hyphen', kind: 'boundary', method: 'GET', path: '/api/memory/my-bot/files', capture: ['err'], note: '连字符分支' },
    { id: 'charset:mem-long', kind: 'boundary', method: 'GET', path: `/api/memory/${'x'.repeat(65)}/files`, capture: ['err'], note: 'memory 的 :id 无长度上限（moments 才有 {1,64}）' },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、采集
// ═══════════════════════════════════════════════════════════════════════════

// 把任意 JSON 值压成「结构指纹」：只保留键路径与类型，丢弃具体数值。
// 数组不记长度（会随数据变化），只对首元素采样递归。
function shapeOf(value) {
  const out = [];
  const walk = (val, p) => {
    const t = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
    out.push(`${p}:${t}`);
    if (Array.isArray(val)) { if (val.length) walk(val[0], `${p}[]`); }
    else if (t === 'object') { for (const k of Object.keys(val).sort()) walk(val[k], p === '$' ? k : `${p}.${k}`); }
  };
  walk(value, '$');
  return out.sort();
}

// 响应体分类：拆分后静态资源的 MIME 变化会被这里抓到
function classifyBody(contentType, text) {
  if (!text) return 'empty';
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('javascript')) return 'js';
  if (ct.includes('css')) return 'css';
  return 'text';
}

const HEADER_KEYS = ['content-type', 'cache-control', 'access-control-allow-origin', 'access-control-allow-methods'];

function pickHeaders(res) {
  const out = {};
  for (const k of HEADER_KEYS) {
    const v = res.headers.get(k);
    if (v) out[k] = v;
  }
  // 非白名单 origin 场景下，「有没有 ACAO」本身就是契约，必须显式记录
  if (!out['access-control-allow-origin']) out['access-control-allow-origin'] = '<none>';
  return out;
}

async function runProbe(base, probe) {
  const rec = {
    id: probe.id,
    kind: probe.kind,
    method: probe.method,
    path: probe.path,
    note: probe.note || '',
  };
  try {
    const init = { method: probe.method, headers: { ...(probe.headers || {}) }, signal: AbortSignal.timeout(15000) };
    if (probe.json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(probe.json);
    }
    const res = await fetch(base + probe.path, init);
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';

    rec.status = res.status;
    rec.bodyKind = classifyBody(contentType, text);
    rec.headers = pickHeaders(res);

    if (rec.bodyKind === 'json') {
      try {
        const data = JSON.parse(text);
        rec.shape = shapeOf(data);
        if (probe.capture) {
          rec.captured = {};
          for (const k of probe.capture) if (k in data) rec.captured[k] = String(data[k]).slice(0, 200);
        }
      } catch { rec.parseError = '响应声称是 JSON 但解析失败'; }
    } else {
      // 非 JSON（静态资源 / 204）：只记类型与长度量级，不记正文
      rec.length = text.length === 0 ? 0 : text.length < 1024 ? '<1K' : text.length < 65536 ? '<64K' : '>=64K';
    }
  } catch (err) {
    rec.error = err.name === 'TimeoutError' ? 'timeout' : String(err.message || err);
  }
  return rec;
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、比对
// ═══════════════════════════════════════════════════════════════════════════

function compare(baseline, current) {
  const issues = [];
  const bMap = new Map((baseline.results || []).map((r) => [r.id, r]));
  const cMap = new Map((current.results || []).map((r) => [r.id, r]));

  for (const [id, b] of bMap) {
    const c = cMap.get(id);
    if (!c) { issues.push({ id, kind: 'MISSING', detail: '本次未采集到该探针' }); continue; }
    if (b.status !== c.status) issues.push({ id, kind: 'STATUS', detail: `${b.status ?? b.error} → ${c.status ?? c.error}` });
    for (const field of ['bodyKind', 'error', 'parseError']) {
      if (b[field] !== c[field]) issues.push({ id, kind: field.toUpperCase(), detail: `${b[field] ?? '-'} → ${c[field] ?? '-'}` });
    }
    if (JSON.stringify(b.headers) !== JSON.stringify(c.headers)) {
      issues.push({ id, kind: 'HEADERS', detail: `${JSON.stringify(b.headers)} → ${JSON.stringify(c.headers)}` });
    }
    if (JSON.stringify(b.shape) !== JSON.stringify(c.shape)) {
      issues.push({ id, kind: 'SHAPE', detail: diffShape(b.shape || [], c.shape || []) });
    }
    if (JSON.stringify(b.captured) !== JSON.stringify(c.captured)) {
      issues.push({ id, kind: 'CAPTURED', detail: `${JSON.stringify(b.captured)} → ${JSON.stringify(c.captured)}` });
    }
  }
  for (const id of cMap.keys()) if (!bMap.has(id)) issues.push({ id, kind: 'ADDED', detail: '基线中没有这条探针' });
  return issues;
}

function diffShape(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  const lost = before.filter((x) => !a.has(x));
  const gained = after.filter((x) => !b.has(x));
  const parts = [];
  if (lost.length) parts.push(`消失 ${lost.length} 项（${lost.slice(0, 3).join(', ')}${lost.length > 3 ? ' …' : ''}）`);
  if (gained.length) parts.push(`新增 ${gained.length} 项（${gained.slice(0, 3).join(', ')}${gained.length > 3 ? ' …' : ''}）`);
  return parts.join('；') || '顺序变化';
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、主流程
// ═══════════════════════════════════════════════════════════════════════════

function gitSha() {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return String(r.stdout || '').trim().slice(0, 40) || '<unknown>';
  } catch { return '<unknown>'; }
}

async function main() {
  console.log('══ MoonChatBot 接口契约快照 ══');
  console.log(CHECK_ONLY ? '模式：比对（--check）' : '模式：采集（写入基线）');

  const dir = makeSandbox();
  console.log(`沙箱：${dir}`);

  let child = null;
  let sandboxInfo = null;
  let current = null;
  try {
    sandboxInfo = await patchSandboxConfig(dir);
    console.log(`沙箱端口：${sandboxInfo.port}　探针机器人：${sandboxInfo.botId}`);

    const started = await startServer(dir, sandboxInfo.port);
    child = started.child;
    console.log('沙箱服务已就绪，开始打探针…\n');

    const probes = buildProbes(sandboxInfo.botId);
    const results = [];
    for (const probe of probes) {
      const rec = await runProbe(started.base, probe);
      results.push(rec);
      const mark = rec.error ? '✗' : rec.status < 400 ? '·' : '·';
      console.log(`  ${mark} ${String(rec.status ?? 'ERR').padEnd(3)}  ${rec.method.padEnd(6)} ${rec.path}`);
    }

    current = {
      meta: {
        generatedAt: new Date().toISOString(),
        node: process.version,
        sourceSha: gitSha(),
        probeCount: results.length,
        note: '由 scripts/api-baseline.mjs 在临时副本沙箱中生成。比对时忽略 meta.generatedAt。',
      },
      results,
    };

    const statusTally = {};
    for (const r of results) statusTally[r.status ?? 'ERR'] = (statusTally[r.status ?? 'ERR'] || 0) + 1;
    console.log(`\n共 ${results.length} 条探针　状态码分布：${Object.entries(statusTally).map(([k, v]) => `${k}×${v}`).join('　')}`);
  } catch (err) {
    // 失败路径也必须清沙箱：这里如果只靠下面的正常流程收尾，
    // 异常会在 finally 之后继续上抛，把删除逻辑整段跳过，临时目录就越积越多。
    stopServer(child);
    await sleep(400);
    if (!KEEP_SANDBOX) removeSandbox(dir);
    else console.warn(`保留沙箱供排查：${dir}`);
    throw err;
  } finally {
    stopServer(child);
    await sleep(400);
  }

  if (!current) {
    removeSandbox(dir);
    throw new Error('采集失败，未产出结果');
  }

  // ── 比对模式 ──
  if (CHECK_ONLY) {
    removeSandbox(dir);
    if (!fs.existsSync(BASELINE_FILE)) {
      console.error(`\n✗ 找不到基线文件：${BASELINE_FILE}\n  先跑一次 node scripts/api-baseline.mjs 生成。`);
      process.exit(1);
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    const issues = compare(baseline, current);
    if (!issues.length) {
      console.log('\n✅ 接口契约与基线完全一致（' + current.results.length + ' 条探针逐条对齐）');
      return;
    }
    console.error(`\n✗ 发现 ${issues.length} 处契约偏差：\n`);
    for (const it of issues) console.error(`  [${it.kind}] ${it.id}\n        ${it.detail}`);
    process.exit(1);
  }

  // ── 采集模式 ──
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.log(`\n✅ 基线已写入：${path.relative(REPO_ROOT, BASELINE_FILE)}`);

  if (KEEP_SANDBOX) console.log(`沙箱保留在：${dir}`);
  else removeSandbox(dir);
}

main().catch((err) => {
  console.error('\n✗ 快照失败：' + (err?.stack || err));
  process.exit(1);
});
