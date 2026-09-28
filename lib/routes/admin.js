// 面板管理员 AI 路由：普通对话 / SSE 流式 Agent / 会话记录管理
'use strict';
const { SESSION_ID_RE } = require('../ids');

// 管理员会话 id 的路径捕获段（纯 ASCII，最长 40 位）
const ADMIN_SESSION_SEG = '([\\w-]{1,40})';

module.exports = function (deps) {
  const {
    app, memory,
    adminPickModel, buildAdminSystem, adminToolSchemas,
    streamAdminAgent, adminEnsureEdits, adminChatAgent,
  } = deps;

  return [
    // POST /api/admin/chat/stream { content, history?, modelId?, botId? } — Agent + SSE 流式
    {
      exact: '/api/admin/chat/stream',
      m: 'POST',
      h: (c) => {
        const { send, readBody, res } = c;
        readBody((body) => {
          (async () => {
            const content = (body.content || '').trim();
            if (!content) return send(400, { ok: false, err: '缺少内容' });
            const cfg = app.getConfig();
            // 选择模型：优先指定且可用 → 兜底到「可靠模型」而非小免费端点
            const usable = cfg.models.filter((m) => m.apiKey || app.env[m.apiKeyEnv]);
            const model = adminPickModel(usable, body.modelId);
            if (!model) return send(400, { ok: false, err: '没有可用的模型，请先在「▤ 模型」中配置 API Key' });
            const apiKey = model.apiKey || app.env[model.apiKeyEnv];
            const history = Array.isArray(body.history)
              ? body.history.slice(-16).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
              : [];
            const sid = SESSION_ID_RE.test(String(body.sessionId || '')) ? String(body.sessionId) : '';
            const messages = [
              { role: 'system', content: buildAdminSystem(cfg, body.botId) },
              ...history,
              { role: 'user', content },
            ];
            const webEnabled = cfg.webSearch === true || model.webSearch === true;
            const tools = adminToolSchemas(webEnabled);
            console.log(`[admin:stream] start bot=${body.botId || '-'} model=${model.id} tools=${tools.length} sid=${sid || '-'}`);
            // 立即返回 SSE 流头，开始 Agent 循环
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
            });
            // 收集工具过程与「待确认编辑」，随 done 一次性返回，保证前端稳定弹出确认条
            const extras = { tools: [], pendings: [] };
            const emit = (obj) => {
              if (obj.type === 'tool') extras.tools.push({ name: obj.name, summary: obj.summary || '', ok: obj.ok !== false });
              else if (obj.type === 'pending' && obj.edit) extras.pendings.push(obj.edit);
              try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {}
            };
            try {
              const out = await streamAdminAgent(cfg, model, messages, apiKey, tools, emit);
              // 结构化兜底：只给文字建议而未走工具 → 自动补一轮 propose_* 提交（工具/待确认事件会照常流给前端）
              if (!extras.tools.length && out.text) {
                try { await adminEnsureEdits(cfg, model, messages, apiKey, out.text, emit); }
                catch (e) { console.warn(`[admin:stream] ensure-edits skipped: ${e.message}`); }
              }
              // 持久化到管理员会话（工具轮无正文也写入占位，保证会话连续）
              if (sid) {
                const text = out.text || (out.toolsDisabled ? '' : '（本轮调用了工具，详见活动记录）');
                memory.recordAdminSession(sid, 'user', content);
                if (text) memory.recordAdminSession(sid, 'assistant', text);
              }
              emit({ type: 'done', modelName: model.name || model.id, text: out.text || '', toolsDisabled: !!out.toolsDisabled, pendings: extras.pendings });
              console.log(`[admin:stream] done bot=${body.botId || '-'} model=${model.id} len=${(out.text || '').length} disabled=${!!out.toolsDisabled} pendings=${extras.pendings.length}`);
            } catch (err) {
              console.warn(`[admin:stream] error: ${err.message}`);
              emit({ type: 'err', err: err.message || '调用失败' });
            }
            try { res.end(); } catch {}
          })().catch((err) => send(200, { ok: false, err: err.message }));
        });
        return true;
      },
    },

    // POST /api/admin/chat { content, history?, modelId?, botId?, sessionId? } — 普通模式（默认，稳定可靠）
    {
      exact: '/api/admin/chat',
      m: 'POST',
      h: (c) => {
        const { send, readBody } = c;
        readBody((body) => {
          (async () => {
            const content = (body.content || '').trim();
            if (!content) return send(400, { ok: false, err: '缺少内容' });
            const cfg = app.getConfig();
            // 选择模型：优先指定且可用 → 第一个已配置 Key 的模型
            const usable = cfg.models.filter((m) => m.apiKey || app.env[m.apiKeyEnv]);
            const model = adminPickModel(usable, body.modelId);
            if (!model) return send(400, { ok: false, err: '没有可用的模型，请先在「▤ 模型」中配置 API Key' });
            const apiKey = model.apiKey || app.env[model.apiKeyEnv];
            const sid = SESSION_ID_RE.test(String(body.sessionId || '')) ? String(body.sessionId) : '';
            // 会话上下文：优先取前端传入 history；未传时用会话记录补足最近消息
            let history = Array.isArray(body.history)
              ? body.history.slice(-20).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
              : [];
            if (!history.length && sid) {
              history = memory.getAdminSession(sid).slice(-20).map(({ role, content }) => ({ role, content }));
            }
            const messages = [
              { role: 'system', content: buildAdminSystem(cfg, body.botId) },
              ...history,
              { role: 'user', content },
            ];
            // 完整 Agent 循环（工具调用 + 编辑确认），用量已在循环内记录
            const out = await adminChatAgent(cfg, model, messages, apiKey);
            if (!out.content) return send(200, { ok: false, err: '模型返回为空，请重试或更换模型' });
            // 持久化到管理员会话（Agent 长期记忆）
            if (sid) { memory.recordAdminSession(sid, 'user', content); memory.recordAdminSession(sid, 'assistant', out.content); }
            console.log(`[admin:chat] ok bot=${body.botId || '-'} model=${model.id} len=${out.content.length} tools=${out.tools.length} sid=${sid || '-'}`);
            send(200, { ok: true, reply: out.content, modelId: model.id, modelName: model.name || model.id, tools: out.tools || [], toolsDisabled: !!out.toolsDisabled });
          })().catch((err) => {
            console.warn(`[admin:chat] error: ${err.message}`);
            send(200, { ok: false, err: err.message });
          });
        });
        return true;
      },
    },

    // GET /api/admin/sessions — 会话列表
    {
      exact: '/api/admin/sessions',
      m: 'GET',
      h: (c) => c.send(200, { ok: true, sessions: memory.listAdminSessions() }),
    },

    // GET /api/admin/sessions/:id — 单会话消息
    {
      re: new RegExp('^/api/admin/sessions/' + ADMIN_SESSION_SEG + '$'),
      m: 'GET',
      h: (c, asm) => c.send(200, { ok: true, messages: memory.getAdminSession(asm[1]) }),
    },

    // DELETE /api/admin/sessions/:id — 删除会话
    {
      re: new RegExp('^/api/admin/sessions/' + ADMIN_SESSION_SEG + '$'),
      m: 'DELETE',
      h: (c, asm) => {
        memory.deleteAdminSession(asm[1]);
        return c.send(200, { ok: true });
      },
    },
  ];
};
