/* ==========================================================================
   EPD Toolbox — Service Worker
   --------------------------------------------------------------------------
   目标：页面能「安装到桌面」并离线打开（BLE 要连设备，离线只能做图像处理）。

   策略：
     - 导航请求（HTML）：网络优先，失败回退缓存；这样改完页面刷新就能拿到新版
     - 静态资源（JS / CSS / 图标 / manifest）：缓存优先 + 后台悄悄更新
       （stale-while-revalidate），断网也能打开
     - 只处理同源 GET，跨域请求（GitHub、其他设备）直接放行
     - 新版本 install 时 skipWaiting()、activate 时 clients.claim() 并清旧缓存，
       页面里的 pwa.js 监听 controllerchange 后提示「刷新缓存」

   改版时记得把 VERSION 加一，PRECACHE 里新增/删除文件也要同步，
   否则离线包会缺文件（见 docs/conventions.md §13）。
   ========================================================================== */

const VERSION = 'epd-toolbox-v1';
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

  // 导航：网络优先，断网回退缓存
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        try {
          const response = await fetch(request);
          // 用「路径」作缓存键，忽略 ?demo=1 这类查询串
          cache.put(new Request(url.origin + url.pathname), response.clone()).catch(() => {});
          return response;
        } catch (err) {
          const cached =
            (await cache.match(new Request(url.origin + url.pathname), { ignoreSearch: true })) ||
            (await cache.match(request, { ignoreSearch: true }));
          return cached || (await cache.match('./index.html')) || Response.error();
        }
      })()
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  event.respondWith(
    (async () => {
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
    })()
  );
});
