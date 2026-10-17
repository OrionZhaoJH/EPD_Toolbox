/* ==========================================================================
   EPD Toolbox — BLE 通信层
   --------------------------------------------------------------------------
   面向 CH592F / E6 固件的 Web Bluetooth 封装。

   帧格式（上下行一致，见 App/peripheral.c handleChar3Message）：
     0x55 0xAA LEN_H LEN_L CMD DATA... CRC 0x0D
     LEN = 数据总长 = DATA 长度 + 7（固件会校验 LEN 与实长一致）
     CRC 固件暂不校验，填 0x00

   服务 / 特征（Profile/gattprofile.h）：
     FFE0 服务，FFE3 下行命令（写），FFE4 上行响应（notify）
     FFE3/FFE4 单包长度 20 字节，所以命令帧都很短

   命令码（CHAR3_CMD_t）：
     0x00 读 IC 版本     55 AA 00 08 00 00 00 0D  → 响应带 3 字节版本号
     0x10 刷纯色         data[0] = 颜色编号 0~7
     0x20 擦除图片槽     data[0] = image_id 0~10
   响应码（RESPONSE_CODE_t）：
     0x00 成功 / 0x01 受理中(DOING) / 0x02 完成(DONE) / 0x03 忙 / 0xE0+ 各类错误
   ========================================================================== */
