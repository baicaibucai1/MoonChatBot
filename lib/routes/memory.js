// 机器人记忆路由（最大一块：23 条）
// 顺序即语义：必须「先具体后通配」。例如 /files/order 必须排在 /files/:key 之前，
// /files/:key/tier 必须排在 /files/:key 之前，否则 "order"/"tier" 会被当成文件名吞掉。
'use strict';
const { ID_SEG, NOT_ID_CLASS } = require('../ids');

const TS_SEG = '(\\d{10,17})';   // 毫秒时间戳段
// 文件名清洗用：非法字符（非 ID 字符）替换成下划线
const ILLEGAL_CHARS_G = new RegExp(NOT_ID_CLASS + '+', 'g');

module.exports = function (deps) {
  const { app, memory, makeChatFn } = deps;

  return [
    // GET /api/memory/:id/files — 全部记忆文件
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/files$'),
      m: 'GET',
      h: (c, m) => c.send(200, { ok: true, files: memory.getMemoryFiles(m[1]) }),
    },

    // POST /api/memory/:id/files — 新建记忆文件 { key }
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/files$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const key = (body.key || '').trim();
            if (!key) return send(400, { ok: false, err: '缺少文件名 key' });
            memory.saveMemoryFile(m[1], key, '');
            send(200, { ok: true });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // POST /api/memory/:id/upload — 上传文本文件为记忆文件 { name, content, tier? }
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/upload$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            // 文件名清洗：去扩展名 → 非法字符转下划线 → 截断；空名退化为时间戳
            let key = String(body.name || '').trim().replace(/\.(md|txt|markdown)$/i, '')
              .replace(ILLEGAL_CHARS_G, '_').replace(/^_+|_+$/g, '').slice(0, 48);
            if (!key) key = 'upload_' + Date.now();
            const content = String(body.content ?? '');
            if (!content.trim()) return send(400, { ok: false, err: '文件内容为空' });
            memory.saveMemoryFile(m[1], key, content);
            const tier = Number(body.tier);
            if ([1, 2, 3].includes(tier)) memory.setFileTier(m[1], key, tier);
            send(200, { ok: true, key });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // PUT /api/memory/:id/files/order — 保存记忆文件重要性排序（面板拖动）{ keys: [...] }
    // 注意：必须置于通配的 /files/:key 路由之前，否则 "order" 会被当成文件名
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/files/order$'),
      m: 'PUT',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { memory.setFileOrder(m[1], body.keys); send(200, { ok: true }); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // PUT /api/memory/:id/files/:key/tier — 设置文件记忆层级 { tier: 1|2|3 }
    // 注意：置于通配的 /files/:key 路由之前
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/files/' + ID_SEG + '/tier$'),
      m: 'PUT',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { memory.setFileTier(m[1], m[2], body.tier); send(200, { ok: true }); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // PUT /api/memory/:id/files/:key — 保存单个记忆文件
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/files/' + ID_SEG + '$'),
      m: 'PUT',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { memory.saveMemoryFile(m[1], m[2], body.content || ''); send(200, { ok: true }); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // DELETE /api/memory/:id/files/:key — 删除记忆文件
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/files/' + ID_SEG + '$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        try { memory.deleteMemoryFile(m[1], m[2]); send(200, { ok: true }); }
        catch (err) { send(500, { ok: false, err: err.message }); }
        return true;
      },
    },

    // PUT /api/memory/:id/files/:key/enabled — 启用/禁用记忆文件 { enabled }
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/files/' + ID_SEG + '/enabled$'),
      m: 'PUT',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { memory.setFileEnabled(m[1], m[2], body.enabled !== false); send(200, { ok: true }); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // PUT /api/memory/:id/files/:key/desc — 修改记忆文件备注 { desc }
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/files/' + ID_SEG + '/desc$'),
      m: 'PUT',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { memory.setFileDesc(m[1], m[2], body.desc); send(200, { ok: true }); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // POST /api/memory/:id/key-events — 手动追加关键剧情（写入结构化事件流）
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/key-events$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { memory.appendKeyEvent(m[1], body.event || ''); send(200, { ok: true }); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // GET /api/memory/:id/layers — 分层记忆状态（人格核心卡 / 事件流 / 各摘要）
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/layers$'),
      m: 'GET',
      h: (c, m) => c.send(200, { ok: true, state: memory.getMemState(m[1]) }),
    },

    // PUT /api/memory/:id/core — 手动编辑人格核心卡 { core: {...} }
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/core$'),
      m: 'PUT',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { memory.writePersonaCore(m[1], body.core || body); send(200, { ok: true }); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // POST /api/memory/:id/seed-from-core — 从人格核心卡反向生成种子（persona.md）
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/seed-from-core$'),
      m: 'POST',
      h: (c, m) => {
        const { send } = c;
        try { send(200, memory.seedFromCore(m[1])); }
        catch (err) { send(500, { ok: false, err: err.message }); }
        return true;
      },
    },

    // POST /api/memory/:id/distill — 手动蒸馏：核心卡 + 剧情/内容摘要 + 事件压缩
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/distill$'),
      m: 'POST',
      h: (c, m) => {
        const { send } = c;
        const cfg = app.getConfig();
        const bot = cfg.bots.find((x) => x.id === m[1]);
        if (!bot) return send(404, { ok: false, err: '机器人不存在' });
        const chatFn = makeChatFn(m[1]);
        if (!chatFn) return send(400, { ok: false, err: '该机器人未绑定可用模型或未配置 API Key' });
        (async () => {
          const pick = (r) => (r.status === 'fulfilled' ? r.value : { ok: false, err: r.reason?.message || String(r.reason) });
          const results = await Promise.allSettled([
            memory.distillPersonaCore(m[1], chatFn),
            memory.summarizeAllSources(m[1], chatFn, true),
            memory.compactEventsIfNeeded(m[1], chatFn, true),
          ]);
          send(200, {
            ok: true,
            results: {
              core: pick(results[0]),
              summaries: pick(results[1]),
              events: pick(results[2]),
            },
          });
        })().catch((err) => send(200, { ok: false, err: err.message }));
        return true;
      },
    },

    // DELETE /api/memory/:id/events/:ts — 删除单条经历事件
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/events/' + TS_SEG + '$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        try { send(200, { ok: memory.deleteEvent(m[1], m[2]) }); }
        catch (err) { send(500, { ok: false, err: err.message }); }
        return true;
      },
    },

    // DELETE /api/memory/:id/events — 清空经历事件流（归档不受影响）
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/events$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        try { memory.clearEvents(m[1]); send(200, { ok: true }); }
        catch (err) { send(500, { ok: false, err: err.message }); }
        return true;
      },
    },

    // DELETE /api/memory/:id/events-summary — 清空经历摘要（常驻注入的那份）
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/events-summary$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        try { memory.clearEventsSummary(m[1]); send(200, { ok: true }); }
        catch (err) { send(500, { ok: false, err: err.message }); }
        return true;
      },
    },

    // GET /api/memory/:id/sessions
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/sessions$'),
      m: 'GET',
      h: (c, m) => c.send(200, { ok: true, sessions: memory.getRecentSessions(m[1], 200), lastSender: memory.getLastSender(m[1]), masterSender: memory.getMasterSender(m[1]) }),
    },

    // DELETE /api/memory/:id/sessions
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/sessions$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        try { memory.clearSessions(m[1]); send(200, { ok: true }); }
        catch (err) { send(500, { ok: false, err: err.message }); }
        return true; // 防止继续落到末尾 404 造成二次响应（进程崩溃）
      },
    },

    // DELETE /api/memory/:id/sessions/:ts — 删除单条会话记录（AI 将不再读到它）
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/sessions/' + TS_SEG + '$'),
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        try { memory.deleteSession(m[1], m[2]); send(200, { ok: true }); }
        catch (err) { send(500, { ok: false, err: err.message }); }
        return true; // 防止继续落到末尾 404 造成二次响应（进程崩溃）
      },
    },

    // POST /api/memory/:id/sessions/branch — 以 fromTs 为分叉点建立新分支
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/sessions/branch$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { send(200, memory.forkSession(m[1], body.fromTs)); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // GET /api/memory/:id/branches — 全部分支（可回切）
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/branches$'),
      m: 'GET',
      h: (c, m) => c.send(200, { ok: true, branches: memory.listBranches(m[1]) }),
    },

    // POST /api/memory/:id/branches/restore — 恢复某分支为主会话
    {
      re: new RegExp('^/api/memory/' + ID_SEG + '/branches/restore$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { send(200, memory.restoreBranch(m[1], body.fromTs)); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
  ];
};
