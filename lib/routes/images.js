// 图床路由：/api/images —— 上传 / 列表 / 删除
//
// 图床在这个项目里解决三件事：
//   1. 角色图（形象）有地方放 —— 角色卡是纯文本，图片只以 URL 挂在 avatar 上；
//   2. 场景图、素材等「其他图」共用同一个地方，不必为每种用途各开一个目录；
//   3. 删图时知道**谁在用**，不会把角色卡上的形象删成死链。
//
// ★ 图片一律落磁盘 images/，config.json 里只存相对 URL（/images/xxx.png）。
//   两条硬理由：
//   · config.json 是**整份覆盖写**的，把 base64 塞进去会让每次保存配置都变慢；
//   · 角色卡的 history 版本档是按「可编辑字段」快照的（见 lib/characters.js 的
//     snapshot），图片数据量不该被快照进去，否则 MAX_HISTORY=20 会被几张图撑爆，
//     回滚也就跟着失去意义。
//
// ★ 与 avatars/ 的分工：avatars/ 是**写手**头像（沿用旧接口），images/ 是图床。
//   两个目录分开，以后按用途清理/备份互不牵连。
'use strict';

// 单图上限 5MB：base64 后约 6.7MB，仍低于 context.js 的 8MB 请求体上限
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// ★ 刻意不支持 svg：image/svg+xml 在同源下可内联执行脚本，是现成的 XSS 载体。
//   要支持图标请转成 png/webp 再传。
const SNIFF_EXTS = ['png', 'jpg', 'gif', 'webp', 'avif'];

