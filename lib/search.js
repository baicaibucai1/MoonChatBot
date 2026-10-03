// 联网搜索层：基于 Playwright 无头浏览器
// 提供 搜索(webSearch) 与 抓正文(webFetch)，免 key：直接驱动无头 Chromium
// 打开必应搜索页 / 目标网页，读取真实渲染后的内容
// ------------------------------------------------------------------
'use strict';
const path = require('node:path');
// 浏览器内核安装到项目内（playwright-browsers/），避免写入系统目录受限
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ||
  path.join(__dirname, '..', 'playwright-browsers');
const { chromium } = require('playwright');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 暴露给模型的工具定义
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索互联网，获取实时信息（新闻、天气、最新事件、百科资料等）。返回若干条搜索结果的标题、摘要与链接。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词或完整问题' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '打开指定网页链接，读取页面正文内容（用于获取搜索摘要之外的详细内容）。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要读取的网页完整 URL' } },
        required: ['url'],
      },
    },
  },
];

let _browser = null;          // 常驻浏览器实例（复用，避免每次冷启动）
let _lastSearchAt = 0;        // 简单限速：避免高频抓取被必应限制

function getBrowser() {
  if (_browser && _browser.isConnected()) return Promise.resolve(_browser);
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  }).then((b) => {
    _browser = b;
    return b;
  });
}

// 搜索：打开必应搜索页，提取结果（标题/链接/摘要）—— 浏览器版（可靠，需 Chromium）
async function searchBrowser(query, count = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  // 限速：距上次搜索不足 5 秒则等待
  const gap = Date.now() - _lastSearchAt;
  if (gap < 5000) await new Promise((r) => setTimeout(r, 5000 - gap));
  _lastSearchAt = Date.now();

  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: UA, locale: 'zh-CN' });
  try {
    const page = await context.newPage();
    await page.goto('https://cn.bing.com/search?q=' + encodeURIComponent(q), {
      timeout: 15000,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('li.b_algo', { timeout: 8000 }).catch(() => {});
    const items = await page.evaluate((max) => {
      const out = [];
      for (const el of document.querySelectorAll('li.b_algo')) {
        const a = el.querySelector('h2 a');
        if (!a) continue;
        const p = el.querySelector('.b_caption p, p');
        out.push({
          title: (a.textContent || '').trim().slice(0, 150),
          url: a.href || '',
          snippet: (p ? p.textContent : '').trim().slice(0, 300),
        });
        if (out.length >= max) break;
      }
      return out;
    }, count);
    return items;
  } catch (e) {
    return [];
  } finally {
    await context.close().catch(() => {});
  }
}

// 从必应搜索结果页 HTML 中提取结果（轻量版用）
function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function parseBingHtml(html) {
  const items = [];
  const blocks = String(html || '').split('<li class="b_algo"');
  for (let i = 1; i < blocks.length && items.length < 5; i++) {
    const b = blocks[i];
    const m = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m || (!m[2] && !m[1])) continue;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    items.push({
      title: stripHtml(m[2]).slice(0, 150),
      url: m[1],
      snippet: stripHtml(p ? p[1] : '').slice(0, 300),
    });
  }
  return items;
}

// 搜索：轻量版（纯 HTTP 抓必应搜索页解析，不启动浏览器，快且省资源）
async function searchLight(query, count = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const res = await fetch('https://cn.bing.com/search?q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    return parseBingHtml(await res.text()).slice(0, count);
  } catch (e) {
    return [];
  }
}

// 自动分级搜索：mode = 'auto'(默认，轻量优先，失败/无结果才升级浏览器) | 'light'(仅轻量) | 'browser'(仅浏览器)
async function smartSearch(query, mode = 'auto') {
  if (mode === 'browser') return searchBrowser(query);
  const light = await searchLight(query);
  if (mode === 'light') return light;
  if (light && light.length) return light; // auto：轻量有结果就直接返回
  return searchBrowser(query);             // auto：轻量失败/无结果 → 浏览器兜底
}

// 抓正文：打开网页，等待渲染，提取可见文本（去掉导航/脚本等）
async function webFetch(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: UA, locale: 'zh-CN' });
  try {
    const page = await context.newPage();
    await page.goto(u, { timeout: 15000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500); // 等待动态内容渲染
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      for (const sel of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'iframe', 'form', 'button']) {
        for (const el of clone.querySelectorAll(sel)) el.remove();
      }
      return (clone.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    });
    return text ? text.slice(0, 6000) : '';
  } catch (e) {
    return '';
  } finally {
    await context.close().catch(() => {});
  }
}

// 把搜索结果格式化为给模型看的文本
function formatResults(items) {
  if (!items || !items.length) return '没有搜索到相关结果';
  return items.map((it, i) => `${i + 1}. ${it.title}\n   链接：${it.url}\n   摘要：${it.snippet}`).join('\n\n');
}

// 进程退出时关闭浏览器
process.on('exit', () => { if (_browser) _browser.close().catch(() => {}); });

module.exports = { TOOLS, smartSearch, webFetch, formatResults };
