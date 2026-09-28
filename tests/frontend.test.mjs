// 前端纯函数测试：在真实 Chromium 里加载面板，调用 public/app.js 的函数做断言。
//
// 为什么非要走浏览器，而不是直接 import：
//   public/app.js 是原生 <script>（非 module），顶层函数靠全局作用域共享，
//   没有任何 export —— 在 Node 里 import 不进来。而项目已经依赖 Playwright
//   （lib/search.js 用它做联网搜索），复用同一套浏览器内核即可零新增依赖地
//   在真实运行时里测试这些函数。
//
// 额外收益：这套测试同时守着「面板能正常加载、app.js 顶层执行不抛错」，
//   而这正是批 4（前端模块化）最大的风险点 —— 100 处内联 onclick 全靠全局作用域活着。
//
// 运行：npm test
// 沙箱说明见 scripts/lib/sandbox.mjs（所有写操作只落在临时副本内）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  REPO_ROOT, sleep, makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox,
} from '../scripts/lib/sandbox.mjs';

// 浏览器内核装在项目内，与 lib/search.js 保持同一份配置
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ||
  path.join(REPO_ROOT, 'playwright-browsers');
// 动态 import：确保上面的环境变量在此之前已生效
const { chromium } = await import('playwright');

let sandboxDir = null;
let srv = null;
let browser = null;
let page = null;
let botId = '';
const pageErrors = [];

before(async () => {
  sandboxDir = makeSandbox();
  const info = await patchSandboxConfig(sandboxDir);
  botId = info.botId;
  srv = await startServer(sandboxDir, info.port);

  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = (typeof m.location === 'function' ? m.location() : null) || {};
    // 浏览器会自动请求 /favicon.ico，而项目本身没有提供 favicon ——
    // 这是浏览器行为、不是项目缺陷，过滤掉，免得噪音淹没真问题。
    if (loc.url && loc.url.includes('/favicon.ico')) return;
    pageErrors.push(`console.error: ${m.text()}${loc.url ? ' @ ' + loc.url : ''}`);
  });

  await page.goto(srv.base + '/', { waitUntil: 'load' });
  // app.js 执行完毕的标志：顶层函数已挂到全局（内联 onclick 依赖这一点）
  await page.waitForFunction(() => typeof window.md === 'function', null, { timeout: 15000 });
});

after(async () => {
  await browser?.close().catch(() => {});
  stopServer(srv?.child);
  await sleep(400);
  if (sandboxDir) removeSandbox(sandboxDir);
});

// ─────────────────────────────────────────────────────────────
// 加载健康度
// ─────────────────────────────────────────────────────────────

test('面板首页加载全程无 JS 运行时错误', () => {
  assert.deepEqual(pageErrors, [], '页面出现 JS 错误：\n' + pageErrors.join('\n'));
});

test('关键顶层函数已挂到全局（内联 onclick 的前提）', async () => {
  // 注意：只有 function 声明会被挂到 window 上，const/let 声明的不会。
  // 例如 const $ = (s) => document.querySelector(s); 就不在 window 上 ——
  // 所以它不能进这个清单（但它在本文件内照常可用）。
  const names = [
    'md', 'esc', 'fmtNum', 'fmtShortTs', 'api', 'toast',
    'loadMemLayers', 'renderMemDistill', 'distillFold', 'ingestMemory',
  ];
  const missing = await page.evaluate((ns) => ns.filter((n) => typeof window[n] !== 'function'), names);
  assert.deepEqual(missing, [], '以下顶层函数未挂到全局：' + missing.join(', '));
});

