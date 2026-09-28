// 全局设定路由：多文件 + 开关（设置页管理）
'use strict';
const { ID_SEG } = require('../ids');

module.exports = function (deps) {
  const { memory } = deps;

  return [
    // GET /api/global/files — 全局记忆文件列表（含内容与启用状态）
    {
      exact: '/api/global/files',
      m: 'GET',
      h: (c) => c.send(200, { ok: true, files: memory.getGlobalFiles() }),
    },

    // POST /api/global/files — 新建全局文件 { key }
    {
      exact: '/api/global/files',
      m: 'POST',
      h: (c) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const key = (body.key || '').trim();
            if (!key) return send(400, { ok: false, err: '缺少文件名 key' });
            memory.saveGlobalFile(key, '');
            send(200, { ok: true });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // PUT /api/global/files/:key/enabled — 启用/禁用 { enabled }
    {
      re: new RegExp('^/api/global/files/' + ID_SEG + '/enabled$'),
      m: 'PUT',
      h: (c, gm) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { memory.setGlobalFileEnabled(gm[1], body.enabled !== false); send(200, { ok: true }); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // PUT /api/global/files/:key — 保存单个全局文件
    {
      re: new RegExp('^/api/global/files/' + ID_SEG + '$'),
      m: 'PUT',
      h: (c, gm) => {
        const { send, readBody } = c;
        readBody((body) => {
          try { memory.saveGlobalFile(gm[1], body.content || ''); send(200, { ok: true }); }
          catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // DELETE /api/global/files/:key — 删除全局文件
    {
      re: new RegExp('^/api/global/files/' + ID_SEG + '$'),
      m: 'DELETE',
      h: (c, gm) => {
        const { send } = c;
        try { memory.deleteGlobalFile(gm[1]); send(200, { ok: true }); }
        catch (err) { send(500, { ok: false, err: err.message }); }
        return true;
      },
    },
  ];
};
