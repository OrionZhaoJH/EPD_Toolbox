/* ==========================================================================
   BLE 命令测试页
   --------------------------------------------------------------------------
   逐条下发固件已实现的 CHAR3 命令：
     0x00 CHAR3_CMD_00_REVISION      读 IC 版本
     0x10 CHAR3_CMD_10_UPDATE_COLOR  刷纯色（六色可选）
     0x11 CHAR3_CMD_11_UPDATE_IMAGE  刷图（把指定槽的图显示到屏上）
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
    // 连接状态徽章在顶栏：设备名在「已连接」左边（.badge-device），不再维护页内第二份状态
    bleStatus: $('bleStatus'),
    bleStatusText: $('bleStatusText'),
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

    btnTemp: $('btnTemp'),
    tempFrame: $('tempFrame'),
    tempResult: $('tempResult'),
    tempState: $('tempState'),
    tempMs: $('tempMs'),

    slotSelect: $('slotSelect'),
    btnErase: $('btnErase'),
    eraseFrame: $('eraseFrame'),
    eraseState: $('eraseState'),
    eraseMs: $('eraseMs'),

    imgSlotSelect: $('imgSlotSelect'),
    btnUpdateImage: $('btnUpdateImage'),
    imgState: $('imgState'),
    imgMs: $('imgMs'),
    imgFrame: $('imgFrame'),

    upSlotSelect: $('upSlotSelect'),
    upRefreshAfter: $('upRefreshAfter'),
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
    // 徽章只有顶栏这一处：设备名在同一徽章内、位于状态词左边
    el.bleStatus.className = cls;
    el.bleStatus.title = fullText || label;
    el.bleStatusText.textContent = label;
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
    fillSlotSelect(el.imgSlotSelect); // 刷图卡片（独立选择，互不影响）
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
    const imgSlot = Number(el.imgSlotSelect.value) || 0;
    el.revFrame.textContent = BLE.hex(BLE.buildFrame(CMD.REVISION, [0x00]));
    el.tempFrame.textContent = BLE.hex(BLE.buildFrame(CMD.TEMPERATURE, [0x00]));
    el.colorFrame.textContent = BLE.hex(BLE.buildFrame(CMD.UPDATE_COLOR, [selectedColor]));
    el.eraseFrame.textContent = BLE.hex(BLE.buildFrame(CMD.FLASH_ERASE, [slot]));
    el.imgFrame.textContent = BLE.hex(BLE.buildFrame(CMD.UPDATE_IMAGE, [imgSlot]));
    if (testImage) {
      const head = BLE.buildImageChunkFrame(upSlot, 0, testImage.bytes.subarray(0, BLE.CHUNK_PAYLOAD));
      el.upFrame.textContent = BLE.hex(head.subarray(0, 16)) + ' … (' + head.length + ' 字节)';
    }
  }

  /* ---------------- 0x30 测试送图：六色棋盘图 ----------------
     构造 480×720 六色棋盘并打包成 4bpp（172800 字节），供 0x30 卡片直接发送。 */
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
    el.btnTemp.disabled = !usable;
    el.btnErase.disabled = !usable;
    el.btnUpdateImage.disabled = !usable;
    el.btnUploadTest.disabled = !usable;
    el.slotSelect.disabled = !usable;
    el.upSlotSelect.disabled = !usable;
    el.imgSlotSelect.disabled = !usable;
    el.upRefreshAfter.disabled = !usable;
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
      } else if (cmd === CMD.UPDATE_IMAGE) {
        log('sys', '刷图仍在进行，收到设备心跳（保持等待）');
      } else if (cmd === CMD.FLASH_ERASE) {
        log('sys', '擦除仍在进行，收到设备心跳（保持等待）');
      }
      // 0x30 送图不再回 DOING（写响应即入队），DONE 只用来算进度，不逐片写日志
    },
  });

  el.nameFilter.addEventListener('input', updateFrames);
  el.slotSelect.addEventListener('change', updateFrames);
  el.upSlotSelect.addEventListener('change', updateFrames);
  el.imgSlotSelect.addEventListener('change', updateFrames);

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

  /* ---------------- 0x00 读版本 ----------------
     同步命令；应答没有响应码，结果框只写版本号，原始帧交给 ble.js 的 rx 日志。 */
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
      // 结果框只放版本号本身；完整响应帧由 ble.js 的 rx 日志记到底部收发日志里
      el.revResult.textContent = rev ? 'IC Revision：' + rev : '（响应无数据）';
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

  /* ---------------- 0x01 读温度 ----------------
     同步命令；应答同样没有响应码，PAYLOAD 就是 1 字节温度寄存器原值（TS[7:0]）。
     换算走 BLE.decodeTemperature()：0x00~0x32 = 0~50 ℃、0xE7~0xFF = -25~-1 ℃，
     其它编码超出规格，标「越界」但仍显示有符号解析值，方便排查读到的怪值。 */
  el.btnTemp.addEventListener('click', async () => {
    if (busy) return log('sys', '上一条命令还在执行，稍等');
    busy = true;
    setCommandLock(true);
    setCmdState(el.tempState, 'running', '执行中…');
    const t0 = performance.now();
    try {
      const frame = await client.readTemperature();
      const ms = Math.round(performance.now() - t0);
      const raw = frame.data.length ? frame.data[0] : 0;
      const t = BLE.decodeTemperature(raw);
      const rawHex = '0x' + raw.toString(16).padStart(2, '0').toUpperCase();
      el.tempMs.textContent = ms + ' ms';
      el.tempResult.textContent =
        'TS[7:0]：' + rawHex + ' → ' + t.celsius + ' ℃' +
        (t.valid ? '' : '（越界：规格 -25~50 ℃）');
      setCmdState(el.tempState, t.valid ? 'ok' : 'err', t.valid ? t.celsius + ' ℃' : '越界');
      if (t.valid) log('ok', '读温度成功：' + rawHex + ' → ' + t.celsius + ' ℃（' + ms + ' ms）');
      else log('err', '读温度越界：' + rawHex + ' → ' + t.celsius + ' ℃（规格 -25~50 ℃）');
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      el.tempMs.textContent = ms + ' ms';
      el.tempResult.textContent = '失败：' + err.message;
      setCmdState(el.tempState, 'err', '失败');
      log('err', '读温度失败：' + err.message);
    } finally {
      busy = false;
      setCommandLock(false);
    }
  });

  /* ---------------- 0x10 刷纯色 ----------------
     点颜色块即发；异步，靠 0x01 心跳续命，成功 / 失败 / 超时都在 finally 里解锁控件。 */
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

  /* ---------------- 0x11 刷图（显示指定槽） ----------------
     异步；完成通知的 CMD 是 0x10（固件 quirk），acceptCmds 已在 client.updateImage() 里配好。 */
  el.btnUpdateImage.addEventListener('click', async () => {
    if (busy) return log('sys', '上一条命令还在执行，稍等');
    const slot = Number(el.imgSlotSelect.value) || 0;
    busy = true;
    setCommandLock(true);
    startProgress(el.imgState, '刷图中');
    const t0 = performance.now();
    try {
      await client.updateImage(slot, {
        onRetry: (info) => log('sys', '刷图第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
      });
      const ms = Math.round(performance.now() - t0);
      stopProgress();
      el.imgMs.textContent = ms + ' ms';
      setCmdState(el.imgState, 'ok', '完成 · 槽 ' + slot);
      log('ok', '刷图完成：槽 ' + slot + ' 已显示到屏上（' + (ms / 1000).toFixed(1) + ' s，心跳 ' + hbCount + ' 次）');
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      stopProgress();
      el.imgMs.textContent = ms + ' ms';
      setCmdState(el.imgState, 'err', '失败');
      log('err', '刷图失败：槽 ' + slot + '（' + err.message + '）——槽里没有有效图片时先擦除并送图');
    } finally {
      busy = false;
      setCommandLock(false);
    }
  });

  /* ---------------- 0x20 擦除图片槽 ----------------
     异步但无心跳，按 60 s 空闲上限等待；发之前 window.confirm 二次确认，失败不自动重试。 */
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

  /* ---------------- 0x30 测试送图 ----------------
     擦除 → 742 片逐片发（ATT 写响应即「已入队」）→ 等 DONE 到齐确认落盘 →（可选）0x11 刷屏；
     中止 / 送图失败 / 送图成功但刷图失败分开提示。 */
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
    let uploaded = false; // 数据是否已完整落盘（区分「送图失败」和「送图成功但刷图失败」）
    const show = el.upRefreshAfter.checked;

    try {
      // 1) 先擦除目标槽并等 DONE —— 协议要求写图前槽是干净的
      setCmdState(el.upState, 'running', '擦除中…');
      setProgress(0, '擦除槽 ' + slot + ' …');
      await client.eraseSlot(slot, {
        onRetry: (info) => log('sys', '擦除第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
      });
      log('ok', '槽 ' + slot + ' 擦除完成，开始送图（' + img.bytes.length + ' 字节 / ' + BLE.IMAGE_CHUNKS + ' 片）');

      // 2) 逐片写入：写响应回来就发下一片（不再等 DONE），最后统一等落盘确认
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
            '送图 ' + (p.index + 1) + '/' + p.count + ' 片 · 已发 ' + (ratio * 100).toFixed(1) + '% · ' +
              '落盘 ' + ((p.flashed / p.total) * 100).toFixed(1) + '% · ' +
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

      uploaded = true;
      const sec = (performance.now() - t0) / 1000;
      el.upMs.textContent = sec.toFixed(1) + ' s';
      log('ok', '送图完成：槽 ' + slot + '，' + res.chunks + ' 片，' + sec.toFixed(1) + ' s' + (retries ? '，重试 ' + retries + ' 次' : '') + '（数据已落盘）');

      // 3) 可选：送完立刻发 0x11 把这一槽刷到屏上，省一次手动点击
      if (show) {
        setCmdState(el.upState, 'running', '刷图中…');
        setProgress(1, '送图完成 · 正在刷图（0x11 · 槽 ' + slot + '）…');
        log('sys', '开始刷图：0x11 槽 ' + slot + '（该命令的完成通知 CMD 是 0x10，属固件约定）');
        await client.updateImage(slot, {
          onRetry: (info) => log('sys', '刷图第 ' + info.attempt + ' 次失败（' + info.error.message + '），重发'),
        });
      }

      const total = (performance.now() - t0) / 1000;
      el.upMs.textContent = total.toFixed(1) + ' s';
      setProgress(
        1,
        '完成：' + res.chunks + ' 片 / ' + res.bytes.toLocaleString() + ' 字节' +
          (retries ? ' · 重试 ' + retries + ' 次' : '') + (show ? ' · 已刷图' : '')
      );
      setCmdState(el.upState, 'ok', '完成 · 槽 ' + slot + (show ? ' 已显示' : ''));
      if (show) log('ok', '刷图完成：槽 ' + slot + ' 已显示到屏上（送图 + 刷屏总耗时 ' + total.toFixed(1) + ' s）');
    } catch (err) {
      const sec = (performance.now() - t0) / 1000;
      el.upMs.textContent = sec.toFixed(1) + ' s';
      const aborted = uploadAbort;
      const what = aborted ? '中止' : uploaded ? '送图成功但刷图失败' : '失败';
      setCmdState(el.upState, 'err', aborted ? '已中止' : uploaded ? '送图完成 · 刷图失败' : '失败');
      el.upText.textContent = what + '：' + err.message;
      log('err', what + '：' + err.message + (uploaded ? '（图片数据已落盘，可稍后单独点 0x11 刷该槽）' : ''));
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
    log('sys', '命令测试页就绪：0x00 读版本 / 0x01 读温度 / 0x10 刷纯色 / 0x11 刷图 / 0x20 擦除图片槽 / 0x30 测试送图');
  }
})();
