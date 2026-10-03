// 配置存储：config.json 读写 + .env 解析
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const ENV_FILE = path.join(ROOT, '.env');

// 解析 .env（简单实现，够用即可）
function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !m[1].startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { port: 4357, bots: [], models: [] };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// 从配置项解析出实际凭据（支持 env: 前缀引用）
function resolveSecret(value, env) {
  if (!value) return null;
  if (typeof value === 'string' && value.startsWith('env:')) {
    return env[value.slice(4)] ?? null;
  }
  return String(value);
}

module.exports = { getConfig, saveConfig, loadEnv, resolveSecret };