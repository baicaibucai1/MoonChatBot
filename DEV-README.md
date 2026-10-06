# MoonChatBook — 开发副本

> 本项目是 **QQbot 的开发副本**，用于实施「写手卡 + 角色池」架构改造。
> 改造完成、验收通过后，再替换 `AI_Production/QQbot`。

## 一、来历

| 项 | 值 |
|---|---|
| 分叉自 | `C:\AI_Production\QQbot` @ `9c3b6e1`（tag `v1.1.0-pre-writer`） |
| 分叉日期 | 2026-10-03 |
| 目的 | 把「角色卡」重构为「写手卡」，角色改为角色池机制，记忆系统重新分层 |
| 工作模式 | **独立开发、独立提交**；验收通过后才回替主项目 |

主项目两侧的备份（分叉前状态）：

- 标签 `v1.1.0-pre-writer` → `9c3b6e1`
- 分支 `backup/pre-writer` → `9c3b6e1`
- 物理数据备份 `../QQbot-backup-20261003-201100/`（`memory/` + `config.json` + `avatars/`）

★ **注意**：`.gitignore` 排除了 `/memory/`、`/avatars/`、`config.json`，
**git 备份救不了运行时数据** —— 改数据结构的任务必须先做物理 `cp -r` 备份。

## 二、怎么跑

```bash
cd C:\AI_Production\MoonChatBook
node server.js          # 面板地址 http://127.0.0.1:4358
```

- **端口 4358**（主项目 QQbot 是 4357）—— 严格遵循「一项目一端口」。
- **依赖**：`node_modules` 已实体复制（37M）；`playwright-browsers` 是 junction 链接
  指向主项目的（703M，纯二进制不会变）。需要重装依赖时 `npm install` 即可。
- **未带入**：`desktop/`（3.4G Tauri 编译产物）、`dist-setup/`、`.tmp-*`。

## 三、★ 离线模式（必须知道）

`.env` 里默认 `QQBOT_OFFLINE=1`：

> **本副本与主项目共用同一批 QQ 凭据。QQ 的 WebSocket 是单连接设计 ——
> 两个实例同时连同一批机器人会互相挤掉连接、事件分发错乱。**

实测教训：副本第一次启动时**没开**这个开关，日志立刻出现
`access_token 获取成功` → `连接网关` → `WebSocket 已连接`，BOT3 甚至收到 `READY`。
当时主项目恰好没启动才没出事。

因此在副本里开发/回归**一律保持 `QQBOT_OFFLINE=1`**，只有确实要验证 QQ 收发时才临时改 0
（并确认主项目已停）。命中离线模式时，机器人状态显示为「离线模式」，完全不发 QQ 请求。

## 四、门禁（复制时已验证与主项目一致）

```bash
npm run lint            # 0 errors / 107 warnings
npm test                # 125 条：123 pass / 0 fail / 2 todo
npm run baseline:check  # 100 条探针逐条对齐
```

★ 本机 `curl` 访问 `127.0.0.1` 会被代理劫持（报 `502 upstream connect failed`），
**验证本地服务要用 node 直接发 http 请求**，或 `curl --noproxy '*'`。

## 五、本次要做的改造

用户已拍板的四个决策：

1. **写手输出** = 两者混合，写手自主决定叙述还是对白。
2. **写手改角色卡** = 可以改，但可回滚（需要版本档）。
3. **角色池里的角色** = 仍可单独聊（不破坏现有习惯，两套并存）。
4. **记忆** = 写手一份 + 每角色各一份。

摸底发现（改造时必须考虑）：

- 四个角色里**只有 BOT2 是真资产**（`WORLDS.md` 143KB + `SOUL.md` 18KB + `FACT.md` 14KB +
  `剧情记录.md` 21KB + `sessions.jsonl` 626KB）；BOT1 有真 `persona.md`（806B）；
  BOT3/BOT4 是空壳。
- ★ `plot.md` 在四个角色里**全是 75 字节空模板** —— 「剧情挂在 plot.md 上」是错的。
  真实剧情在 BOT2 的 `WORLDS.md`（tier2）+ `剧情记录.md`（tier3）。
  **做记忆分层不能只看预设 key，要按 `_meta.json` 的 `files[].tier` 真实层级走。**
- `persona_core.json` 的 `relationship_state` 语义待定：写手对用户 vs 角色对用户
  （倾向保留在角色侧）。
- 其他受影响点：`FILE_TYPES` 硬编码 plot 归角色、`memory/<botId>/` 单目录混装、
  `getRecentSessions` 跨线程归并语义、`bot.enabled`/`sandbox` 对写手不适用、
  长度自主权对「小说段落」与「聊天回复」语义不同、`server.js` 的 `propose_bot_config_edit`
  字段白名单。

## 六、替换主项目的流程（验收后）

1. 主项目侧确认已停、备份仍在。
2. 处理主线数据增量：主项目在副本开发期间可能又产生了新对话/记忆 → 需要**数据合并或重拷**。
   注意先比对 `memory/` 各角色的 `sessions.jsonl` / `threads/` 时间戳。
3. 代码替换、升版本号。
4. 门禁全绿后提交，并按项目惯例推送 GitHub。

⚠️ 替换前务必确认：副本里 `config.json` 的 `port` 是 4358、`QQBOT_OFFLINE` 是 1，
替换回主项目时要改回 4357 并**确认离线开关的去留**。
