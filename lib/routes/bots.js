// 机器人控制路由：重启 / 主动发消息 / 打开记忆目录 / AI 归档 / 面板直接对话
'use strict';
const { ID_SEG } = require('../ids');

module.exports = function (deps) {
  const { app, memory, makeChatFn, chatWithBot, extractJsonObjects, spawn } = deps;

  return [
    // POST /api/bots/:id/restart
    {
      re: new RegExp('^/api/bots/' + ID_SEG + '/restart$'),
      m: 'POST',
      h: (c, m) => {
        const { send } = c;
        const cfg = app.getConfig();
        const bot = cfg.bots.find((x) => x.id === m[1]);
        if (!bot) return send(404, { ok: false, err: '机器人不存在' });
        app.bots.stop(m[1]);
        app.bots.start(bot);
        send(200, { ok: true });
        return true;
      },
    },

    // POST /api/bots/:id/send { scene:'c2c'|'group'|'guild', targetId, content }
    {
      re: new RegExp('^/api/bots/' + ID_SEG + '/send$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        const cfg = app.getConfig();
        const bot = cfg.bots.find((x) => x.id === m[1]);
        if (!bot) return send(404, { ok: false, err: '机器人不存在' });
        readBody((body) => {
          const { scene = 'c2c', targetId, content } = body || {};
          if (!targetId || !content) return send(400, { ok: false, err: '缺少 targetId 或 content' });
          app.bots.send(bot, scene, String(targetId), String(content).slice(0, 4000), '')
            .then(() => send(200, { ok: true }))
            .catch((err) => send(200, { ok: false, err: err.message }));
        });
        return true;
      },
    },

    // POST /api/bots/:id/open-folder — 在系统文件管理器中打开该机器人的记忆目录
    {
      re: new RegExp('^/api/bots/' + ID_SEG + '/open-folder$'),
      m: 'POST',
      h: (c, m) => {
        const { send } = c;
        const dir = memory.memoryDir(m[1]);
        deps.fs.mkdirSync(dir, { recursive: true });
        // explorer 是单实例进程，直接 exec 会因退出码非 0 误报失败，改用 spawn 不等待退出码
        const child = spawn(process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => send(500, { ok: false, err: '打开文件夹失败: ' + err.message }));
        child.unref();
        send(200, { ok: true });
        return true;
      },
    },

    // POST /api/bots/:id/ingest { text } — 概述新剧情/内容，AI 归类写入对应记忆文件
    {
      re: new RegExp('^/api/bots/' + ID_SEG + '/ingest$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        const cfg = app.getConfig();
        const bot = cfg.bots.find((x) => x.id === m[1]);
        if (!bot) return send(404, { ok: false, err: '机器人不存在' });
        readBody((body) => {
          const text = (body.text || '').trim();
          if (!text) return send(400, { ok: false, err: '缺少 text' });
          const model = cfg.models.find((x) => x.id === bot.modelId) || cfg.models[0];
          if (!model) return send(400, { ok: false, err: '该机器人未绑定模型' });
          const apiKey = model.apiKey || app.env[model.apiKeyEnv];
          if (!apiKey) return send(400, { ok: false, err: '模型未配置 API Key' });
          // 统一模型调用器：内部按「全局蒸馏模型 > 机器人绑定模型」选择并记录用量。
          // 修复：此前这里直接调用 chatFn 但从未创建它，导致本接口必然抛
          // ReferenceError（被 .catch 吞成 200 {ok:false}），AI 归档功能完全不可用。
          const chatFn = makeChatFn(bot.id);
          if (!chatFn) return send(400, { ok: false, err: '没有可用的模型，请先配置 API Key' });
          (async () => {
            // 系统生成文件（events_summary/events_archive）只读管理，不允许 AI 归档写入
            const files = memory.getMemoryFiles(bot.id).filter((f) => f.enabled && !f.sys);
            if (!files.length) return send(400, { ok: false, err: '没有可用的记忆文件' });
            const listDesc = files.map((f) => `- ${f.key}（${f.name}）：${f.desc}`).join('\n');
            const sys = `你是记忆整理助手。用户会提供一段新信息（剧情进展、人物设定、特征、知识等），你需要把它归类到合适的记忆文件，并改写为简洁条目。
可用记忆文件（只允许写入以下已启用的文件）：
${listDesc}
规则：
1. 判断新信息归属哪个文件；可以拆分成多条分别归档到不同文件。
2. 只输出一个 JSON 对象（不要任何其他文字，不要 markdown 代码块），格式：{"items":[{"file":"<上面某个key>","append":true,"content":"<简洁的条目内容>"}]}
3. content 中不要出现英文双引号，保持纯文本。
4. append=true 表示在文件末尾追加一条。若新信息是对现有设定的整体替换（如角色状态彻底改变），可输出 append:false 且 content 为完整的替换内容（谨慎，勿覆盖无关内容）。`;
            // 调用模型（makeChatFn 内部按「全局蒸馏模型 > 机器人绑定模型」选择并记录用量；
            // jsonMode：不支持 response_format 的端点会自动去参重试）
            const reply = await chatFn([
              { role: 'system', content: sys },
              { role: 'user', content: text },
            ], { maxTokens: 500, jsonMode: true });
            // 解析：优先直解 {"items":[...]}；失败降级兼容旧版「每行一个 JSON 对象」
            const raw = String(reply || '');
            let items = [];
            try {
              const j = JSON.parse(raw.replace(/```(?:json)?/g, '').trim());
              if (Array.isArray(j.items)) items = j.items;
            } catch {}
            if (!items.length) items = extractJsonObjects(raw).filter((o) => o && o.file && o.content);
            const enabledMap = new Map(files.map((f) => [f.key, f]));
            const results = [];
            for (const obj of items) {
              if (!obj || !obj.file || !obj.content) continue;
              const target = enabledMap.get(obj.file);
              if (!target) continue;
              if (obj.append === false) memory.saveMemoryFile(bot.id, target.key, String(obj.content));
              else memory.appendMemoryFile(bot.id, target.key, String(obj.content));
              results.push({ file: target.key, name: target.name, action: obj.append === false ? '覆盖' : '追加', content: String(obj.content) });
            }
            if (!results.length) {
              return send(200, { ok: false, err: 'AI 返回格式无法解析: ' + String(reply).slice(0, 200) });
            }
            for (const r of results) console.log(`[bot:${bot.id}] AI 归档 → ${r.file}（${r.action}）: ${r.content.slice(0, 60)}`);
            send(200, { ok: true, results });
          })().catch((err) => send(200, { ok: false, err: err.message }));
        });
        return true;
      },
    },

    // POST /api/bots/:id/chat { content, threadId? } — 不经过 QQ，直接与角色（当前模型+记忆）对话
    // threadId 缺省 → 落在「当前线程」（见 lib/memory/threads.js 的 defaultThreadId）
    {
      re: new RegExp('^/api/bots/' + ID_SEG + '/chat$'),
      m: 'POST',
      h: (c, m) => {
        const { send, readBody } = c;
        readBody((body) => {
          const content = (body.content || '').trim();
          if (!content) return send(400, { ok: false, err: '缺少 content' });
          (async () => {
            // 先定线程再写：user 与 assistant 两条必须落在同一条线程上，
            // 否则对话历史（只读当前线程）会读不到刚写进去的那半句。
            const threadId = body.threadId
              ? String(body.threadId)
              : memory.threads.getDefaultThreadId(m[1]);
            memory.threads.appendMessage(m[1], threadId, 'user', content);
            const reply = await chatWithBot(m[1], content, { threadId });
            if (!reply) return send(200, { ok: false, err: '模型返回为空' });
            memory.threads.appendMessage(m[1], threadId, 'assistant', reply);
            // 默认把面板对话的输出主动发送给主 ID
            const master = memory.getMasterSender(m[1]);
            let pushed = false;
            if (master) {
              try {
                const cfg = app.getConfig();
                const bot = cfg.bots.find((x) => x.id === m[1]);
                if (bot) {
                  await app.bots.send(bot, 'c2c', master, reply.slice(0, 4000), '', { markdown: true });
                  pushed = true;
                }
              } catch (e) { console.log(`[bot:${m[1]}] 主动推送主 ID 失败: ${e.message}`); }
            }
            send(200, { ok: true, reply, pushed, threadId });
          })().catch((err) => send(200, { ok: false, err: err.message }));
        });
        return true;
      },
    },
  ];
};
