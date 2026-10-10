// 图床后端验证（跑在沙箱副本里，不碰正在运行的面板）
// 覆盖：列表 → 上传 → 静态访问 → 伪图片拦截 → 引用保护 → 强制删除
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox } from './lib/sandbox.mjs';

let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { pass++; console.log('  ok   -', n, e); } else { fail++; console.log('  FAIL -', n, e); } };

// 1×1 PNG
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC';

const dir = makeSandbox();
const { port, botId } = await patchSandboxConfig(dir);
const { child, base } = await startServer(dir, port);

const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const del = async (p) => (await fetch(base + p, { method: 'DELETE' })).json();

try {
  console.log('== 列表（初始应为空）==');
  let list = await get('/api/images');
  ok(list.ok && Array.isArray(list.items), 'GET /api/images 返回 items', `${(list.items || []).length} 张`);

  console.log('\n== 上传 ==');
  const up = await post('/api/images', { name: '测试 图.png', data: PNG1 });
  ok(up.ok === true, '上传成功', up.err || '');
  const img = up.image || {};
  ok(/^\/images\/.+\.png$/.test(img.url || ''), '返回 /images/ 开头的 URL', img.url);
  ok(img.ext === 'png', '类型按文件头认成 png（不是信前端给的）', 'ext=' + img.ext);
  ok(img.w === 1 && img.h === 1, '读出尺寸 1×1', `${img.w}×${img.h}`);
  // 文件名基干里中文应保留、空格应折叠
  ok(/测试/.test(img.name), '文件名保留中文基干', img.name);

  console.log('\n== 静态访问 ==');
  const raw = await fetch(base + img.url);
  const buf = Buffer.from(await raw.arrayBuffer());
  ok(raw.status === 200, 'GET ' + img.url + ' 返回 200', String(raw.status));
  ok(raw.headers.get('content-type') === 'image/png', 'Content-Type 正确', raw.headers.get('content-type'));
  ok(buf.length === img.size, '下载字节数与上传一致', `${buf.length}`);

  console.log('\n== 路径穿越与其它防护 ==');
  const bad1 = await post('/api/images', { name: 'x.png', data: Buffer.from('<html><script>alert(1)</script></html>').toString('base64') });
  ok(bad1.ok === false, 'HTML 冒充 png 被拒（按魔数识别）', bad1.err);
  const bad2 = await post('/api/images', { name: 'x.png', data: '' });
  ok(bad2.ok === false, '空数据被拒', bad2.err);
  const bad3 = await post('/api/images', { name: 'x.png', data: '这不是base64!!!' });
  ok(bad3.ok === false, '非法 base64 被拒', bad3.err);
  const trav = await fetch(base + '/images/..%2f..%2fconfig.json');
  ok(trav.status === 404 || trav.status === 403, '路径穿越取不到 config.json', String(trav.status));

  console.log('\n== 列表回来有它 ==');
  list = await get('/api/images');
  const found = (list.items || []).find((x) => x.name === img.name);
  ok(!!found, '列表里能找到刚传的图');
  ok(found && found.refs.length === 0, '此时没有被引用', found ? `refs=${found.refs.length}` : '');

  console.log('\n== 引用保护：先挂到角色卡上 ==');
  const chars = await get('/api/characters');
  const ch = (chars.characters || [])[0];
  if (!ch) { console.log('  (沙箱没有角色，跳过引用检查)'); }
  else {
    const put = await fetch(base + '/api/characters/' + encodeURIComponent(ch.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ch.name, persona: ch.persona || '', avatar: img.url, tags: ch.tags || [] }),
    }).then((r) => r.json());
    ok(put.ok === true, '角色 avatar 写成图床 URL', put.err || '');
    list = await get('/api/images');
    const f2 = (list.items || []).find((x) => x.name === img.name);
    ok(f2 && f2.refs.length === 1 && f2.refs[0].kind === 'char', '列表里显示被 1 处引用', f2 ? JSON.stringify(f2.refs[0]) : '');

    const noForce = await del('/api/images/' + encodeURIComponent(img.name));
    ok(noForce.ok === false, '未加 force 时拒绝删除（409）', noForce.err);
    ok(Array.isArray(noForce.refs) && noForce.refs.length === 1, '拒绝时带上 refs 供前端提示');

    const forced = await del('/api/images/' + encodeURIComponent(img.name) + '?force=1');
    ok(forced.ok === true, 'force=1 时允许删除', forced.err || '');
    const gone = await fetch(base + img.url);
    ok(gone.status === 404, '删完再访问是 404', String(gone.status));
  }
} finally {
  await stopServer(child);
  await removeSandbox(dir);
}
console.log(fail ? `\n✗ ${fail} 项失败（${pass} 项通过）` : `\n✓ 全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
