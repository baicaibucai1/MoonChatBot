// QQ 机器人接入层（基于官方文档 api-v2）
// ------------------------------------------------------------------
// 文档来源：
//   获取访问凭证:  https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
//   API 调用指南:  https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html
//   消息事件:      https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/event.html
//
// 关键流程：
//   1. POST https://api.bot.qq.com/app/getAppAccessToken 换取 access_token（7200s，可缓存）
//   2. 所有 OpenAPI 请求头携带 Authorization: QQBot {access_token}
//   3. WebSocket 网关：Hello(op10) → Identify(op2) → 心跳(op1) → 事件(op0 Dispatch)
//   4. 单聊回复：POST /v2/users/{openid}/messages
//      群聊回复：POST /v2/groups/{group_openid}/messages
// ------------------------------------------------------------------
'use strict';
const WebSocket = require('ws');

// 域名：正式 api.bot.qq.com（官方文档），沙箱 sandbox.api.sgroup.qq.com（已验证可用）
const TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';
const API_SANDBOX = 'https://sandbox.api.sgroup.qq.com';
const API_PROD = 'https://api.bot.qq.com';

// 事件订阅 intents（位掩码，官方文档）
//   GROUP_AND_C2C_EVENT (1<<25)：单聊 C2C_MESSAGE_CREATE + 群聊 GROUP_AT_MESSAGE_CREATE
//   PUBLIC_GUILD_MESSAGES (1<<30)：频道 @消息 AT_MESSAGE_CREATE
const INTENT_BITS = {
  GROUP_AND_C2C_EVENT: 1 << 25,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
};
const INTENT_ALL = (INTENT_BITS.GROUP_AND_C2C_EVENT | INTENT_BITS.PUBLIC_GUILD_MESSAGES) >>> 0;

function buildIntentMask(names) {
  if (!names || !names.length) return INTENT_ALL;
  let mask = 0;
  for (const n of names) mask |= INTENT_BITS[n] || 0;
  return mask >>> 0;
}

// ---------- access_token 缓存（按 AppID 隔离，支持多机器人） ----------
const _tokenMap = new Map();   // appId -> { accessToken, expiresAt }
const _pending = new Map();    // appId -> Promise（防止并发重复请求）

async function getAccessToken(appId, appSecret) {
  const now = Date.now();
  const cached = _tokenMap.get(appId);
  if (cached && cached.expiresAt > now + 60_000) return cached.accessToken; // 提前 60s 刷新
  if (_pending.has(appId)) return _pending.get(appId);

  const p = (async () => {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: String(appId), clientSecret: String(appSecret) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`获取 access_token 失败 (HTTP ${res.status}): ${data.message || JSON.stringify(data)}`);
    }
    const expiresIn = Number(data.expires_in || 7200);
    _tokenMap.set(appId, { accessToken: data.access_token, expiresAt: now + expiresIn * 1000 });
    console.log(`[qq:${appId}] access_token 获取成功，有效期 ${expiresIn}s`);
    return data.access_token;
  })();

  _pending.set(appId, p);
  try { return await p; }
  finally { _pending.delete(appId); }
}

