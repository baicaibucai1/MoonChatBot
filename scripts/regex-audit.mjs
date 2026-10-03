// 路由正则等价性审计
//
// 用途：证明「历史路由正则没有被丢失或改写」。多线程改造 C1 起会**有意新增**路由，
// 所以判据不是「两侧集合相等」，而是「老正则是否仍被等价表达」。
//
// 用法：
//   node scripts/regex-audit.mjs                        # 与历史快照比对（默认，不需要 git）
//   node scripts/regex-audit.mjs --write-snapshot <文件> # 从某份 server.js 重建历史快照
//   node scripts/regex-audit.mjs <文件>                  # 与指定 server.js 快照临时比对
//   node scripts/regex-audit.mjs ... --strict            # 任何差异（含新增）都算失败
//
// 退出码：
//   0  老正则全部被等价表达（新增路由不算失败，见下）
//   1  有「旧有新无」——某条老正则在新路由表里丢失或被改写，这是回归信号
//   2  历史快照缺失 / 传入的旧源码里找不到可比的 handleApi 区段
//
// 为什么不直接比对 git HEAD:server.js：
//   拆分完成后 HEAD 里的 server.js 已经不含 handleApi，拿它当「旧版」毫无意义；
//   而且本机沙箱里 spawn git 会 EBUSY。改成把拆分前的正则固化成
//   scripts/regex-baseline.json，比对自此与 git 无关、完全可复现。
//
// 为什么不再把「新增」算作失败：
//   批 1 是纯搬家，当时任何差异都等于出错，所以两侧集合必须完全相等。
//   但从 C1 起会**有意新增**接口，继续用「集合相等」当判据，只会逼人每次去改断言。
//   真正危险的只有一个方向：**丢掉或改写老正则**。所以默认只对 onlyOld 报错，
//   onlyNew 明确列出来给人看；要严格相等就加 --strict。
//
// 注意：RegExp.prototype.source 会把 '/' 转义成 '\/'，且自带 '^' '$' 首尾锚点。
// 两侧做同样的归一化处理，因此比对是逐字符的。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// lib/http/router.js 是 CommonJS
const require = createRequire(import.meta.url);
const { createRouter } = require('../lib/http/router');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(HERE, 'regex-baseline.json');

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const WRITE_SNAPSHOT = argv.includes('--write-snapshot');
const FILE_ARG = argv.find((a) => !a.startsWith('--'));

// ---- 1) 从源码文本里抽出所有 /^.../ 正则源码 ----
// 返回值从 '^' 开始，与 RegExp.prototype.source 的形态一致
function extractRegexSources(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const s = line.indexOf('/^', i);
    if (s < 0) break;
    const j = s + 1;          // 指向 '^'
    let k = j + 1;
    let inClass = false;
    while (k < line.length) {
      const c = line[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      k++;
    }
    out.push(line.slice(j, k));
    i = k + 1;
  }
  return out;
}

