/* ==========================================================================
   EPD Toolbox — Service Worker
   --------------------------------------------------------------------------
   目标：页面能「安装到桌面」并离线打开（BLE 要连设备，离线只能做图像处理）。

   策略（v2 起）：
     - 导航请求（HTML）：网络优先，失败回退缓存
     - **JS / CSS：网络优先**，失败才回退缓存
       以前这两类是「缓存优先」，发版后会变成「HTML 是新的、脚本还是旧缓存」，
       表现为色板下拉空白 / 要刷新几次才正常；改成网络优先后刷新即一致。
     - 图标 / manifest 等图片资源：缓存优先 + 后台更新（几乎不变，优先速度）
     - 只处理同源 GET，跨域请求（GitHub、其他设备）直接放行
     - 新版本 install 时 skipWaiting()、activate 时 clients.claim() 并清旧缓存，
       页面里的 pwa.js 监听 controllerchange 后提示「刷新缓存」

   改版时记得把 VERSION 加一，PRECACHE 里新增/删除文件也要同步，
   否则离线包会缺文件（见 docs/conventions.md §13）。
   ========================================================================== */

const VERSION = 'epd-toolbox-v3';
const PRECACHE = [
  './',
  './index.html',
  './e6-image.html',
  './ble-console.html',
  './manifest.webmanifest',
  './assets/css/app.css',
  './assets/js/e6-codec.js',
  './assets/js/ble.js',
  './assets/js/e6-page.js',
  './assets/js/ble-console.js',
  './assets/js/pwa.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon-180.png',
];

/** 会随发版变化的「代码资源」：必须网络优先，避免旧 HTML 配旧脚本 */
const CODE_ASSET = /\.(?:js|css)$/i;

/** 网络优先 + 缓存兜底：在线永远拿最新，离线才吃缓存；fallbackUrl 用于导航兜底到首页 */
async function networkFirst(request, cacheKey, fallbackUrl) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(cacheKey || request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    const cached =
      (await cache.match(cacheKey || request, { ignoreSearch: true })) ||
      (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    if (fallbackUrl) return (await cache.match(fallbackUrl)) || Response.error();
    return Response.error();
  }
}

/** 缓存优先 + 后台更新：只给几乎不动的图片 / manifest 用 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const fresh = await network;
  return fresh || Response.error();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 跨域不接管

  if (request.mode === 'navigate') {
    // 用「路径」作缓存键，忽略 ?demo=1 这类查询串；连缓存都没有时回退首页
    const key = new Request(url.origin + url.pathname);
    event.respondWith(networkFirst(request, key, './index.html'));
    return;
  }

  if (CODE_ASSET.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
