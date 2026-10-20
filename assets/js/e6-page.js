/* ==========================================================================
   E6 图像转换页的交互逻辑
   --------------------------------------------------------------------------
   依赖：assets/js/e6-codec.js（E6Codec）
   面板方向由固件负责（打包后整体上下反转），上位机按正常方向量化、打包即可，
   不做任何翻转补偿；预览、导出、送图的字节方向完全一致。
   ========================================================================== */
(function () {
  'use strict';

  const Codec = window.E6Codec;
  const $ = (id) => document.getElementById(id);

  /**
   * 版本兜底：Service Worker 升级期间，可能出现「HTML 是新版、脚本还是旧缓存」，
   * 旧版 codec 没有 PALETTES，会在 initSelects 里抛错、表现为色板下拉空白、
   * 刷新几次才正常。这里直接给出可执行的提示，并亮出顶栏的「刷新缓存」按钮。
   */
  function bailOnStaleAssets(reason) {
    console.warn('[e6-page] ' + reason);
    const state = document.getElementById('convertState');
    if (state) {
      state.textContent = '脚本版本过旧，请刷新缓存';
      state.className = 'badge off';
    }
    const refresh = document.getElementById('btnRefreshCache');
    if (refresh) refresh.removeAttribute('hidden');
  }

  if (!Codec || !Codec.PALETTES || !Codec.getPalette || !Codec.PALETTE_IDS) {
    bailOnStaleAssets('e6-codec.js 版本过旧（缺少 PALETTES / getPalette），已停止初始化');
    return;
  }

  /* ---------------- 状态 ---------------- */
  const state = {
    image: null, // 源图（ImageBitmap / HTMLImageElement）
    srcImageData: null, // 按目标尺寸绘制后的源数据
    result: null, // { ids, bytes, imageData, width, height }
    zoom: 'fit',
    busy: false,
    sending: false, // 送图 / 刷图执行中（与转换的 busy 分开，互不干扰）
    autoTimer: null,
  };

  const el = {
    topbar: $('topbar'),
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    srcMeta: $('srcMeta'),
    fitMode: $('fitMode'),
    sizePreset: $('sizePreset'),
    imgW: $('imgW'),
    imgH: $('imgH'),
    bytesPreview: $('bytesPreview'),
    algo: $('algo'),
    paletteSelect: $('paletteSelect'),
    palettePreview: $('palettePreview'),
    serpentine: $('serpentine'),
    nameFilter: $('nameFilter'),
    brightness: $('brightness'),
    contrast: $('contrast'),
    strength: $('strength'),
    brightnessVal: $('brightnessVal'),
    contrastVal: $('contrastVal'),
    strengthVal: $('strengthVal'),
    btnConvert: $('btnConvert'),
    btnReset: $('btnReset'),
    convertState: $('convertState'),
    srcWrap: $('srcWrap'),
    outWrap: $('outWrap'),
    zoomSeg: $('zoomSeg'),
    colorStats: $('colorStats'),
    metaSize: $('metaSize'),
    metaBytes: $('metaBytes'),
    metaBpp: $('metaBpp'),
    outMeta: $('outMeta'),
    btnExportBin: $('btnExportBin'),
    btnExportC: $('btnExportC'),
    btnCopyHex: $('btnCopyHex'),
    hexOut: $('hexOut'),
    logBox: $('logBox'),
    btnClearLog: $('btnClearLog'),
    // 4 · 送图 / 刷图
    bleState: $('bleState'),
    bleStateText: $('bleStateText'),
    bleDeviceName: $('bleDeviceName'),
    btnConnect: $('btnConnect'),
    btnDisconnect: $('btnDisconnect'),
    slotSelect: $('slotSelect'),
    btnSend: $('btnSend'),
    btnRefresh: $('btnRefresh'),
    btnCancelSend: $('btnCancelSend'),
    refreshAfter: $('refreshAfter'),
    sendState: $('sendState'),
    sendMs: $('sendMs'),
    sendBar: $('sendBar'),
    sendSpeed: $('sendSpeed'),
  };

  /* ---------------- 日志 ---------------- */
  function log(type, text) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = document.createElement('div');
    line.className = 'log-line ' + (type || 'sys');
    const t = document.createElement('span');
    t.className = 'log-time';
    t.textContent = time;
    const m = document.createElement('span');
    m.className = 'log-msg';
    m.textContent = text;
    line.appendChild(t);
    line.appendChild(m);
    const pin = el.logBox.scrollHeight - el.logBox.scrollTop - el.logBox.clientHeight < 24;
    el.logBox.appendChild(line);
    while (el.logBox.childElementCount > 400) el.logBox.removeChild(el.logBox.firstChild);
    if (pin) el.logBox.scrollTop = el.logBox.scrollHeight;
  }

  /* ---------------- 送图 / 刷图（0x30 / 0x11） ----------------
     沿用命令测试页的规矩（docs/conventions.md）：
     ① 命令互斥：任一命令执行期间，除连接以外的命令控件全部禁用；
     ② 长命令用「空闲超时 + 心跳保活」，不用固定总超时；
     ③ 送图先擦后写：写响应回来就发下一片（不再等 DONE），末尾等 DONE 到齐确认落盘，单片最多试 3 次；
     ④ 送图只写 Flash 不显示，要显示必须再发 0x11。
     送图与刷图共用同一个槽位下拉 el.slotSelect。 */
  const BLE = window.EPDBLE || null;
  const SLOT_MAX = 10; // 固件 FLASH_IMAGE_MAX_COUNT = 11，槽号 0~10
  let locked = false; // 命令互斥锁
  let sendAbort = false; // 中止送图

  const client = BLE
    ? BLE.create({
        onLog: (type, text) => log(type, text),
        onStatus: (st, text) => {
          setBleStatus(st, text);
          const connected = st === 'connected';
          setBleConnected(connected);
          el.bleDeviceName.textContent = connected && client.device ? client.device.name || '' : '';
        },
        onHeartbeat: (cmd, count) => {
          // 0x01 只是「还在处理」：第一次心跳补一句说明，后续不再刷屏
          if (count !== 1) return;
          if (cmd === BLE.CMD.UPDATE_COLOR) log('sys', '刷屏仍在进行，收到设备心跳（保持等待）');
          else if (cmd === BLE.CMD.UPDATE_IMAGE) log('sys', '刷图仍在进行，收到设备心跳（保持等待）');
          else if (cmd === BLE.CMD.FLASH_ERASE) log('sys', '擦除仍在进行，收到设备心跳（保持等待）');
        },
      })
    : null;

  function fillSlotSelect() {
    for (let i = 0; i <= SLOT_MAX; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = '槽 ' + i;
      el.slotSelect.appendChild(opt);
    }
    el.slotSelect.value = '0';
  }

  function setBleStatus(st, text) {
    const connected = st === 'connected';
    const label = connected ? '已连接' : st === 'connecting' ? '连接中…' : '未连接';
    el.bleState.className = 'badge ' + (connected ? 'ok' : st === 'connecting' ? 'ready' : 'off');
    el.bleState.title = text || label;
    el.bleStateText.textContent = label;
  }

  function setBleConnected(on) {
    el.btnConnect.disabled = on;
    el.btnDisconnect.disabled = !on;
    el.nameFilter.disabled = on; // 已连接后前缀不再生效，和 BLE 命令测试页一致
    if (!on) locked = false; // 断开时清锁，避免重连后一直锁着
    applyCommandEnabled();
  }

  /** 命令卡片的状态徽章：「未执行 / 执行中… / 完成 / 失败」 */
  function setSendState(kind, text) {
    el.sendState.className = 'badge ' + (kind === 'ok' ? 'ok' : kind === 'running' ? 'ready' : 'off');
    el.sendState.textContent = text;
  }

  /** 卡片底部只有一个进度条：细粒度信息（第几片、重试、完成字节数）都写进日志 */
  function setSendProgress(ratio) {
    el.sendBar.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  }

  /** 送图只认正好 172800 字节（480×720 4bpp），转换结果尺寸不对就禁用按钮 */
  function imageReady() {
    return !!(BLE && state.result && state.result.bytes && state.result.bytes.length === BLE.IMAGE_BYTES);
  }

  /**
   * 命令互斥的唯一入口：命令控件可用 = 已连接 && 未锁定（新增命令必须挂到这里，
   * 否则会绕过互斥，见 docs/conventions.md §1）。
   */
  function applyCommandEnabled() {
    const usable = !!client && client.connected && !locked;
    el.slotSelect.disabled = !usable;
    el.btnSend.disabled = !usable || !imageReady();
    el.btnRefresh.disabled = !usable;
    el.refreshAfter.disabled = !usable; // 只是开关，同样在命令执行中锁住，免得中途改主意
    if (!usable) el.btnCancelSend.disabled = true;
  }

  function setCommandLock(value) {
    locked = value;
    applyCommandEnabled();
  }

  /* ---------------- 初始化控件 ---------------- */
  function initSelects() {
    Codec.ALGORITHMS.forEach((a) => {
      const opt = document.createElement('option');
      opt.value = a.value;
      opt.textContent = a.label;
      el.algo.appendChild(opt);
    });
    el.algo.value = 'floydSteinberg';

    // 色板选项直接由 Codec.PALETTES 生成，新增色板只改 codec，不用动页面
    Object.keys(Codec.PALETTES).forEach((key) => {
      const palette = Codec.PALETTES[key];
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = palette.name;
      el.paletteSelect.appendChild(opt);
    });
    el.paletteSelect.value = Codec.DEFAULT_PALETTE_KEY;
    renderPalette();

    updateSizeHint();
  }

  /** 画当前色板的 6 个色块 + hex（只影响量化目标，设备 id 不变） */
  function renderPalette() {
    const palette = Codec.getPalette(el.paletteSelect.value);
    el.palettePreview.innerHTML = '';
    palette.colors.forEach((c) => {
      const chip = document.createElement('span');
      chip.className = 'palette-chip';
      chip.title = c.name + '（设备 id ' + c.id + '）';
      const swatch = document.createElement('i');
      swatch.style.background = c.hex;
      const label = document.createElement('span');
      label.textContent = c.hex.replace('#', '').toUpperCase();
      chip.appendChild(swatch);
      chip.appendChild(label);
      el.palettePreview.appendChild(chip);
    });
  }

  function updateSizeHint() {
    const w = parseInt(el.imgW.value, 10) || 0;
    const h = parseInt(el.imgH.value, 10) || 0;
    el.bytesPreview.textContent = w && h ? Codec.frameBytes(w, h).toLocaleString() + ' 字节' : '—';
  }

  /* ---------------- 图片读取 ---------------- */
  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      log('err', '不是图片文件：' + file.name);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      state.image = img;
      el.srcMeta.textContent = file.name + ' · ' + img.naturalWidth + '×' + img.naturalHeight;
      el.btnConvert.disabled = false;
      log('sys', '已载入 ' + file.name + '（' + img.naturalWidth + '×' + img.naturalHeight + '）');
      convert('首次转换');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      log('err', '图片解码失败：' + file.name);
    };
    img.src = url;
  }

  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => loadFile(e.target.files && e.target.files[0]));

  ['dragenter', 'dragover'].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove('dragover');
    })
  );
  el.dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    loadFile(file);
  });

  /* ---------------- 参数变化 → 延迟自动重算 ---------------- */
  function scheduleAuto() {
    if (!state.image) return;
    clearTimeout(state.autoTimer);
    state.autoTimer = setTimeout(() => convert('参数变化'), 220);
  }

  el.algo.addEventListener('change', scheduleAuto);
  el.serpentine.addEventListener('change', scheduleAuto);
  el.fitMode.addEventListener('change', scheduleAuto);

  // 换色板 = 换量化的目标颜色，需要重算；设备 id 不变（黑0 白1 黄2 红3 蓝5 绿6）
  el.paletteSelect.addEventListener('change', () => {
    const palette = Codec.getPalette(el.paletteSelect.value);
    renderPalette();
    log('sys', '已切换色板：' + palette.name + '（' + palette.colors.map((c) => c.hex).join(' ') + '）');
    scheduleAuto();
  });

  [el.brightness, el.contrast, el.strength].forEach((input) => {
    input.addEventListener('input', () => {
      el.brightnessVal.textContent = el.brightness.value;
      el.contrastVal.textContent = el.contrast.value;
      el.strengthVal.textContent = el.strength.value + '%';
      scheduleAuto();
    });
  });

  // 分辨率下拉只保留 480×720（E6 面板）与「自定义」：选预设就回填宽高，
  // 选自定义不动作，由下面的宽/高输入框自由改；改到非预设值时下拉自动切到「自定义」
  el.sizePreset.addEventListener('change', () => {
    const v = el.sizePreset.value;
    if (v !== 'custom') {
      const [w, h] = v.split('x').map(Number);
      el.imgW.value = String(w);
      el.imgH.value = String(h);
      updateSizeHint();
      scheduleAuto();
    }
  });

  [el.imgW, el.imgH].forEach((input) =>
    input.addEventListener('input', () => {
      const key = el.imgW.value + 'x' + el.imgH.value;
      const options = Array.from(el.sizePreset.options).map((o) => o.value);
      el.sizePreset.value = options.includes(key) ? key : 'custom';
      updateSizeHint();
      scheduleAuto();
    })
  );

  // 「重置参数」只复位亮度 / 对比度 / 抖动强度这三项调图参数，
  // 算法、尺寸适配、目标分辨率、蛇形扫描、槽位等选择保持用户当前设置不动
  el.btnReset.addEventListener('click', () => {
    el.brightness.value = '0';
    el.contrast.value = '0';
    el.strength.value = '100';
    el.brightnessVal.textContent = '0';
    el.contrastVal.textContent = '0';
    el.strengthVal.textContent = '100%';
    log('sys', '已重置亮度 / 对比度 / 抖动强度');
    scheduleAuto();
  });

  /* ---------------- 转换主流程 ---------------- */
  function readDim() {
    const w = Math.max(8, Math.min(4096, parseInt(el.imgW.value, 10) || Codec.DEFAULT_WIDTH));
    const h = Math.max(8, Math.min(4096, parseInt(el.imgH.value, 10) || Codec.DEFAULT_HEIGHT));
    return { w, h };
  }

  function convert(reason) {
    if (!state.image) return;
    if (state.busy) return;
    const { w, h } = readDim();
    state.busy = true;
    el.convertState.textContent = '转换中…';
    el.convertState.className = 'badge off';

    // 让浏览器先把「转换中」画出来，再进入同步的图像计算
    setTimeout(() => {
      const t0 = performance.now();
      try {
        // 面板方向由固件在刷屏时处理，这里一律按正常方向量化 + 打包
        const drawn = Codec.drawFitted(state.image, w, h, el.fitMode.value, '#ffffff');
        state.srcImageData = drawn;
        renderSource(drawn, w, h);

        const res = Codec.dither(drawn, {
          algo: el.algo.value,
          palette: el.paletteSelect.value, // 实际选中的色板决定量化目标
          brightness: parseInt(el.brightness.value, 10),
          contrast: parseInt(el.contrast.value, 10),
          strength: parseInt(el.strength.value, 10) / 100,
          serpentine: el.serpentine.checked,
        });
        const bytes = Codec.pack(res.ids, w, h);
        state.result = { ids: res.ids, bytes, imageData: res.imageData, width: w, height: h };

        renderResult(res.imageData);
        renderStats(res.stats);
        renderOutputs(bytes, w, h);

        const ms = Math.round(performance.now() - t0);
        const colors = res.stats.filter((s) => s.count > 0).length;
        el.convertState.textContent = '完成 · ' + ms + ' ms · ' + colors + ' 色';
        el.convertState.className = 'badge ok';
        log('ok', '转换完成（' + reason + '）：' + w + '×' + h + '，' + bytes.length + ' 字节，' + ms + ' ms');
      } catch (err) {
        el.convertState.textContent = '转换失败';
        el.convertState.className = 'badge off';
        log('err', '转换失败：' + (err && err.message ? err.message : err));
      } finally {
        state.busy = false;
      }
    }, 16);
  }

  el.btnConvert.addEventListener('click', () => convert('手动转换'));

  /* ---------------- 预览渲染 ---------------- */
  function canvasInto(wrap, imageData) {
    wrap.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    wrap.appendChild(canvas);
    return canvas;
  }

  function applyZoom() {
    [el.srcWrap, el.outWrap].forEach((wrap) => {
      const canvas = wrap.querySelector('canvas');
      if (!canvas) return;
      if (state.zoom === 'fit') {
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
      } else {
        const z = parseInt(state.zoom, 10);
        canvas.style.width = canvas.width * z + 'px';
        canvas.style.height = canvas.height * z + 'px';
      }
    });
  }

  function renderSource(imageData, w, h) {
    canvasInto(el.srcWrap, imageData);
    applyZoom();
    el.metaSize.textContent = w + ' × ' + h;
  }

  function renderResult(imageData) {
    canvasInto(el.outWrap, imageData);
    applyZoom();
  }

  el.zoomSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-zoom]');
    if (!btn) return;
    state.zoom = btn.dataset.zoom;
    Array.from(el.zoomSeg.children).forEach((b) => b.classList.toggle('active', b === btn));
    applyZoom();
  });

  /* ---------------- 统计与输出 ---------------- */
  function renderStats(stats) {
    el.colorStats.innerHTML = '';
    stats.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'color-stat-row';
      const dot = document.createElement('span');
      dot.className = 'color-stat-dot';
      dot.style.background = s.hex;
      const name = document.createElement('span');
      name.textContent = s.name;
      const bar = document.createElement('span');
      bar.className = 'color-stat-bar';
      const fill = document.createElement('i');
      fill.style.width = (s.ratio * 100).toFixed(2) + '%';
      fill.style.background = s.hex;
      bar.appendChild(fill);
      const num = document.createElement('span');
      num.className = 'color-stat-num';
      num.textContent = (s.ratio * 100).toFixed(1) + '%';
      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(bar);
      row.appendChild(num);
      el.colorStats.appendChild(row);
    });
  }

  function renderOutputs(bytes, w, h) {
    el.metaSize.textContent = w + ' × ' + h;
    el.metaBytes.textContent = bytes.length.toLocaleString() + ' B';
    el.metaBpp.textContent = '4 bit';
    el.outMeta.textContent = w + '×' + h + ' · ' + bytes.length.toLocaleString() + ' 字节';
    el.hexOut.value = Codec.toHex(bytes, 128);
    [el.btnExportBin, el.btnExportC, el.btnCopyHex].forEach((b) => (b.disabled = false));
    applyCommandEnabled(); // 尺寸是否是 480×720 决定「送图」按钮能不能点
  }

  function download(name, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  }

  el.btnExportBin.addEventListener('click', () => {
    if (!state.result) return;
    const r = state.result;
    download('e6_' + r.width + 'x' + r.height + '.bin', new Blob([r.bytes], { type: 'application/octet-stream' }));
    log('ok', '已导出 e6_' + r.width + 'x' + r.height + '.bin（' + r.bytes.length + ' 字节）');
  });

  el.btnExportC.addEventListener('click', () => {
    if (!state.result) return;
    const r = state.result;
    const text = Codec.toCArray(r.bytes, 'gImageE6_' + r.width + 'x' + r.height, 16);
    download('e6_' + r.width + 'x' + r.height + '.h', text, 'text/plain');
    log('ok', '已导出 C 数组（' + r.width + '×' + r.height + '）');
  });

  el.btnCopyHex.addEventListener('click', async () => {
    if (!state.result) return;
    try {
      await navigator.clipboard.writeText(Codec.toHex(state.result.bytes));
      log('ok', '全部 ' + state.result.bytes.length + ' 字节已复制到剪贴板');
    } catch (err) {
      log('err', '复制失败：' + err.message);
    }
  });

  /* ---------------- 连接设备 ---------------- */
  el.btnConnect.addEventListener('click', async () => {
    if (!client) return;
    // 与 BLE 命令测试页一致：按设备名前缀过滤，留空则列出全部设备
    const namePrefix = (el.nameFilter.value || '').trim();
    try {
      await client.connect({ namePrefix }); // 默认 FFE0 服务 / FFE3 写 / FFE4 通知
    } catch (err) {
      if (err && err.name === 'NotFoundError') log('sys', '已取消设备选择');
      else log('err', '连接失败：' + (err && err.message ? err.message : err));
      setBleStatus('idle');
      setBleConnected(false);
    }
  });

  el.btnDisconnect.addEventListener('click', () => {
    if (!client) return;
    client.disconnect();
    setBleConnected(false);
  });

  /* ---------------- 送图（0x30）：擦除同槽 → 逐片写（勾了自动刷图则写完接着发 0x11） ---------------- */
  el.btnSend.addEventListener('click', async () => {
    if (!client) return;
    if (state.sending) return log('sys', '上一条命令还在执行，稍等');
    if (!client.connected) return log('err', '请先连接设备');
    if (!imageReady()) return log('err', '送图需要 480 × 720 的转换结果（172800 字节），当前结果尺寸不符');

    const slot = Number(el.slotSelect.value) || 0;
    const bytes = state.result.bytes; // 先取快照：送图期间再转换也不影响这一轮发送
    state.sending = true;
    setCommandLock(true);
    sendAbort = false;
    el.btnCancelSend.disabled = false;
    el.sendMs.textContent = '—';
    el.sendSpeed.textContent = '—';
    setSendState('running', '擦除中…');
    setSendProgress(0);
    const t0 = performance.now();
    let retries = 0;
    let uploaded = false; // 数据是否已写进 Flash：刷图失败时靠它区分「全失败」与「只是没显示出来」

    try {
      // 1) 先擦除目标槽并等 DONE —— 协议要求写图前槽是干净的
      log('sys', '开始擦除槽 ' + slot + ' …');
      setSendProgress(0);
      await client.eraseSlot(slot, {
        onRetry: (info) => log('sys', '擦除第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
      });
      log('ok', '槽 ' + slot + ' 擦除完成，开始送图（' + bytes.length + ' 字节 / ' + BLE.IMAGE_CHUNKS + ' 片）');

      // 2) 逐片写入：写响应回来就发下一片（不再等 DONE），最后统一等落盘确认
      setSendState('running', '送图中…');
      let lastSent = 0;
      let lastTime = performance.now();
      const res = await client.writeImage(slot, bytes, {
        idleMs: 5000,
        attempts: 3, // 每片最多试 3 次（GATT 并发 / 瞬时错误重发）
        shouldStop: () => sendAbort,
        onProgress: (p) => {
          const ratio = p.sent / p.total;
          setSendProgress(ratio);
          const now = performance.now();
          if (now - lastTime > 400) {
            const kbps = (p.sent - lastSent) / ((now - lastTime) / 1000) / 1024;
            el.sendSpeed.textContent = kbps.toFixed(1) + ' KB/s';
            lastSent = p.sent;
            lastTime = now;
          }
        },
        onRetry: (info) => {
          retries++;
          log('sys', '第 ' + (info.index + 1) + ' 片第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发');
        },
      });

      // 送图成功：数据已经在 Flash 里了。勾了「自动刷图」就接着发 0x11 把这一槽显示出来
      uploaded = true;
      let shown = false;
      if (el.refreshAfter.checked) {
        el.btnCancelSend.disabled = true; // 中止只作用于分片写入，刷图阶段不再需要
        setSendState('running', '刷图中…');
        setSendProgress(1);
        log('sys', '开始刷图：0x11 槽 ' + slot + '（该命令的完成通知 CMD 是 0x10，属固件约定）');
        await client.updateImage(slot, {
          onRetry: (info) => log('sys', '刷图第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
        });
        shown = true;
      }

      const sec = (performance.now() - t0) / 1000;
      el.sendMs.textContent = sec.toFixed(1) + ' s';
      setSendProgress(1);
      setSendState('ok', shown ? '完成 · 槽 ' + slot + ' 已显示' : '完成 · 槽 ' + slot + ' 已写入');
      log(
        'ok',
        '送图完成：槽 ' + slot + '，' + res.chunks + ' 片 / ' + res.bytes.toLocaleString() + ' 字节，' + sec.toFixed(1) + ' s' +
          (retries ? '，重试 ' + retries + ' 次' : '') +
          (shown ? '，已自动刷图显示' : '（数据已落盘，点「刷图」才会显示）')
      );
    } catch (err) {
      const sec = (performance.now() - t0) / 1000;
      el.sendMs.textContent = sec.toFixed(1) + ' s';
      const aborted = sendAbort;
      // 刷图失败时 742 片其实已经写好了：不能报成「送图失败」，否则用户会白重送一遍
      const what = aborted ? '已中止' : uploaded ? '送图成功但刷图失败' : '送图失败';
      setSendState('err', aborted ? '已中止' : uploaded ? '送图完成 · 刷图失败' : '失败');
      setSendProgress(0);
      log('err', what + '：' + err.message + (uploaded ? '（图片数据已落盘，可点「刷图」再试）' : ''));
    } finally {
      state.sending = false;
      setCommandLock(false);
      el.btnCancelSend.disabled = true;
      sendAbort = false;
    }
  });

  /* ---------------- 刷图（0x11）：把该槽已有的图刷到屏上 ---------------- */
  el.btnRefresh.addEventListener('click', async () => {
    if (!client) return;
    if (state.sending) return log('sys', '上一条命令还在执行，稍等');
    if (!client.connected) return log('err', '请先连接设备');

    const slot = Number(el.slotSelect.value) || 0;
    state.sending = true;
    setCommandLock(true);
    el.sendMs.textContent = '—';
    el.sendSpeed.textContent = '—';
    setSendState('running', '刷图中…');
    setSendProgress(1);
    const t0 = performance.now();

    try {
      log('sys', '开始刷图：0x11 槽 ' + slot + '（该命令的完成通知 CMD 是 0x10，属固件约定）');
      await client.updateImage(slot, {
        onRetry: (info) => log('sys', '刷图第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
      });
      const sec = (performance.now() - t0) / 1000;
      el.sendMs.textContent = sec.toFixed(1) + ' s';
      setSendProgress(1);
      setSendState('ok', '完成 · 槽 ' + slot + ' 已显示');
      log('ok', '刷图完成：槽 ' + slot + ' 已显示到屏上（' + sec.toFixed(1) + ' s）');
    } catch (err) {
      const sec = (performance.now() - t0) / 1000;
      el.sendMs.textContent = sec.toFixed(1) + ' s';
      setSendState('err', '失败');
      setSendProgress(0);
      log('err', '刷图失败：' + err.message + '（该槽可能还没送过图，先「送图」再「刷图」）');
    } finally {
      state.sending = false;
      setCommandLock(false);
    }
  });

  el.btnCancelSend.addEventListener('click', () => {
    if (!state.sending) return;
    sendAbort = true;
    el.btnCancelSend.disabled = true;
    log('sys', '已请求中止送图，等当前分片返回后停止');
  });

  /* ---------------- 其它 ---------------- */
  el.btnClearLog.addEventListener('click', () => {
    el.logBox.innerHTML = '';
  });

  /* ---------------- 吸顶条 ---------------- */
  const onScroll = () => el.topbar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------------- 启动 ---------------- */
  try {
    fillSlotSelect();
    setBleStatus('idle');
    setBleConnected(false);
    setSendProgress(0);
    initSelects();
    updateSizeHint();
    const test = Codec.selfTest();
    if (test.ok) log('ok', '编解码自检通过（4bpp 打包 / 反解一致）');
    else log('err', '编解码自检失败：' + test.reason);
  } catch (err) {
    // 多半是新旧脚本混用（SW 旧缓存），提示刷新而不是留一个「点了没反应」的页面
    bailOnStaleAssets('初始化失败：' + (err && err.message ? err.message : err) + '，可能是缓存了旧版脚本');
    return;
  }

  if (!BLE) {
    el.btnConnect.disabled = true;
    log('err', '未加载 assets/js/ble.js，送图 / 刷图不可用（只能转换和导出）');
  } else if (!navigator.bluetooth) {
    el.btnConnect.disabled = true;
    log('sys', '当前浏览器不支持 Web Bluetooth：可以转换和导出，但不能送图 / 刷图。请用 Chrome / Edge（HTTPS 或 localhost）');
  } else {
    log('sys', '送图 / 刷图已就绪：连接设备后，同一个槽位下拉框先后「送图（0x30）」「刷图（0x11）」，勾「送完自动刷图」可一步到屏');
  }

  /* 演示模式：?demo=1 时生成一张测试图，方便没有素材时验证效果 */
  function loadDemo() {
    const c = document.createElement('canvas');
    c.width = 960;
    c.height = 1440;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const bars = ['#000000', '#ffffff', '#ffe600', '#e8332a', '#1b57c4', '#1f9d55'];
    bars.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, (c.height / bars.length) * i, c.width, c.height / bars.length);
    });
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(60, 560, c.width - 120, 320);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 96px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('EPD Toolbox', c.width / 2, 700);
    ctx.font = '54px "Microsoft YaHei", sans-serif';
    ctx.fillText('E6 六色测试图', c.width / 2, 800);
    const img = new Image();
    img.onload = () => {
      state.image = img;
      el.srcMeta.textContent = '演示测试图 · ' + img.naturalWidth + '×' + img.naturalHeight;
      el.btnConvert.disabled = false;
      log('sys', '演示模式：已生成 E6 六色测试图');
      convert('演示图');
    };
    img.src = c.toDataURL('image/png');
  }

  if (new URLSearchParams(location.search).get('demo') === '1') loadDemo();
})();
