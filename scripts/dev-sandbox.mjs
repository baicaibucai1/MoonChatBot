#!/usr/bin/env node
// 可运行的本地实例 —— 起一份能真实点击、且模型真的能对话的面板。
//
// 两种模式：
//   默认（推荐）  模型可用 + QQ 断开
//                 用沙箱副本起服务，config 里的模型 Key 原样保留，
//                 所以面板里的「直接对话」「AI 助手」「模型测试」全都真的能通；
//                 机器人保持 enabled=false，不会连接你的 QQ。
//                 public/ 与 memory/ 是完整副本，界面与数据展示和真身一致。
//
//   --with-qq     完全真身模式：机器人也启用，会真连 QQ、真的收发消息。
//
// 用法：
//   npm run dev:sandbox                    # 模型可用，QQ 断开
//   npm run dev:sandbox -- --with-qq       # 连 QQ
//   npm run dev:sandbox -- --no-model      # 连模型调用也禁掉（纯界面，零费用）
//   npm run dev:sandbox -- --port 4399     # 指定端口
//
// 退出：Ctrl+C（自动停服务并清理临时目录）

import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT, makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox,
} from './lib/sandbox.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const portArgIdx = argv.indexOf('--port');
const wantPort = portArgIdx >= 0 ? Number(argv[portArgIdx + 1]) : 0;

const withQQ = has('--with-qq');
const keepModelKeys = !has('--no-model') && !withQQ;   // --with-qq 时配置原样，Key 自然保留
const enableBots = withQQ;

const STATUS_FILE = path.join(REPO_ROOT, '.workbuddy', 'dev-sandbox.json');

let sandboxDir = null;
let child = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  stopServer(child);
  if (sandboxDir) removeSandbox(sandboxDir);
  try { fs.rmSync(STATUS_FILE, { force: true }); } catch { /* 忽略 */ }
}

process.on('SIGINT', () => { cleanup(); console.log('\n已停止，临时目录已清理。'); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

console.log('正在创建沙箱副本…');
sandboxDir = makeSandbox();

const patched = await patchSandboxConfig(sandboxDir, { keepModelKeys, enableBots });

let port = patched.port;
if (wantPort) {
  const cfgPath = path.join(sandboxDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.port = wantPort;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  port = wantPort;
}

console.log('正在启动服务…');
const started = await startServer(sandboxDir, port);
child = started.child;
const base = started.base;

fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
fs.writeFileSync(STATUS_FILE, JSON.stringify({
  pid: process.pid,
  childPid: child.pid,
  port,
  base,
  botId: patched.botId,
  mode: withQQ ? 'with-qq' : keepModelKeys ? 'model-on' : 'ui-only',
  sandboxDir,
  startedAt: new Date().toISOString(),
}, null, 2), 'utf8');

const line = '='.repeat(58);
console.log('');
console.log(line);
console.log('  MoonChatBot —— 本地实例已启动');
console.log(line);
console.log(`  面板地址   ${base}`);
console.log(`  运行模式   ${withQQ ? '真身：连 QQ + 模型可用' : keepModelKeys ? '模型可用 · QQ 断开' : '纯界面：模型与 QQ 都断开'}`);
console.log(`  沙箱目录   ${sandboxDir}`);
console.log('');
if (withQQ) {
  console.log('  ⚠️ 真身模式：机器人已启用，会真实连接 QQ 并收发消息');
} else {
  console.log('  与真身的差异：机器人 enabled=false，不连接任何 QQ');
  console.log('  其余（界面 / 记忆数据 / 模型调用）均为真实可用');
}
if (!withQQ && !keepModelKeys) console.log('  模型 Key 已清空：不会产生任何模型费用');
console.log('');
console.log('  想跑完全真身（含 QQ）请另开终端： npm start');
console.log('  按 Ctrl+C 停止并清理');
console.log(line);

child.on('exit', (code) => {
  console.log(`\n服务进程已退出（code=${code}）`);
  cleanup();
  process.exit(code ?? 0);
});
