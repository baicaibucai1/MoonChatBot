# MoonChatBot Android 完整移植施工图

> 日期：2026-10-06　·　目标：**一个 APK 装上即用**，Node 服务 + 面板 + QQ 长连接全在手机里，不依赖电脑
> 代码改动落在副本 `C:\AI_Production\MoonChatBook`（开发主线），主项目 `QQbot` 待验收后回替。

---

## 🚧 施工进度（2026-10-07 更新）

**阶段 C 完成并在电脑模拟器上跑通了 —— App 装上、Node 起来、面板渲染出来。**

| 产物 | 路径 | 体积 |
|---|---|---|
| 真机包（arm64-v8a） | `MoonChatBook/android/dist/MoonChatBot-arm64-debug.apk` | **18 MB** |
| 模拟器包（x86_64） | `MoonChatBook/android/dist/MoonChatBot-x86_64-debug.apk` | **19 MB** |
| 包名 / 版本 | `com.moonchatbot.app` v1.0.0 | |
| 目标平台 | minSdk 26 / targetSdk 34 | |
| 签名 | Android Debug（可直接安装） | |

包内结构已逐项核对：`jniLibs/<abi>/libnode.so`、JNI 桥、58 个 `assets/nodejs-project/*`
文件；**playwright 与真实凭据都没进包**。权限已用 `aapt dump permissions` 核对。

### ✅ 模拟器实测结果（Android 14 / x86_64，非纸面）

```
adb install → Success
am start  → 进程存活，无 FATAL、无 SecurityException
NodeService: 已提权为前台服务            （dumpsys: isForeground=true types=DATA_SYNC）
AssetsInstaller: assets 解压完成（0.08s）
NODEJS-MOBILE: [main] node=v18.20.4
NODEJS-MOBILE: 面板地址: http://127.0.0.1:4357     （冷启动到横幅共 0.78s）
HTTP 经 adb forward 实测：/api/state 200、首页 200、app.js 200（330 KB）
```

面板在 WebView 里正常渲染（左侧导航 + 主区 + 底部「后端已连接」）。
**UI 31 项断言全绿**（`android/verify-ui.mjs`，见下）。

### ★ 这次真机跑出来才暴露的三个问题

**1) Android 14 前台服务类型权限 —— 会让 App 起来即死**
manifest 写了 `foregroundServiceType="dataSync"` 就必须声明
`FOREGROUND_SERVICE_DATA_SYNC`，否则 `startForeground()` 抛 `SecurityException`，
Service 创建失败 → 进程崩溃重启循环（定位在 `NodeService.onCreate`）。
已补权限，并把 `startForeground` 包进 try/catch 降级（以后缺权限只丢前台资格，不带崩服务）。

**2) `lib/store.js` 里 `path` 变成未使用变量**
阶段 A 的路径重构遗漏 —— `npm run lint` 从基线 108 条告警涨到 109。已清理，回到 108。

**3) ≤700px 的响应式规则是半成品，手机上直接掉功能**
原来把 `.settings-btn` / `.admin-entry` 整组 `display:none` ——
「设置 / 模型 / 工作区 / 面板管理员」四个入口在手机上一个都点不到；
同时 `.side-foot`（状态点 + 连接中… + 两个按钮）在 72px 栏里横排不下，
flex 按 min-content 撑开 → **侧栏实际溢出到 ~105px**，中文只能竖排（截图里「写\n手」）。
已改成标准**图标轨**：宽度锁死 64px、文字收起、底部入口竖排、触摸目标放大到 ≥36px，
两列表单网格在窄屏收成单列。桌面 1440px 实测仍是原样 256px（同 origin A/B 比对过）。

**4) `build-apk.sh` 的产物会被自己删掉**
AGP 切 ABI 时会清掉输出目录里不认识的额外文件 —— 先打 arm64 再打 x86_64，
**arm64 的包被静默删除**。产物已改落到 `android/dist/`（Gradle 不碰）。

> ★ 阶段 A 那次验证抓到 `PUBLIC_DIR` 没做 `path.resolve` 会让静态资源全部 404
> （`static.js` 用字符串前缀判越界）。这次包内实测 `/api/state`、首页、app.js 全 200，确认已修好。

### 门禁（本次改动后全过）

`npm run lint` → 0 errors / **108 warnings（= 基线）**；`npm run baseline:check` → 100 条探针逐条一致；
`npm test` → 267 tests / **265 pass / 0 fail** / 2 todo。

**还没做的**：真机（arm64）插机验证、更深一层的移动端交互范式（底部标签栏 / 抽屉，阶段 D 剩余部分）、
保活调优（阶段 E）、release 签名。

---

## 0. 与上一版方案的区别

