// ③ 世界卡：纯逻辑单测（写手提议 → 用户确认 → 追加进 world.md）
// ------------------------------------------------------------------
// 隔离手法与 tests/threads.test.mjs 一致：把 lib/memory.js 复制进临时目录，
// 副本里的 __dirname 就把 MEMORY_DIR 指到「临时目录/memory」，真实数据零接触。
//
// 为什么要测：
//   世界卡是**追加式流水**（和经历一样），不是整份覆盖。写手提议的「世界被改成了什么样」
//   一旦被整份覆盖写进去，用户手写的「世界设定」底稿就没了。这条边界必须有断言守着。
// ------------------------------------------------------------------
import { test, after } from 'node:test';
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

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonchatbot-worldcard-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  for (const f of ['ids.js', 'memory.js']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'lib', f), path.join(dir, 'lib', f));
  }
  fs.cpSync(path.join(REPO_ROOT, 'lib', 'memory'), path.join(dir, 'lib', 'memory'), { recursive: true });
  return dir;
}

const loadMemory = (dir) => require(path.join(dir, 'lib', 'memory.js'));
const DONE = [];
const withMem = (fn) => {
  const dir = makeSandbox();
  DONE.push(dir);
  return fn(loadMemory(dir), dir);
};
// 全部用例跑完再清临时目录（node:test 并发跑，不能在单个用例里删）
after(() => {
  for (const d of DONE) fs.rmSync(d, { recursive: true, force: true });
});

// ---------- 记忆文件体系：六段式 ----------

test('★ 预设记忆文件含 ② 标准要求 与 ③ 世界卡', () => {
  withMem((memory) => {
    const keys = memory.FILE_TYPES.map((f) => f.key);
    assert.ok(keys.includes('standards'), '缺 standards：计数器与输出头尾没地方放');
    assert.ok(keys.includes('world'), '缺 world：世界卡没地方放');
    // ★ 顺序即写手组成：写手设定 → 标准要求 → 世界卡
    assert.ok(keys.indexOf('persona') < keys.indexOf('standards'));
    assert.ok(keys.indexOf('standards') < keys.indexOf('world'));
  });
});

test('★ 旧预设 key 一个都不能丢（key 是磁盘文件名，改名会让历史文件失联）', () => {
  withMem((memory) => {
    const keys = memory.FILE_TYPES.map((f) => f.key);
    for (const k of ['persona', 'plot', 'content', 'traits']) {
      assert.ok(keys.includes(k), `丢了历史 key：${k}`);
    }
  });
});

