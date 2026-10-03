// ESLint 扁平配置（ESLint 9）
//
// 定位：架构拆分（批 1–5）的「搬家安全网」。
// 拆分时最容易犯的错是：函数搬走了引用没跟着走、复制粘贴留下重复键、
// 变量重名互相覆盖、搬完留了一段永远走不到的代码。这几类问题靠人眼几乎看不出来，
// 但 lint 一跑就现形。
//
// 因此这里刻意只开「正确性」类规则，一条格式/风格规则都不开
// （不装 eslint-config-prettier、不开 indent/quotes/semi 等）。
// 理由：本项目现有代码 9700 行、从未过过 lint，一旦引入风格规则，
// 第一次运行就会刷出成千上万条与本次重构无关的告警，把真正的信号完全淹掉。
//
// 用法：
//   npm run lint          检查
//   npm run lint -- --fix 自动修复（仅对可自动修复的项生效）

import globals from 'globals';

// 能抓出「搬家事故」的规则集合 —— 全项目统一适用
const CORRECTNESS = {
  // 引用了不存在的变量：函数搬走但引用没搬 → 必抓
  'no-undef': 'error',
  // 对象字面量里重复的键：复制粘贴残留
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  // 函数/参数/类成员重复定义
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  // 给不该赋值的绑定赋值：作用域搬错时最容易撞上
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-class-assign': 'error',
  'no-import-assign': 'error',
  // 同一作用域重复声明（搬文件时同名残留）
  'no-redeclare': 'error',
  // 永远走不到 / 无意义的代码
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  // 明显写错的内建调用
  'no-obj-calls': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-fallthrough': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  // 仅告警：现有代码里存量不少，报错会直接卡住门禁，
  // 但作为 warn 保留信号——拆分时若新冒出未使用变量，多半是搬漏了调用点
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
};

export default [
  {
    // 构建产物、第三方代码、用户数据目录一律不检查
    ignores: [
      'node_modules/**',
      'dist-setup/**',
      'playwright-browsers/**',
      'desktop/**',        // Tauri 壳，含 Rust 工程与独立 node_modules
      'avatars/**',        // 用户上传的头像
      'memory/**',         // 用户记忆数据（.md / .jsonl，非代码）
      '.tmp-diagnostics/**',
    ],
  },
  {
    // 后端：CommonJS
    files: ['server.js', 'setup.js', 'lib/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: CORRECTNESS,
  },
  {
    // Playwright 的 page.evaluate(fn) 会把 fn 序列化后【送到浏览器里执行】，
    // 所以这类回调里的 document / window 是合法的浏览器全局，
    // 按 Node 环境解析就会误报 no-undef。lib/search.js 是唯一含这种
    // 「跨上下文代码」的 Node 文件，因此只对它的 globals 做最小补充。
    files: ['lib/search.js'],
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly', navigator: 'readonly' },
    },
  },
  {
    // 工具脚本：ESM（.mjs 强制按模块解析，不受 package.json 的 type 影响）
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: CORRECTNESS,
  },
  {
    // 真机验证脚本（scripts/verify-*.mjs）：含大量 page.evaluate(fn) ——
    // 回调被序列化后送到浏览器里执行，里面的 document 是合法的浏览器全局。
    // 与上面 lib/search.js 同一个理由，只是这些脚本整篇都在写跨上下文代码。
    files: ['scripts/verify-*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // 前端：原生 <script>（非 module），靠全局作用域共享顶层函数，
    // 正是为了配合 index.html 里的内联 onclick="fn()"
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: CORRECTNESS,
  },
];