// ---- 按文件头认类型 ----
// ★ 不信任前端给的 ext：只按声明的扩展名存盘，等于允许把 HTML/脚本存成 .png。
//   这里自己读一遍魔数，认不出来就拒；认出来的结果**覆盖**前端给的 ext。
function sniff(buf) {
  if (buf.length < 12) return '';
  const s = (a, b) => buf.toString('latin1', a, b);
  if (buf[0] === 0x89 && s(1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (s(0, 4) === 'GIF8') return 'gif';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  // AVIF / HEIF 系：第 4~8 字节是 ftyp，后面跟主品牌
  if (s(4, 8) === 'ftyp' && /^(avif|avis|mif1)/.test(s(8, 12))) return 'avif';
  return '';
}

// ---- 读尺寸（只给图库网格显示用，读不出来就返回 null，不影响存盘）----
// 只读前 64KB：EXIF 很大的 jpg 可能扫不到 SOF，那种情况显示「-」即可，
// 不值得为此把整个 5MB 文件读进内存。
function dims(buf, ext) {
  try {
    if (ext === 'png' && buf.length >= 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (ext === 'gif' && buf.length >= 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (ext === 'jpg') {
      // 逐段跳过 APPn / 注释，找到 SOFn 才有尺寸
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        // SOF0~SOF15，排除 DHT(0xC4)/JPG(0xC8)/DAC(0xCC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) break;
        i += 2 + len;
      }
      return null;
    }
    if (ext === 'webp' && buf.length >= 30) {
      const fourcc = buf.toString('latin1', 12, 16);
      if (fourcc === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fourcc === 'VP8X') {
        return { w: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, h: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
      }
    }
  } catch { /* 尺寸是锦上添花，读不出来就算了 */ }
  return null;
}

// 文件名基干：保留中英文/数字/下划线/连字符，其余折叠成 '-'
function safeBase(s) {
  const b = String(s || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return b || 'img';
}

// 谁在用这张图（删图前的引用检查）
function refsOf(cfg, url) {
  const out = [];
  for (const b of cfg.bots || []) {
    if (String(b.avatar || '') === url) out.push({ kind: 'bot', id: b.id, name: b.name || b.id });
  }
  for (const p of cfg.characterPools || []) {
    for (const ch of p.characters || []) {
      if (String(ch.avatar || '') === url) {
        out.push({ kind: 'char', id: ch.id, name: ch.name || ch.id, pool: p.name || p.id });
      }
    }
  }
  return out;
}

module.exports = function (deps) {
  const { fs, path, app, IMAGE_DIR } = deps;
  const isImageName = (n) => /\.(png|jpe?g|gif|webp|avif)$/i.test(n);

  function uniqueName(base, ext) {
    let fname = `${base}-${Date.now()}.${ext}`;
    if (fs.existsSync(path.join(IMAGE_DIR, fname))) {
      fname = `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    }
    return fname;
  }

  return [
    // ---- 列表 ----
    {
      exact: '/api/images',
      m: 'GET',
      h: (c) => {
        const { send } = c;
        const cfg = app.getConfig();
        let names = [];
        try {
          names = fs.readdirSync(IMAGE_DIR).filter((n) => isImageName(n));
        } catch { names = []; }
        const items = [];
        for (const name of names) {
          const full = path.join(IMAGE_DIR, name);
          let st = null;
          try { st = fs.statSync(full); } catch { continue; }
          if (!st.isFile()) continue;
          const ext = (name.split('.').pop() || '').toLowerCase();
          const url = '/images/' + name;
          let w = null, h = null;
          const head = Buffer.alloc(65536);
          try {
            const fd = fs.openSync(full, 'r');
            const got = fs.readSync(fd, head, 0, head.length, 0);
            fs.closeSync(fd);
            const d = dims(head.slice(0, got), ext === 'jpeg' ? 'jpg' : ext);
            if (d) { w = d.w; h = d.h; }
          } catch { /* 忽略：尺寸读不出来就留空 */ }
          items.push({
            name, url, ext,
            size: st.size,
            mtime: st.mtimeMs || (st.mtime ? st.mtime.getTime() : 0),
            w, h,
            refs: refsOf(cfg, url),
          });
        }
        // 新的在前：刚传完的那张要一眼看见，而不是翻到最后
        items.sort((a, b) => b.mtime - a.mtime);
        send(200, { ok: true, items });
      },
    },

    // ---- 上传 ----
    {
      exact: '/api/images',
      m: 'POST',
      h: (c) => {
        const { send, readBody } = c;
        readBody((body) => {
          try {
            const data = String(body.data || '');
            if (!data) return send(400, { ok: false, err: '图片数据为空' });
            const buf = Buffer.from(data, 'base64');
            if (!buf.length) return send(400, { ok: false, err: '图片数据为空或不是合法 base64' });
            if (buf.length > MAX_IMAGE_BYTES) {
              return send(400, { ok: false, err: `图片过大（${(buf.length / 1048576).toFixed(1)}MB，上限 5MB）` });
            }
            const real = sniff(buf);
            if (!real) {
              return send(400, { ok: false, err: '不是能识别的图片（支持 png / jpg / gif / webp / avif）' });
            }
            const fname = uniqueName(safeBase(body.name), real);
            fs.writeFileSync(path.join(IMAGE_DIR, fname), buf);
            const d = dims(buf, real);
            console.log(`[api] 图床已保存: ${fname}（${(buf.length / 1024).toFixed(0)}KB）`);
            send(200, {
              ok: true,
              image: {
                name: fname, url: '/images/' + fname, ext: real, size: buf.length,
                w: d ? d.w : null, h: d ? d.h : null,
                mtime: Date.now(), refs: [],
              },
            });
          } catch (err) { send(500, { ok: false, err: err.message }); }
        });
        return true;
      },
    },

    // ---- 删除 ----
    // 被引用时默认拒绝（409 + refs），前端拿 refs 提示用户；确认后带 ?force=1 再删。
    // ★ 为什么不做「自动从角色卡上摘掉」：那是改数据，不是删文件，
    //   静默改会让用户的角色形象莫名消失；交给用户点一次确认更稳。
    {
      re: /^\/api\/images\/([^/]+)$/,
      m: 'DELETE',
      h: (c, m) => {
        const { send } = c;
        let name = '';
        try { name = decodeURIComponent(m[1]); } catch { name = m[1]; }
        if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
          return send(400, { ok: false, err: '文件名不合法' });
        }
        const full = path.join(IMAGE_DIR, path.basename(name));
        if (!full.startsWith(IMAGE_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return send(404, { ok: false, err: '图片不存在' });
        }
        let force = false;
        try { force = new URL(c.req.url, 'http://127.0.0.1').searchParams.get('force') === '1'; } catch { force = false; }
        const refs = refsOf(app.getConfig(), '/images/' + name);
        if (refs.length && !force) {
          return send(409, { ok: false, err: `还有 ${refs.length} 处在用这张图`, refs });
        }
        try { fs.unlinkSync(full); } catch (err) { return send(500, { ok: false, err: err.message }); }
        send(200, { ok: true, name, refs });
      },
    },
  ];
};
