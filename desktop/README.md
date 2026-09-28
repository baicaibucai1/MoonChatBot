# MoonChatBot · 桌面壳

把 QQ 机器人管理面板装进一个独立的 Windows 桌面窗口。

**壳与服务是分开的** —— 壳只有约 8 MB（安装包 1.18 MB），
QQ 机器人服务仍由 `node server.js` 在后台独立运行。

```
┌─ 后端服务（常驻，必须在跑）──────────┐
│  node server.js                      │
│  http://127.0.0.1:4357               │
│  含 Playwright 701MB、4 个机器人长连接 │
└──────────────────────────────────────┘
              ↕ HTTP（跨域，服务端已放行）
┌─ 桌面壳（约 8MB）────────────────────┐
│  WebView2 加载内嵌前端                │
│  从 tauri.localhost 调上面的 API      │
└──────────────────────────────────────┘
```

---

## 快速使用

### 日常使用（已装好之后）

1. **先启动服务**：在项目根目录双击 `启动面板.bat`（或 `node server.js`）
2. **再打开壳**：开始菜单里的「MoonChatBot」

> 顺序反了也没关系 —— 壳会显示「无法连接后端服务」的提示，
> 并给出命令和「重试连接」按钮。

### 从源码打包

```
desktop/打包桌面版.bat     ← 双击，产出安装包
```

产物位置：
```
desktop/src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/
    MoonChatBot_0.2.0_x64-setup.exe
```

也可以在 `desktop/` 下跑 `node scripts/pack.mjs`。

---

## 环境要求

| 项 | 状态 | 说明 |
|---|---|---|
| Rust（GNU 工具链） | ✅ 已装 rustc/cargo 1.98.1 | 走 GNU 路线，**不需要 Visual Studio** |
| MinGW-w64 | ✅ 已装在 `~/msys64/mingw64` | gcc 16.2.0 |
| MSYS2 | ✅ `~/msys64` | |
| NSIS 打包器 | ✅ 已缓存 `%LOCALAPPDATA%\tauri` | |
| WebView2 Runtime | ✅ 已装 153.0.4234.48 | Win10 1803+ 自带 |
| Tauri CLI | ✅ 2.11.5（`desktop/node_modules`） | |

**这是上一轮打包 web2exe 时已经装好的环境，本次零环境成本。**

第一次完整打包耗时约 102 秒（依赖已编译过）；全新环境首次约 15–20 分钟。

---

## 目录说明

```
desktop/
├── src-tauri/
│   ├── tauri.conf.json     ★ 应用名 / 窗口 / 打包配置
│   ├── Cargo.toml          Rust 依赖（已剥离 updater/process 插件）
│   ├── src/main.rs         入口（纯薄壳，无自定义逻辑）
│   ├── capabilities/       权限清单（只留 core:default）
│   ├── icons/              14 个图标
│   ├── .cargo/config.toml  GNU 工具链路径（本机绝对路径，不入库）
│   └── WebView2Loader.dll  GNU 目标必需，缺了装完启动报错
└── scripts/                构建脚本（复用 web2exe-tauri 的成熟流程）
    ├── pack.mjs            ★ 打包主流程（5 步）
    ├── build-desktop.mjs   ★ 调 cargo/tauri 的那一层
    ├── env-check.mjs       环境自检
    ├── check-installer.mjs 装完能不能用：读 installer.nsi 逐文件核对
    └── ...
```

---

## 关键设计决策（与 web2exe 模板的差异）

### 1. 剥离了 React/Vite/TS 构建链

原模板是「Vite 构建 → dist/ → Tauri 内嵌」。本项目前端是**现成的静态文件**，
所以 `build.frontendDist` 直接指向仓库里的 `public/`，**没有构建步骤**。

相应改动：
- 删除 `src/`、`index.html`、`vite.config.ts`、`tsconfig*.json`
- `package.json` 只留 `@tauri-apps/cli` 一个依赖
- `pack.mjs` 第 3 步从「跑 tsc+vite」改为「检查 frontendDist 目录」
- `env-check.mjs` 从「检查 dist/index.html」改为「按 frontendDist 实际指向检查」

### 2. 关闭了自动更新

`bundle.createUpdaterArtifacts: false`，同时从 `Cargo.toml` 移除了
`tauri-plugin-updater` / `tauri-plugin-process`，`main.rs` 不再注册它们，
`capabilities/default.json` 也移除了对应权限。

> ⚠️ 这四个地方必须同步改 —— 少改一处就会在编译最后阶段报
> `Permission updater:default not found`。

