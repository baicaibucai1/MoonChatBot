// 全量测试：一条命令跑完「单元 + 契约 + 端到端」全部门禁。
//
// 为什么要这个脚本：2026-10-08 的全量跑测抓到 4 个脚本因为「顶层 cfg.characters
// 退役」而静默失效 —— 它们不在平时那两条 pool 探针的覆盖里，所以一直是绿的假象。
// 只要跑测范围靠人记，就一定会有漏掉的入口，这个脚本把范围写死在代码里。
//
//   npm run test:all
//
// 组成：
//   ① 4 个 npm 门禁（串行）
//   ② 自带沙箱的 verify-*.mjs（并行 4；沙箱内部用 pickFreePort() 自选端口，互不撞）
//   ③ 需要外部服务的探针（真实出网的 net-reach；需在跑副本服务的 characters-ui）
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONCURRENCY = 4;
const TIMEOUT_MS = 240000;

const GATES = [
  { name: 'npm test（单元/集成）', cmd: 'npm', args: ['test'] },
  { name: 'npm run lint', cmd: 'npm', args: ['run', 'lint'] },
  { name: 'npm run baseline:check（接口契约）', cmd: 'npm', args: ['run', 'baseline:check'] },
  { name: 'npm run audit:regex（正则审计）', cmd: 'npm', args: ['run', 'audit:regex'] },
];

// 自带沙箱（makeSandbox）的端到端探针：可以并行，跑完自己清理临时目录
const SANDBOX_SCRIPTS = [
  'verify-pools.mjs', 'verify-pools-ui.mjs',
  'verify-writer-basics.mjs', 'verify-writer-pool.mjs',
  'verify-admin-characters.mjs', 'verify-admin-stream.mjs',
  'verify-char-template.mjs', 'verify-char-plaintext.mjs', 'verify-character-edit.mjs',
  'verify-composer.mjs', 'verify-counter-spec.mjs', 'verify-experience.mjs',
  'verify-progress.mjs', 'verify-selfcheck.mjs', 'verify-world-caps.mjs',
];

function run(name, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: REPO, shell: true, env: { ...process.env, ...opts.env } });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, opts.timeout || TIMEOUT_MS);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, code: killed ? -2 : code, out, err, ms: Date.now() - t0, killed });
    });
  });
}

// 从输出里挑一条最能说明结论的行
function highlight(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (
    [...lines].reverse().find((l) => /^(结果：|✅ 全部|✗ |FAIL|# pass|# fail|✖ )/.test(l)) ||
    [...lines].reverse().find((l) => /(全部通过|逐条对齐|全部被等价表达|problems)/.test(l)) ||
    lines[lines.length - 1] || ''
  ).slice(0, 110);
}

function failLines(out, err) {
  return `${out}\n${err}`
    .split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /(✗|✘|FAIL|not ok|Error:|AssertionError|无法|失败)/.test(l))
    .slice(0, 4);
}

const mark = (code) => (code === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m');
const report = (r) => {
  console.log(`  ${mark(r.code)} ${r.name}  (${(r.ms / 1000).toFixed(1)}s)  ${highlight(r.out)}`);
  if (r.code === 0) return;
  for (const f of failLines(r.out, r.err)) console.log(`      ↳ ${f}`);
  // ★ 失败时把输出尾巴整段打出来。上面那组关键字匹配经常抓不到真正的死因 ——
  //   进程中途崩掉时，「最后一行」很可能只是一句普普通通的 ✅，
  //   只按关键字找失败行会得到一片空白，然后只能靠人再跑一遍才看得到原因。
  const tail = r.out.split(/\r?\n/).filter((l) => l.trim()).slice(-14);
  for (const l of tail) console.log(`      │ ${l.trim().slice(0, 150)}`);
  if (r.err.trim()) {
    for (const l of r.err.split(/\r?\n/).filter((l) => l.trim()).slice(-6)) {
      console.log(`      ! ${l.trim().slice(0, 150)}`);
    }
  }
};

async function pool(items, worker, limit) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
      report(results[idx]);
    }
  }));
  return results;
}

function httpGet(port, p) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, timeout: 2000 }, (x) => {
      x.resume();
      x.on('end', () => res(x.statusCode));
    });
    r.on('error', () => res(0));
    r.on('timeout', () => { r.destroy(); res(0); });
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
console.log('\n════════ 全量测试开始 ════════\n');

console.log('【第一组】npm 门禁\n');
const gateResults = [];
for (const g of GATES) {
  const r = await run(g.name, g.cmd, g.args);
  gateResults.push(r);
  report(r);
}

console.log(`\n【第二组】自带沙箱的端到端探针（并行 ${CONCURRENCY}）\n`);
const scriptResults = await pool(SANDBOX_SCRIPTS, (s) => run(`node scripts/${s}`, 'node', [`scripts/${s}`]), CONCURRENCY);

console.log('\n【第三组】需要外部服务的探针\n');

// 真实出网探测（只列模型 /v1/models，零计费）。网络本身不可用时算环境问题，不算回归。
const netReach = await run('node scripts/verify-net-reach.mjs', 'node', ['scripts/verify-net-reach.mjs']);
report(netReach);

// 这个探针要一台在跑的副本服务（默认 4358）—— 现起一台，跑完杀掉。
let charUi = { name: 'node scripts/verify-characters-ui.mjs', code: -1, out: '', err: '', ms: 0 };
{
  const PORT = 4358;
  const srv = spawn('node', ['scripts/dev-sandbox.mjs', '--port', String(PORT)], {
    cwd: REPO, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if ((await httpGet(PORT, '/api/state')) === 200) { ready = true; break; }
    await sleep(500);
  }
  if (ready) {
    charUi = await run('node scripts/verify-characters-ui.mjs', 'node', ['scripts/verify-characters-ui.mjs'], {
      env: { SHOT_BASE: `http://127.0.0.1:${PORT}` },
    });
  } else {
    charUi.err = `端口 ${PORT} 上的副本服务 20s 内未就绪`;
  }
  srv.kill('SIGKILL');
  report(charUi);
}

const all = [...gateResults, ...scriptResults, netReach, charUi];
const failed = all.filter((r) => r.code !== 0);

console.log('\n════════ 汇总 ════════');
console.log(`  总入口：${all.length}　通过：${all.length - failed.length}　失败：${failed.length}`);
console.log(`  耗时：${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (failed.length) {
  console.log('\n  未通过：');
  for (const f of failed) console.log(`    · ${f.name} (exit ${f.code}${f.killed ? ', 超时' : ''})`);
}
console.log(failed.length ? '\n❌ 存在未通过项\n' : '\n✅ 全量测试全部通过\n');
process.exit(failed.length ? 1 : 0);
