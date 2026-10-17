/* ==========================================================================
   E6 图像转换页的交互逻辑
   --------------------------------------------------------------------------
   依赖：assets/js/e6-codec.js（E6Codec）
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
        const src = Codec.drawFitted(state.image, w, h, el.fitMode.value, '#ffffff');
        state.srcImageData = src;
        renderSource(src, w, h);

        const res = Codec.dither(src, {
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

  /* ---------------- 其它 ---------------- */
  el.btnClearLog.addEventListener('click', () => {
    el.logBox.innerHTML = '';
  });

  /* ---------------- 吸顶条 ---------------- */
  const onScroll = () => el.topbar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------------- 启动 ---------------- */
  initSelects();
  updateSizeHint();
  const test = Codec.selfTest();
  if (test.ok) log('ok', '编解码自检通过（4bpp 打包 / 反解一致）');
  else log('err', '编解码自检失败：' + test.reason);

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