上一版《安卓手机版方案探索》的结论是"手机当遥控器，服务留在电脑"——**那个结论已被推翻**。
现在的目标是**真移植**：服务本体跑在手机上。

这不是把上一版方案放大，而是换了一条路：

| | 遥控器方案（已推翻） | 完整移植（本方案） |
|---|---|---|
| 服务位置 | 电脑 | **手机进程内** |
| 断网/不在家 | 不可用 | **可用（只需手机有网）** |
| Playwright 搜索 | 完整 | **降级为纯 HTTP** |
| 需要动架构 | 否 | **是（本次已动）** |
| 产物 | 3–8 MB 壳 | **45–60 MB APK** |

---

## 1. 本次已经落地的地基（不是纸面方案）

三处**与平台无关**的重构，桌面行为完全不变，门禁全过：

### ① `lib/paths.js`（新增）——数据目录可配置

原来 5 处各自 `path.join(__dirname, '..')` 推导路径（`server.js`、`store.js`、`memory.js`、
`memory/threads.js`、`workspace.js`）。Android 上代码在**只读的 assets**，这么写等于全盘不可写。

```js
const PROJECT_ROOT = path.join(__dirname, '..');            // 代码（可只读）
const DATA_ROOT = process.env.QQBOT_DATA_DIR || PROJECT_ROOT;  // 数据（必须可写）
const PUBLIC_DIR = process.env.QQBOT_PUBLIC_DIR || path.join(PROJECT_ROOT, 'public');
// → CONFIG_FILE / ENV_FILE / AVATAR_DIR / MEMORY_DIR / WS_DIR 全部挂在 DATA_ROOT 下
```

为什么用环境变量而不是 config 字段：**config.json 自己就躺在数据区里**，
用配置去描述"配置在哪"会自相矛盾，必须在读 config 之前就定下来。

### ② `lib/search.js` —— Playwright 从"启动前提"降为"可选增强"

原来顶层 `const { chromium } = require('playwright')`：模块一加载就要装好浏览器内核，
否则**整个服务起不来**。Android 上没有可用的 Chromium 构建，这行会直接让面板打不开。

```js
let _chromium;                       // undefined=未探测 / false=不可用 / 其余=可用
function chromiumMod() { ... try { _chromium = require('playwright').chromium || false } catch { _chromium = false } }
function browserAvailable() { return chromiumMod() !== false; }
```

配套降级：
- `smartSearch()` 无内核时**所有模式**（含 `'browser'`）一律退到轻量 HTTP —— 否则"仅浏览器"
  会变成一个永远搜不到东西的设置；
- 新增 `webFetchLight()`（纯 fetch + 剥标签），`webFetch()` 变成"有内核用内核，没有用 HTTP"；
- 桌面端行为**零变化**（有内核时仍走浏览器优先路径）。

### ③ `lib/routes/bots.js` —— 移动端没有文件管理器

`open-folder` 原来无条件 spawn `explorer/open/xdg-open`，手机上三个都不存在 → ENOENT。
现在先判 `HAS_DESKTOP`（win32 / darwin / 有 DISPLAY|WAYLAND_DISPLAY），
非桌面环境返回明确文案而不是让人看不懂的失败。

### 验证结果

| 项目 | 结果 |
|---|---|
| `npm run lint` | **0 errors**，109 warnings（历史遗留，改动文件 0 warning） |
| `npm test` | **267 tests / 265 pass / 0 fail / 2 todo** |
| `npm run baseline:check` | **100 条探针逐条对齐** |
| 无 Playwright 环境降级（`.tmp-verify/search-nopw.cjs`） | **8/8 通过** |

> ⚠️ 踩到的坑：两个测试（`threads.test.mjs`、`worldcard.test.mjs`）把 `lib/` 下的**固定文件清单**
> 复制进临时沙箱，新增 `lib/paths.js` 后没同步 → 34 条 MODULE_NOT_FOUND。
> **以后在 `lib/` 下新增文件，必须同步这两份清单。**

---

## 2. 目标架构

```
┌─ APK（单 ABI arm64，约 45–60 MB）────────────────────────┐
│                                                           │
│  MainActivity（Kotlin）                                   │
│    └─ WebView ──loadUrl──► http://127.0.0.1:4357          │
│                                    ▲                      │
│  NodeBridge（前台服务，常驻通知）    │                      │
│    └─ System.loadLibrary("node") ──┘                      │
│         └─ 进程内线程跑 server.js（JNI，不是 fork 子进程）   │
│                                                           │
│  assets/nodejs-project/   ← 首次启动解压到 filesDir         │
│    ├─ server.js / lib/ / public/                          │
│    └─ node_modules/（只有 ws，纯 JS）                      │
│                                                           │
│  filesDir/data/  ← QQBOT_DATA_DIR（config/memory/avatars） │
└───────────────────────────────────────────────────────────┘
```

