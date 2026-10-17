/* ==========================================================================
   E6 图像转换页的交互逻辑
   --------------------------------------------------------------------------
   依赖：assets/js/e6-codec.js（E6Codec）
   要点：「上下翻转」勾选框默认开启——面板装反了，屏上画面相对原图上下颠倒，
   所以只在算数据时（dither 之前）用 Codec.flipV() 把源图上下翻一次，预览始终是正常方向
   （见 docs/conventions.md §12；补偿放页面层，别写死进 codec 的 pack()）。
   ========================================================================== */
(function () {
  'use strict';

  const Codec = window.E6Codec;
  const $ = (id) => document.getElementById(id);

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
    serpentine: $('serpentine'),
    flipV: $('flipV'),
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
    sendState: $('sendState'),
    sendMs: $('sendMs'),
    sendBar: $('sendBar'),
    sendText: $('sendText'),
    sendSpeed: $('sendSpeed'),
    sendFrame: $('sendFrame'),
    refreshFrame: $('refreshFrame'),
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
     ③ 送图先擦后写、逐片等 DONE，单片最多试 3 次；
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
    if (!on) locked = false; // 断开时清锁，避免重连后一直锁着
    applyCommandEnabled();
  }

  /** 命令卡片的状态徽章：「未执行 / 执行中… / 完成 / 失败」 */
  function setSendState(kind, text) {
    el.sendState.className = 'badge ' + (kind === 'ok' ? 'ok' : kind === 'running' ? 'ready' : 'off');
    el.sendState.textContent = text;
  }

  function setSendProgress(ratio, text) {
    el.sendBar.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
    if (text != null) el.sendText.textContent = text;
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
    if (!usable) el.btnCancelSend.disabled = true;
    updateFrames();
  }

  function setCommandLock(value) {
    locked = value;
    applyCommandEnabled();
  }

  /** 槽位或转换结果一变就重算两条命令帧，方便对照协议表 / 抓包 */
  function updateFrames() {
    if (!BLE) return;
    const slot = Number(el.slotSelect.value) || 0;
    el.refreshFrame.textContent = BLE.hex(BLE.buildFrame(BLE.CMD.UPDATE_IMAGE, [slot]));
    if (imageReady()) {
      const head = BLE.buildImageChunkFrame(slot, 0, state.result.bytes.subarray(0, BLE.CHUNK_PAYLOAD));
      el.sendFrame.textContent = BLE.hex(head.subarray(0, 16)) + ' … (' + head.length + ' 字节)';
    } else {
      el.sendFrame.textContent = '—（需要 480 × 720 的转换结果）';
    }
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
    updateSizeHint();
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

  // 面板装反了：屏上画面相对原图上下颠倒，所以默认勾选，算数据前把源图上下翻一次。
  // 只影响导出的数据，预览保持正常方向；勾掉可以对比方向，同样自动重算
  el.flipV.addEventListener('change', () => {
    log(
      'sys',
      el.flipV.checked
        ? '已开启上下翻转：导出数据前把源图上下翻一次（预览不受影响）'
        : '已关闭上下翻转：按原图方向算数据'
    );
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

  el.btnReset.addEventListener('click', () => {
    el.brightness.value = '0';
    el.contrast.value = '0';
    el.strength.value = '100';
    el.brightnessVal.textContent = '0';
    el.contrastVal.textContent = '0';
    el.strengthVal.textContent = '100%';
    el.algo.value = 'floydSteinberg';
    el.fitMode.value = 'contain';
    el.serpentine.checked = true;
    el.flipV.checked = true;
    el.sizePreset.value = '480x720';
    el.imgW.value = '480';
    el.imgH.value = '720';
    updateSizeHint();
    log('sys', '参数已重置');
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
        // 预览始终按正常方向画（看到的和原图一致）；只有算数据时才按面板方向上下翻转，
        // 所以 state.srcImageData 存未翻转的图，zoom 重绘也不会跟着变
        const drawn = Codec.drawFitted(state.image, w, h, el.fitMode.value, '#ffffff');
        const data = el.flipV.checked ? Codec.flipV(drawn) : drawn;
        state.srcImageData = drawn;
        renderSource(drawn, w, h);

        const res = Codec.dither(data, {
          algo: el.algo.value,
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

  el.slotSelect.addEventListener('change', updateFrames);

  /* ---------------- 送图（0x30）：擦除同槽 → 逐片写 ---------------- */
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
    setSendProgress(0, '准备中…');
    const t0 = performance.now();
    let retries = 0;

    try {
      // 1) 先擦除目标槽并等 DONE —— 协议要求写图前槽是干净的
      setSendProgress(0, '擦除槽 ' + slot + ' …');
      await client.eraseSlot(slot, {
        onRetry: (info) => log('sys', '擦除第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
      });
      log('ok', '槽 ' + slot + ' 擦除完成，开始送图（' + bytes.length + ' 字节 / ' + BLE.IMAGE_CHUNKS + ' 片）');

      // 2) 逐片写入，每片等 DONE（天然流控，避免固件忙时回 BUSY 丢片）
      setSendState('running', '送图中…');
      let lastSent = 0;
      let lastTime = performance.now();
      const res = await client.writeImage(slot, bytes, {
        idleMs: 5000,
        attempts: 3, // 每片最多试 3 次（GATT 并发 / 瞬时错误重发）
        shouldStop: () => sendAbort,
        onProgress: (p) => {
          const ratio = p.sent / p.total;
          setSendProgress(
            ratio,
            '送图 ' + (p.index + 1) + '/' + p.count + ' 片 · ' + (ratio * 100).toFixed(1) + '% · ' +
              p.sent.toLocaleString() + '/' + p.total.toLocaleString() + ' 字节' +
              (retries ? ' · 重试 ' + retries + ' 次' : '')
          );
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
          el.sendText.textContent = '重发第 ' + (info.index + 1) + ' 片（第 ' + info.attempt + ' 次重试）…';
        },
      });

      const sec = (performance.now() - t0) / 1000;
      el.sendMs.textContent = sec.toFixed(1) + ' s';
      setSendProgress(
        1,
        '完成：' + res.chunks + ' 片 / ' + res.bytes.toLocaleString() + ' 字节' +
          (retries ? ' · 重试 ' + retries + ' 次' : '') + ' · 已落盘，点「刷图」显示'
      );
      setSendState('ok', '完成 · 槽 ' + slot + ' 已写入');
      log(
        'ok',
        '送图完成：槽 ' + slot + '，' + res.chunks + ' 片，' + sec.toFixed(1) + ' s' +
          (retries ? '，重试 ' + retries + ' 次' : '') + '（数据已落盘，点「刷图」才会显示）'
      );
    } catch (err) {
      const sec = (performance.now() - t0) / 1000;
      el.sendMs.textContent = sec.toFixed(1) + ' s';
      const aborted = sendAbort;
      setSendState('err', aborted ? '已中止' : '失败');
      setSendProgress(0, (aborted ? '中止' : '送图失败') + '：' + err.message);
      log('err', (aborted ? '已中止' : '送图失败') + '：' + err.message);
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
    setSendProgress(1, '刷图（0x11 · 槽 ' + slot + '）…');
    const t0 = performance.now();

    try {
      log('sys', '开始刷图：0x11 槽 ' + slot + '（该命令的完成通知 CMD 是 0x10，属固件约定）');
      await client.updateImage(slot, {
        onRetry: (info) => log('sys', '刷图第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
      });
      const sec = (performance.now() - t0) / 1000;
      el.sendMs.textContent = sec.toFixed(1) + ' s';
      setSendProgress(1, '完成：槽 ' + slot + ' 已显示到屏上');
      setSendState('ok', '完成 · 槽 ' + slot + ' 已显示');
      log('ok', '刷图完成：槽 ' + slot + ' 已显示到屏上（' + sec.toFixed(1) + ' s）');
    } catch (err) {
      const sec = (performance.now() - t0) / 1000;
      el.sendMs.textContent = sec.toFixed(1) + ' s';
      setSendState('err', '失败');
      setSendProgress(0, '刷图失败：' + err.message);
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
  fillSlotSelect();
  setBleStatus('idle');
  setBleConnected(false);
  setSendProgress(0, '等待开始');
  initSelects();
  updateSizeHint();
  const test = Codec.selfTest();
  if (test.ok) log('ok', '编解码自检通过（4bpp 打包 / 反解一致）');
  else log('err', '编解码自检失败：' + test.reason);

  if (!BLE) {
    el.btnConnect.disabled = true;
    log('err', '未加载 assets/js/ble.js，送图 / 刷图不可用（只能转换和导出）');
  } else if (!navigator.bluetooth) {
    el.btnConnect.disabled = true;
    log('sys', '当前浏览器不支持 Web Bluetooth：可以转换和导出，但不能送图 / 刷图。请用 Chrome / Edge（HTTPS 或 localhost）');
  } else {
    log('sys', '送图 / 刷图已就绪：连接设备后，同一个槽位下拉框先后「送图（0x30）」「刷图（0x11）」');
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