(function (global) {
  'use strict';

  const HEAD1 = 0x55;
  const HEAD2 = 0xaa;
  const TAIL = 0x0d;

  const CMD = {
    REVISION: 0x00,
    UPDATE_COLOR: 0x10,
    FLASH_ERASE: 0x20,
  };

  const RESPONSE_TEXT = {
    0x00: '成功',
    0x01: '已受理（刷屏中）',
    0x02: '完成',
    0x03: '设备忙',
    0xe0: '长度太短',
    0xe1: '长度太长',
    0xe2: '帧头错误',
    0xe3: '帧尾错误',
    0xe4: '长度不一致',
    0xe5: '无效主命令',
    0xe6: '无效从命令',
    0xe7: '无效数据',
    0xff: '未处理/默认错误',
  };

  const ERR_CODE = {
    E0: 0xe0, E1: 0xe1, E2: 0xe2, E3: 0xe3, E4: 0xe4, E5: 0xe5, E6: 0xe6, E7: 0xe7,
  };

  const DEFAULTS = {
    namePrefix: '',
    serviceUuid: 0xffe0,
    writeUuid: 0xffe3,
    notifyUuid: 0xffe4,
    responseTimeout: 4000,
  };

  /** 十六进制字符串 → 期望的 16 位 UUID 形式（蓝牙标准写法 0000xxxx-0000-1000-8000-00805f9b34fb 可省略） */
  function toUuid(v) {
    if (typeof v === 'number') return v;
    const s = String(v).trim().toLowerCase();
    if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s, 16);
    if (/^[0-9a-f]{4}$/.test(s)) return parseInt(s, 16);
    return s;
  }

  /** 组帧：55 AA LEN_H LEN_L CMD DATA... 00 0D */
  function buildFrame(cmd, data) {
    const payload = data || [];
    const len = payload.length + 7;
    const frame = new Uint8Array(len);
    frame[0] = HEAD1;
    frame[1] = HEAD2;
    frame[2] = (len >> 8) & 0xff;
    frame[3] = len & 0xff;
    frame[4] = cmd & 0xff;
    for (let i = 0; i < payload.length; i++) frame[5 + i] = payload[i] & 0xff;
    frame[len - 2] = 0x00; // crc 占位
    frame[len - 1] = TAIL;
    return frame;
  }

  function hex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
  }

  /**
   * 创建一个 BLE 客户端实例。
   * @param {object} handlers
   *   onLog(type, text)    type: sys/tx/rx/ok/err
   *   onStatus(state, text) state: idle/connecting/connected/error
   *   onFrame(frame)       解析后的帧 { cmd, data, raw }
   */
  function create(handlers) {
    const h = handlers || {};
    const log = (type, text) => h.onLog && h.onLog(type, text);
    const status = (state, text) => h.onStatus && h.onStatus(state, text);

    const client = {
      device: null,
      server: null,
      writeChar: null,
      notifyChar: null,
      connected: false,
      settings: Object.assign({}, DEFAULTS),
      rx: [],
      lastFrame: null,
    };

    function reset() {
      client.connected = false;
      client.device = null;
      client.server = null;
      client.writeChar = null;
      client.notifyChar = null;
      client.rx = [];
      status('idle', '未连接');
    }

    client.isSupported = () => !!navigator.bluetooth;

    /** 连接设备。namePrefix 为空时列出全部设备（仍限制在可选服务里） */
    client.connect = async function (opts) {
      if (!client.isSupported()) throw new Error('当前浏览器不支持 Web Bluetooth');
      const o = Object.assign({}, client.settings, opts || {});
      const requestOptions = { optionalServices: [toUuid(o.serviceUuid)] };
      if (o.namePrefix) requestOptions.filters = [{ namePrefix: o.namePrefix }];
      else requestOptions.acceptAllDevices = true;

      status('connecting', '正在选择设备…');
      log('sys', '请求蓝牙设备（' + (o.namePrefix ? '名称前缀 ' + o.namePrefix : '全部设备') + '）');

      const device = await navigator.bluetooth.requestDevice(requestOptions);
      device.addEventListener('gattserverdisconnected', onDisconnected);
      client.device = device;
      log('sys', '已选择：' + (device.name || '(未命名)'));

      status('connecting', '连接 GATT…');
      const server = await device.gatt.connect();
      client.server = server;

      status('connecting', '发现服务…');
      const service = await server.getPrimaryService(toUuid(o.serviceUuid));
      const chars = await service.getCharacteristics();
      log(
        'sys',
        '服务 ' + o.serviceUuid.toString(16).replace('0x', '').toUpperCase() +
          ' 特征：' + chars.map((c) => c.uuid).join(', ')
      );

      client.writeChar = await service.getCharacteristic(toUuid(o.writeUuid));
      client.notifyChar = await service.getCharacteristic(toUuid(o.notifyUuid));

      await client.notifyChar.startNotifications();
      client.notifyChar.addEventListener('characteristicvaluechanged', onNotify);

      client.connected = true;
      status('connected', '已连接：' + (device.name || 'BLE 设备'));
      log('ok', 'GATT 连接就绪（FFE3 写 / FFE4 通知）');
      return device;
    };

    client.disconnect = function () {
      if (client.device && client.device.gatt && client.device.gatt.connected) {
        client.device.gatt.disconnect();
      }
      reset();
      log('sys', '已断开');
    };

    function onDisconnected() {
      log('err', '设备已断开连接');
      reset();
    }

    /** 通知数据可能被拆包，按帧头长度做重组 */
    function onNotify(event) {
      const value = event.target.value;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      for (let i = 0; i < bytes.length; i++) client.rx.push(bytes[i]);
      parseRx();
    }

    function parseRx() {
      for (;;) {
        // 丢弃帧头之前的噪声
        while (client.rx.length >= 2 && !(client.rx[0] === HEAD1 && client.rx[1] === HEAD2)) {
          client.rx.shift();
        }
        if (client.rx.length < 4) return;
        const len = (client.rx[2] << 8) | client.rx[3];
        if (len < 7 || len > 512) {
          client.rx.shift();
          continue;
        }
        if (client.rx.length < len) return;
        const frame = client.rx.splice(0, len);
        if (frame[len - 1] !== TAIL) {
          log('err', '收到的帧尾不是 0x0D，已丢弃：' + hex(frame));
          continue;
        }
        const parsed = {
          cmd: frame[4],
          code: frame[5],
          data: frame.slice(5, len - 2),
          raw: frame,
        };
        client.lastFrame = parsed;
        log('rx', '接收 ' + hex(frame));
        if (h.onFrame) h.onFrame(parsed);
      }
    }

    client.cmdName = function (cmd) {
      switch (cmd) {
        case CMD.REVISION: return '读版本';
        case CMD.UPDATE_COLOR: return '刷纯色';
        case CMD.FLASH_ERASE: return '擦除图片槽';
        default: return '0x' + cmd.toString(16).toUpperCase();
      }
    };

    client.responseText = function (code) {
      return RESPONSE_TEXT[code] || '未知响应 0x' + code.toString(16).toUpperCase();
    };

    /** 底层写一帧 */
    client.writeFrame = async function (frame) {
      if (!client.connected) throw new Error('未连接设备');
      log('tx', '发送 ' + hex(frame));
      await client.writeChar.writeValue(frame);
    };

    /** 发送命令帧 */
    client.send = async function (cmd, data) {
      const frame = buildFrame(cmd, data);
      await client.writeFrame(frame);
      return frame;
    };

    /**
     * 发送命令并等待指定 cmd 的最终响应（DONE / ERR）。
     * 刷纯色与擦除属于异步命令：先回 DOING(0x01)，完成后再推 DONE(0x02)。
     */
    client.sendAndWait = function (cmd, data, timeout) {
      return new Promise((resolve, reject) => {
        let timer = null;
        const prev = h.onFrame;
        const finish = (fn, arg) => {
          clearTimeout(timer);
          h.onFrame = prev;
          fn(arg);
        };
        timer = setTimeout(() => finish(reject, new Error('等待响应超时（' + client.cmdName(cmd) + '）')), timeout || client.settings.responseTimeout);

        h.onFrame = function (frame) {
          if (prev) prev(frame);
          if (frame.cmd !== cmd) return;
          const code = frame.code;
          if (code === 0x00) finish(resolve, frame); // 立即成功
          else if (code === 0x02) finish(resolve, frame); // 异步完成
          else if (code === 0x01) return; // DOING，继续等
          else finish(reject, new Error(client.responseText(code) + '（0x' + code.toString(16).toUpperCase() + '）'));
        };

        client.send(cmd, data).catch((err) => finish(reject, err));
      });
    };

    client.readRevision = function () {
      return client.sendAndWait(CMD.REVISION, [0x00], 3000);
    };

    client.updateColor = function (colorId) {
      if (colorId < 0 || colorId > 7) return Promise.reject(new Error('颜色编号只能是 0~7'));
      return client.sendAndWait(CMD.UPDATE_COLOR, [colorId], 15000);
    };

    client.eraseSlot = function (imageId) {
      if (imageId < 0 || imageId > 10) return Promise.reject(new Error('图片槽只能是 0~10'));
      return client.sendAndWait(CMD.FLASH_ERASE, [imageId], 20000);
    };

    return client;
  }

  global.EPDBLE = {
    create,
    buildFrame,
    toUuid,
    hex,
    CMD,
    RESPONSE_TEXT,
    DEFAULTS,
  };
})(window);
