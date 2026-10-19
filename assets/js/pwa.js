/* ==========================================================================
   PWA 支持（三个页面共用）
   --------------------------------------------------------------------------
   1. 注册 sw.js（离线缓存 / 安装能力），注册后立刻 update()：
      已安装的 PWA 每次启动都能马上检查并接管新版 SW（iOS 尤其需要）
   2. 「安装到桌面」按钮 #pwaInstallBtn：浏览器触发 beforeinstallprompt 时显示，
      点击后调用 prompt()；安装完成（appinstalled）自动隐藏
   3. 「刷新缓存」按钮 #btnRefreshCache：检测到 SW 换新版本（controllerchange）时
      才出现，点击清空本地缓存 + 更新 SW + 带 _v 参数重载，替代手机上按不出 Ctrl+F5

   页面只需要放两个 hidden 按钮：
     <button id="pwaInstallBtn" hidden>…</button>
     <button id="btnRefreshCache" hidden>…</button>
   ========================================================================== */
(function () {
  'use strict';

  const CACHE_PREFIX = 'epd-toolbox-';

  /* ---------------- 1. 注册 Service Worker ---------------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js', { scope: './' })
        .then((reg) => {
          if (reg) reg.update().catch(() => {});
        })
        .catch((err) => {
          console.warn('[PWA] Service Worker 注册失败：', err);
        });
    });
  }

  /* ---------------- 2. 安装到桌面 ---------------- */
  const installBtn = document.getElementById('pwaInstallBtn');
  let deferredPrompt = null;

  const showInstall = (show) => {
    if (!installBtn) return;
    if (show) installBtn.removeAttribute('hidden');
    else installBtn.setAttribute('hidden', '');
  };

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    showInstall(true);
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try {
        await deferredPrompt.userChoice;
      } catch (_) {
        /* 用户取消或浏览器不支持，忽略 */
      }
      deferredPrompt = null;
      showInstall(false);
    });
  }

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    showInstall(false);
  });

  /* ---------------- 3. 新版本 → 刷新缓存 ---------------- */
  const refreshBtn = document.getElementById('btnRefreshCache');
  if (!refreshBtn || !('serviceWorker' in navigator)) return;

  // 首次安装时 SW 接管页面也会触发 controllerchange，那种情况不提示
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    refreshBtn.removeAttribute('hidden');
    refreshBtn.classList.add('update-available');
  });

  refreshBtn.addEventListener('click', async () => {
    const label = refreshBtn.textContent;
    refreshBtn.textContent = '刷新中…';
    refreshBtn.disabled = true;
    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key)));
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    } catch (err) {
      console.warn('[PWA] 刷新缓存失败：', err);
    }
    const url = new URL(location.href);
    url.searchParams.set('_v', Date.now()); // 破坏 HTTP 缓存，强制重新拉取
    location.replace(url.href);
    refreshBtn.textContent = label;
  });
})();