// ---------- 获取网关地址 ----------
async function getGatewayUrl(appId, appSecret, sandbox) {
  const token = await getAccessToken(appId, appSecret);
  const base = sandbox ? API_SANDBOX : API_PROD;
  const res = await fetch(`${base}/gateway/bot`, { headers: { Authorization: 'QQBot ' + token } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) {
    throw new Error(`获取网关地址失败 (HTTP ${res.status}): ${data.message || JSON.stringify(data)}`);
  }
  return data.url;
}

// ---------- 事件标准化（官方事件结构） ----------
// C2C_MESSAGE_CREATE:  { id, content, timestamp, author:{ user_openid } }
// GROUP_AT_MESSAGE_CREATE: { id, content, timestamp, group_openid, author:{ member_openid } }
function normalizeEvent(type, d) {
  if (!d) return null;
  const author = d.author || {};
  const content = String(d.content || '').replace(/<@!?\d+>/g, '').trim();
  const msgId = d.id || '';

  if (type === 'C2C_MESSAGE_CREATE') {
    return {
      type, scene: 'c2c',
      targetId: author.user_openid || '',   // 回复用 openid
      msgId, content,
      sender: author.user_openid || '',
      timestamp: d.timestamp || Date.now(),
    };
  }
  if (type === 'GROUP_AT_MESSAGE_CREATE') {
    return {
      type, scene: 'group',
      targetId: d.group_openid || '',       // 回复用群 openid
      msgId, content,
      sender: author.member_openid || '',
      timestamp: d.timestamp || Date.now(),
    };
  }
  if (type === 'AT_MESSAGE_CREATE') {       // 频道 @（可选能力）
    return {
      type, scene: 'guild',
      targetId: d.channel_id || '',
      msgId, content,
      sender: author.id || '',
      timestamp: d.timestamp || Date.now(),
    };
  }
  return null; // 其他事件（加群、退群等）暂不处理
}

// ---------- 被动回复（单聊 / 群聊 / 频道） ----------
// opts.markdown = true 时优先以 markdown（msg_type=2）发送；失败自动回退纯文本
let _msgSeq = Math.floor(Math.random() * 1e6); // msg_seq 单调递增，用于消息排重

async function sendReply(appId, appSecret, sandbox, scene, targetId, content, msgId, opts = {}) {
  const token = await getAccessToken(appId, appSecret);
  const base = sandbox ? API_SANDBOX : API_PROD;
  const path = scene === 'c2c' ? `/v2/users/${encodeURIComponent(targetId)}/messages`
             : scene === 'group' ? `/v2/groups/${encodeURIComponent(targetId)}/messages`
             : scene === 'guild' ? `/channels/${encodeURIComponent(targetId)}/messages`
             : null;
  if (!path) throw new Error(`未知回复场景: ${scene}`);

  const post = async (body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'QQBot ' + token },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`发送消息失败 (HTTP ${res.status}): ${data.message || JSON.stringify(data).slice(0, 300)}`);
      err.code = data.code;
      throw err;
    }
    return data;
  };

  if (opts.markdown) {
    try {
      const data = await post({ msg_type: 2, markdown: { content }, msg_id: msgId || '', msg_seq: ++_msgSeq });
      console.log(`[qq:${appId}] 回复已发送 → ${scene} (markdown)`);
      return data;
    } catch (err) {
      // 无 markdown 权限 / 内容不合规等 → 回退纯文本
      console.warn(`[qq:${appId}] markdown 发送失败，回退纯文本: ${err.message.slice(0, 120)}`);
    }
  }
  const data = await post({ msg_type: 0, content, msg_id: msgId || '', msg_seq: ++_msgSeq });
  console.log(`[qq:${appId}] 回复已发送 → ${scene}`);
  return data;
}

