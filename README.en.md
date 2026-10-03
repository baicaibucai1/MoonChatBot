<p align="center">
  <img src="public/logo.svg" width="86" alt="MoonChatBot">
</p>

# MoonChatBot — QQ Bot Management Panel

> **English · [中文](README.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)

A local, visual management tool for **multiple QQ bots + character persona/memory documents + any OpenAI-compatible model**, with a built-in **Panel Admin AI**, **heartbeat tasks**, **memory gallery**, and **workspace drafts**. Everything runs in a build-free, vanilla frontend web panel.

```
QQ user sends message → bot gateway (qq-guild-bot over WebSocket)
   → assemble persona (memory/<id>/*.md) + recent sessions
   → call the bound model (DeepSeek / SiliconFlow / Zhipu / Ollama…)
   → auto-reply and append to session history
   → manage & monitor from the web panel (http://127.0.0.1:4357)
```

## Table of Contents

- [Feature Overview](#feature-overview)
- [Quick Deploy](#quick-deploy-from-github-in-3-steps)
- [Desktop Shell](#-desktop-shell-optional)
- [Features in Detail](#features-in-detail)
- [Structure](#structure)
- [Config & Security](#config--security-important)
- [FAQ](#faq)
- [Changelog](#changelog)
- [License](#license)

## Feature Overview

| Area | One-liner |
|------|-----------|
| Multiple characters | Independent AppID/Secret, live status, per-bot edit / reconnect / delete |
| Sidebar nav | Sorted by **most recent chat**, **right-click to favorite**, **resumes where you left off** |
| Memory vault | Multiple Markdown files per bot — toggle, AI filing, branching |
| Sessions | Bubble chat with Markdown, delete one, export, clear |
| **Memory gallery** | AI-extracted standout moments shown as readable cards (was "highlight moments") |
| Model provider | Any OpenAI-compatible endpoint, one-click connectivity test, token stats |
| Web search | function-calling search with light / browser auto-tiering |
| Heartbeat tasks | Characters speak proactively: timer / interval / random, **unlimited** cards |
| Workspace | Draft desk for the Admin AI: generate → park → inject on demand |
| Panel Admin AI | Built-in agent: read-only review → pending-approval edit proposals |
| Desktop shell | Optional Tauri shell — the panel in its own window (1.18 MB installer) |
| Appearance | Accent color, light/dark theme, card background effects |

## Quick Deploy (from GitHub in 3 steps)

**Windows**: double-click **`安装并启动.bat`** — it runs `npm install`, generates missing `config.json` / `.env` from the examples (never overwrites existing files), starts the panel and opens the browser.

**macOS / Linux**:

```bash
npm install
npm run setup     # one-shot init: check deps + copy missing example configs
npm start
```

Then set your credentials either way:
1. edit `config.json` (bot AppID, bound model) and `.env` (QQ Secret, model API keys); or
2. open **http://127.0.0.1:4357** and add bots / models visually in the panel (saved automatically).

> For web-search / browser features, Playwright prepares its browser engine on first use; for long-running processes use `pm2 start server.js --name moonchatbot-panel`.

## 🖥 Desktop Shell (optional)

The panel runs in a browser by default. If you'd rather have it in a **standalone window** (own taskbar icon and Start-menu entry, no browser tabs), the repo ships a thin Tauri shell — source in [`desktop/`](desktop/README.md).

**The shell and the service are deliberately separate:**

```
┌─ Backend service (always on, must run first) ─┐
│  node server.js                               │
│  http://127.0.0.1:4357                        │
│  Playwright engine + bot connections          │
└───────────────────────────────────────────────┘
              ↕ HTTP (CORS allowed server-side)
┌─ Desktop shell (~8 MB / 1.18 MB installer) ───┐
│  WebView2 renders the bundled frontend        │
│  calls the API from tauri.localhost           │
└───────────────────────────────────────────────┘
```

That split pays off: the shell doesn't carry Playwright (701 MB) or a Rust runtime, so the **installer is only 1.18 MB** — and restarting, tailing logs, or `pm2`-managing the service is independent of the window.

- **Usage**: run `启动面板.bat` first, then open **MoonChatBot**. Reverse order just shows a "cannot reach backend" card with a retry button — no blank window.
- **Build from source**: run `desktop/打包桌面版.bat`; toolchain deps (Rust + MSYS2/MinGW-w64) are prepared by scripts — **no admin rights, no Visual Studio**.
- **CORS note**: on Windows the WebView2 origin is `http://tauri.localhost`, so `server.js` whitelists it (plus local dev ports — not a wildcard). Update the server alongside the frontend.
- Design trade-offs, verification log and known limits: **[`desktop/README.md`](desktop/README.md)**.

## Features in Detail

### 0. Sidebar navigation (sorting / favorites / resume)

The left-hand character list is not alphabetical — it organizes itself around how you actually work:

- **Most recent first**: sorted by each character's last chat time across all its threads; whoever you just talked to is at hand (characters with no conversations sink to the bottom).
- **Right-click to favorite**: right-click a character → "Favorite"; favorites are **pinned to the top** and still sorted by recency inside the group. Right-click again to unfavorite. This is a local UI preference stored in the browser's `localStorage` — it is **not written to `config.json`** and never syncs to another machine.
- **Resume where you left off**: the last "character + tab + conversation thread" is remembered and restored on refresh or restart (pausing on Settings/Models doesn't overwrite it). If that thread was deleted, it falls back to the character's most recent conversation instead of leaving a blank pane.

### 1. Character management

- **Multiple instances**: add as many QQ bots as you like from the sidebar; each has its own AppID/Secret, sandbox/live environment and bound model.
- **Live status dot**: 🟢 connected / 🟡 chatting / 🔴 offline or error — mirrored in the sidebar and the card.
- **Info card** (first card of a bot's page):
  - avatar (URL / emoji / uploaded image stored to `avatars/`);
  - name, "actively operating" tag, connection badge, AppID;
  - four info tiles: bound model, history length, key reference, memory file count;
  - status bar: environment (live/sandbox), web-search state, search mode, runtime status;
  - **highlight moments** section (§8) and the animated background canvas (§10).
- **Actions**: `↻ Reconnect`, `✎ Edit` (full form: AppID/Secret/model/history/env/web search/mode/avatar), `Delete` (confirm dialog).

### 2. Memory vault (memory/<botID>/)

A per-bot Markdown vault of multiple files, loaded as persona system prompts on replies.

- **Files**: e.g. persona / plot / content — **enable or disable each file**, edit body, set description, delete.
- **Use global settings**: toggle per bot — when on, global user/profile files are read first, then this vault; off uses the vault only.
- **AI filing**: describe a new plot point in the box and AI files it into the right memory file for you.
- **Branching**: restart a storyline from any history point and switch between branches.
- **Open folder**: jump to the bot's memory directory in your OS file manager.

### 3. Session history

- **Bubble chat**: user/bot bubbles with Markdown rendering (headings, lists, code, quotes).
- **Auto-scroll**: lands on the latest message when opened; scrolling up to read history isn't interrupted — follow resumes when you're back at the bottom.
- **Per-message**: `✕` delete a message (AI won't read it again) or `⑂` fork a new branch from it.
- **Card tools**: `⛶ Expand` full history modal, `⑂ Branches` (switch/resume), `⬇ Export` (plain text), `Clear` (confirm).
- **Direct chat**: the input at the bottom talks to the model directly (bypasses QQ) — handy for persona/model QA, with a "thinking…" placeholder.

### 4. Proactive messaging

At the bottom of a bot page, send messages yourself: pick **DM / group / guild**, set the target openid (auto-filled with the **master ID** — the first person who talked to you) and type the content.

### 5. Models & usage

- **Models page** (sidebar ▤): each model is one OpenAI-compatible endpoint (Base URL + model name); keys come from `.env` vars (`apiKeyEnv`) or inline.
- **One-click test**: `POST /api/models/:id/test` verifies connectivity.
- **Binding**: switch any bot to any model; bots without a model won't reply.
- **Token stats** (Settings → Usage): totals/today, calls/failures, per-bot horizontal bars, last-14-days column chart with count-up animation.

### 6. Web search (function calling)

- Global toggle + **tiering**: `Auto` (light first, upgrade to browser when needed), `Light only` (HTTP titles/summaries), `Browser only` (headless search).
- **Per-bot override** in the edit form (bot > global).
- The model invokes tools on demand and auto-fetches full pages when needed.

### 7. Heartbeat tasks (proactive speech)

Bottom of the bot page, "♥ Heartbeat tasks". **One card = one independent schedule**, unlimited count, mixed modes allowed:

- `⏱ Interval`: every N minutes (min 5).
- `🕘 Timer`: daily recurring time points, each with its own task prompt.
- `🎲 Random`: trigger at a random minute within your min/max range.
- **Prompt**: write custom content per card (injected as a "heartbeat task" instruction); otherwise generated by tone (greet / advance plot / ask a question).
- **Status**: header shows "N enabled · next in ~X min" and the master ID; disabled cards desaturate.

### 8. Memory gallery ✨

AI-curated **standout moments** promoted to their own tab (they used to sit on the bot card),
laid out as a card grid — summary and quote are **visible right away**, no per-item expanding:

- **Entry**: open a character, then the "Gallery" tab.
- **Trigger**: "✨ Summarize highlights" at the gallery's top-right (or "↻ Re-summarize" once populated); or ask the Panel Admin "summarize BOT1's highlights".
- **Source**: the bot's enabled memory files + its last 16 conversations, distilled by the bound model in a "script editor" role into **exactly 3** entries (title + one-line takeaway + signature quote).
- **Manage**: delete one card via its top-right `✕` (with confirm); re-summarizing replaces the group and persists to `config.json`.
- Collapses to a single column on narrow screens.

### 9. Workspace (draft desk for the Admin AI)

The "▤ Workspace" sidebar entry is a **staging area** for the Panel Admin: generate content first, inject only what proves useful — so the AI never writes to memory unchecked.

- **Generate**: have the admin produce drafts (setting copy, plot snippets, persona additions…); they land in the workspace.
- **Park**: every draft can be renamed, previewed, deleted; they are independent of each other.
- **Inject**: pick a draft → "⤓ Inject…" → choose the target (global settings / a character's memory file), confirm twice, then it's written; the panel keeps an "injected" ledger for review.

### 10. Panel Admin AI (agent)

Open the golden "◈ Panel Admin" entry in the sidebar for the built-in assistant:

- **Reads**: list/inspect bots, models, global settings; read any bot's memory files & sessions; full-text keyword search across the memory vault; and propose changes.
- **Safe-write model**: every change goes through "pending" — the admin only generates proposals (`propose_memory_edit / propose_global_edit / propose_bot_config_edit`), you press **Apply** to actually write; or ignore / edit it.
- **Summary & moments**: exposes `summarize_moments` (writes highlight moments) plus persona rewrite, story cleanup, content summaries.
- **Persistent sessions**: history list on the right keeps each conversation across visits; "New chat" anytime. Streaming output by default.
- **Fixed guidelines**: core instruction parts are hard-coded (see Settings → Web → Panel Admin) and keep the assistant in a read-only evaluation role.

### 11. Appearance & UI

- **Brand mark**: a crescent moon in light blue (`public/logo.svg`), used as the browser tab icon and the sidebar mark.

- **Accent color**: presets (default gold / blue / green / purple / red / cyan / orange / pink) or a custom color picker — the whole UI follows.
- **Light/dark theme**: one-click toggle, remembered.
- **Card background effects** (bot info card): `🌊 Pixel wave`, `✨ Light stream`, `🖥 Matrix rain`, `☄ Meteor`, `◽ Plain`.
- **Visual language**: glass cards with top glaze, dimensional buttons/switches, gold hover feedback; Settings is split into tabs (Appearance / Web / Global files / Usage) to keep things tidy.

### 12. Data & storage

| Data | Location | Notes |
|------|----------|-------|
| Panel & bot config | `config.json` | port, bots, models |
| Secrets | `.env` | QQ Secret, model API keys (or `env:VAR` refs in config) |
| Character memory | `memory/<id>/*.md` | persona & plot files |
| Session history | `memory/<id>/sessions.jsonl` | one JSON line per message |
| Global files | `memory/global/*.md` | user profile, global prompts |
| Usage stats | `memory/usage.jsonl` | token call log |
| Avatars | `avatars/` | uploaded avatars |
| **Local UI preferences** | browser `localStorage` | sidebar favorites, last position, accent color — **machine-local only**, not synced via `config.json` |

> Runtime data above is **not committed** to Git by default (see [Config & Security](#config--security-important)).

## Structure

```
server.js            Entry: HTTP panel + API + QQ bot scheduler
setup.js             one-shot init (auto-copies missing example configs)
安装并启动.bat        Windows one-click: install deps → init → run
lib/
  bots.js            QQ bot lifecycle & connection
  memory.js          memory vault / sessions / global settings
  models.js          OpenAI-compatible model calls (with tool support)
  qqv2.js            QQ v2 gateway
  search.js          web search (light + browser)
  store.js           config read/write
public/              Panel frontend (vanilla HTML/CSS/JS, no build step)
desktop/             Optional desktop shell (Tauri 2 source, see desktop/README.md)
  src-tauri/         Rust shell project (tauri.conf.json points at ../public)
  scripts/           packaging / env self-check / toolchain bootstrap
dist-setup/          Desktop installer output (build artifact, not committed)
memory/              Runtime data: character memory & chat logs (do NOT commit)
avatars/             Uploaded avatars (do NOT commit)
LICENSE              MIT license
```

## Config & Security (important)

| File | Purpose | Commit to repo |
|------|---------|----------------|
| `config.json` | port, bots, models | **No** (holds credentials; gitignored) |
| `.env` | QQ Secret, model API keys | **No** (gitignored) |
| `memory/` | character memory, chat logs | **No** (gitignored) |
| `avatars/` | uploaded avatars | No |
| `config.example.json` / `.env.example` | public placeholders | Yes |
| `dist-setup/` | desktop installer | No (build artifact, ships via Releases) |
| `desktop/src-tauri/target/` | Rust build intermediates (~4 GB per run) | **No** (gitignored) |

- The server listens on `127.0.0.1` only — the panel is local-only.
- CORS is opened to an explicit allow-list only (`tauri.localhost`, `localhost:1420`) — never `*`. The panel itself is same-origin and needs no CORS.
- Secrets can be stored directly in `config.json` or referenced as `env:VARIABLE_NAME` (recommended) so keys live in `.env`.
- The panel echoes keys back for editing convenience, but traffic stays on this machine.
- Before publishing this repo, make sure the runtime files above are not tracked; `.gitignore` excludes them by default.

## FAQ

- **Panel won't open**: confirm `npm start` succeeds and port 4357 is free; on Windows, `安装并启动.bat` / `启动面板.bat` check the port and open the browser for you.
- **Bot won't connect**: verify the Secret in `.env` and the AppID on the card; check terminal logs.
- **No reply / errors**: make sure the bot has a bound model and its `apiKeyEnv` key is valid (one-click test in the Models page).
- **Persona drift**: edit `memory/<id>/persona.md` / `plot.md`, and toggle "use global settings" to control whether global prompts are layered in.
- **Restart a storyline**: fork from history in Sessions, or summarize new events into memory files with AI filing.
- **Desktop shell says "cannot reach backend"**: expected — `node server.js` isn't running. Start the service, then hit retry in the shell. Don't restart only the shell: the CORS allow-list lives in the server, so both must be the new version.
- **`打包桌面版.bat` fails**: read `desktop/环境自检报告.txt` — it reports Rust / MSYS2 / WebView2 status individually. The first Rust dependency build is slow; that's normal.

## Changelog

### v1.1.0 — smarter sidebar + memory gallery + brand mark

**Added**

- **Sidebar sorting**: characters ordered by most recent chat, so whoever you just talked to is at hand.
- **Right-click favorite**: pin a character to the top (favorites group keeps recency order inside it).
- **Resume last position**: remembers "character + tab + thread" and restores it on reopen.
- **Memory gallery**: "highlight moments" promoted from the bot card's second row to a dedicated tab, card grid with summary & quote visible at once.
- **Workspace**: draft desk for the Admin AI — generate → park → inject into character memory on demand.
- **Brand mark**: crescent-moon SVG in light blue (`public/logo.svg`), also used as the tab icon.

**Changed**

- Panel Admin chat no longer offers a streaming toggle — streaming is always on, with automatic fallback when the environment can't hold a long connection.
- Removed the "max 3 per character" cap on heartbeat tasks.

**Fixed**

- Template literals (`${...}`) leaking into the UI inside icon buttons.
- Thread id not following a character switch, causing the previous character's thread to be loaded.
- Buttons losing their SVG icon after a temporary label swap (used `textContent` instead of `innerHTML`).

## License

Released under the [MIT License](LICENSE) — use, modify and redistribute freely, keeping the copyright notice.

QQ bot capabilities come from Tencent's official QQ Open Platform; follow their developer terms. This project is not affiliated with Tencent.
