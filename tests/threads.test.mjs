// 对话线程层单测（多线程改造 C1）
// ------------------------------------------------------------------
// 隔离手法：线程模块的 MEMORY_DIR 由 path.join(__dirname, '..', '..') 推导，
// 所以只把 lib/ids.js 与 lib/memory/threads.js 复制进临时目录，
// 副本里的 __dirname 就把 MEMORY_DIR 指到「临时目录/memory」，真实数据零接触。
//
// 反例数据是刻意设计的：branches 里的消息时间戳**晚于**主会话 ——
// 这正是「按 updatedAt 取最大会把分支误判成默认线程」那个坑的复现条件。
// ------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const BOT = 'BOT1';

// ---------- 最小沙箱 ----------

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonchatbot-threads-'));
  fs.mkdirSync(path.join(dir, 'lib', 'memory'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'lib', 'ids.js'), path.join(dir, 'lib', 'ids.js'));
  fs.copyFileSync(path.join(REPO_ROOT, 'lib', 'memory', 'threads.js'), path.join(dir, 'lib', 'memory', 'threads.js'));
  return dir;
}

function loadThreads(dir) {
  return require(path.join(dir, 'lib', 'memory', 'threads.js'));
}

function botPath(dir, ...rest) {
  return path.join(dir, 'memory', BOT, ...rest);
}

function writeJsonl(file, msgs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
}

// 老结构：主会话 4 条（ts 1000..1003）+ 两个分支文件（ts 2000+ / 3000+，都晚于主会话）
const MAIN = [
  { role: 'user', content: '你还记得上次说到哪儿了吗', ts: 1000 },
  { role: 'assistant', content: '记得，说到出发前收拾行李。', ts: 1001 },
  { role: 'user', content: '那我们继续', ts: 1002 },
  { role: 'assistant', content: '好。', ts: 1003 },
];
const BRANCH_A = [
  { role: 'user', content: '换个走向试试', ts: 2000 },
  { role: 'assistant', content: '那就换个方向。', ts: 2001 },
];
const BRANCH_B = [
  { role: 'user', content: '切分支时的备份内容', ts: 3000 },
];

function seedLegacy(dir) {
  writeJsonl(botPath(dir, 'sessions.jsonl'), MAIN);
  writeJsonl(botPath(dir, 'branches', '1002.jsonl'), BRANCH_A);
  writeJsonl(botPath(dir, 'branches', 'main-1003.jsonl'), BRANCH_B);
}

function withSandbox(fn) {
  const dir = makeSandbox();
  try { return fn(dir, loadThreads(dir)); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } }
}

// ---------- 迁移 ----------

test('迁移：sessions.jsonl 与 branches 全部提升为线程，消息零丢失', () => {
  withSandbox((dir, threads) => {
    seedLegacy(dir);
    const r = threads.migrateIfNeeded(BOT);
    assert.equal(r.migrated, true);
    assert.equal(r.threads, 3, '主会话 1 条 + 分支 2 条 = 3 条线程');

    const list = threads.listThreads(BOT);
    assert.equal(list.length, 3);

    const total = list.reduce((a, t) => a + t.msgCount, 0);
    assert.equal(total, MAIN.length + BRANCH_A.length + BRANCH_B.length, '消息总条数不变');

    // 每条 ts 都要能在迁移后的线程里找到
    const allTs = new Set();
    for (const t of list) for (const m of threads.readThreadMessages(BOT, t.id)) allTs.add(m.ts);
    for (const m of [...MAIN, ...BRANCH_A, ...BRANCH_B]) assert.ok(allTs.has(m.ts), `ts ${m.ts} 丢失`);
  });
});

test('迁移：老文件不被删除，可原路回溯', () => {
  withSandbox((dir, threads) => {
    seedLegacy(dir);
    threads.migrateIfNeeded(BOT);
    assert.ok(fs.existsSync(botPath(dir, 'sessions.jsonl')), 'sessions.jsonl 应保留');
    assert.ok(fs.existsSync(botPath(dir, 'branches', '1002.jsonl')), '分支文件应保留');
    assert.ok(fs.existsSync(botPath(dir, 'branches', 'main-1003.jsonl')), '切分支备份应保留');
  });
});

test('迁移：幂等 —— 第二次调用不重写索引', () => {
  withSandbox((dir, threads) => {
    seedLegacy(dir);
    threads.migrateIfNeeded(BOT);
    const idxFile = botPath(dir, 'threads', 'index.json');
    const first = fs.readFileSync(idxFile, 'utf8');
    const mtime1 = fs.statSync(idxFile).mtimeMs;

    const r2 = threads.migrateIfNeeded(BOT);
    assert.equal(r2.migrated, false);
    assert.equal(r2.reason, 'index-exists');

    assert.equal(fs.readFileSync(idxFile, 'utf8'), first, '索引内容不应变化');
    assert.equal(fs.statSync(idxFile).mtimeMs, mtime1, '索引不应被重写');
    assert.equal(threads.listThreads(BOT).length, 3, '线程数不应翻倍');
  });
});

