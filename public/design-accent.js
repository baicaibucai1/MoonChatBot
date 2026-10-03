/* ============================================================================
   design-accent.js — 强调色的自适应前景色
   ----------------------------------------------------------------------------
   主题色（--accent）由用户在「设置 → 外观」里任选，既可能是深蓝，也可能是
   浅黄。CSS 无法按颜色亮度分支，所以这里只做一件事：
   读 --accent，算出它该配深色字还是浅色字，写回 --on-primary /
   --on-primary-container。纯 UI 层，不改动任何业务逻辑。
   ========================================================================= */
(function () {
  var root = document.documentElement;

  /* 一次性迁移：把旧版默认的黄色强调色换成新设计语言的默认色。
     只搬「值等于旧默认色」的情况，用户自己挑过的颜色不动。 */
  try {
    var OLD_DEFAULT = '#f5b301';
    var NEW_DEFAULT = '#1a73e8';
    var FLAG = 'qqbot-accent-v3-migrated';
    if (!localStorage.getItem(FLAG)) {
      localStorage.setItem(FLAG, '1');
      if ((localStorage.getItem('qqbot-accent') || '').toLowerCase() === OLD_DEFAULT) {
        localStorage.setItem('qqbot-accent', NEW_DEFAULT);
        root.style.setProperty('--accent', NEW_DEFAULT);
      }
    }
  } catch (e) { /* 无 localStorage（隐私模式）时跳过 */ }

  function parseColor(v) {
    if (!v) return null;
    v = v.trim();
    var m;
    if ((m = v.match(/^#([0-9a-f]{3})$/i))) {
      return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
    }
    if ((m = v.match(/^#([0-9a-f]{6})$/i))) {
      return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    }
    if ((m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i))) {
      return [+m[1], +m[2], +m[3]];
    }
    return null;
  }

  /* 相对亮度（WCAG / sRGB） */
  function luminance(rgb) {
    var c = rgb.map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function isDarkTheme() {
    return root.getAttribute('data-theme') === 'dark';
  }

  /* 对比度：WCAG 相对亮度比值 */
  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  function sync() {
    var raw = root.style.getPropertyValue('--accent') ||
              getComputedStyle(root).getPropertyValue('--accent');
    var rgb = parseColor(raw);
    if (!rgb) return;

    /* --on-primary 只看「强调色本身有多亮」，不看当前明暗主题。
       原因：app.js 会把用户保存的强调色以内联样式写到根元素上，
       它会盖掉 [data-theme=dark] 里那套「暗底降饱和」的强调色。
       于是暗色主题下 --accent 很可能仍是一条深蓝（#1a73e8），
       此时若按主题分支给出深色字，就是深字压深蓝 —— 实测只有 3.3:1。
       所以统一规则：底亮用深字，底暗用白字，两种主题都一样。 */
    var dark = [31, 33, 35], light = [255, 255, 255];
    var onPrimary = contrast(rgb, dark) >= contrast(rgb, light) ? '#1f2123' : '#ffffff';
    root.style.setProperty('--on-primary', onPrimary);

    /* 容器色随主题变（亮主题是淡色调、暗主题是深色调），文字走向也就相反 */
    if (isDarkTheme()) {
      root.style.setProperty('--on-primary-container', 'color-mix(in srgb, var(--accent) 68%, #ffffff)');
    } else {
      root.style.setProperty('--on-primary-container', 'color-mix(in srgb, var(--accent) 74%, #000000)');
    }
  }

  sync();
  /* 主题色切换 / 明暗切换都会改根元素属性，跟着重算 */
  if (window.MutationObserver) {
    new MutationObserver(sync).observe(root, {
      attributes: true,
      attributeFilter: ['style', 'data-theme']
    });
  }
})();
