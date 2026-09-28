// 路由层纯函数测试
//
// 批 0 时「路由参数提取」无法测试 —— 那时 43 条路由全挤在 server.js 的
// handleApi 里，而 server.js 一被 import 就会 listen 端口、连 QQ、起心跳。
// 拆出 lib/http/router.js 后，路由表可以在零副作用的前提下被直接断言。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRouter } = require('../lib/http/router');

/** 只够把路由表建起来的最小依赖：所有函数位一律返回空对象。 */
function buildRouter(bots = []) {
  const appStub = {
    env: {},
    getConfig: () => ({ bots: bots.map((id) => ({ id })), models: [] }),
    saveConfig() {},
    bots: { getStatus: () => null, sync() {}, start() {}, stop() {}, send: async () => {} },
  };
  const memoryStub = new Proxy({}, { get: () => () => ({}) });
  const deps = new Proxy({}, {
    get(_t, k) {
      if (k === 'app') return appStub;
      if (k === 'memory') return memoryStub;
      return () => ({});
    },
  });
  return createRouter(deps);
}

/**
 * 把正则源码里的 `\/` 还原成 `/` 再断言。
 * RegExp.prototype.source 会把斜杠转义成 `\/`（便于重新包成字面量），
 * 不还原的话测试里写 `/\/files\/order$/` 是匹配不上的。
 */