test('★ 迁移：默认线程是原主会话，不是时间戳更晚的分支', () => {
  withSandbox((dir, threads) => {
    seedLegacy(dir);
    threads.migrateIfNeeded(BOT);

    const defId = threads.getDefaultThreadId(BOT);
    const def = threads.getThread(BOT, defId);
    assert.equal(def.origin, 'migrated', '默认线程必须是 origin=migrated 的原主会话');
    assert.equal(def.msgCount, MAIN.length);

    // 反证：分支 B 的 updatedAt 更大，若靠 updatedAt 排序就会选错
    const byUpdated = threads.listThreads(BOT)[0];
    assert.ok(byUpdated.updatedAt > def.updatedAt, '分支时间戳确实更晚（这正是要防的坑）');
    assert.notEqual(byUpdated.id, defId, '默认线程不能等于 updatedAt 最大的那条');
  });
});

test('迁移：没有可迁移数据时不留痕（不凭空造目录）', () => {
  withSandbox((dir, threads) => {
    const r = threads.migrateIfNeeded(BOT);
    assert.equal(r.migrated, false);
    assert.equal(r.reason, 'nothing-to-migrate');
    assert.ok(!fs.existsSync(botPath(dir, 'threads')), '没有数据就不该建 threads/ 目录');
    assert.deepEqual(threads.listThreads(BOT), []);
  });
});

// ---------- 线程隔离 ----------

test('线程隔离：两条线程的消息互不串线', () => {
  withSandbox((dir, threads) => {
    const a = threads.createThread(BOT, { title: '线程A' });
    const b = threads.createThread(BOT, { title: '线程B' });
    threads.appendMessage(BOT, a.id, 'user', 'A 的第一句');
    threads.appendMessage(BOT, b.id, 'user', 'B 的第一句');
    threads.appendMessage(BOT, a.id, 'assistant', 'A 的回复');

    const am = threads.readThreadMessages(BOT, a.id).map((m) => m.content);
    const bm = threads.readThreadMessages(BOT, b.id).map((m) => m.content);
    assert.deepEqual(am, ['A 的第一句', 'A 的回复']);
    assert.deepEqual(bm, ['B 的第一句']);
  });
});

test('跨线程归并：readAllRecent 按 ts 升序返回全部线程', () => {
  withSandbox((dir, threads) => {
    const a = threads.createThread(BOT, { title: 'A' });
    const b = threads.createThread(BOT, { title: 'B' });
    threads.appendMessage(BOT, a.id, 'user', 'A1');
    threads.appendMessage(BOT, b.id, 'user', 'B1');
    threads.appendMessage(BOT, a.id, 'user', 'A2');

    const merged = threads.readAllRecent(BOT, 0);
    assert.equal(merged.length, 3);
    for (let i = 1; i < merged.length; i++) assert.ok(merged[i].ts > merged[i - 1].ts, 'ts 必须严格升序');
    assert.deepEqual(merged.map((m) => m.content), ['A1', 'B1', 'A2']);

    assert.deepEqual(threads.readAllRecent(BOT, 2).map((m) => m.content), ['B1', 'A2'], 'limit 取尾部');
  });
});

test('ts 取号：跨线程全局唯一且严格递增', () => {
  withSandbox((dir, threads) => {
    const a = threads.createThread(BOT, { title: 'A' });
    const b = threads.createThread(BOT, { title: 'B' });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(threads.appendMessage(BOT, a.id, 'user', 'x'));
      seen.push(threads.appendMessage(BOT, b.id, 'user', 'y'));
    }
    assert.equal(new Set(seen).size, seen.length, 'ts 不得重复');
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], 'ts 必须递增');
  });
});

test('默认线程跟随「最近说话的线程」', () => {
  withSandbox((dir, threads) => {
    const a = threads.createThread(BOT, { title: 'A' });
    threads.createThread(BOT, { title: 'B' });      // 新建 B → B 成为当前
    assert.notEqual(threads.getDefaultThreadId(BOT), a.id);
    threads.appendMessage(BOT, a.id, 'user', '回到 A 说话');
    assert.equal(threads.getDefaultThreadId(BOT), a.id, '在 A 说话后当前线程应切回 A');
  });
});

