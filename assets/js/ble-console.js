/* ==========================================================================
   BLE 命令测试页
   --------------------------------------------------------------------------
   逐条下发固件已实现的 CHAR3 命令：
     0x00 CHAR3_CMD_00_REVISION      读 IC 版本
     0x10 CHAR3_CMD_10_UPDATE_COLOR  刷纯色（六色可选）
     0x20 CHAR3_CMD_20_FLASH_ERASE   擦除图片槽
   依赖：e6-codec.js（六色调色板）、ble.js（连接与组帧）
   ========================================================================== */
(function () {
  'use strict';

  const Codec = window.E6Codec;
  const BLE = window.EPDBLE;
  const $ = (id) => document.getElementById(id);

  const CMD = BLE.CMD;
  const SLOT_MAX = 10; // 固件 FLASH_IMAGE_MAX_COUNT = 11（槽 0~10）

  const el = {
    topbar: $('topbar'),
    bleWarn: $('bleWarn'),
    bleStatus: $('bleStatus'),
    bleStatusText: $('bleStatusText'),
    bleStatusTop: $('bleStatusTop'),
    bleStatusTopText: $('bleStatusTopText'),
    bleDeviceName: $('bleDeviceName'),
    nameFilter: $('nameFilter'),
    uuidService: $('uuidService'),
    uuidWrite: $('uuidWrite'),
    uuidNotify: $('uuidNotify'),
    btnConnect: $('btnConnect'),
    btnDisconnect: $('btnDisconnect'),

    colorGrid: $('colorGrid'),
    colorFrame: $('colorFrame'),
    colorState: $('colorState'),
    colorMs: $('colorMs'),

    btnRev: $('btnRev'),
    revFrame: $('revFrame'),
    revResult: $('revResult'),
    revState: $('revState'),
    revMs: $('revMs'),

    slotSelect: $('slotSelect'),
    btnErase: $('btnErase'),
    eraseFrame: $('eraseFrame'),
    eraseState: $('eraseState'),
    eraseMs: $('eraseMs'),

    upSlotSelect: $('upSlotSelect'),
    btnUploadTest: $('btnUploadTest'),
    btnUploadCancel: $('btnUploadCancel'),
    upState: $('upState'),
    upMs: $('upMs'),
    upBar: $('upBar'),
    upText: $('upText'),
    upSpeed: $('upSpeed'),
    upPreview: $('upPreview'),
    upFrame: $('upFrame'),

    logBox: $('logBox'),
    btnClearLog: $('btnClearLog'),
  };

  let selectedColor = 0; // 默认黑
  let busy = false; // 同一时刻只跑一条命令，避免响应互相顶掉
  let locked = false; // 有命令在执行：所有命令卡片禁用，直到完成/超时/出错
  let testImage = null; // 懒生成的六色棋盘图 { bytes, imageData }
  let uploadAbort = false; // 送图中止请求

  /* 长命令（刷屏可能几十秒）的进度：每 200ms 刷一次徽章，显示耗时与心跳次数 */
  let ticker = null;
  let cmdStart = 0;
  let hbCount = 0;

  function startProgress(badge, prefix) {
    stopProgress();
    cmdStart = performance.now();
    hbCount = 0;
    const paint = () => {
      const s = ((performance.now() - cmdStart) / 1000).toFixed(1);
      setCmdState(badge, 'running', prefix + ' ' + s + ' s' + (hbCount ? ' · 心跳 ' + hbCount : ''));
    };
    paint();
    ticker = setInterval(paint, 200);
  }

  function stopProgress() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

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

  /* ---------------- 状态 ---------------- */
  function setStatus(st, fullText) {
    const connected = st === 'connected';
    const label = connected ? '已连接' : st === 'connecting' ? '连接中…' : '未连接';
    const cls = 'badge ' + (connected ? 'ok' : st === 'connecting' ? 'ready' : 'off');
    [el.bleStatus, el.bleStatusTop].forEach((badge) => {
      badge.className = cls;
      badge.title = fullText || label;
    });
    el.bleStatusText.textContent = label;
    el.bleStatusTopText.textContent = label;
  }

  /** 命令卡片右上角的小状态：「未执行 / 执行中… / 成功 / 失败」 */
  function setCmdState(badge, kind, text) {
    badge.className = 'badge ' + (kind === 'ok' ? 'ok' : kind === 'running' ? 'ready' : 'off');
    badge.textContent = text;
  }

  /* ---------------- 控件初始化 ---------------- */
  function fillSlotSelect(select) {
    for (let i = 0; i <= SLOT_MAX; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = '槽 ' + i;
      select.appendChild(opt);
    }
    select.value = '0';
  }

  function initSlots() {
    fillSlotSelect(el.slotSelect); // 擦除卡片
    fillSlotSelect(el.upSlotSelect); // 送图卡片（独立选择，互不影响）
  }

  function initColors() {
    Codec.PALETTE.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-btn';
      btn.dataset.colorId = String(color.id);
      btn.disabled = true;
      btn.title = '下发刷' + color.name;

      const chip = document.createElement('span');
      chip.className = 'color-chip';
      chip.style.background = color.hex;

      const meta = document.createElement('span');
      meta.className = 'meta';
      const name = document.createElement('b');
      name.textContent = color.name;
      const id = document.createElement('span');
      id.textContent = 'color_id = ' + color.id;
      meta.appendChild(name);
      meta.appendChild(id);

      btn.appendChild(chip);
      btn.appendChild(meta);
      el.colorGrid.appendChild(btn);
    });
    selectColor(Codec.PALETTE[0].id);
  }

  function selectColor(id) {
    selectedColor = id;
    Array.from(el.colorGrid.children).forEach((btn) => {
      const on = Number(btn.dataset.colorId) === id;
      btn.classList.toggle('selected', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    updateFrames();
  }

  /** 每张卡片下方的「发送帧」预览，参数一变就重算，方便对照抓包 */
  function updateFrames() {
    const slot = Number(el.slotSelect.value) || 0;
    const upSlot = Number(el.upSlotSelect.value) || 0;
    el.revFrame.textContent = BLE.hex(BLE.buildFrame(CMD.REVISION, [0x00]));
    el.colorFrame.textContent = BLE.hex(BLE.buildFrame(CMD.UPDATE_COLOR, [selectedColor]));
    el.eraseFrame.textContent = BLE.hex(BLE.buildFrame(CMD.FLASH_ERASE, [slot]));
    if (testImage) {
      const head = BLE.buildImageChunkFrame(upSlot, 0, testImage.bytes.subarray(0, BLE.CHUNK_PAYLOAD));
      el.upFrame.textContent = BLE.hex(head.subarray(0, 16)) + ' … (' + head.length + ' 字节)';
    }
  }

  /* ---------------- 0x30 测试送图：六色棋盘图 ---------------- */
  /**
   * 生成 480×720 的六色棋盘：60px 方格，(cx + cy*2) % 6 保证上下左右相邻格不同色，
   * 直接走阈值量化（颜色本来就是调色板原色，不会被抖动改掉）再按 4bpp 打包。
   */
  function buildTestImage() {
    const w = Codec.DEFAULT_WIDTH;
    const h = Codec.DEFAULT_HEIGHT;
    const cell = 60;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const cols = Math.ceil(w / cell);
    const rows = Math.ceil(h / cell);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const color = Codec.PALETTE[(cx + cy * 2) % Codec.PALETTE.length];
        ctx.fillStyle = color.hex;
        ctx.fillRect(cx * cell, cy * cell, cell, cell);
      }
    }
    const src = ctx.getImageData(0, 0, w, h);
    const res = Codec.dither(src, { algo: 'threshold' });
    const bytes = Codec.pack(res.ids, w, h);
    return { bytes, imageData: res.imageData };
  }

  function getTestImage() {
    if (!testImage) testImage = buildTestImage();
    return testImage;
  }

  /** 生成一次并画到预览 canvas 上（启动时调用） */
  function initTestImage() {
    const img = getTestImage();
    const canvas = el.upPreview;
    canvas.width = img.imageData.width;
    canvas.height = img.imageData.height;
    canvas.getContext('2d').putImageData(img.imageData, 0, 0);
    log('sys', '已生成六色棋盘测试图：' + img.imageData.width + '×' + img.imageData.height + '，' + img.bytes.length + ' 字节');
    updateFrames();
  }

  function setProgress(ratio, text) {
    el.upBar.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
    if (text != null) el.upText.textContent = text;
  }

  /**
   * 命令互斥的唯一入口：命令控件是否可用 = 已连接 && 未锁定。
   * 任何新增的命令按钮/下拉都必须挂到这里，否则会绕过互斥（见 docs/conventions.md）。
   */
  function applyCommandEnabled() {
    const usable = !!client.connected && !locked;
    el.btnRev.disabled = !usable;
    el.btnErase.disabled = !usable;
    el.btnUploadTest.disabled = !usable;
    el.slotSelect.disabled = !usable;
    el.upSlotSelect.disabled = !usable;
    Array.from(el.colorGrid.children).forEach((btn) => (btn.disabled = !usable));
    if (!usable) el.btnUploadCancel.disabled = true;
  }

  /**
   * 执行中锁定所有命令卡片（读版本 / 刷纯色 / 擦除，含各自的参数控件），
   * 只有命令完成、超时或出错时才解锁；断开连接会顺带清锁。
   */
  function setCommandLock(value) {
    locked = value;
    applyCommandEnabled();
  }

  function setConnected(on) {
    el.btnConnect.disabled = on;
    el.btnDisconnect.disabled = !on;
    [el.nameFilter, el.uuidService, el.uuidWrite, el.uuidNotify].forEach((input) => (input.disabled = on));
    if (!on) locked = false; // 断开时清锁，避免重连后一直锁着
    applyCommandEnabled();
  }

  /* ---------------- BLE ---------------- */
  const client = BLE.create({
    onLog: (type, text) => log(type, text),
    onStatus: (st, text) => {
      setStatus(st, text);
      const connected = st === 'connected';
      setConnected(connected);
      el.bleDeviceName.textContent = connected && client.device ? client.device.name || '' : '';
      if (!connected) stopProgress();
    },
    onHeartbeat: (cmd, count) => {
      // 0x01 是「已受理 / 仍在处理」：既不能当失败，也不一定每个 cmd 都会发心跳
      hbCount = count;
      if (count !== 1) return;
      if (cmd === CMD.UPDATE_COLOR) {
        log('sys', '刷屏仍在进行，收到设备心跳（保持等待）');
      } else if (cmd === CMD.FLASH_ERASE) {
        log('sys', '擦除仍在进行，收到设备心跳（保持等待）');
      }
      // 0x30 送图是「每片一次 0x01」，进度条已经在报，不再逐片写日志
    },
  });

  el.nameFilter.addEventListener('input', updateFrames);
  el.slotSelect.addEventListener('change', updateFrames);
  el.upSlotSelect.addEventListener('change', updateFrames);

  el.btnConnect.addEventListener('click', async () => {
    try {
      await client.connect({
        namePrefix: el.nameFilter.value.trim(),
        serviceUuid: el.uuidService.value.trim() || 'ffe0',
        writeUuid: el.uuidWrite.value.trim() || 'ffe3',
        notifyUuid: el.uuidNotify.value.trim() || 'ffe4',
      });
    } catch (err) {
      if (err && err.name === 'NotFoundError') log('sys', '已取消设备选择');
      else log('err', '连接失败：' + (err && err.message ? err.message : err));
      setStatus('idle');
      setConnected(false);
    }
  });

  el.btnDisconnect.addEventListener('click', () => {
    client.disconnect();
    setConnected(false);
  });

  /* ---------------- 0x00 读版本 ---------------- */
  el.btnRev.addEventListener('click', async () => {
    if (busy) return log('sys', '上一条命令还在执行，稍等');
    busy = true;
    setCommandLock(true);
    setCmdState(el.revState, 'running', '执行中…');
    const t0 = performance.now();
    try {
      const frame = await client.readRevision();
      const ms = Math.round(performance.now() - t0);
      // 0x00 的应答没有响应码，PAYLOAD 就是 3 字节版本号
      const rev = BLE.hex(frame.data);
      el.revMs.textContent = ms + ' ms';
      el.revResult.textContent = 'IC Revision：' + (rev || '（响应无数据）') + '\n帧：' + BLE.hex(frame.raw);
      setCmdState(el.revState, 'ok', '成功');
      log('ok', '读版本成功：' + (rev || '无数据') + '（' + ms + ' ms）');
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      el.revMs.textContent = ms + ' ms';
      el.revResult.textContent = '失败：' + err.message;
      setCmdState(el.revState, 'err', '失败');
      log('err', '读版本失败：' + err.message);
    } finally {
      busy = false;
      setCommandLock(false); // 成功 / 失败 / 超时都解禁
    }
  });

  /* ---------------- 0x10 刷纯色 ---------------- */
  el.colorGrid.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-color-id]');
    if (!btn) return;
    const id = Number(btn.dataset.colorId);
    selectColor(id);
    if (busy) return log('sys', '上一条命令还在执行，稍等');

    const color = Codec.PALETTE.find((c) => c.id === id);
    busy = true;
    setCommandLock(true);
    startProgress(el.colorState, '刷屏中');
    const t0 = performance.now();
    try {
      await client.updateColor(id);
      const ms = Math.round(performance.now() - t0);
      stopProgress();
      el.colorMs.textContent = ms + ' ms';
      setCmdState(el.colorState, 'ok', '完成 · ' + (color ? color.name : 'id ' + id));
      log('ok', '刷纯色完成：' + (color ? color.name : 'id ' + id) + '（' + (ms / 1000).toFixed(1) + ' s，心跳 ' + hbCount + ' 次）');
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      stopProgress();
      el.colorMs.textContent = ms + ' ms';
      setCmdState(el.colorState, 'err', '失败');
      log('err', '刷纯色失败：' + err.message);
    } finally {
      busy = false;
      setCommandLock(false);
    }
  });

  /* ---------------- 0x20 擦除图片槽 ---------------- */
  el.btnErase.addEventListener('click', async () => {
    if (busy) return log('sys', '上一条命令还在执行，稍等');
    const slot = Number(el.slotSelect.value) || 0;
    if (!window.confirm('擦除槽 ' + slot + ' 的图片数据？该操作不可撤销。')) {
      log('sys', '已取消擦除槽 ' + slot);
      return;
    }
    busy = true;
    setCommandLock(true);
    startProgress(el.eraseState, '擦除中');
    const t0 = performance.now();
    try {
      await client.eraseSlot(slot, {
        onRetry: (info) => log('sys', '擦除第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
      });
      const ms = Math.round(performance.now() - t0);
      stopProgress();
      el.eraseMs.textContent = ms + ' ms';
      setCmdState(el.eraseState, 'ok', '完成');
      log('ok', '擦除槽 ' + slot + ' 完成（' + (ms / 1000).toFixed(1) + ' s）');
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      stopProgress();
      el.eraseMs.textContent = ms + ' ms';
      setCmdState(el.eraseState, 'err', '失败');
      log('err', '擦除槽 ' + slot + ' 失败：' + err.message);
    } finally {
      busy = false;
      setCommandLock(false);
    }
  });

  /* ---------------- 0x30 测试送图 ---------------- */
  el.btnUploadTest.addEventListener('click', async () => {
    if (busy) return log('sys', '上一条命令还在执行，稍等');
    const slot = Number(el.upSlotSelect.value) || 0;
    const img = getTestImage();

    busy = true;
    setCommandLock(true);
    uploadAbort = false;
    el.btnUploadCancel.disabled = false;
    el.upMs.textContent = '—';
    el.upSpeed.textContent = '—';
    setProgress(0, '准备中…');
    const t0 = performance.now();
    let retries = 0;

    try {
      // 1) 先擦除目标槽并等 DONE —— 协议要求写图前槽是干净的
      setCmdState(el.upState, 'running', '擦除中…');
      setProgress(0, '擦除槽 ' + slot + ' …');
      await client.eraseSlot(slot, {
        onRetry: (info) => log('sys', '擦除第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
      });
      log('ok', '槽 ' + slot + ' 擦除完成，开始送图（' + img.bytes.length + ' 字节 / ' + BLE.IMAGE_CHUNKS + ' 片）');

      // 2) 逐片写入，每片等 DONE
      setCmdState(el.upState, 'running', '送图中…');
      let lastSent = 0;
      let lastTime = performance.now();
      const res = await client.writeImage(slot, img.bytes, {
        idleMs: 5000,
        attempts: 3, // 每片最多试 3 次（GATT 并发/瞬时错误重发）
        shouldStop: () => uploadAbort,
        onProgress: (p) => {
          const ratio = p.sent / p.total;
          setProgress(
            ratio,
            '送图 ' + (p.index + 1) + '/' + p.count + ' 片 · ' + (ratio * 100).toFixed(1) + '% · ' +
              p.sent.toLocaleString() + '/' + p.total.toLocaleString() + ' 字节' +
              (retries ? ' · 重试 ' + retries + ' 次' : '')
          );
          const now = performance.now();
          if (now - lastTime > 400) {
            const kbps = (p.sent - lastSent) / ((now - lastTime) / 1000) / 1024;
            el.upSpeed.textContent = kbps.toFixed(1) + ' KB/s';
            lastSent = p.sent;
            lastTime = now;
          }
        },
        onRetry: (info) => {
          retries++;
          const msg = '第 ' + (info.index + 1) + ' 片第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发';
          log('sys', msg);
          el.upText.textContent = '重发第 ' + (info.index + 1) + ' 片（第 ' + info.attempt + ' 次重试）…';
        },
      });

      const sec = (performance.now() - t0) / 1000;
      el.upMs.textContent = sec.toFixed(1) + ' s';
      setProgress(1, '完成：' + res.chunks + ' 片 / ' + res.bytes.toLocaleString() + ' 字节' + (retries ? ' · 重试 ' + retries + ' 次' : ''));
      setCmdState(el.upState, 'ok', '完成 · 槽 ' + slot);
      log('ok', '送图完成：槽 ' + slot + '，' + res.chunks + ' 片，' + sec.toFixed(1) + ' s' + (retries ? '，重试 ' + retries + ' 次' : '') + '（固件暂无刷图命令，数据已落盘）');
    } catch (err) {
      const sec = (performance.now() - t0) / 1000;
      el.upMs.textContent = sec.toFixed(1) + ' s';
      const aborted = uploadAbort;
      setCmdState(el.upState, 'err', aborted ? '已中止' : '失败');
      el.upText.textContent = (aborted ? '已中止' : '失败') + '：' + err.message;
      log('err', '送图' + (aborted ? '中止' : '失败') + '：' + err.message);
    } finally {
      busy = false;
      setCommandLock(false);
      el.btnUploadCancel.disabled = true;
      uploadAbort = false;
    }
  });

  el.btnUploadCancel.addEventListener('click', () => {
    if (!busy) return;
    uploadAbort = true;
    el.btnUploadCancel.disabled = true;
    log('sys', '已请求中止送图，等当前分片返回后停止');
  });

  el.btnClearLog.addEventListener('click', () => {
    el.logBox.innerHTML = '';
  });

  /* ---------------- 吸顶条 ---------------- */
  const onScroll = () => el.topbar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------------- 启动 ---------------- */
  initSlots();
  initColors();
  initTestImage(); // 六色棋盘图 + 预览（同时刷新第一片帧头预览）
  updateFrames();
  setConnected(false);
  setProgress(0, '等待开始');

  if (!navigator.bluetooth) {
    el.bleWarn.hidden = false;
    el.btnConnect.disabled = true;
    log('sys', '当前浏览器不支持 Web Bluetooth，仅能查看发送帧');
  } else {
    log('sys', '命令测试页就绪：0x00 读版本 / 0x10 刷纯色 / 0x20 擦除图片槽 / 0x30 测试送图');
  }
})();
