// 真机验证：角色卡是**纯文本** —— 新建 / 编辑只有一个正文框，旧版分类字段并入正文
//
// 为什么必须真机跑：
//   「弹窗里还剩几个框」「旧字段到底有没有并进正文」都是 DOM 与前端的耦合，
//   单测只看得见 lib/ 里的纯函数，看不见弹窗长什么样。而这一步会**改写用户数据**
//   （并把旧字段清空）—— 错一次就是永久丢内容，必须有一条真点真读的探针钉住。
//   另外「并轨要幂等」这条也只有连续开两次弹窗才看得出来。
//
// 验证点：
//   ① 弹窗只有一个正文框：traits / age / appearance / background 四个输入框都不在了
//   ② 新建时正文预填全局模板（含 {{名字}} 与 ##Counter），且模板里**不含编辑器自己的说明**
//   ③ ★ 编辑带旧字段的角色 → 旧字段内容并进正文，并给出「已并入」的说明
//   ④ ★ 保存后旧字段被清空、内容留在正文里（一个字都不丢）
//   ⑤ ★ 再打开一次不会重复并（幂等）—— 否则每编辑一次正文就长一截
//   ⑥ 版本档仍能读出旧字段的中文名（改动历史不给用户看裸 key）
//   ⑦ 全程无 JS 错误
//
// 用法：node scripts/verify-char-plaintext.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeSandbox, patchSandboxConfig, startServer, stopServer, removeSandbox, REPO_ROOT, findProbeCharacter } from './lib/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(HERE, 'shots');
const CHROME = path.join(REPO_ROOT, 'playwright-browsers', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const CHAR_ID = 'CHRprobe0001';
// 夹具（scripts/lib/sandbox.mjs）里这位角色的四个旧字段 —— 故意都不出现在 persona 里，
// 所以「并轨」是必然会发生的，而不是碰巧 persona 里已经抄了一份。
const LEGACY = { traits: '沉稳', age: '18', appearance: '黑发', background: '来历不明' };
const BASE_PERSONA = '沙箱探针用的角色设定。';

const count = (hay, needle) => String(hay).split(needle).length - 1;

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : ' —— ' + detail}`);
  if (!ok) fails.push(name);
};

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  const dir = makeSandbox();
  let srv = null;
  let browser = null;
  try {
    const { port } = await patchSandboxConfig(dir);
    const cfgPath = path.join(dir, 'config.json');
    // ★ 清掉用户可能自己写过的模板：本探针要验的是**默认模板**的预填，
    //   留着真实 config.json 里的自定义模板，断的就是别人的内容。
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    delete cfg.characterTemplate;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    for (const f of ['app.js', 'style.css', 'design.css', 'index.html']) {
      const src = path.join(REPO_ROOT, 'public', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'public', f));
    }

    srv = await startServer(dir, port);
    console.log(`沙箱已启动 ${srv.base}\n`);

    browser = await chromium.launch({ executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

    await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.loadState && window.loadState(false));
    await page.waitForTimeout(900);

    // ── ① 弹窗形态：只有一个正文框 ──
    console.log('[1] 新建角色弹窗：只剩一个正文框');
    await page.evaluate(() => window.openCharacterPool());
    await page.waitForTimeout(900);
    await page.evaluate(() => { window.openCharacterEditModal(null); });
    await page.waitForSelector('#chr-persona', { timeout: 5000 });
    await page.waitForTimeout(400);

    const gone = await page.evaluate(() => ['traits', 'age', 'appearance', 'background']
      .map((k) => `chr-${k}`).filter((id) => document.getElementById(id)));
    check('★ 旧版分类字段的输入框已从弹窗移除', gone.length === 0, `还在：${gone.join('、')}`);
    const kept = await page.evaluate(() => ['chr-name', 'chr-persona', 'chr-avatar', 'chr-tags']
      .filter((id) => document.getElementById(id)));
    check('角色名 / 正文 / 形象链接 / 标签 仍在', kept.length === 4, kept.join('、'));

    const preBody = await page.inputValue('#chr-persona');
    check('★ 新建时正文预填了默认模板（含 {{名字}} 与 ## 小节）',
      /\{\{名字\}\}/.test(preBody) && /## 形象/.test(preBody), preBody.slice(0, 100));
    check('★ 默认模板自带 ##Counter（用户不用记语法）',
      /##Counter：好感度\[0,100\]/.test(preBody), preBody.slice(-90));
    // 这条钉的是 2026-10-08 修掉的毛病：模板里曾写着「角色设定是纯文本，图片不进正文……」
    // 这句编辑器自己的说明，于是它跟着模板进了**每一张**新建角色卡的正文。
    check('★ 模板里不再混进编辑器自己的说明文字',
      !/角色设定是纯文本/.test(preBody), preBody.slice(0, 140));
    await page.screenshot({ path: path.join(SHOT, 'plaintext-new-modal.png') });
    await page.evaluate(() => { const m = document.getElementById('chr-edit-modal'); if (m) m.remove(); });

    // ── ② ★ 编辑带旧字段的角色：并入正文 ──
    console.log('\n[2] ★ 编辑带旧字段的角色：旧字段并入正文');
    await page.evaluate((id) => { window.openCharacterEditModal(id); }, CHAR_ID);
    await page.waitForSelector('#chr-persona', { timeout: 5000 });
    await page.waitForTimeout(500);

    const title = await page.evaluate(() => {
      const el = document.querySelector('#chr-edit-modal .modal-head .lb');
      return el ? el.textContent.trim() : '';
    });
    // 若 state.characters 没加载好，openCharacterEditModal 会把已有角色当成「新建」——
    // 那样后面所有断言都会在一个空表单上通过，变成假绿。
    check('弹窗进的是「编辑角色」（不是误判成新建）', title === '编辑角色', title);

    const editBody = await page.inputValue('#chr-persona');
    check('正文里带上了原来的角色设定', editBody.includes(BASE_PERSONA), editBody.slice(0, 80));
    for (const [k, v] of Object.entries(LEGACY)) {
      check(`★ 旧字段「${k}」的内容已并入正文`, editBody.includes(v), `缺 ${v}`);
    }
    check('★ 并进来的是带小节名的正文（不是裸文字堆在末尾）',
      /## 性格/.test(editBody) && /## 背景/.test(editBody), editBody.slice(-160));

    const modalTxt = await page.evaluate(() => {
      const m = document.getElementById('chr-edit-modal');
      return m ? m.textContent.replace(/\s+/g, ' ') : '';
    });
    check('★ 界面上明说了「已把旧版分类字段并入正文」',
      /已把旧版分类字段/.test(modalTxt) && /性格特点/.test(modalTxt) && /背景故事/.test(modalTxt),
      modalTxt.slice(0, 60));
    const gone2 = await page.evaluate(() => ['traits', 'age', 'appearance', 'background']
      .map((k) => `chr-${k}`).filter((id) => document.getElementById(id)));
    check('编辑态同样没有旧字段输入框', gone2.length === 0, gone2.join('、'));
    await page.screenshot({ path: path.join(SHOT, 'plaintext-fold-note.png') });

    // ── ③ 保存：旧字段清空，内容留在正文 ──
    console.log('\n[3] 保存：旧字段归零、内容留在正文');
    await page.evaluate((id) => { window.saveCharacter(id); }, CHAR_ID);
    await page.waitForTimeout(1800);

    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const aChr = findProbeCharacter(after, CHAR_ID);
    check('角色还在池里（没被误删）', !!aChr, CHAR_ID);
    if (aChr) {
      // ★ 用磁盘原文件断言，比走接口更严：接口可能做了展示层的包装。
      for (const [k, v] of Object.entries(LEGACY)) {
        check(`★ 磁盘上旧字段「${k}」已清空`, String(aChr[k] ?? '') === '', `实际 ${JSON.stringify(aChr[k])}`);
        check(`★ 但「${v}」仍留在正文里（一个字没丢）`, String(aChr.persona).includes(v), '');
      }
      check('★ 原 persona 也没被覆盖掉', String(aChr.persona).includes(BASE_PERSONA), '');
      check('保存产生了一条版本档', (aChr.history || []).length === 2, `history=${(aChr.history || []).length}`);
      const snap = (aChr.history || [])[1] || {};
      check('★ 版本档记的是「并轨之前」的样子（回滚可以把旧字段找回来）',
        String(snap.traits) === LEGACY.traits && String(snap.background) === LEGACY.background,
        `traits=${JSON.stringify(snap.traits)}`);

      // ── ④ ★ 幂等：再开一次不会又并一遍 ──
      console.log('\n[4] ★ 再打开一次：不重复并（幂等）');
      await page.evaluate((id) => { window.openCharacterEditModal(id); }, CHAR_ID);
      await page.waitForSelector('#chr-persona', { timeout: 5000 });
      await page.waitForTimeout(500);
      const again = await page.inputValue('#chr-persona');
      for (const v of Object.values(LEGACY)) {
        check(`★「${v}」在正文里只出现 1 次`, count(again, v) === 1, `实际 ${count(again, v)} 次`);
      }
      const noteAgain = await page.evaluate(() => {
        const m = document.getElementById('chr-edit-modal');
        return m ? m.textContent.replace(/\s+/g, ' ') : '';
      });
      check('再次打开不再提示「已并入」（已经并过了）', !/已把旧版分类字段/.test(noteAgain), '');
      await page.evaluate(() => { const m = document.getElementById('chr-edit-modal'); if (m) m.remove(); });

      // ── ⑤ 版本档要读出中文名 ──
      console.log('\n[5] 版本档里的旧字段名');
      await page.evaluate((id) => { window.characterHistory(id); }, CHAR_ID);
      await page.waitForSelector('#chr-hist-modal', { timeout: 5000 });
      await page.waitForTimeout(600);
      const histTxt = await page.evaluate(() => {
        const m = document.getElementById('chr-hist-modal');
        return m ? m.textContent.replace(/\s+/g, ' ') : '';
      });
      check('★ 版本档把 traits / background 显示成中文名（不给用户看裸 key）',
        /性格特点/.test(histTxt) && /背景故事/.test(histTxt) && !/\btraits\b/.test(histTxt),
        histTxt.slice(0, 120));
      check('★ 版本档标出这是「旧」字段', /性格特点（旧）/.test(histTxt), '');
      await page.screenshot({ path: path.join(SHOT, 'plaintext-history.png') });
    }

    // ── ⑥ 无 JS 错误 ──
    console.log('\n[6] JS 错误');
    check('全程无 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    console.log(`\n结果：${fails.length ? '❌ ' + fails.length + ' 项失败' : '✅ 全部通过'}`);
    if (fails.length) console.log('失败项：', fails.join('、'));
    console.log('截图写入', SHOT);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (srv) stopServer(srv.child);
    removeSandbox(dir);
  }
  // ★ 别用 process.exit()：stdout 重定向时会丢未 flush 的日志（空输出 + exit 0）
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
