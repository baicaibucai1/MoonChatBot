// 路由正则等价性审计
//
// 用途：架构拆分期间，证明「只搬家不改逻辑」在路由匹配层成立 ——
// 把新路由表生成的正则与拆分前 server.js 里的字面量逐字符比对。
//
// 用法：
//   node scripts/regex-audit.mjs                     # 与 git HEAD 的 server.js 比对
//   node scripts/regex-audit.mjs <旧文件路径>         # 与指定快照比对
//
// 退出码：一致 0 / 有差异 1（可直接用于 CI）
//
// 注意：RegExp.prototype.source 会把 '/' 转义成 '\/'，且自带 '^' '$' 首尾锚点。
// 本脚本在两边做同样的归一化处理，因此比对是逐字符的。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// lib/http/router.js 是 CommonJS
const require = createRequire(import.meta.url);
const { createRouter } = require('../lib/http/router');

// ---- 1) 取出「旧」server.js ----
function loadOldSource() {
  const arg = process.argv[2];
  if (arg) {
    const p = path.resolve(arg);
    if (!fs.existsSync(p)) throw new Error('文件不存在: ' + p);
    return { text: fs.readFileSync(p, 'utf8'), label: p };
  }
  try {
    const text = execFileSync('git', ['show', 'HEAD:server.js'], { encoding: 'utf8' });
    return { text, label: 'git HEAD:server.js' };
  } catch (err) {
    throw new Error('无法读取 git HEAD:server.js，请改用 `node scripts/regex-audit.mjs <旧文件路径>`\n' + err.message);
  }
}

// ---- 2) 从源码文本里抽出所有 /^.../ 正则源码 ----
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

function collectOldRegexes(text) {
  const lines = text.split('\n');
  // 只扫 handleApi 区段：从函数声明到启动段
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

// ---- 3) 取新路由表生成的正则 ----
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

// ---- 主流程 ----
const { text, label } = loadOldSource();
const oldSide = collectOldRegexes(text);
const newSide = collectNewRegexes();

console.log(`旧源码: ${label}`);
if (oldSide.scanned) {
  console.log(`  handleApi 区段: 第 ${oldSide.startIdx + 1} – ${oldSide.endIdx} 行`);
} else {
  console.log('  ⚠️ 未找到 handleApi（可能已拆完），改为全文扫描');
}
console.log('');
console.log(`旧正则 ${oldSide.set.size} 条 · 新正则 ${newSide.set.size} 条 · 精确路径匹配 ${newSide.exact} 条 · 路由条目 ${newSide.total} 条`);
console.log('');

const onlyOld = [...oldSide.set].filter((s) => !newSide.set.has(s)).sort();
const onlyNew = [...newSide.set].filter((s) => !oldSide.set.has(s)).sort();

if (!onlyOld.length && !onlyNew.length) {
  console.log('✅ 正则源码集合完全一致（捕获组/锚点/字符类逐字符相同）');
  process.exit(0);
}

if (onlyOld.length) {
  console.log('⚠️ 仅存在于旧代码（新代码里没有被等价表达）:');
  onlyOld.forEach((s) => console.log('   OLD ', s));
}
if (onlyNew.length) {
  console.log('⚠️ 仅存在于新代码:');
  onlyNew.forEach((s) => console.log('   NEW ', s));
}
process.exit(1);