// 只扫 handleApi 区段：从函数声明到启动段。区域外（如静态资源处理）不参与比对。
function collectFromServerSource(text) {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) => l.startsWith('function handleApi(req, res, p) {'));
  const endIdx = lines.findIndex((l) => l.startsWith('const cfg = store.getConfig();'));
  const region = lines.slice(startIdx < 0 ? 0 : startIdx, endIdx < 0 ? lines.length : endIdx);

  const set = new Set();
  for (const line of region) {
    if (!/\.exec\(p\)|p\.match\(/.test(line)) continue;
    for (const src of extractRegexSources(line)) {
      // 归一化掉转义斜杠再判断，因为两边都把 '/' 写作 '\/'
      if (src.replace(/\\\//g, '/').includes('/api/')) set.add(src);
    }
  }
  return { set, startIdx, endIdx, scanned: startIdx >= 0 };
}

// ---- 2) 取新路由表生成的正则 ----
function collectNewRegexes() {
  // 建路由表只需要能解构出一堆函数的桩，handler 不会被执行
  const deps = new Proxy({}, { get: () => () => ({}) });
  const router = createRouter(deps);
  const set = new Set();
  let exact = 0;
  for (const r of router.routes) {
    if (r.exact !== undefined) { exact++; continue; }
    set.add(r.re.source);
  }
  return { set, exact, total: router.routes.length };
}

// ---- 3) 取历史正则集合 ----
function loadOldSide() {
  if (FILE_ARG) {
    const p = path.resolve(FILE_ARG);
    if (!fs.existsSync(p)) throw new Error('文件不存在: ' + p);
    const parsed = collectFromServerSource(fs.readFileSync(p, 'utf8'));
    return { ...parsed, label: p, fromFile: true };
  }
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    throw new Error('缺少历史正则快照: ' + SNAPSHOT_FILE
      + '\n  重建方式：git show <拆分前的提交>:server.js > old.js && node scripts/regex-audit.mjs --write-snapshot old.js');
  }
  const j = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  return {
    set: new Set(j.patterns || []),
    label: 'scripts/regex-baseline.json（历史正则快照）',
    snapshot: j,
    scanned: true,
    startIdx: -1,
    endIdx: -1,
  };
}

// ---- 主流程 ----
const oldSide = loadOldSide();

// 重建快照模式：把某份 server.js 的历史正则固化下来，不参与比对
if (WRITE_SNAPSHOT) {
  if (!FILE_ARG) throw new Error('--write-snapshot 需要指定 server.js 路径');
  if (oldSide.set.size === 0) {
    console.error('✗ 该文件里没有可比对的路由正则（未找到 handleApi 区段）。');
    process.exit(2);
  }
  const payload = {
    note: '拆分前 server.js 的 handleApi 区段里出现过的 /api/ 路由正则（归一化后）。'
      + '由 scripts/regex-audit.mjs --write-snapshot 生成，供路由等价性回归比对。',
    source: FILE_ARG,
    generatedAt: new Date().toISOString(),
    count: oldSide.set.size,
    patterns: [...oldSide.set].sort(),
  };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`✅ 历史正则快照已写入：${path.relative(process.cwd(), SNAPSHOT_FILE)}（${payload.count} 条）`);
  process.exit(0);
}

const newSide = collectNewRegexes();

console.log(`旧侧: ${oldSide.label}`);
if (oldSide.fromFile) {
  if (oldSide.scanned) console.log(`  handleApi 区段: 第 ${oldSide.startIdx + 1} – ${oldSide.endIdx} 行`);
  else console.log('  ⚠️ 未找到 handleApi，改为全文扫描');
} else if (oldSide.snapshot) {
  console.log(`  快照取自: ${oldSide.snapshot.source} @ ${oldSide.snapshot.generatedAt}`);
}
console.log('');
console.log(`旧正则 ${oldSide.set.size} 条 · 新正则 ${newSide.set.size} 条 · 精确路径匹配 ${newSide.exact} 条 · 路由条目 ${newSide.total} 条`);
console.log('');

if (oldSide.set.size === 0) {
  console.error('✗ 旧源码里没有可比对的路由正则（未找到 handleApi 区段）。');
  console.error('  请传入**拆分前**的 server.js 快照，例如：');
  console.error('    git show <拆分前的提交>:server.js > old-server.js');
  console.error('    node scripts/regex-audit.mjs old-server.js');
  process.exit(2);
}

const onlyOld = [...oldSide.set].filter((s) => !newSide.set.has(s)).sort();
const onlyNew = [...newSide.set].filter((s) => !oldSide.set.has(s)).sort();

if (!onlyOld.length && !onlyNew.length) {
  console.log(`✅ 正则源码集合完全一致（${newSide.set.size} 条，捕获组/锚点/字符类逐字符相同）`);
  process.exit(0);
}

if (onlyOld.length) {
  console.error(`✗ 有 ${onlyOld.length} 条老正则在新路由表里找不到等价表达（回归信号）:`);
  onlyOld.forEach((s) => console.error('   OLD ', s));
}

if (onlyNew.length) {
  const out = STRICT ? console.error : console.log;
  out(`${STRICT ? '✗' : 'ℹ'} 新路由表多出 ${onlyNew.length} 条（老源码里没有，即新增接口）:`);
  onlyNew.forEach((s) => out('   NEW ', s));
}

if (onlyOld.length) {
  console.error('\n✗ 审计未通过：有老正则丢失或被改写。');
  process.exit(1);
}

if (onlyNew.length && STRICT) {
  console.error('\n✗ --strict 模式下不允许任何新增。');
  process.exit(1);
}

console.log(`\n✅ 老正则 ${oldSide.set.size} 条全部被等价表达；另有 ${onlyNew.length} 条为有意新增的接口。`);
process.exit(0);