// ---------- 流式发送（官方 stream_messages，仅单聊） ----------
// 首片（input_state=1, index=0）返回 stream_msg_id；续片携带该 id；
// input_mode=replace：content_raw 为当前累积全文（须以已下发前缀开头）；input_state=10 结束。
// 支持内容格式：text / markdown。
async function sendStreamChunk({ appId, appSecret, sandbox, targetId, content, inputState, index, contentType = 'text', msgId = '', streamMsgId = '', msgSeq = 1 }) {
  const token = await getAccessToken(appId, appSecret);
  const base = sandbox ? API_SANDBOX : API_PROD;
  const body = {
    input_mode: 'replace',
    input_state: inputState,
    index,
    content_type: contentType,
    content_raw: content,
    msg_seq: msgSeq,
  };
  if (msgId) body.msg_id = msgId;
  if (streamMsgId) body.stream_msg_id = streamMsgId;
  const res = await fetch(`${base}/v2/users/${encodeURIComponent(targetId)}/stream_messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'QQBot ' + token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`流式发送失败 (HTTP ${res.status}): ${data.message || JSON.stringify(data).slice(0, 200)}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

// ---------- 启动机器人 WebSocket 网关 ----------
// handlers: { onReady(d), onEvent(type, d), onError(err), onClose() }
function startBot({ appId, appSecret, sandbox = true, intents, handlers = {} }) {
  let ws = null, heartbeatTimer = null, reconnectTimer = null;
  let stopped = false, connecting = false, sessionId = null, lastSeq = null;

  const log = (msg) => console.log(`[qq:${appId}] ${msg}`);

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
  }

  async function connect(tryResume = false) {
    if (stopped || connecting) return;
    connecting = true;

    try {
      const token = await getAccessToken(appId, appSecret);
      const url = await getGatewayUrl(appId, appSecret, sandbox);
      if (stopped) return;

      log(`连接网关: ${url}`);
      ws = new WebSocket(url);

      ws.on('open', () => log('WebSocket 已连接'));

      ws.on('message', (raw) => {
        let frame;
        try { frame = JSON.parse(raw.toString()); } catch { return; }
        const op = frame.op;

        // Hello(op10)：建立心跳，发送 Identify / Resume
        if (op === 10) {
          const interval = frame.d?.heartbeat_interval || 45000;
          clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            try { ws.send(JSON.stringify({ op: 1, d: lastSeq })); } catch {}
          }, interval);

          if (tryResume && sessionId && lastSeq != null) {
            ws.send(JSON.stringify({ op: 6, d: { token: 'QQBot ' + token, session_id: sessionId, seq: lastSeq } }));
          } else {
            sessionId = null; lastSeq = null;
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token: 'QQBot ' + token,
                intents: buildIntentMask(intents),
                shard: [0, 1],
                properties: { $os: 'windows', $browser: 'moonchatbot', $device: 'pc' },
              },
            }));
          }
        }
        // 心跳 ACK(op11)：正常，忽略
        // Dispatch(op0)：业务事件
        else if (op === 0) {
          if (frame.s != null) lastSeq = frame.s;
          const t = frame.t;
          log(`事件 [${t}]`);

          if (t === 'READY') {
            sessionId = frame.d?.session_id || null;
            log(`✅ 鉴权成功，机器人: ${frame.d?.user?.username || frame.d?.user?.id || ''}`);
            handlers.onReady?.(frame.d);
          } else if (t === 'RESUMED') {
            log('✅ 会话恢复 (RESUMED)');
          } else if (t === 'RECONNECT' || op === 7) {
            log('收到 Reconnect，准备重连');
            reconnect(true);
          } else {
            try { handlers.onEvent?.(t, frame.d); }
            catch (e) { log('事件处理异常: ' + e.message); }
          }
        }
        // Invalid Session(op9)
        else if (op === 9) {
          log('会话失效 (op9)，重新连接');
          sessionId = null; lastSeq = null;
          reconnect();
        }
      });

      ws.on('close', (code) => {
        log(`连接关闭 (code=${code})，3 秒后重连`);
        stopHeartbeat();
        handlers.onClose?.();
        if (!stopped) reconnectTimer = setTimeout(() => connect(Boolean(sessionId && lastSeq != null)), 3000);
      });

      ws.on('error', (err) => {
        log('WebSocket 错误: ' + err.message);
        handlers.onError?.(err);
      });
    } catch (err) {
      log('连接失败: ' + err.message + '，10 秒后重试');
      handlers.onError?.(err);
      if (!stopped) reconnectTimer = setTimeout(() => connect(), 10000);
    } finally {
      connecting = false;
    }
  }

  function reconnect(tryResume = false) {
    stopHeartbeat();
    try { ws?.close(); } catch {}
    ws = null;
    if (!stopped) reconnectTimer = setTimeout(() => connect(tryResume && Boolean(sessionId && lastSeq != null)), 1500);
  }

  connect();

  return {
    stop() {
      stopped = true;
      stopHeartbeat();
      try { ws?.close(); } catch {}
      ws = null;
    },
  };
}

module.exports = { sendReply, sendStreamChunk, startBot, normalizeEvent };
