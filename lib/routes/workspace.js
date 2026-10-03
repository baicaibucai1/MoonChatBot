// 工作区路由：管理员 AI 的草稿台 CRUD + 注入到目标
//
// 注入语义：把工作区某文件的内容写到目标（角色记忆库 / 全局设定）。
// 这一步**会真正改动 AI 的记忆**，所以前端必须走确认；但后端这里不做二次拦截 ——
// 与既有的记忆文件 PUT 接口保持同一信任级别（面板本身已是管理员边界）。
'use strict';
const { ID_CLASS } = require('../ids');

// 工作区文件名捕获段（与 lib/workspace.js 的 KEY_RE 同字符集）
// ★ ID_CLASS 本身已含方括号（[\w\u4e00-\u9fa5-]），这里**不能再包一层**，
//   否则会拼出 ([[\w...]]{1,64}) —— 字符类里嵌字符类，永远匹配不上。
const WS_KEY = '(' + ID_CLASS + '{1,64})';

module.exports = function (deps) {
  const { app, memory, workspace } = deps;

  // 把工作区文件注入到目标；返回 { ok, err }
  function injectTo(key, targetType, targetId, destKey) {
    const content = workspace.readFile(key);
    if (!content && content !== '') throw new Error('工作区文件不存在或为空: ' + key);
    const dest = destKey || key;   // 默认沿用工作区文件名作为目标文件名
    if (targetType === 'global') {
      memory.saveGlobalFile(dest, content);
      workspace.recordInject(key, { targetType: 'global', targetId: '', destKey: dest });
      return true;
    }
    if (targetType === 'bot') {
      const cfg = app.getConfig();
      const b = (cfg.bots || []).find((x) => x.id === targetId);
      if (!b) throw new Error('机器人不存在: ' + targetId);
      memory.saveMemoryFile(targetId, dest, content);
      workspace.recordInject(key, { targetType: 'bot', targetId, destKey: dest });
      return true;
    }
    throw new Error('未知的注入目标类型: ' + targetType);
  }

  return [
    // GET /api/workspace — 文件列表
    {
      exact: '/api/workspace',
      m: 'GET',
      h: (c) => {
        try { return c.send(200, { ok: true, files: workspace.listFiles(), dir: workspace.WS_DIR }); }
        catch (err) { return c.send(500, { ok: false, err: err.message }); }
      },
    },

    // POST /api/workspace/inject { key, targetType: bot|global, targetId?, destKey? }
    // 注意：必须排在 /api/workspace/:key 之前，否则 'inject' 会被当成文件名吃掉
    {
      exact: '/api/workspace/inject',
      m: 'POST',
      h: (c) => {
        c.readBody((body) => {
          try {
            const key = String(body?.key || '');
            if (!workspace.KEY_RE.test(key)) return c.send(400, { ok: false, err: '非法的文件名: ' + key });
            const targetType = String(body?.targetType || '');
            const targetId = String(body?.targetId || '');
            const destKey = body?.destKey ? String(body.destKey) : '';
            if (!['bot', 'global'].includes(targetType)) return c.send(400, { ok: false, err: 'targetType 必须是 bot 或 global' });
            injectTo(key, targetType, targetId, destKey);
            return c.send(200, { ok: true });
          } catch (err) { return c.send(200, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // POST /api/workspace/:key/rename { to } — 改名
    // ★ 必须排在下面三条 /:key 通配规则之前：router 按数组顺序匹配、无优先级区分。
    //   注意三条通配规则共用 `^...$` 全匹配，'/rename' 后缀不会被它们吃掉 ——
    //   但顺序仍然守住，避免将来有人把某条通配改成前缀匹配时静默失配。
    {
      re: new RegExp('^/api/workspace/' + WS_KEY + '/rename$'),
      m: 'POST',
      h: (c, m) => {
        c.readBody((body) => {
          try {
            const to = String(body?.to || '');
            if (!workspace.KEY_RE.test(to)) return c.send(400, { ok: false, err: '非法的目标文件名: ' + to });
            workspace.renameFile(m[1], to);
            return c.send(200, { ok: true, key: to });
          } catch (err) { return c.send(400, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // GET /api/workspace/:key — 读单个文件正文
    {
      re: new RegExp('^/api/workspace/' + WS_KEY + '$'),
      m: 'GET',
      h: (c, m) => {
        try { return c.send(200, { ok: true, key: m[1], content: workspace.readFile(m[1]) }); }
        catch (err) { return c.send(400, { ok: false, err: err.message }); }
      },
    },

    // PUT /api/workspace/:key { content, desc? } — 新建或覆盖（免确认：写草稿台是安全操作）
    {
      re: new RegExp('^/api/workspace/' + WS_KEY + '$'),
      m: 'PUT',
      h: (c, m) => {
        c.readBody((body) => {
          try {
            workspace.writeFile(m[1], String(body?.content ?? ''), body?.desc);
            return c.send(200, { ok: true });
          } catch (err) { return c.send(400, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // DELETE /api/workspace/:key — 删除
    {
      re: new RegExp('^/api/workspace/' + WS_KEY + '$'),
      m: 'DELETE',
      h: (c, m) => {
        try { workspace.deleteFile(m[1]); return c.send(200, { ok: true }); }
        catch (err) { return c.send(400, { ok: false, err: err.message }); }
      },
    },
  ];
};
