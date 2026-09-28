// 沙箱公用件：把项目复制到临时目录 → 改写配置 → 起一份隔离服务。
//
// 供两个脚本共用：
//   scripts/api-baseline.mjs   接口契约快照
//   tests/frontend.test.mjs    前端纯函数测试（需要真实浏览器加载面板）
//
// 为什么需要沙箱（而不是直接起本机服务）：
//   lib/store.js 与 lib/memory.js 的路径全由 path.join(__dirname, '..') 推导，
//   所以把源码复制到临时目录后，config.json / memory/ / avatars/ 会全部落在副本内。
//   副本里的写操作（PUT /api/config、DELETE /api/memory/:id/events…）就伤不到真实数据。
//   更隐蔽的是 lib/memory.js 的 botDir() 带 fs.mkdirSync + 预设文件自创建 ——
//   哪怕只 GET 一次 /api/memory/<不存在的id>/files 也会凭空造出目录。
//
// 副本内额外做三件事，确保零外部副作用：
//   · bots[].enabled = false          → BotManager.sync() 直接 continue，不建立任何 QQ 连接
//   · bots 的 appId/appSecret 换占位符 → 万一走到发送路径，也只会认证失败
//   · 清空 models[].apiKey 且不复制 .env → 所有模型调用在「未配置 Key」处早退，不产生费用

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

// 只复制运行必需的部分；node_modules 靠 NODE_PATH 指回真身，.env 绝不复制。
// avatars/ 必须带上：config.json 里机器人的头像指向 /avatars/<file>，
// 副本缺了它前端会打出一串 404（会让「页面加载无错误」这类测试误报）。
const COPY_ENTRIES = ['server.js', 'setup.js', 'package.json', 'config.json', 'lib', 'public', 'memory', 'avatars'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 向操作系统要一个空闲端口：监听 0 让内核分配，拿到号后立刻释放。
// 不能在子进程里做 —— Windows 上管道 stdout 是异步的，子进程随即退出会丢掉输出。
export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moonchatbot-baseline-'));
  for (const entry of COPY_ENTRIES) {
    const src = path.join(REPO_ROOT, entry);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dir, entry), { recursive: true });
  }
  return dir;
}

// 改写副本 config.json：换端口、断机器人、清 Key。返回 { port, botId }
export async function patchSandboxConfig(dir) {
  const cfgPath = path.join(dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  for (const bot of cfg.bots || []) {
    bot.enabled = false;              // sync() 会直接 continue，不连 QQ
    bot.appId = '__probe_appid__';    // 万一走到发送路径，只会认证失败
    bot.appSecret = '__probe_secret__';
  }
  for (const model of cfg.models || []) {
    delete model.apiKey;              // 所有模型调用在「未配置 Key」处早退
    model.apiKeyEnv = '__PROBE_NO_SUCH_KEY__';
  }
  cfg.port = await pickFreePort();
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  const botId = (cfg.bots || [])[0]?.id;
  if (!botId) throw new Error('config.json 里没有机器人，无法确定 :id 探针参数');
  return { port: cfg.port, botId };
}

export async function startServer(dir, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...process.env, NODE_PATH: path.join(REPO_ROOT, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`沙箱服务启动即退出（code=${child.exitCode}）：\n${log.slice(0, 3000)}`);
    }
    try {
      const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { child, base, getLog: () => log };
    } catch { /* 未就绪，继续轮询 */ }
    await sleep(200);
  }
  child.kill();
  throw new Error(`沙箱服务 20s 内未就绪：\n${log.slice(0, 3000)}`);
}

export function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
}

export function removeSandbox(dir) {
  // 只删自己刚创建的临时目录：路径必须同时满足「在 os.tmpdir() 内」且「带本前缀」
  const tmp = os.tmpdir();
  const safe = path.resolve(dir).startsWith(path.resolve(tmp)) && path.basename(dir).startsWith('moonchatbot-baseline-');
  if (!safe) {
    console.warn(`⚠️ 沙箱路径未通过安全校验，不删除：${dir}`);
    return;
  }
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { sleepSync(300); }
  }
  console.warn(`⚠️ 沙箱目录删除失败（可手动清理）：${dir}`);
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  // Atomics.wait 是同步阻塞的标准做法，避免为几次重试引入异步复杂度
  const sab = new SharedArrayBuffer(4);
  while (Date.now() < end) Atomics.wait(new Int32Array(sab), 0, 0, Math.min(ms, 100));
}
