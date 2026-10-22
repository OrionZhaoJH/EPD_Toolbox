/* ==========================================================================
   PWA 自测（无依赖，node tests/pwa.test.mjs）
   --------------------------------------------------------------------------
   钉住三件事（对应 docs/conventions.md §13）：
     1. manifest 能被解析，且有 192 / 512 图标且文件真实存在
     2. sw.js 的 PRECACHE 清单里的文件都存在（漏文件 = 装了 PWA 某页打不开）
     3. 三个页面都引了 manifest / pwa.js，并各有一枚安装与刷新缓存按钮
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const has = (p) => existsSync(resolve(root, p));

const fail = [];
const ok = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else {
    console.error('  ✗ ' + msg);
    fail.push(msg);
  }
};

console.log('PWA 自测');

/* 1. manifest */
{
  let manifest = null;
  try {
    manifest = JSON.parse(read('manifest.webmanifest'));
  } catch (err) {
    console.error('  ✗ manifest 不是合法 JSON：' + err.message);
    fail.push('manifest JSON');
  }
  if (manifest) {
    ok(!!manifest.name && !!manifest.short_name, 'manifest 有 name / short_name');
    ok(manifest.display === 'standalone', 'display = standalone');
    ok(!!manifest.start_url && !!manifest.scope, 'start_url / scope 已设置');

    const icons = manifest.icons || [];
    const sizes = icons.map((i) => i.sizes);
    ok(sizes.includes('192x192') && sizes.includes('512x512'), '图标含 192x192 与 512x512');
    ok(
      icons.some((i) => (i.purpose || '').split(' ').includes('maskable')),
      '有 maskable 图标'
    );

    const missing = icons.filter((i) => !has(i.src)).map((i) => i.src);
    ok(missing.length === 0, missing.length ? '图标文件缺失：' + missing.join(', ') : '图标文件都存在');

    const shortcuts = manifest.shortcuts || [];
    const badShortcut = shortcuts.filter((s) => !has(s.url)).map((s) => s.url);
    ok(badShortcut.length === 0, badShortcut.length ? '快捷方式指向的文件不存在：' + badShortcut.join(', ') : '快捷方式页面都存在');
  }
}

/* 2. sw.js 的 PRECACHE */
{
  const sw = read('sw.js');
  ok(/const VERSION = 'epd-toolbox-v\d+'/.test(sw), 'VERSION 形如 epd-toolbox-vN');

  const listMatch = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
  ok(!!listMatch, '找到 PRECACHE 清单');
  if (listMatch) {
    const entries = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    ok(entries.length >= 10, 'PRECACHE 至少 10 项（当前 ' + entries.length + '）');
    ok(entries.includes('./assets/js/pwa.js'), 'PRECACHE 含 pwa.js');
    ok(entries.includes('./manifest.webmanifest'), 'PRECACHE 含 manifest');
    const missing = entries
      .filter((p) => p !== './')
      .filter((p) => !has(p.replace(/^\.\//, '')))
      .map((p) => p);
    ok(missing.length === 0, missing.length ? 'PRECACHE 指向的文件不存在：' + missing.join(', ') : 'PRECACHE 里的文件都存在');
  }

  // 脚本 / 样式必须走网络优先：否则发版后会出现「HTML 新、脚本旧」的混搭
  ok(/const CODE_ASSET = \/\\\.\(\?:js\|css\)\$\/i/.test(sw) || sw.includes('CODE_ASSET'), 'sw.js 有 CODE_ASSET 判定');
  ok(sw.includes('networkFirst') && sw.includes('staleWhileRevalidate'), 'sw.js 同时提供网络优先与缓存优先两种策略');
}

/* 2.1 色板已回退：页面不应再有 paletteSelect / e6-page 不应再依赖 PALETTES */
{
  const page = read('e6-image.html');
  const js = read('assets/js/e6-page.js');
  ok(!page.includes('paletteSelect'), 'e6-image.html 已移除色板下拉');
  ok(!page.includes('palettePreview'), 'e6-image.html 已移除色板预览');
  ok(!js.includes('paletteSelect') && !js.includes('Codec.PALETTES'), 'e6-page.js 不再引用色板 API');
}

/* 3. 三个页面的接入 */
{
  const pages = ['index.html', 'e6-image.html', 'ble-console.html'];
  for (const page of pages) {
    const html = read(page);
    const checks = {
      'manifest 链接': html.includes('rel="manifest" href="manifest.webmanifest"'),
      'apple-touch-icon': html.includes('rel="apple-touch-icon"'),
      '引入 pwa.js': html.includes('src="assets/js/pwa.js"'),
      '安装按钮唯一': (html.match(/id="pwaInstallBtn"/g) || []).length === 1,
      '刷新缓存按钮唯一': (html.match(/id="btnRefreshCache"/g) || []).length === 1,
      '按钮默认 hidden': /id="pwaInstallBtn"[^>]*hidden/.test(html) && /id="btnRefreshCache"[^>]*hidden/.test(html),
    };
    const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    ok(bad.length === 0, page + (bad.length ? ' 缺少：' + bad.join('、') : ' PWA 接入完整'));
  }
}

if (fail.length) {
  console.error('\n失败 ' + fail.length + ' 项');
  process.exit(1);
}
console.log('\n全部通过');
