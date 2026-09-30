// 模型路由层：DeepSeek 官方 / 任意 OpenAI 兼容端点
// 全部走 fetch（Node 18+ 内置）
'use strict';

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
      const status = err && err.status;
      const retriable = (err && err.retriable === true) || status === 429 || (status >= 500 && status < 600);
      if (!retriable || attempt >= retries) throw err;
      const ra = Number(err.retryAfter);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : base * 2 ** attempt;
      await sleep(Math.min(wait, 15000));
    }
  }
}

// 调用 chat/completions（OpenAI 兼容协议）
// 返回 { content, usage, toolCalls, finishReason, promptTokens }：usage 为模型返回的精确用量（可能为 null），
// toolCalls 为模型请求调用的工具列表（[{ id, function:{name,arguments} }]，可能为 null），
// finishReason 为结束原因（'stop' 写完 / 'length' 被 max_tokens 截断，可能为 null），
// promptTokens 为本地估算值（请求失败等拿不到 usage 时兜底）
async function chat(model, messages, options = {}) {
  const apiKey = options.apiKey || null;
  if (!apiKey) throw new Error('缺少 API Key');

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

  const doFetch = () => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  });

  // 网络层与 HTTP 状态处理都在重试闭包内：重试只发生在尚未收到任何响应字节时
  return withRetry(async () => {
    let res;
    try {
      res = await doFetch();
    } catch (fetchErr) {
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

module.exports = { chat, chatStream, chatStreamCollect };

// 流式收集器：调用 chatStream 并解析 SSE，累积 content / tool_calls / usage。
// onDelta(accumulatedText)：每收到一个 content 增量回调一次（参数为当前累积全文）。
// 返回 { content, toolCalls, usage, promptTokens }（与 chat 同构）
async function chatStreamCollect(model, messages, options = {}, onDelta) {
  const { res, promptTokens } = await chatStream(model, messages, options);
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
  for await (const chunk of res.body) feed(dec.decode(chunk, { stream: true }));
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
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
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