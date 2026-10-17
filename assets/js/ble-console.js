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

    logBox: $('logBox'),
    btnClearLog: $('btnClearLog'),
  };

  let selectedColor = 0; // 默认黑
  let busy = false; // 同一时刻只跑一条命令，避免响应互相顶掉

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
  function initSlots() {
    for (let i = 0; i <= SLOT_MAX; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = '槽 ' + i;
      el.slotSelect.appendChild(opt);
    }
    el.slotSelect.value = '0';
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
    el.revFrame.textContent = BLE.hex(BLE.buildFrame(CMD.REVISION, [0x00]));
    el.colorFrame.textContent = BLE.hex(BLE.buildFrame(CMD.UPDATE_COLOR, [selectedColor]));
    el.eraseFrame.textContent = BLE.hex(BLE.buildFrame(CMD.FLASH_ERASE, [Number(el.slotSelect.value) || 0]));
  }

  function setConnected(on) {
    el.btnConnect.disabled = on;
    el.btnDisconnect.disabled = !on;
    el.btnRev.disabled = !on;
    el.btnErase.disabled = !on;
    Array.from(el.colorGrid.children).forEach((btn) => (btn.disabled = !on));
    [el.nameFilter, el.uuidService, el.uuidWrite, el.uuidNotify].forEach((input) => (input.disabled = on));
  }

  /* ---------------- BLE ---------------- */
  const client = BLE.create({
    onLog: (type, text) => log(type, text),
    onStatus: (st, text) => {
      setStatus(st, text);
      const connected = st === 'connected';
      setConnected(connected);
      el.bleDeviceName.textContent = connected && client.device ? client.device.name || '' : '';
    },
    onFrame: (frame) => {
      // 异步命令的中间态：设备已受理，正在刷屏 / 擦除
      if (frame.code === 0x01) {
        if (frame.cmd === CMD.UPDATE_COLOR) setCmdState(el.colorState, 'running', '刷屏中…');
        if (frame.cmd === CMD.FLASH_ERASE) setCmdState(el.eraseState, 'running', '擦除中…');
      }
    },
  });

  el.nameFilter.addEventListener('input', updateFrames);
  el.slotSelect.addEventListener('change', updateFrames);

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
    setCmdState(el.colorState, 'running', '执行中…');
    const t0 = performance.now();
    try {
      await client.updateColor(id);
      const ms = Math.round(performance.now() - t0);
      el.colorMs.textContent = ms + ' ms';
      setCmdState(el.colorState, 'ok', '完成 · ' + (color ? color.name : 'id ' + id));
      log('ok', '刷纯色完成：' + (color ? color.name : 'id ' + id) + '（' + ms + ' ms）');
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      el.colorMs.textContent = ms + ' ms';
      setCmdState(el.colorState, 'err', '失败');
      log('err', '刷纯色失败：' + err.message);
    } finally {
      busy = false;
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
    setCmdState(el.eraseState, 'running', '执行中…');
    const t0 = performance.now();
    try {
      await client.eraseSlot(slot);
      const ms = Math.round(performance.now() - t0);
      el.eraseMs.textContent = ms + ' ms';
      setCmdState(el.eraseState, 'ok', '完成');
      log('ok', '擦除槽 ' + slot + ' 完成（' + ms + ' ms）');
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      el.eraseMs.textContent = ms + ' ms';
      setCmdState(el.eraseState, 'err', '失败');
      log('err', '擦除槽 ' + slot + ' 失败：' + err.message);
    } finally {
      busy = false;
    }
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
  updateFrames();
  setConnected(false);

  if (!navigator.bluetooth) {
    el.bleWarn.hidden = false;
    el.btnConnect.disabled = true;
    log('sys', '当前浏览器不支持 Web Bluetooth，仅能查看发送帧');
  } else {
    log('sys', '命令测试页就绪：0x00 读版本 / 0x10 刷纯色 / 0x20 擦除图片槽');
  }
})();
