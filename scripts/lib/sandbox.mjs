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
//
// opts.keepModelKeys
//   默认 false —— 清空所有模型 Key。api-baseline.mjs 与 frontend.test.mjs 依赖这个默认值：
//     基线要求可复现（真跑模型会因网络抖动产生不稳定响应），测试要求零费用。
//   置 true 时保留内联 Key，模型可真实调用。仅供 dev-sandbox.mjs 起「能对话的实例」用。
//
// opts.enableBots
//   默认 false —— 机器人全部禁用，不建立任何 QQ 连接。
export async function patchSandboxConfig(dir, opts = {}) {
  const { keepModelKeys = false, enableBots = false } = opts;
  const cfgPath = path.join(dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  // ★★ 沙箱恒用固定 fixture（2026-10-05 改）：不管真实 config.json 里有没有写手/角色，
  //   一律整段替换成探针数据。
  //   为什么不再「只在为空时才补」：config.json 是**运行时数据**，用户随时会在面板里
  //   新建写手（比如 ARC1）。一旦有真实写手，探针就按 bots[0] 取到它 —— 而它不带
  //   heartbeats / activeCharacterIds 这些可选字段，于是：
  //     ① api-baseline 报「消失 N 项」的假偏差（shape 契约被真实数据污染）；
  //     ② verify-* 脚本硬编码的 BOT1 / 探针写手 全部落空，静默跑在错误的对象上。
  //   沙箱的语义本来就是「可复现的隔离环境」，恒用 fixture 才是对的；真实 config 绝不改动。
  //   ★ 字段必须对齐 api-baseline.json 里 entry:cors-allowed 记录的完整 shape，
  //     否则基线会报「消失 N 项」的假偏差（shape 是结构性契约，缺字段就算变更）。
  {
    // ★ 数组字段都放至少一个元素：shape 是「结构性契约」，空数组会让
    //   heartbeats[].* / moments[].* / activeCharacterIds[] 这些内层字段整批消失，
    //   基线就会报「消失 N 项」的假偏差（内容本身是假的，只有形状有意义）。
    cfg.bots = [{
      id: 'BOT1', name: '探针写手', kind: 'writer',
      modelId: (cfg.models || [])[0]?.id || '',
      enabled: false, sandbox: false, personaFile: 'persona', avatar: '',
      useGlobal: false, webSearch: false, searchMode: 'auto',
      historyLimit: 10, intents: ['probe-intent'],
      activeCharacterIds: ['CHRprobe0001'],
      // 绑定的角色池（多池架构）：形状上必须有这个字段，否则基线会报「消失 N 项」
      poolIds: [],
      // 「上一轮由池带来」的 id 账本：解绑时靠它分清哪些是池给的、哪些是手点的
      poolCharacterIds: [],
      moments: [{ title: '探针时刻', quote: '一句台词', summary: '一段摘要' }],
      heartbeats: [{
        enabled: false, mode: 'random', tone: 'natural', prompt: '探针心跳',
        intervalMin: 60, minMin: 30, maxMin: 120,
        tasks: [{ time: '09:00', prompt: '探针任务' }],
      }],
    }];
  }
  {
    cfg.characters = [{
      id: 'CHRprobe0001', ts: 1700000000000, name: '探针角色',
      persona: '沙箱探针用的角色设定。', traits: '沉稳', age: '18',
      appearance: '黑发', background: '来历不明', tags: ['探针'], avatar: '',
      source: 'probe',
      // history 也要有元素（含 by/ts + 全字段快照），否则内层字段整批消失
      history: [{
        by: 'user', ts: 1700000000000, name: '探针角色', persona: '沙箱探针用的角色设定。',
        traits: '沉稳', age: '18', appearance: '黑发', background: '来历不明', tags: ['探针'], avatar: '',
      }],
    }];
  }

  for (const bot of cfg.bots || []) {
    if (enableBots) continue;         // 保留原样（会真连 QQ）
    bot.enabled = false;              // sync() 会直接 continue，不连 QQ
    bot.appId = '__probe_appid__';    // 万一走到发送路径，只会认证失败
    bot.appSecret = '__probe_secret__';
  }
  for (const model of cfg.models || []) {
    if (keepModelKeys) continue;      // 保留 Key，模型可真实调用
    delete model.apiKey;              // 所有模型调用在「未配置 Key」处早退
    model.apiKeyEnv = '__PROBE_NO_SUCH_KEY__';
  }
  cfg.port = await pickFreePort();
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  const botId = (cfg.bots || [])[0]?.id;
  if (!botId) throw new Error('config.json 里没有机器人，无法确定 :id 探针参数');

  // ★ 种一份可复现的运行时数据（只写副本）：会话 / 分支 / 管理员会话 / 用量日志。
  //   不种的话这些接口返回空数组 → shape 缩水 → 基线会报「消失 N 项」的假偏差，
  //   而且回归价值随之降低（空数组测不出字段结构）。
  seedRuntimeData(dir, cfg.bots[0]);
  return { port: cfg.port, botId };
}

// 在沙箱副本内种入固定运行时数据。全部是「只有形状有意义」的假数据。
function seedRuntimeData(dir, bot) {
  const memo = path.join(dir, 'memory');
  const botDir = path.join(memo, bot.id);
  fs.mkdirSync(botDir, { recursive: true });

  // 主会话：threads.migrateIfNeeded() 首次读到 sessions.jsonl 会自动搬成默认线程，
  // 所以这里只写「旧格式」，迁移逻辑由被测代码自己跑 —— 顺带测到迁移路径。
  const seedMsgs = [
    { role: 'user', content: '你好，介绍一下你自己。', ts: 1700000000000 },
    { role: 'assistant', content: '我是沙箱探针写手。', ts: 1700000001000 },
  ];
  fs.writeFileSync(path.join(botDir, 'sessions.jsonl'),
    seedMsgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');

  // 经历事件流（api:mem-layers 里 state.events[] 的形状来源）
  fs.writeFileSync(path.join(botDir, 'events.jsonl'),
    JSON.stringify({ ts: 1700000001000, actors: ['探针角色'], event: '探针事件', emotion: '平静', importance: 3, source: 'auto' }) + '\n', 'utf8');

  // 人格核心卡（api:mem-layers 里 state.core 的形状来源；不种就是 null，shape 会缩水）
  fs.writeFileSync(path.join(botDir, 'persona_core.json'), JSON.stringify({
    ts: 1700000000000, manual: false, seedHash: 'probe-seed-hash',
    core: {
      identity: '沙箱探针写手', tone: '平稳', relationship_state: '初次见面',
      boundaries: '仅用于探针', evolved_notes: '无',
    },
  }, null, 2) + '\n', 'utf8');

  // 归档分支（api:mem-branches 的形状来源）
  const branchesDir = path.join(botDir, 'branches');
  fs.mkdirSync(branchesDir, { recursive: true });
  fs.writeFileSync(path.join(branchesDir, '1700000002000.jsonl'),
    JSON.stringify({ role: 'assistant', content: '分支内容。', ts: 1700000002000 }) + '\n', 'utf8');

  // 管理员会话（api:admin-sessions 的形状来源）
  const adminDir = path.join(memo, 'admin');
  fs.mkdirSync(adminDir, { recursive: true });
  const adminMsgs = [
    { id: 'probe', ts: 1700000010000, role: 'user', content: '帮我看看面板状态。' },
    { id: 'probe', ts: 1700000011000, role: 'assistant', content: '面板一切正常。' },
  ];
  fs.writeFileSync(path.join(adminDir, 'sessions.jsonl'),
    adminMsgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');

  // 用量日志（api:usage 的形状来源）
  const usage = [
    { ts: 1700000001000, botId: bot.id, modelId: bot.modelId || 'probe-model', promptTokens: 100, completionTokens: 50, totalTokens: 150, ok: true },
  ];
  fs.writeFileSync(path.join(memo, 'usage.jsonl'),
    usage.map((u) => JSON.stringify(u)).join('\n') + '\n', 'utf8');
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