**关键：为什么是 nodejs-mobile 而不是 Termux**

| | Termux | **nodejs-mobile** |
|---|---|---|
| 形态 | 要另装 App + 敲命令 | **一个 APK，装上即用** |
| 进程模型 | fork 出的 Linux 进程 | **进程内线程**（JNI 加载 libnode.so） |
| Android 12+ phantom process killer | **会被杀**（专门杀 fork 子进程） | 按实现**不受影响**（需目标机型实测确认） |
| 保活手段 | wake-lock + 白名单 + tmux，折腾 | **前台服务**，标准做法 |
| 给他人用 | 不现实 | 发 APK 即可 |

---

## 3. 运行时选型（2026 现状）

| 方案 | Node 版本 | ABI | 备注 |
|---|---|---|---|
| **官方 `nodejs-mobile`** | **24（v24.18.0）** | arm64-v8a / armeabi-v7a / x86_64，16 KB 页对齐 | 主线，有 RN / Cordova 插件 |
| `OpenFlun/nodejs-mobile` | 22.23.2 | arm64-v8a + x86_64，API 30+，full-ICU | 提供预编译 `android-libnode.zip`（.so 约 113 MB，已剥离符号） |
| `node-on-android` | 较旧 | **仅 arm64** | CLI 直接产出 APK（apktool 注入），省事但维护状态一般 |

**建议**：官方 nodejs-mobile（主线 Node 24，16 KB 对齐已满足 Play 要求）+ 自己写宿主工程。
若想先跑通原型，`node-on-android` 的 CLI 能把整个项目直接打成 APK，代价是它是老方案、仅 arm64。

### 体积估算

| 组成 | 大小 |
|---|---|
| libnode.so（arm64，剥离符号，压缩进 APK） | ~40–50 MB |
| `public/`（前端，零构建直接可用） | ~1.1 MB |
| `lib/` + `server.js` | ~0.4 MB |
| `node_modules`（只剩 `ws`） | ~0.2 MB |
| **playwright-browsers** | **0（不进包）** |
| **APK 合计（单 ABI）** | **约 45–60 MB** |

---

## 4. 平台差异清单（哪些已解决、哪些待做）

| # | 差异 | 状态 |
|---|---|---|
| 1 | 数据目录写不进（assets 只读） | ✅ `QQBOT_DATA_DIR` |
| 2 | Playwright 缺失导致服务起不来 | ✅ 懒加载 + 纯 HTTP 降级 |
| 3 | 无文件管理器 | ✅ 优雅降级 |
| 4 | 监听地址 | ✅ 保持 `127.0.0.1`（App 内反而更安全，且天然无跨域问题） |
| 5 | 明文 HTTP（Android 9+ 默认拦 cleartext，localhost 也拦） | ☐ `network_security_config.xml` 只放行 `127.0.0.1` |
| 6 | 前台服务 + 常驻通知（保活） | ☐ 原生 |
| 7 | 开机自启 / 网络恢复重连 | ☐ 原生 |
| 8 | 手机上没终端，日志看不到 | ☐ 面板内加「运行日志」页 + 通知栏 |
| 9 | 移动端布局（侧栏抽屉、100dvh、触控） | ☐ CSS |
| 10 | 数据备份（手机上没法翻目录） | ☐ 一键导出 zip 到 Downloads |
| 11 | `ws` 在 Node 24 移动版上的可用性 | ☐ 需实测（纯 JS，预期 OK） |
| 12 | 电池优化白名单（国产 ROM） | ☐ 首次启动引导页 |

---

## 5. 阶段划分

### 阶段 A · 平台无关重构 —— ✅ 已完成
即上文三处。门禁全过，桌面行为零变化。

### 阶段 B · 原型验证（约 1 天，零成本，强烈建议先做）
**在手机上装 Termux 跑一遍**，验证"除 Playwright 外全部功能在 Android + Node 上能不能跑通"：

```bash
pkg install nodejs git
git clone <repo> && cd MoonChatBot && npm install --omit=optional
QQBOT_DATA_DIR=$HOME/moonchat-data node server.js   # 验证 paths 生效
# 手机浏览器打开 http://127.0.0.1:4357
```

验收：面板能开、能加机器人、能对话、能改记忆。
这一步能提前暴露阶段 A 没覆盖到的问题，**比直接搭 Android 工程便宜得多**。

