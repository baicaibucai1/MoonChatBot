// 验证「输出设置 → 模型」的保存链路真的落盘：
//   1) 选另一个模型 → 保存 → 服务端 config 里 modelId 变了，且别的写手没被抹掉
//   2) 选「不绑定」→ 保存 → modelId 真的被清掉（不是 triOf 那种「空=保留原值」）
// 用完一律还原，还原失败会把原值打印出来让用户自己改回去。
import { chromium } from 'playwright';

const BASE = process.env.PANEL || 'http://127.0.0.1:4357';
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { pass++; console.log('  ok   -', n, e); } else { fail++; console.log('  FAIL -', n, e); } };

const apiGet = async (p) => (await fetch(BASE + p)).json();
const st0 = await apiGet('/api/state');
const bots = st0.bots || [];
const bot = bots.find((b) => /测试/.test(b.name || b.id)) || bots[0];
const orig = bot.modelId || '';
const allModels = st0.models || [];
const other = allModels.find((m) => m.id !== orig);
console.log(`写手 ${bot.name || bot.id}　原模型=${orig || '(未绑定)'}　备选=${other ? other.id : '(无)'}`);
if (!other) { console.log('只有一个模型，无法验证切换'); process.exit(0); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.openOutputSheet === 'function', null, { timeout: 20000 });
await page.waitForTimeout(600);

async function setAndSave(value) {
  await page.evaluate((id) => window.openOutputSheet(id), bot.id);
  await page.waitForSelector('#output-sheet', { timeout: 5000 });
  await page.selectOption('#os-model', value);
  await page.evaluate((id) => window.saveOutputSheet(id), bot.id);
  await page.waitForFunction(() => !document.querySelector('#output-sheet'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const st = await apiGet('/api/state');
  return {
    modelId: ((st.bots || []).find((b) => b.id === bot.id) || {}).modelId || '',
    botCount: (st.bots || []).length,
    others: (st.bots || []).filter((b) => b.id !== bot.id).map((b) => (b.modelId || '')).join(','),
  };
}

const othersBefore = bots.filter((b) => b.id !== bot.id).map((b) => (b.modelId || '')).join(',');
try {
  console.log('\n== 换成另一个模型 ==');
  const a = await setAndSave(other.id);
  ok(a.modelId === other.id, '保存后服务端 modelId 已更新', `→ ${a.modelId}`);
  ok(a.botCount === bots.length, '别的写手没被整份覆盖抹掉', `${a.botCount} 个`);
  ok(a.others === othersBefore, '别的写手的模型绑定没被改动');

  console.log('\n== 选「不绑定」==');
  const b = await setAndSave('');
  ok(b.modelId === '', '空值 = 真的解绑（没有保留原值）', `→ ${b.modelId === '' ? '(已解绑)' : b.modelId}`);
} finally {
  console.log('\n== 还原 ==');
  const c = await setAndSave(orig);
  ok(c.modelId === orig, '已还原到原模型', `→ ${c.modelId || '(未绑定)'}`);
  await browser.close();
}
console.log(fail ? `\n✗ ${fail} 项失败（${pass} 项通过）` : `\n✓ 全部通过（${pass} 项）`);
process.exit(fail ? 1 : 0);
