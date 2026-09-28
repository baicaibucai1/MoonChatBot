// MoonChatBot - one-shot setup
// 1) copies example configs to real ones when missing (never overwrites)
// 2) verifies Node.js / deps are ready
// Usage: node setup.js   (also wired to `npm run setup`)
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const ok = (msg) => console.log('  \u2713 ' + msg);
const info = (msg) => console.log('  ' + msg);
const warn = (msg) => console.log('  ! ' + msg);

function copyIfMissing(src, dst, label) {
  const from = path.join(root, src);
  const to = path.join(root, dst);
  if (fs.existsSync(to)) { info(`[keep]   ${label} already exists -> ${dst} (left untouched)`); return false; }
  if (!fs.existsSync(from)) { warn(`${src} missing, skip ${dst}`); return false; }
  fs.copyFileSync(from, to);
  ok(`${label} created -> ${dst}  (please fill in your credentials)`);
  return true;
}

console.log('');
console.log('== MoonChatBot · one-shot setup ==');
console.log('');

// 0) Node version sanity
const [major] = (process.version || '').replace('v', '').split('.');
if (Number(major) < 18) { warn('Node.js 18+ is recommended (current: ' + process.version + ')'); }

// 1) runtime configs
const created = [];
if (copyIfMissing('config.example.json', 'config.json', 'Panel config')) created.push('config.json');
if (copyIfMissing('.env.example', '.env', 'Credentials (.env)')) created.push('.env');

// 2) dependencies
const hasDeps = fs.existsSync(path.join(root, 'node_modules'));
if (!hasDeps) {
  console.log('');
  info('node_modules not found, running `npm install` ...');
  try {
    require('child_process').execSync('npm install --no-audit --no-fund', { cwd: root, stdio: 'inherit' });
    ok('dependencies installed');
  } catch (e) {
    console.error('\n[ERROR] npm install failed. Check network / npm registry and retry.');
    process.exit(1);
  }
} else {
  ok('dependencies already installed');
}

// 3) summary
console.log('');
if (created.length) {
  console.log('Next steps:');
  for (const f of created) {
    if (f === 'config.json') console.log('  1. edit config.json   - set your QQ bot AppID & bind a model');
    if (f === '.env') console.log('  2. edit .env           - put your QQ Secret & model API keys');
  }
  console.log('  3. run `npm start`, then open http://127.0.0.1:4357');
  console.log('     (you can also add bots & models right inside the panel)');
} else {
  ok('everything looks ready. Start it with:  npm start');
}
console.log('');
