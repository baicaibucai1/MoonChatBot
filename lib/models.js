// 模型路由层：DeepSeek 官方 / 任意 OpenAI 兼容端点
// 全部走 fetch（Node 18+ 内置），但**出站连接带可达性兜底** —— 见下面的 reach。
//
// ★★ 为什么请求不能直接用 fetch（2026-10-05，一次真实故障）：
//   本机 Agnes 端点的地址可用性会变，而且变过两次、方向相反：
//     · 2026-10-04：IPv4 被中间设备劫持（换来自签证书），IPv6 干净；
//     · 2026-10-05：**反过来了** —— IPv4 正常，IPv6 一个超时、一个证书过期。
//   当时的对策是把「此刻哪条路能走」写死进代码（server.js 的 ipv6first），
//   于是环境一变，修复就变成故障源：每次调模型都失败，用户看到「对话失败」。
//   lib/net-reach.js 换掉了这个思路：解析全部候选地址 → **逐个试到 TLS 握手成功** →
//   记住可用的那个；连接层失败时清缓存重新探测并重试一次。不做任何环境假设。
'use strict';

const reach = require('./net-reach');

// 粗略估算消息的 prompt token 数（仅在模型未返回 usage 时兜底，如请求失败）
// 规则：ASCII 约 4 字符/token，中文约 1 字/token，其余按 2 字符/token
function estimateTokens(messages) {
  let n = 0;
  const walk = (s) => {
    for (const ch of String(s ?? '')) {
      const c = ch.codePointAt(0);
      if (c < 128) n += 0.25;
      else if (c >= 0x4e00 && c <= 0x9fff) n += 1;
      else n += 0.5;
    }
  };
  for (const m of messages || []) { walk(m.role); walk(': '); walk(m.content); walk('\n'); }
  return Math.max(1, Math.ceil(n));
}

// 等待指定毫秒
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 带退避的重试：429 / 5xx / 网络层错误自动重试（默认最多 2 次）；429 优先按 Retry-After 等待
// fn 抛出的错误需带 err.status（HTTP 状态码）或 err.retriable=true（网络层）
async function withRetry(fn, { retries = 2, base = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      // ★ 主动中断绝不重试（2026-10-09）：用户点「停止」后还退避重试一次，
      //   等于「停下来」之后又偷偷发一轮请求。名字和 code 都判一下，避免漏网。
      if (isAbort(err)) throw err;
      const status = err && err.status;
      const retriable = (err && err.retriable === true) || status === 429 || (status >= 500 && status < 600);
      if (!retriable || attempt >= retries) throw err;
      const ra = Number(err.retryAfter);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : base * 2 ** attempt;
      await sleep(Math.min(wait, 15000));
    }
  }
}

// 是否是「用户主动中断」产生的错误。
// Node 的 fetch 在 signal.abort() 后抛 AbortError（DOMException 同名）；
// 但经过 net-reach / withRetry 几层包装后 name 可能只剩在 cause 上，所以两处都看。
function isAbort(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  const c = err.cause;
  return !!(c && (c.name === 'AbortError' || c.code === 'ABORT_ERR'));
}

// 中断错误统一出口：抛一个带 aborted 标记的错误，上层据此区分「失败」与「被用户停掉」。
function abortError() {
  const e = new Error('已被用户终止');
  e.name = 'AbortError';
  e.aborted = true;
  return e;
}

// 调用 chat/completions（OpenAI 兼容协议）
// 返回 { content, usage, toolCalls, finishReason, promptTokens }：usage 为模型返回的精确用量（可能为 null），
// toolCalls 为模型请求调用的工具列表（[{ id, function:{name,arguments} }]，可能为 null），
// finishReason 为结束原因（'stop' 写完 / 'length' 被 max_tokens 截断，可能为 null），
// promptTokens 为本地估算值（请求失败等拿不到 usage 时兜底）
async function chat(model, messages, options = {}) {
  const apiKey = options.apiKey || null;
  if (!apiKey) throw new Error('缺少 API Key');
  // 已经停了就别再发请求（用户点了停止后，续写/重试等后续调用点会走到这里）
  if (options.signal && options.signal.aborted) throw abortError();

  const promptTokens = estimateTokens(messages);
  const url = (model.baseURL || '').replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model.model,
    messages,
    temperature: options.temperature ?? model.temperature ?? 0.7,
  };
  // maxTokens 为 0 / 空 = 不限制（不传 max_tokens，交给模型默认）
  const maxTokens = options.maxTokens ?? model.maxTokens;
  if (maxTokens && maxTokens > 0) body.max_tokens = maxTokens;
  // 联网工具（function calling）
  if (options.tools && options.tools.length) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice ?? 'auto';
  }
  // 结构化输出（OpenAI 兼容 response_format；个别端点不支持时自动去掉重试一次）
  if (options.jsonMode) body.response_format = { type: 'json_object' };

  // requestBody 先序列化成**字符串**再交给 fetchReachable：
  // 它可能重试一次（连接层失败时），body 若是流/一次性对象，第二次就发不出去了。
  const requestBody = JSON.stringify(body);
  const doFetch = () => reach.fetchReachable(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: requestBody,
    // 主动中断：用户在面板点了「停止」→ AbortController.abort() → 这里立刻断开
    signal: options.signal,
  });

  // 网络层与 HTTP 状态处理都在重试闭包内：重试只发生在尚未收到任何响应字节时
  return withRetry(async () => {
    let res;
    try {
      res = await doFetch();
    } catch (fetchErr) {
      // 被主动中断：不是网络故障，别标 retriable（标了 withRetry 还会再来一次）
      if (isAbort(fetchErr)) throw abortError();
      // 网络层错误（连接失败/超时等）同样消耗 token，挂上估算值供统计兜底；标记可重试
      fetchErr.promptTokens = promptTokens;
      fetchErr.retriable = true;
      throw fetchErr;
    }
    let text = await res.text();
    // 端点不支持 response_format（400）→ 去掉该参数重试一次（不计入重试次数）
    if (!res.ok && body.response_format && res.status === 400) {
      delete body.response_format;
      try {
        res = await doFetch();
        text = await res.text();
      } catch (e) {
        if (isAbort(e)) throw abortError();
        e.promptTokens = promptTokens;
        e.retriable = true;
        throw e;
      }
    }
    let data;
    try { data = JSON.parse(text); } catch { data = { error: { message: text.slice(0, 300) } }; }

    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      const err = new Error('模型调用失败: ' + msg);
      err.promptTokens = promptTokens; // 失败时也把估算值带出，便于统计兜底
      err.status = res.status;
      const ra = Number(res.headers?.get?.('retry-after'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
      throw err;
    }
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      toolCalls: data.choices?.[0]?.message?.tool_calls ?? null,
      usage: data.usage || null,
      // 结束原因：'stop' = 模型自己写完了；'length' = 被 max_tokens 截断（还有话没说完）。
      // 分段续写靠它判断要不要接着写 —— 拿不到就续不了，所以这层必须透出。
      finishReason: data.choices?.[0]?.finish_reason || null,
      promptTokens,
    };
  }, { retries: options.retries ?? 2 });
}