const clean = (entry) => entry.re.source.replace(/\\\//g, '/');

function fakeReq(method = 'GET') {
  return { method, headers: {}, on() {} };
}

function fakeRes() {
  const r = { code: null, headers: null, raw: null, body: null };
  r.writeHead = (c, h) => { r.code = c; r.headers = h; };
  r.setHeader = () => {};
  r.end = (b) => {
    r.raw = b ?? null;
    try { r.body = b ? JSON.parse(b) : null; } catch { r.body = null; }
  };
  return r;
}

let router;
before(() => { router = buildRouter(); });

describe('路由表结构', () => {
  test('条目总数稳定在 51（批 1 的 45 条 + 多线程 C1 的 6 条线程路由）', () => {
    assert.equal(router.routes.length, 51);
  });

  test('每条路由只声明 exact 或 re 之一，且方法字段合法', () => {
    for (const r of router.routes) {
      const hasExact = r.exact !== undefined;
      const hasRe = r.re instanceof RegExp;
      assert.ok(hasExact !== hasRe, `条目应恰好声明 exact 或 re 之一: ${JSON.stringify(Object.keys(r))}`);
      assert.equal(typeof r.h, 'function');
      if (r.m !== null) {
        const allow = Array.isArray(r.m) ? r.m : [r.m];
        for (const mth of allow) {
          assert.ok(['GET', 'POST', 'PUT', 'DELETE'].includes(mth), `未知方法: ${mth}`);
        }
      }
    }
  });

  test('不存在「方法 + 匹配条件」完全重复的条目（会互相遮蔽）', () => {
    const seen = new Set();
    for (const r of router.routes) {
      const key = (r.exact !== undefined ? 'E:' + r.exact : 'R:' + r.re.source)
        + '|' + (Array.isArray(r.m) ? r.m.join(',') : r.m);
      assert.ok(!seen.has(key), `重复条目: ${key}`);
      seen.add(key);
    }
  });

  test('memory 域保持「先具体后通配」的顺序（否则 order/tier 会被当成文件名）', () => {
    const idx = (pred) => router.routes.findIndex(pred);
    // 用字符串判断而不是正则：正则源码里自带 '^' 与 '$' 字面字符，再套一层正则会非常难读
    const iOrder = idx((r) => r.re && clean(r).endsWith('/files/order$'));
    const iTier = idx((r) => r.re && clean(r).endsWith('/tier$'));
    // 通配条目：memory 域的 /files/:key ——以 ')$' 结尾，且路径里只到 /files/ 一层
    const iWild = idx((r) => {
      if (!r.re) return false;
      const s = clean(r);
      if (!s.startsWith('^/api/memory/')) return false;
      if (!s.endsWith(')$')) return false;
      if (!s.includes('/files/(')) return false;
      return !/tier|order|enabled|desc/.test(s);
    });
    assert.ok(iOrder >= 0, '应存在 /files/order 条目');
    assert.ok(iTier >= 0, '应存在 /files/:key/tier 条目');
    assert.ok(iWild >= 0, '应存在 /files/:key 通配条目');
    assert.ok(iOrder < iWild, `/files/order 必须排在 /files/:key 之前（当前 ${iOrder} vs ${iWild}）`);
    assert.ok(iTier < iWild, `/files/:key/tier 必须排在 /files/:key 之前（当前 ${iTier} vs ${iWild}）`);
  });

  test('threads 域同样守「先具体后通配」：/threads/:tid/fork 必须排在 /threads/:tid 之前', () => {
    const idx = (pred) => router.routes.findIndex(pred);
    const iFork = idx((r) => r.re && clean(r).endsWith(String.raw`/threads/(\d{1,20})/fork$`));
    const iOne = idx((r) => r.re && clean(r).endsWith(String.raw`/threads/(\d{1,20})$`));
    const iList = idx((r) => r.re && clean(r).endsWith('/threads$'));
    assert.ok(iFork >= 0, '应存在 /threads/:tid/fork 条目');
    assert.ok(iOne >= 0, '应存在 /threads/:tid 条目');
    assert.ok(iList >= 0, '应存在 /threads 列表条目');
    assert.ok(iFork < iOne, `/threads/:tid/fork 必须排在 /threads/:tid 之前（当前 ${iFork} vs ${iOne}）`);
  });
});

describe('参数提取', () => {
  test('PUT /api/memory/:id/files/order 命中 order 条目而非通配条目', () => {
    const e = router.matchEntry('PUT', '/api/memory/BOT1/files/order');
    assert.ok(e && e.re, '应命中正则条目');
    assert.match(clean(e), /\/files\/order\$/, `实际命中: ${clean(e)}`);
  });

  test('中文 ID 与文件名能正确提取', () => {
    const e = router.matchEntry('PUT', '/api/memory/测试机器人/files/人设/tier');
    assert.ok(e && e.re, '应命中 tier 条目');
    const m = e.re.exec('/api/memory/测试机器人/files/人设/tier');
    assert.equal(m[1], '测试机器人');
    assert.equal(m[2], '人设');
  });

  test('时间戳段只接受 10–17 位数字', () => {
    assert.ok(router.matchEntry('DELETE', '/api/memory/BOT1/events/1758000000000'));
    assert.equal(router.matchEntry('DELETE', '/api/memory/BOT1/events/abc'), null);
  });

  test('PUT /api/memory/:id/files/desc 命中通配条目（/desc 是两段后缀，与原实现一致）', () => {
    const e = router.matchEntry('PUT', '/api/memory/BOT1/files/desc');
    assert.ok(e && e.re, '应命中条目');
    const m = e.re.exec('/api/memory/BOT1/files/desc');
    assert.equal(m[2], 'desc', '此时 desc 被当作文件名，这是原有语义');
  });

  test('非法路径段（含点/斜杠）不会被通配条目吞掉', () => {
    assert.equal(router.matchEntry('GET', '/api/memory/a.b/files'), null);
    assert.equal(router.matchEntry('GET', '/api/memory/a/b/files'), null);
  });

  test('线程路由：:id 与 :tid 能分别提取，非数字 tid 不命中', () => {
    const e = router.matchEntry('PUT', '/api/memory/BOT1/threads/1759000000000');
    assert.ok(e && e.re, '应命中线程重命名条目');
    const m = e.re.exec('/api/memory/BOT1/threads/1759000000000');
    assert.equal(m[1], 'BOT1');
    assert.equal(m[2], '1759000000000');

    assert.ok(router.matchEntry('POST', '/api/memory/BOT1/threads/1759000000000/fork'), '应命中 fork 条目');
    assert.equal(router.matchEntry('PUT', '/api/memory/BOT1/threads/abc'), null, 'tid 非数字应落空');
    assert.equal(router.matchEntry('PUT', '/api/memory/BOT1/threads/a.b'), null);
  });
});

describe('分发与兜底', () => {
  test('未知路径落到 404「接口不存在」', () => {
    const res = fakeRes();
    router.handle(fakeReq('GET'), res, '/api/__totally_nonexistent__');
    assert.equal(res.code, 404);
    assert.equal(res.body.ok, false);
    assert.match(res.body.err, /接口不存在/);
  });

  test('/api/state 不限方法：GET 与 POST 都会命中同一条目', () => {
    for (const mth of ['GET', 'POST']) {
      const e = router.matchEntry(mth, '/api/state');
      assert.ok(e, `${mth} /api/state 应命中`);
      assert.equal(e.exact, '/api/state');
    }
  });

  test('moments 先做实体校验：未知 id 在任何方法下都报「机器人不存在」', () => {
    // 与原实现一致：机器人存在性检查在方法分派之前
    for (const mth of ['GET', 'POST', 'DELETE']) {
      const res = fakeRes();
      router.handle(fakeReq(mth), res, '/api/moments/anybot');
      assert.equal(res.code, 404, `${mth} 应 404`);
      assert.equal(res.body.err, '机器人不存在: anybot', `${mth} 错误信息应一致`);
    }
  });

  test('moments 方法不是 POST/DELETE 时继续下探到 404「接口不存在」', () => {
    const r = buildRouter(['known']);
    const res = fakeRes();
    r.handle(fakeReq('GET'), res, '/api/moments/known');
    assert.equal(res.code, 404);
    assert.match(res.body.err, /接口不存在/);
  });
});
