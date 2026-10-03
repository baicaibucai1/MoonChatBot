// 多机器人管理器：基于 QQ v2 协议（AppID + AppSecret），连接/分发/重启
'use strict';
const qqv2 = require('./qqv2');

class BotManager {
  constructor(ctx) {
    this.ctx = ctx; // { getConfig, env, resolveSecret, handleMessage }
    this.items = new Map(); // botId -> { stop, status, username }
  }

  sync(config) {
    // 停止已移除的机器人
    for (const id of [...this.items.keys()]) {
      if (!config.bots.some((b) => b.id === id)) this.stop(id);
    }
    // 启动/重启配置中的机器人
    for (const bot of config.bots) {
      if (!bot.enabled) { this.stop(bot.id); continue; }
      this.start(bot);
    }
  }

  start(bot) {
    const appId = this.ctx.resolveSecret(bot.appId, this.ctx.env);
    const appSecret = this.ctx.resolveSecret(bot.appSecret, this.ctx.env);
    if (!appId || !appSecret) {
      console.warn(`[bot:${bot.id}] 未配置 AppID/AppSecret，跳过`);
      this.setStatus(bot.id, '未配置');
      return;
    }

    const key = JSON.stringify({ appId, appSecret, intents: bot.intents, sandbox: bot.sandbox });
    const cur = this.items.get(bot.id);
    if (cur && cur._key === key && cur.status === '已连接') return; // 配置未变则保持连接

    this.stop(bot.id);

    const intents = bot.intents || ['GROUP_AND_C2C_EVENT', 'PUBLIC_GUILD_MESSAGES'];
    const handle = qqv2.startBot({
      appId,
      appSecret,
      sandbox: bot.sandbox !== false,
      intents,
      handlers: {
        onReady: (d) => {
          this.setStatus(bot.id, '已连接', d?.user?.username || '');
          console.log(`[bot:${bot.id}] ✅ 已连接（${bot.name || bot.id}）`);
        },
        onEvent: async (type, d) => {
          const evt = qqv2.normalizeEvent(type, d);
          if (!evt) return;
          await this.ctx.handleMessage(bot.id, evt);
        },
        onError: (err) => {
          this.setStatus(bot.id, '错误');
        },
        onClose: () => {
          this.setStatus(bot.id, '已断开');
        },
      },
    });

    this.items.set(bot.id, { stop: handle.stop, _key: key, status: '连接中' });
    console.log(`[bot:${bot.id}] 启动中（AppID: ${appId}，沙箱: ${bot.sandbox !== false}）`);
  }

  send(bot, scene, targetId, content, msgId, opts = {}) {
    const appId = this.ctx.resolveSecret(bot.appId, this.ctx.env);
    const appSecret = this.ctx.resolveSecret(bot.appSecret, this.ctx.env);
    return qqv2.sendReply(appId, appSecret, bot.sandbox !== false, scene, targetId, content, msgId, opts);
  }