test('删掉当前线程后，默认线程能自动回退而不是悬空', () => {
  withSandbox((dir, threads) => {
    const a = threads.createThread(BOT, { title: 'A' });
    const b = threads.createThread(BOT, { title: 'B' });
    threads.appendMessage(BOT, b.id, 'user', '写一句');
    assert.equal(threads.getDefaultThreadId(BOT), b.id);
    threads.deleteThread(BOT, b.id);
    const def = threads.getDefaultThreadId(BOT);
    assert.equal(def, a.id, '应回退到剩下那条');
    assert.ok(threads.getThread(BOT, def));
  });
});

// ---------- fork：非破坏性派生 ----------

test('★ fork 为非破坏性派生：原线程一条都不动', () => {
  withSandbox((dir, threads) => {
    const src = threads.createThread(BOT, { title: '原线程' });
    for (let i = 1; i <= 4; i++) threads.appendMessage(BOT, src.id, i % 2 ? 'user' : 'assistant', 'msg' + i);

    const msgs = threads.readThreadMessages(BOT, src.id);
    const cutTs = msgs[1].ts;
    const r = threads.forkThread(BOT, cutTs, { sourceTid: src.id });

    assert.equal(r.ok, true);
    assert.equal(r.copied, 2, '新线程 = 分叉点及其之前，共 2 条');
    assert.equal(r.source, src.id);

    // 原线程完好 —— 旧 forkSession 会把它截断到 2 条
    const after = threads.readThreadMessages(BOT, src.id);
    assert.equal(after.length, 4, '原线程必须仍是 4 条');

    const forked = threads.readThreadMessages(BOT, r.threadId).map((m) => m.content);
    assert.deepEqual(forked, ['msg1', 'msg2']);
  });
});

test('fork：分叉点不存在时返回 not-found（兼容基线的错误文案）', () => {
  withSandbox((dir, threads) => {
    const src = threads.createThread(BOT, { title: 'A' });
    threads.appendMessage(BOT, src.id, 'user', 'x');
    const r = threads.forkThread(BOT, 9999999999, { sourceTid: src.id });
    assert.equal(r.ok, false);
    assert.equal(r.err, '分叉点未找到');
  });
});

// ---------- 删除与老接口兼容 ----------

test('按 ts 删除：跨线程定位，只删命中那一条', () => {
  withSandbox((dir, threads) => {
    const a = threads.createThread(BOT, { title: 'A' });
    const b = threads.createThread(BOT, { title: 'B' });
    const tsA = threads.appendMessage(BOT, a.id, 'user', 'A1');
    const tsB = threads.appendMessage(BOT, b.id, 'user', 'B1');

    assert.equal(threads.deleteMessageByTs(BOT, tsB), true);
    assert.equal(threads.readThreadMessages(BOT, b.id).length, 0, 'B 被删空');
    assert.equal(threads.readThreadMessages(BOT, a.id).length, 1, 'A 不受影响');
    assert.equal(threads.deleteMessageByTs(BOT, tsA), true);
    assert.equal(threads.deleteMessageByTs(BOT, tsA), false, '重复删除应返回 false');
  });
});

test('归档分支仍可只读列出（老 /branches 接口的形状不变）', () => {
  withSandbox((dir, threads) => {
    seedLegacy(dir);
    threads.migrateIfNeeded(BOT);
    const branches = threads.listBranchFiles(BOT);
    assert.equal(branches.length, 2);
    for (const b of branches) {
      assert.equal(typeof b.fromTs, 'number');
      assert.equal(typeof b.count, 'number');
      assert.equal(typeof b.ts, 'number');
    }
    assert.deepEqual(Object.keys(branches[0]).sort(), ['count', 'fromTs', 'ts']);
  });
});

test('恢复归档分支：变成一条可继续对话的线程，而不是写回 sessions.jsonl', () => {
  withSandbox((dir, threads) => {
    seedLegacy(dir);
    threads.migrateIfNeeded(BOT);
    const r = threads.restoreBranchAsThread(BOT, 1002);
    assert.equal(r.ok, true);
    assert.equal(r.restoredFrom, 1002);
    assert.equal(r.count, BRANCH_A.length);
    assert.deepEqual(threads.readThreadMessages(BOT, r.threadId).map((m) => m.content), BRANCH_A.map((m) => m.content));

    assert.equal(threads.restoreBranchAsThread(BOT, 9999999999).err, '分支不存在');
  });
});

test('非法 id 被拦下（路径穿越防护）', () => {
  withSandbox((dir, threads) => {
    assert.throws(() => threads.listThreads('../evil'), /非法角色 id/);
    assert.throws(() => threads.listThreads('a/b'), /非法角色 id/);
    assert.throws(() => threads.readThreadMessages(BOT, 'abc'), /非法线程 id/);
    assert.throws(() => threads.readThreadMessages(BOT, '../1'), /非法线程 id/);
  });
});
