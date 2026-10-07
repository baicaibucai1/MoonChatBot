// 迁移演练：在真实 config.json + memory/ 上试跑迁移，输出前后对比
// ------------------------------------------------------------------
// ⚠️ 默认是**只读演练**（dry-run），不写盘。加 --apply 才真正写入。
// 用法：
//   node scripts/migrate-dryrun.mjs           # 只读，看会发生什么
//   node scripts/migrate-dryrun.mjs --apply   # 真写入（会先备份 config.json）
// ------------------------------------------------------------------
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');
const MEMORY = path.join(ROOT, 'memory');

// lib/ 是 CommonJS，用 createRequire 载入
const require = createRequire(import.meta.url);
const migrate = require('../lib/characters-migrate');

const apply = process.argv.includes('--apply');

function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const memoryDirOf = (id) => path.join(MEMORY, id);

  console.log('='.repeat(64));
  console.log(apply ? '★ 迁移演练（会真写入）' : '○ 迁移演练（只读，不写盘）');
  console.log('='.repeat(64));
  console.log('');

  // ---- 迁移前 ----
  console.log('【迁移前】');
  console.log(`  bots: ${cfg.bots.length} 个`);
  for (const b of cfg.bots) {
    const p = path.join(memoryDirOf(b.id), 'persona.md');
    let size = 0, blank = null;
    try {
      const t = fs.readFileSync(p, 'utf8');
      size = Buffer.byteLength(t, 'utf8');
      blank = migrate.isBlankPersona(t);
    } catch { size = -1; }
    console.log(`    ${b.id}（${b.name || '未命名'}）persona.md=${size}B ` +
      (size < 0 ? '[无文件]' : blank ? '→ 判为空模板' : '→ ★ 判为有内容，将提取角色'));
  }
  // 角色池有两种落地形态：旧版单池 cfg.characters，新版多池 cfg.characterPools。
  // 任一存在都说明「角色体系已经在位」，不会再触发从 persona.md 提取角色的那套迁移。
  const hasLegacy = Array.isArray(cfg.characters);
  const hasPools = Array.isArray(cfg.characterPools);
  console.log(`  characters（角色池）: ${hasLegacy ? '存在（旧版单池）' : '不存在'}`
    + `   characterPools（多池）: ${hasPools ? `存在 → ${cfg.characterPools.length} 个池` : '不存在'}`
    + `   → ${hasLegacy || hasPools ? '跳过角色提取' : '★ 会触发迁移'}`);
  console.log('');

  // ---- 在副本上跑迁移（不写盘） ----
  const draft = JSON.parse(JSON.stringify(cfg));
  const report = migrate.migrate(draft, { memoryDirOf });

  console.log('【迁移结果】');
  console.log(`  是否执行: ${report.ran ? '是' : '否（已迁移过）'}`);
  console.log(`  写手数: ${report.writers}`);
  console.log(`  新建角色: ${report.created.length} 个`);
  for (const c of report.created) {
    console.log(`    · ${c.name}（${c.charId}）← ${c.source}`);
  }
  console.log('');
  console.log('  逐条明细:');
  for (const d of report.details) console.log(`    ${d}`);
  console.log('');

  // ---- 迁移后角色池 ----
  // 新版是「多池」：cfg.characterPools 是 [{id,name,characters:[...]}]，角色散在各池里。
  // 旧版写法的 cfg.characters 只在迁移中途出现过（ensurePools 会把它收进「默认池」并删掉这个字段），
  // 所以这里优先读 characterPools，兜底才看 characters。
  const pools = Array.isArray(draft.characterPools)
    ? draft.characterPools.map((p) => ({ name: p.name, chars: p.characters || [] }))
    : (Array.isArray(draft.characters) && draft.characters.length ? [{ name: '（旧版单池）', chars: draft.characters }] : []);
  if (pools.length && pools.some((p) => p.chars.length)) {
    console.log('【迁移后的角色池】');
    for (const p of pools) {
      console.log(`  ■ 池「${p.name}」：${p.chars.length} 位`);
      for (const c of p.chars) {
        console.log(`    【${c.name}】${c.id}`);
        console.log(`      来源: ${c.source || '-'}   标签: ${(c.tags || []).join('、') || '-'}`);
        const pv = String(c.persona || '').replace(/\n/g, ' ').slice(0, 90);
        console.log(`      设定: ${pv}${String(c.persona || '').length > 90 ? '…' : ''}`);
        console.log(`      历史档: ${(c.history || []).length} 版   by=${(c.history || []).map(h => h.by).join(',')}`);
      }
    }
    console.log('');
  }

  // ---- 写手引用 ----
  console.log('【写手的 activeCharacterIds / 绑定的角色池】');
  for (const b of draft.bots) {
    console.log(`  ${b.id}: kind=${b.kind || '(未设)'} active=[${(b.activeCharacterIds || []).join(', ')}]`
      + ` pools=[${(b.poolIds || []).join(', ')}]`);
  }
  console.log('');

  if (!apply) {
    console.log('○ 演练结束，未写入任何文件。确认无误后加 --apply 真跑。');
    return;
  }

  // ---- 真写入（先备份） ----
  const bak = CONFIG + '.pre-migrate-' + Date.now();
  fs.copyFileSync(CONFIG, bak);
  fs.writeFileSync(CONFIG, JSON.stringify(draft, null, 2), 'utf8');
  console.log(`★ 已写入 config.json（原文件备份: ${path.basename(bak)}）`);
}

try { main(); } catch (e) {
  console.error('✗ 演练失败：', e.message);
  process.exit(1);
}