test('标准要求模板自带「输出头尾」与「计数器」两个小节', () => {
  withMem((memory) => {
    const t = memory.FILE_TYPES.find((f) => f.key === 'standards');
    assert.ok(t && /输出头尾/.test(t.desc), '描述要讲清它管什么');
    const dir = memory.memoryDir(BOT);
    const txt = fs.readFileSync(path.join(dir, 'standards.md'), 'utf8');
    assert.ok(/##\s*输出头尾/.test(txt), '模板要带输出头尾小节（否则用户不知道往哪写）');
    assert.ok(/##\s*计数器/.test(txt), '模板要带计数器小节');
  });
});

test('世界卡模板自带「世界设定」与「世界的改变」两个小节', () => {
  withMem((memory) => {
    const dir = memory.memoryDir(BOT);
    const txt = fs.readFileSync(path.join(dir, 'world.md'), 'utf8');
    assert.ok(/##\s*世界设定/.test(txt));
    assert.ok(/##\s*世界的改变/.test(txt));
  });
});

// ---------- 世界卡解析 ----------

test('parseWorldCard：只有设定、没有改变 → changes 为空数组', () => {
  withMem((memory) => {
    const r = memory.parseWorldCard('# 世界卡\n\n## 世界设定\n- 架空古代\n\n## 世界的改变\n');
    assert.equal(r.changes.length, 0);
    assert.ok(r.setting.includes('架空古代'));
  });
});

test('parseWorldCard：认出条目 id / 正文 / 提议者', () => {
  withMem((memory) => {
    const r = memory.parseWorldCard(
      '# 世界卡\n\n## 世界的改变\n- [2026/10/5 10:00] 渡口木桥被烧毁　— 探针写手 <!--WCabc123-->\n',
    );
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].id, 'WCabc123');
    assert.equal(r.changes[0].text, '渡口木桥被烧毁');
    assert.equal(r.changes[0].by, '探针写手');
  });
});

test('parseWorldCard：小节里的说明文字不算记录', () => {
  withMem((memory) => {
    const r = memory.parseWorldCard(
      '## 世界的改变\n（写手提议 → 你点确认 → 追加到这里）\n- [x] 真正的记录 <!--WC1-->\n',
    );
    assert.equal(r.changes.length, 1, '括号里的说明不能被当成一条改变');
  });
});

// ---------- 世界改变：追加 ----------

test('★ appendWorldChange：追加一条，且**不动**世界设定底稿', () => {
  withMem((memory) => {
    memory.saveMemoryFile(BOT, 'world',
      '# 世界卡\n\n## 世界设定\n- 架空古代，三城并立\n\n## 世界的改变\n');
    const r = memory.appendWorldChange(BOT, { text: '北城易主', by: '探针写手' });
    assert.ok(r.ok);
    const txt = memory.readMemoryFile(BOT, 'world');
    assert.ok(txt.includes('架空古代，三城并立'), '底稿必须原样保留');
    assert.ok(txt.includes('北城易主'));
    assert.ok(txt.includes('探针写手'), '要能看出是谁提议的');
    assert.ok(txt.includes(r.entry.id), '行尾要带 id 标记，否则删不掉单条');
  });
});

test('★ appendWorldChange：连续追加是**累积**，不是覆盖', () => {
  withMem((memory) => {
    memory.saveMemoryFile(BOT, 'world', '# 世界卡\n\n## 世界的改变\n');
    memory.appendWorldChange(BOT, { text: '第一条' });
    memory.appendWorldChange(BOT, { text: '第二条' });
    const { changes } = memory.parseWorldCard(memory.readMemoryFile(BOT, 'world'));
    assert.equal(changes.length, 2);
    assert.equal(changes[0].text, '第一条');
    assert.equal(changes[1].text, '第二条');
  });
});

test('appendWorldChange：没有「世界的改变」小节时自动补上（老世界卡不炸）', () => {
  withMem((memory) => {
    memory.saveMemoryFile(BOT, 'world', '# 世界卡\n\n## 世界设定\n- 只有设定\n');
    const r = memory.appendWorldChange(BOT, { text: '桥断了' });
    assert.ok(r.ok);
    const { changes } = memory.parseWorldCard(memory.readMemoryFile(BOT, 'world'));
    assert.equal(changes.length, 1);
    assert.ok(memory.readMemoryFile(BOT, 'world').includes('只有设定'), '原设定还得在');
  });
});

test('appendWorldChange：空内容拒绝写入', () => {
  withMem((memory) => {
    assert.equal(memory.appendWorldChange(BOT, { text: '   ' }).ok, false);
    assert.equal(memory.appendWorldChange(BOT, {}).ok, false);
  });
});

// ---------- 世界改变：删除 ----------

test('removeWorldChange：按 id 删掉一条，其它条不受影响', () => {
  withMem((memory) => {
    memory.saveMemoryFile(BOT, 'world', '# 世界卡\n\n## 世界的改变\n');
    const a = memory.appendWorldChange(BOT, { text: '留着' });
    const b = memory.appendWorldChange(BOT, { text: '删掉' });
    assert.ok(memory.removeWorldChange(BOT, b.entry.id).ok);
    const { changes } = memory.parseWorldCard(memory.readMemoryFile(BOT, 'world'));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, a.entry.id);
  });
});

test('removeWorldChange：id 找不到 → 报失败而不是静默', () => {
  withMem((memory) => {
    memory.saveMemoryFile(BOT, 'world', '# 世界卡\n\n## 世界的改变\n');
    assert.equal(memory.removeWorldChange(BOT, 'WC不存在').ok, false);
    assert.equal(memory.removeWorldChange(BOT, '').ok, false);
  });
});
