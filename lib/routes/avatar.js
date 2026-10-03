// 头像上传路由：POST /api/upload-avatar
'use strict';
const { ID_RE } = require('../ids');

module.exports = function (deps) {
  const { fs, path, AVATAR_DIR } = deps;

  return [
    {
      exact: '/api/upload-avatar',
      m: 'POST',
      h: (c) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const botId = String(body.botId || '');
            if (!ID_RE.test(botId)) return send(400, { ok: false, err: '无效的 botId' });
            const ext = String(body.ext || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return send(400, { ok: false, err: '不支持的图片格式' });
            const data = String(body.data || '');
            if (data.length > 4_000_000) return send(400, { ok: false, err: '图片过大（限制约 3MB）' });
            const buf = Buffer.from(data, 'base64');
            if (!buf.length) return send(400, { ok: false, err: '图片数据为空' });
            const fname = `${botId}-${Date.now()}.${ext}`;
            fs.writeFileSync(path.join(AVATAR_DIR, fname), buf);
            console.log(`[api] 头像已保存: ${fname}`);
            send(200, { ok: true, url: '/avatars/' + fname });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },
  ];
};