`pack.mjs` / `build-desktop.mjs` / `check-installer.mjs` 都已相应感知该开关：
关闭时不检查、不生成 `.sig` 签名。

**将来要启用自动更新**：把 `createUpdaterArtifacts` 改回 `true`，
生成密钥对（`tauri signer generate -w .tauri-key`，密码留空），
填好 `plugins.updater.pubkey` 与 `endpoints`，
并把这四个文件里的 updater 配置加回来。

### 3. 假设服务在同机

`public/app.js` 里桌面模式下 API 地址硬编码为 `http://127.0.0.1:4357`。
若将来要连远程服务，需要改成可配置（设置项 + 连通性检测）。

---

## 前端侧的配套改动（在仓库根的 `public/`）

桌面壳能跑起来，靠的是这三处改动：

**① `server.js` 加 CORS 白名单**

Tauri 壳把前端从 `http://tauri.localhost` 加载，调 `127.0.0.1:4357` 就是跨域。
WebView2 和浏览器一样执行同源策略，服务端不放行会得到无信息的 `Failed to fetch`。

```js
const CORS_ORIGINS = new Set([
  'http://tauri.localhost', 'https://tauri.localhost',   // Windows / Android
  'tauri://localhost',                                    // macOS / Linux
  'http://localhost:1420', 'http://127.0.0.1:1420',       // Vite dev
]);
```

**② `public/app.js` 加 `API_BASE`（改 1 处覆盖 70+ 调用）**

`api()` 是唯一的请求入口，所以在它内部统一加前缀，**70+ 处调用一行未改**。

**③ 补齐 3 处非 `api()` 的路径**
`avatarInner()` 用 `assetUrl()`、两处管理员 SSE/普通 `fetch`。

---

## 验证记录

### 跨域通路（HTTP 层，8/8 通过）

| 测试项 | 结果 |
|---|---|
| OPTIONS 预检（Windows origin） | ✅ 204，ACAO 正确 |
| GET `/api/state`（Windows origin） | ✅ 200，`ok=true port=4357 bots=4 models=4` |
| GET（`tauri://localhost`） | ✅ 200 |
| GET（`evil.example.com`）**未授权** | ✅ **ACAO=(none)，未放行** |
| 同源浏览器访问 | ✅ 200，原路径未被破坏 |
| 头像 webp 跨域 | ✅ 200，8718 bytes |
| PUT `/api/config` 预检 | ✅ 204 |
| 首页 / app.js | ✅ 200 / 200 |

### 安装包内容（7/7 PASS）

`moonchatbot.exe` 在清单里、`WebView2Loader.dll` 已装入、卸载项完整。

### 桌面壳加载（决定性证据）

WebView2 数据目录 `%LOCALAPPDATA%\com.baicaibucai.moonchatbot\EBWebView`
已创建，缓存中命中 **`index.html` / `app.js` / `style.css` / `tauri.localhost` / `MoonChatBot`**
全部 5 个关键词，163 个缓存文件，时间戳与启动时刻吻合。

窗口标题正确显示 `MoonChatBot 控制台`，窗口尺寸 1280×820（符合配置）。

> **注意**：用命令行启动壳时，若进程落在非交互式会话，
> 窗口会处于最小化状态（坐标 -25600、客户区 0×0、无 WebView2 子进程）。
> **这是自动化环境的限制，不是产品问题** —— 用户双击启动时是交互式会话，正常显示。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 仅 Windows | GNU 工具链、NSIS、`.bat` 都是 Windows 专有 |
| 服务必须先跑 | 壳不含服务，双击壳之前要保证 `node server.js` 在运行 |
| 无托盘/开机自启 | 当前是纯窗口壳，没有做托盘和自启 |
| 无自动更新 | 已关闭；换版本直接重装安装包 |

---

## 与 web2exe-tauri 的关系

本目录是从 `baicaibucai1/web2exe-tauri` 的 `template/` 改造而来，
复用了它成熟的部分：

- GNU 工具链环境配置（`setup-gnu.mjs` / `toolchain-path.mjs`）
- `WebView2Loader.dll` 同步逻辑（`sync-webview2-loader.mjs`）
- NSIS 打包与内容校验（`check-installer.mjs`）
- 全部 .bat 保持纯 ASCII + CRLF（中文提示由 Node 打印）

**建议回馈给上游**：补一节「服务分离」形态的文档 ——
Tauri 只做壳、后端服务常驻本机、前端从 `tauri.localhost` 跨域调 API。
这是比 sidecar 更常见也更优的形态，需要讲清 CORS 白名单、
origin 三平台差异（Windows 是 `http://tauri.localhost`，**是 http 不是 https**）、
以及相对路径陷阱。