  // 流式回复 sink：把模型增量推送到 QQ「流式消息」（replace 模式，整段累积正文）。
  // 用法：const sink = mgr.makeStreamSink(bot, { scene:'c2c', targetId, msgId, msgSeq });
  //       await sink.push(累积全文)   —— 由模型增量驱动（内部节流 ~900ms）
  //       await sink.finish(最终全文) —— 发送结束片（input_state=10）
  // 属性：started（已创建流式消息）/ failed（首片失败，应退化为普通发送）
  makeStreamSink(bot, { scene, targetId, msgId, msgSeq = 1 } = {}) {
    if (scene !== 'c2c') return null;                       // 流式仅单聊
    const appId = this.ctx.resolveSecret(bot.appId, this.ctx.env);
    const appSecret = this.ctx.resolveSecret(bot.appSecret, this.ctx.env);
    if (!appId || !appSecret || !targetId || !msgId) return null;
    const sandbox = bot.sandbox !== false;

    const st = { started: false, failed: false, index: 0, streamId: '', ct: 'markdown', full: '', lastPush: 0, timer: null, busy: false, pending: false, inflight: null };

    const chunk = (inputState, content) => {
      const p = qqv2.sendStreamChunk({
        appId, appSecret, sandbox, targetId,
        content, inputState, index: st.index, contentType: st.ct,
        msgId, streamMsgId: st.streamId, msgSeq,
      }).then((data) => {
        if (!st.streamId && data.id) st.streamId = data.id;    // 首片返回 stream_msg_id
        st.index++;                                            // 分片序号原子推进（防重复/乱序）
        return data;
      });
      st.inflight = p.catch(() => {});                         // 记录在途片，finish 需等待其完成
      return p;
    };

    async function flush() {
      if (st.busy || st.failed || !st.pending) return;
      st.busy = true; st.pending = false;
      try {
        if (!st.started) {
          if (st.full.replace(/【记录】[\s\S]*$/, '').trim().length < 10) return; // 内容太少不建流
          try {
            await chunk(1, st.full);                          // 首片
            st.started = true; st.lastPush = Date.now();
            console.log(`[bot:${bot.id}] 流式回复已开始（${st.ct}）`);
          } catch (err) {
            // markdown 权限/格式问题 → 改用 text 重试首片一次
            if (st.ct === 'markdown') {
              st.ct = 'text';
              try {
                await chunk(1, st.full);
                st.started = true; st.lastPush = Date.now();
                console.log(`[bot:${bot.id}] 流式回复已开始（text 降级）`);
              } catch (err2) {
                st.failed = true;
                console.warn(`[bot:${bot.id}] 流式首片失败，降级普通回复: ${err2.message.slice(0, 120)}`);
              }
            } else {
              st.failed = true;
              console.warn(`[bot:${bot.id}] 流式首片失败，降级普通回复: ${err.message.slice(0, 120)}`);
            }
          }
        } else {
          await chunk(1, st.full);                            // 续片（replace：累积全文）
          st.lastPush = Date.now();
        }
      } catch (err) {
        console.warn(`[bot:${bot.id}] 流式续片失败: ${err.message.slice(0, 120)}`);
      } finally {
        st.busy = false;
      }
    }

    return {
      get started() { return st.started; },
      get failed() { return st.failed; },
      push(accumulated) {
        st.full = String(accumulated ?? '');
        if (st.failed) return;
        if (!st.started && st.full.replace(/【记录】[\s\S]*$/, '').trim().length < 10) return;
        st.pending = true;                                    // 标记有未下发内容（finish 会等待）
        if (st.timer || st.busy) return;                      // 已排队/在途：flush 后自动带出最新 full
        const now = Date.now();
        const wait = st.started ? Math.max(0, 900 - (now - st.lastPush)) : 0;
        st.timer = setTimeout(() => { st.timer = null; flush(); }, wait);
      },
      async finish(finalText) {
        if (st.timer) { clearTimeout(st.timer); st.timer = null; }
        st.pending = true;                                    // 确保 in-flight flush 携带最新 full
        if (st.inflight) { try { await st.inflight; } catch {} }  // 等待在途分片完成（保证 index 连续）
        if (st.failed || !st.started) return false;
        if (typeof finalText === 'string') st.full = finalText;
        // 结束片：失败重试一次；两次都失败由调用方决定是否普通补发
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await chunk(10, st.full);
            console.log(`[bot:${bot.id}] 流式回复完成（${st.index} 片，${st.full.length} 字）`);
            return true;
          } catch (err) {
            console.warn(`[bot:${bot.id}] 流式结束片失败（第 ${attempt + 1} 次）: ${err.message.slice(0, 120)}`);
            await new Promise((r) => setTimeout(r, 400));
          }
        }
        return false;
      },
    };
  }

  setStatus(id, status, username) {
    const item = this.items.get(id);
    if (item) {
      item.status = status;
      if (username) item.username = username;
    }
  }

  isRunning(id) {
    return this.items.get(id)?.status === '已连接';
  }

  getStatus(id) {
    const item = this.items.get(id);
    return item ? { status: item.status, username: item.username } : { status: '未启动' };
  }

  stop(id) {
    const item = this.items.get(id);
    if (item) {
      try { item.stop(); } catch {}
      this.items.delete(id);
    }
  }

  stopAll() {
    for (const id of [...this.items.keys()]) this.stop(id);
  }
}

module.exports = BotManager;