module.exports = { chat, chatStream, chatStreamCollect, isAbort, abortError };

// 流式收集器：调用 chatStream 并解析 SSE，累积 content / tool_calls / usage。
// onDelta(accumulatedText)：每收到一个 content 增量回调一次（参数为当前累积全文）。
// 返回 { content, toolCalls, usage, promptTokens }（与 chat 同构）
async function chatStreamCollect(model, messages, options = {}, onDelta) {
  const { res, promptTokens } = await chatStream(model, messages, options);
  const signal = options.signal;
  const dec = new TextDecoder();
  const tcs = new Map();
  let text = '';
  let usage = null;
  let buf = '';
  // 流式下 finish_reason 只出现在**最后一个** content chunk（之前的 chunk 里是 null），
  // 而开了 stream_options.include_usage 时还会多一个只有 usage、choices 为空数组的 chunk
  // —— 所以「取最后一个非空值」，而不是「取第一个」或「遇到就覆盖」。
  let finishReason = null;
  const feed = (raw) => {
    buf += raw;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.usage) usage = ev.usage;
      const fr = ev.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      const d = ev.choices?.[0]?.delta;
      if (!d) continue;
      if (d.content) {
        text += d.content;
        try { if (onDelta) onDelta(text); } catch {}
      }
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const idx = Number(tc.index ?? 0);
          const slot = tcs.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) slot.id = tc.id;
          if (tc.function) {
            if (tc.function.name) slot.function.name += tc.function.name;
            if (tc.function.arguments) slot.function.arguments += tc.function.arguments;
          }
          tcs.set(idx, slot);
        }
      }
    }
  };
  for await (const chunk of res.body) {
    // ★ 主动中断的兜底检查（2026-10-09）：abort 会连带销毁 body，for await 自然会抛；
    //   但个别环境下体已缓冲完、abort 只让后续读取静默结束 —— 那样会「停下来却照样返回全文」，
    //   所以每块都自己看一眼，断了就抛，保证上层的 abort 语义一定生效。
    if (signal && signal.aborted) throw abortError();
    feed(dec.decode(chunk, { stream: true }));
  }
  feed(dec.decode()); // 冲刷末尾
  const toolCalls = [...tcs.values()]
    .filter((t) => t.function && t.function.name)
    .map((t) => ({ id: t.id || ('call_' + Math.random().toString(36).slice(2, 10)), type: t.type, function: t.function }));
  return {
    content: text,
    toolCalls: toolCalls.length ? toolCalls : null,
    usage,
    finishReason,
    promptTokens,
  };
}

// 流式调用 chat/completions（stream: true）
// 返回 { res, promptTokens }：res 为已通过状态检查的 fetch Response（body 为 SSE 流）
// SSE 解析交给调用方（需要按 token 增量做工具调用拼装）
async function chatStream(model, messages, options = {}) {
  const apiKey = options.apiKey || null;
  if (!apiKey) throw new Error('缺少 API Key');
  if (options.signal && options.signal.aborted) throw abortError();

  const promptTokens = estimateTokens(messages);
  const url = (model.baseURL || '').replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model.model,
    messages,
    temperature: options.temperature ?? model.temperature ?? 0.7,
    stream: true,
    stream_options: { include_usage: true },
  };
  const maxTokens = options.maxTokens ?? model.maxTokens;
  if (maxTokens && maxTokens > 0) body.max_tokens = maxTokens;
  if (options.tools && options.tools.length) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice ?? 'auto';
  }

  let res;
  try {
    // 同 chat()：序列化成字符串再交给带可达性兜底的 fetch（它可能因连接层失败重试一次）
    res = await reach.fetchReachable(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (fetchErr) {
    if (isAbort(fetchErr)) throw abortError();
    fetchErr.promptTokens = promptTokens;
    throw fetchErr;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text)?.error?.message || msg; } catch {}
    const err = new Error('模型调用失败: ' + msg);
    err.promptTokens = promptTokens;
    throw err;
  }
  return { res, promptTokens };
}