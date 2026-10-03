// 工作区（workspace/）—— 管理员 AI 的「草稿台」
//
// 定位：管理员 AI 需要产出一份长文（人设补充、世界观设定、事件摘要…）时，
// 不要直接往某个角色的记忆库里写 —— 那既不可逆，也无法复用。
// 正确姿势是：先落到工作区（真实 .md 文件），用户在面板审阅，
// 确认后再「注入」到目标（角色记忆库 / 全局设定）。
//
// 与「待确认编辑」(propose_*) 的区别：
//   propose_* 的内容只活在那一轮对话的 pending 里，确认完即蒸发，不能攒、不能改、不能复用；
//   工作区是磁盘上的真文件，可反复注入、可手动编辑、可 git 管。
//
// 注入记录存在 _meta.json，只记「去过哪儿」，不改文件本身 ——
// 同一份内容可以注入给多个角色，这是本模块存在的意义（二次利用）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WS_DIR = path.join(ROOT, 'workspace');
const META_FILE = path.join(WS_DIR, '_meta.json');

// 文件名安全字符集：与 lib/ids.js 的 KEY_RE 保持一致（字母/数字/下划线/中文/连字符）
// 这里刻意重复一份而非 import：ids.js 用的是「整体校验」语义，
// 工作区的 key 还要参与拼路径，校验点越靠近拼路径处越不容易漏。
const KEY_RE = /^[\w\u4e00-\u9fa5-]{1,64}$/;
function assertSafeKey(key) {
  if (!KEY_RE.test(String(key || ''))) throw new Error('非法的文件名: ' + key);
}

function wsDir() {
  fs.mkdirSync(WS_DIR, { recursive: true });
  return WS_DIR;
}

function filePathOf(key) {
  assertSafeKey(key);
  return path.join(wsDir(), `${key}.md`);
}

function getMeta() {
  try {
    const j = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    return (j && typeof j === 'object') ? j : { files: {} };
  } catch {
    return { files: {} };
  }
}

function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

function statOf(key) {
  const file = filePathOf(key);
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  return { size: st.size, mtime: st.mtimeMs };
}

// 列表：磁盘上的真实 .md 为准，_meta 只补「注入记录 / 备注」这类附加信息。
// 这样即便用户手工往 workspace/ 里丢了个 .md，列表也能看到（不会因为没登记而丢失）。
function listFiles() {
  const dir = wsDir();
  const meta = getMeta();
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const key = name.slice(0, -3);
    if (!KEY_RE.test(key)) continue;              // 跳过非法名（如 .tmp 之类）
    const st = statOf(key);
    if (!st) continue;
    const m = (meta.files && meta.files[key]) || {};
    out.push({
      key,
      size: st.size,
      mtime: st.mtime,
      desc: m.desc || '',
      // 注入记录：[{ targetId, targetType, destKey, at }]
      injects: Array.isArray(m.injects) ? m.injects : [],
    });
  }
  // 最近改动的排前面（与线程列表同一套「最近活跃优先」习惯）
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function readFile(key) {
  const file = filePathOf(key);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function writeFile(key, content, desc) {
  const file = filePathOf(key);
  fs.writeFileSync(file, content ?? '', 'utf8');
  const meta = getMeta();
  meta.files = meta.files || {};
  const cur = meta.files[key] || {};
  meta.files[key] = { ...cur, desc: desc !== undefined ? String(desc) : (cur.desc || '') };
  saveMeta(meta);
  return true;
}

function deleteFile(key) {
  assertSafeKey(key);
  const file = filePathOf(key);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const meta = getMeta();
  if (meta.files && meta.files[key]) { delete meta.files[key]; saveMeta(meta); }
  return true;
}

function renameFile(from, to) {
  assertSafeKey(from);
  assertSafeKey(to);
  if (from === to) return true;
  if (fs.existsSync(filePathOf(to))) throw new Error('目标文件名已存在: ' + to);
  const src = filePathOf(from);
  if (!fs.existsSync(src)) throw new Error('文件不存在: ' + from);
  fs.renameSync(src, filePathOf(to));
  // 注入记录跟着改名走，否则历史会「凭空消失」
  const meta = getMeta();
  meta.files = meta.files || {};
  const old = meta.files[from] || {};
  delete meta.files[from];
  meta.files[to] = { ...(meta.files[to] || {}), ...old };
  saveMeta(meta);
  return true;
}

// 记一条注入历史（同一目标 + 同一目标文件名视为「重新注入」，覆盖旧记录而非堆叠）
function recordInject(wsKey, { targetType, targetId, destKey }) {
  assertSafeKey(wsKey);
  const meta = getMeta();
  meta.files = meta.files || {};
  const cur = meta.files[wsKey] || { injects: [] };
  const injects = (Array.isArray(cur.injects) ? cur.injects : []).filter(
    (x) => !(x.targetType === targetType && x.targetId === targetId && x.destKey === destKey)
  );
  injects.unshift({ targetType, targetId, destKey, at: Date.now() });
  meta.files[wsKey] = { ...cur, injects: injects.slice(0, 20) };
  saveMeta(meta);
  return true;
}

module.exports = {
  WS_DIR, KEY_RE,
  listFiles, readFile, writeFile, deleteFile, renameFile, recordInject, getMeta,
};