test('内联 onclick 引用的函数全都存在（批 4 模块化的核心约束）', async () => {
  // 前端是原生 <script>（非 module），界面里上百处 onclick="fn()" 全靠全局作用域。
  // 只要有一个被引用的函数不存在（名字拼错 / 被搬走 / 从 function 改成 const 声明），
  // 对应按钮就变成点不动的死按钮。这正是批 4「ES Modules 化」的头号风险，
  // 所以先把这条约束固化成测试 —— 拆分过程中它会立刻叫。
  const { readFileSync } = await import('node:fs');
  const names = new Set();
  for (const rel of ['public/index.html', 'public/app.js']) {
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const m of src.matchAll(/onclick="([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  }
  assert.ok(names.size > 0, '未能从源码里提取到任何 onclick 引用');

  const missing = await page.evaluate(
    (ns) => ns.filter((n) => typeof window[n] !== 'function'),
    [...names],
  );
  assert.deepEqual(
    missing, [],
    `被 onclick 引用但挂不上全局的函数共 ${missing.length} 个：${missing.join(', ')}`,
  );
});

// ─────────────────────────────────────────────────────────────
// esc()：HTML 转义 —— md() 的第一道安全防线
// ─────────────────────────────────────────────────────────────

test('esc() 转义全部 HTML 危险字符', async () => {
  const got = await page.evaluate(() => esc('<a href="x">&\''));
  assert.equal(got, '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('esc() 对 null / undefined 返回空串而非 "null"', async () => {
  const got = await page.evaluate(() => [esc(null), esc(undefined), esc(0)]);
  assert.deepEqual(got, ['', '', '0']);
});

// ─────────────────────────────────────────────────────────────
// md()：Markdown 渲染
// ─────────────────────────────────────────────────────────────

test('md() 渲染行内语法', async () => {
  const cases = [
    ['**粗体**', '<strong>粗体</strong>'],
    ['*斜体*', '<em>斜体</em>'],
    ['`code`', '<code>code</code>'],
    ['~~删除~~', '<del>删除</del>'],
  ];
  for (const [input, expected] of cases) {
    const html = await page.evaluate((s) => md(s), input);
    assert.ok(html.includes(expected), `md(${JSON.stringify(input)}) 应含 ${expected}，实际：${html}`);
  }
});

test('md() 渲染块级语法', async () => {
  const html = await page.evaluate(() => md('# 标题\n\n---\n\n- 甲\n- 乙\n\n1. 一\n\n> 引用'));
  assert.ok(html.includes('<h1>标题</h1>'), 'h1 未渲染：' + html);
  assert.ok(html.includes('<hr class="md-hr">'), 'hr 未渲染：' + html);
  assert.ok(html.includes('<ul class="md-list"><li>甲</li><li>乙</li></ul>'), 'ul 未渲染：' + html);
  assert.ok(html.includes('<ol class="md-list"><li>一</li></ol>'), 'ol 未渲染：' + html);
  assert.ok(html.includes('<blockquote class="md-quote">引用</blockquote>'), 'blockquote 未渲染：' + html);
});

test('md() 渲染表格', async () => {
  const html = await page.evaluate(() => md('| 甲 | 乙 |\n|---|---|\n| 1 | 2 |'));
  assert.ok(html.includes('<table class="md-table">'), '未产出 table：' + html);
  assert.ok(html.includes('<th>甲</th>'), '表头未渲染：' + html);
  assert.ok(html.includes('<td>1</td>'), '单元格未渲染：' + html);
});

// ── 已知问题（批 0 由测试发现，留待批 4 前端模块化时修复）──────────────
// md() 的替换链有顺序缺陷：先由 markdown 语法生成 `<a href="https://…">`，
// 紧接着的「裸 URL 自动链接」规则又在 href 属性内部匹配到同一个 URL，
// 把它二次包装成 <a>，于是产出嵌套标签；图片（src="…"）同理。
// 作者其实已经用占位符保护了数学公式（\u0001），只是链接这一环漏了 ——
// 修法是同款机制补上（\u0002）。下面两条保留「正确行为」的断言：
// 批 4 修好后它们会自己转绿，届时把 todo 摘掉即可。
test('【已知问题】md() 渲染 markdown 链接不产生嵌套标签', { todo: '待批 4 修复：给已生成的 <a>/<img> 加占位符保护' }, async () => {
  const html = await page.evaluate(() => md('[示例](https://example.com)'));
  assert.ok(html.includes('<a href="https://example.com" target="_blank" rel="noopener">示例</a>'), '链接未正确渲染：' + html);
  assert.ok(!html.includes('href="<a '), '产出嵌套 <a> 标签：' + html);
});

test('【已知问题】md() 渲染 markdown 图片不产生嵌套标签', { todo: '同上，待批 4 一并修' }, async () => {
  const html = await page.evaluate(() => md('![图](https://example.com/a.png)'));
  assert.ok(html.includes('<img class="md-img" src="https://example.com/a.png" alt="图">'), '图片未正确渲染：' + html);
  assert.ok(!html.includes('src="<a '), '产出嵌套 <a> 标签：' + html);
});

test('md() 的裸 URL 自动链接正常（不受上述问题影响）', async () => {
  const html = await page.evaluate(() => md('见 https://example.com/a 页面'));
  assert.ok(
    html.includes('<a href="https://example.com/a" target="_blank" rel="noopener">https://example.com/a</a>'),
    '裸 URL 未被自动链接：' + html,
  );
});

test('md() 代码块整体保护，内部不做行内转换', async () => {
  const html = await page.evaluate(() => md('```\n**不该变粗**\n```'));
  assert.ok(html.includes('<pre class="md-pre"><code>**不该变粗**</code></pre>'), '代码块未按原样保留：' + html);
  assert.ok(!html.includes('<strong>'), '代码块内的 ** 不应被转换成 strong：' + html);
});

test('md() 不产生 XSS：先转义再做行内替换', async () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[点我](javascript:alert(1))',
  ];
  for (const input of payloads) {
    const html = await page.evaluate((s) => md(s), input);
    assert.ok(!html.includes('<script'), `出现可执行 <script：${html}`);
    assert.ok(!html.includes('<img src=x'), `出现未转义标签：${html}`);
    assert.ok(!html.includes('href="javascript:'), `出现 javascript: 伪协议链接：${html}`);
  }
});

// ─────────────────────────────────────────────────────────────
// 数字与时间格式化
// ─────────────────────────────────────────────────────────────

test('fmtNum() 千分位格式化（含空值兜底）', async () => {
  const got = await page.evaluate(() => [fmtNum(0), fmtNum(1234567), fmtNum(null), fmtNum(undefined), fmtNum('8900')]);
  assert.deepEqual(got, ['0', '1,234,567', '0', '0', '8,900']);
});

test('fmtShortTs() 输出「月/日 时:分」且补零', async () => {
  // 用本地时区构造再解析，避免测试结果随时区漂移
  const got = await page.evaluate(() => [
    fmtShortTs(new Date(2026, 0, 5, 9, 7).getTime()),
    fmtShortTs(new Date(2026, 11, 31, 23, 59).getTime()),
  ]);
  assert.deepEqual(got, ['1/5 09:07', '12/31 23:59']);
});

// ─────────────────────────────────────────────────────────────
// 记忆层级视图渲染（dfCls 修复的回归用例）
// ─────────────────────────────────────────────────────────────

test('记忆层级视图能完整渲染（dfCls 回归）', async () => {
  const r = await page.evaluate(async (id) => {
    // 面板默认不在该视图，手工造出渲染目标容器
    for (const sel of ['#mem-layers', '#mem-distill']) {
      if (!document.querySelector(sel)) {
        const d = document.createElement('div');
        d.id = sel.slice(1);
        document.body.appendChild(d);
      }
    }
    const errs = [];
    const onErr = (e) => errs.push(String((e && e.message) || e));
    window.addEventListener('error', onErr);
    try { await loadMemLayers(id); } catch (e) { errs.push(String((e && e.message) || e)); }
    window.removeEventListener('error', onErr);

    const html = document.querySelector('#mem-distill').innerHTML;
    return {
      errs,
      len: html.length,
      hasBlock: html.includes('distill-block'),
      hasFolded: html.includes('folded'),
    };
  }, botId);

  // 修复前：dfCls 未定义 → el.innerHTML 赋值抛 ReferenceError → 视图空白
  assert.deepEqual(r.errs, [], '渲染记忆层级视图时报错：' + r.errs.join(' | '));
  assert.ok(r.len > 0, 'AI 蒸馏内容视图渲染为空');
  assert.ok(r.hasBlock, '未渲染出任何 distill-block');
  assert.ok(r.hasFolded, 'dfCls 未生效：_dfOpen 为空时初始应全部折叠');
});