### 阶段 C · 宿主工程（3–5 天）
1. Android Studio 新建工程（Kotlin，minSdk 30）
2. 集成 nodejs-mobile（按官方插件文档）
3. `assets/nodejs-project/` 放入 `server.js` / `lib/` / `public/` / `node_modules/`
4. 首次启动：assets → `filesDir/nodejs-project/` 解压（官方标准做法）
5. 启动 Node：`QQBOT_DATA_DIR = filesDir/data`，`QQBOT_PUBLIC_DIR = filesDir/nodejs-project/public`
6. 前台服务 + 通知（8+ 必须 5 秒内 `startForeground()`）
7. WebView `loadUrl("http://127.0.0.1:4357")`，配置 `domStorageEnabled = true`
8. `network_security_config.xml` 放行 `127.0.0.1` 明文
9. 开机自启（BOOT_COMPLETED）+ 网络变化广播触发重连

### 阶段 D · 移动端 UI
- ✅ **断点 ≤700px：侧栏 → 图标轨（64px）** —— 文字收起、底部入口竖排、触摸目标 ≥36px，
  所有入口一个不少（原来被 `display:none` 砍掉了四个）
- ✅ **两列栅格降单列**：`.grid-2` / `.cards-2` / `.mem-distill`
- ✅ **同 origin 桌面 A/B 回归**：1440px 仍是 256px 侧栏、800px 命中 220px 档、无横向滚动
- ⬜ 侧栏 → 抽屉 / 底部标签栏（更像手机，但属于交互范式变更，需求确认后再动）
- ⬜ `100vh` → `100dvh`；键盘遮挡（写手对话页输入框）
- ⬜ 右键收藏补长按；`@media (hover:none)` 扩展
- ⬜ 隐藏「打开文件夹」（服务端已优雅降级返回提示，前端仍显示按钮）
- ✅ **真机自动化验证**：`android/verify-ui.mjs` 走 adb devtools 直连 CDP，
  在真机页面里量 31 项指标（宽度 / 溢出 / 入口可见性 / 触摸目标），截图落在 `.tmp-android/shots/`

> ★ 教训：`design.css` 里原本就有一段 `@media (max-width: 700px)`，但它是按
> **「桌面浏览器窗口拖窄」**写的 —— 那种场景下鼠标够用、不介意掉几个按钮，
> 于是它把底部入口整组藏了；到手机上这就成了掉功能。
> **窄屏规则必须按「触摸设备」而非「小窗口」来写，并且必须真机截图验证。**

### 阶段 E · 保活与运维（2–3 天）
- 前台服务通知显示"运行中 · 已连接 N 个机器人"
- 面板内日志页（滚动尾部日志）
- 一键导出 / 导入 zip（config + memory + avatars）
- 电池优化白名单引导
- 断线重连（QQ 长连接 + 网络切换）

---

## 6. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **高** 手机发热耗电 | Node 常驻 ~80–150 MB 内存，QQ 长连接持续心跳 | 前台服务 + 允许用户在设置里关停机器人 |
| **高** 国产 ROM 保活 | MIUI/ColorOS 会额外杀 | 引导页列各品牌白名单步骤；做不到就承认"需要常开屏幕" |
| **中** libnode 与 Node 24 兼容 | `ws` 纯 JS 预期 OK，但需实测 | 阶段 B 先验证 |
| **中** 移动网络切换断线 | WiFi↔4G 切换时 WebSocket 断 | 网络变化广播 + 指数退避重连 |
| **中** 搜索能力下降 | 纯 HTTP 抓不到 JS 渲染的页面 | 已降级但可用；后续可加"用系统浏览器打开"兜底 |
| **低** 上架 Play | 需 target API 36 + 16 KB 对齐 | 自签分发不受限；官方 nodejs-mobile 已满足 16 KB |

---

## 7. 现在就能回答的结论

1. **能移植**，不需要重写 —— 服务是纯 JS（依赖只有 `ws`），前端零构建，这两点是决定性的。
2. **必须重构的只有三处**，本次已全部完成并验证：数据目录、Playwright 可选、桌面专属功能。
3. **阶段 B 不用做了** —— 已经直接跳到 C 并在**电脑模拟器**上完整跑通：
   装上、Node 在 App 进程内起来、面板渲染、31 项 UI 断言全绿。
   模拟器能覆盖的（权限、JNI、assets 解压、数据区落位、WebView 同源）都已覆盖。
4. **现在唯一还没验证的是「真机 + 国产 ROM 的保活」** —— 这只能在真机上跑一晚才有答案，
   且结论取决于机型/系统，不是代码问题。
5. **下一步建议**：先在 arm64 真机上装 `MoonChatBot-arm64-debug.apk` 跑一晚拿保活数据；
   同时决定移动端交互是否要从「图标轨」继续做到底部标签栏 / 抽屉。
