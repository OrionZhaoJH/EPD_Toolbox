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
     FFE3 只支持带响应写（固件 fe1d988 移除了 GATT_PROP_WRITE_NO_RSP）：
     一律用 writeValueWithResponse()，老浏览器退回 writeValue()，
     不要用 writeValueWithoutResponse()（现在会失败）；连接后会核对
     characteristic.properties.writeWithoutResponse 必须为 false。
     0x30 送图（固件 074fc03 起）：入队不再回 DOING，ATT 写响应就是「已入队」，
     收到就发下一片；DONE 只更新进度/确认落盘，不阻塞发送；
     BUSY 表示该包被丢弃，必须用同一个 offset 重发。
     短命令帧都是 8~9 字节；送图分片最大 244 字节，需要 ATT MTU ≥ 247
     （Web Bluetooth 没有主动请求 MTU 的 API，由系统自动协商）

   命令码（CHAR3_CMD_t）：
     0x00 读 IC 版本     55 AA 00 08 00 00 00 0D
                         → 应答 55 AA 00 0A 00 R1 R2 R3 00 0D（无响应码，PAYLOAD 即版本号）
     0x10 刷纯色         data[0] = 颜色编号 0~7
     0x11 刷图           55 AA 00 08 11 [image_id] 00 0D
                         → 把指定槽里已写入的图显示到屏上（先 0x20 擦 + 0x30 写）
     0x20 擦除图片槽     data[0] = image_id 0~10
     0x30 写图片分片     55 AA 00 F4 30 [id] [off H/M/L] [payload 233B] 00 0D
                         见 E6_P370_CH592F/BLE_Protocol.md，742 片存一张 480×720 4bpp 图
   响应码（RESPONSE_CODE_t，仅 0x10 / 0x11 / 0x20 / 0x30 这类带状态应答的命令使用）：
     0x00 成功 / 0x01 受理中(DOING) / 0x02 完成(DONE) / 0x03 忙 / 0xE0+ 各类错误
   注意：解析帧时不能一律把 PAYLOAD 首字节当响应码，读版本的应答首字节是版本号。
   另注：固件 peripheralEPDTaskCB() 推送刷屏进度/完成通知时 CMD 字段写死为 0x10，
         所以等 0x11 的应答必须把 CMD=0x10 的帧一起算（见 updateImage / acceptCmds）。
   ========================================================================== */
(function (global) {
  'use strict';

  const HEAD1 = 0x55;
  const HEAD2 = 0xaa;
  const TAIL = 0x0d;

  const CMD = {
    REVISION: 0x00,
    UPDATE_COLOR: 0x10,
    UPDATE_IMAGE: 0x11,
    FLASH_ERASE: 0x20,
    WRITE_IMAGE: 0x30,
  };

  /* ---- 图片传输常量（见 E6_P370_CH592F/BLE_Protocol.md） ---- */
  const IMAGE_WIDTH = 480;
  const IMAGE_HEIGHT = 720;
  const IMAGE_BYTES = (IMAGE_WIDTH * IMAGE_HEIGHT) / 2; // 172800，4bpp
  const CHUNK_PAYLOAD = 233; // 单帧 244 字节：11 字节开销 + 233 字节数据
  const CHUNK_FRAME_BYTES = 244;
  const IMAGE_CHUNKS = Math.ceil(IMAGE_BYTES / CHUNK_PAYLOAD); // 742

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
    0xff: '未处理/执行失败',
  };

  const ERR_CODE = {
    E0: 0xe0, E1: 0xe1, E2: 0xe2, E3: 0xe3, E4: 0xe4, E5: 0xe5, E6: 0xe6, E7: 0xe7,
  };

  const DEFAULTS = {
    namePrefix: '',
    serviceUuid: 0xffe0,
    writeUuid: 0xffe3,
    notifyUuid: 0xffe4,
    /* 空闲超时：不是总耗时上限。刷屏期间固件每秒左右发一次 0x01 心跳，
       只要心跳不断就一直等；连续这么久没收到任何同 cmd 的帧才判超时。 */
    idleTimeout: 20000,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* 让出一个宏任务：给「与 ATT 写响应同一批到达」的 BLE 通知（典型是 BUSY）先处理的机会，
     否则 BUSY 会被算到下一片上。setTimeout(0) 在 Chrome 有 1ms 起的钳制，742 片会白等
     0.7 s 以上，所以优先用 MessageChannel —— 同样是一个任务，但不用等计时器。 */
  const yieldTask = (() => {
    // 只在真浏览器里用 MessageChannel：Node 的 MessagePort 会挂住事件循环（测试跑完不退出）
    if (typeof global.document !== 'undefined' && typeof MessageChannel === 'function') {
      const queue = [];
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        const next = queue.shift();
        if (next) next();
      };
      return () =>
        new Promise((resolve) => {
          queue.push(resolve);
          ch.port2.postMessage(0);
        });
    }
    return () => new Promise((resolve) => setTimeout(resolve, 0));
  })();

  /**
   * 通用重试：GATT 操作偶发失败（典型是「GATT operation already in progress」）
   * 或单片超时，重发同一帧通常就能过。协议级错误（err.retryable === false，
   * 比如「无效数据」）不重试，重发也没意义。
   *
   * @param {(attempt:number)=>Promise<any>} run
   * @param {number} attempts 总尝试次数，默认 3
   * @param {(info:{attempt:number,error:Error})=>void} [onRetry]
   */
  async function withRetry(run, attempts, onRetry) {
    const total = Math.max(1, attempts || 1);
    let lastErr = null;
    for (let attempt = 1; attempt <= total; attempt++) {
      try {
        return await run(attempt);
      } catch (err) {
        lastErr = err;
        const retryable = !err || err.retryable !== false;
        if (!retryable || attempt >= total) throw err;
        if (onRetry) onRetry({ attempt, error: err });
        await sleep(40 * attempt);
      }
    }
    throw lastErr;
  }

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
   * 组 0x30 写图片分片帧。
   *   55 AA 00 F4 30 [image_id] [offH][offM][offL] [payload ≤233B] 00 0D
   * 满片固定 244 字节；最后一片不满 233 字节时帧长缩短为 11 + payload 长度。
   *
   * @param {number} imageId 图片序号 0~10
   * @param {number} offset  本片数据在整图中的字节偏移（大端写入）
   * @param {Uint8Array} payload 本片数据，长度 ≤ 233
   */
  function buildImageChunkFrame(imageId, offset, payload) {
    const len = 11 + payload.length;
    const frame = new Uint8Array(len);
    frame[0] = HEAD1;
    frame[1] = HEAD2;
    frame[2] = (len >> 8) & 0xff;
    frame[3] = len & 0xff;
    frame[4] = CMD.WRITE_IMAGE;
    frame[5] = imageId & 0xff;
    frame[6] = (offset >> 16) & 0xff;
    frame[7] = (offset >> 8) & 0xff;
    frame[8] = offset & 0xff;
    frame.set(payload, 9);
    frame[len - 2] = 0x00; // crc 占位
    frame[len - 1] = TAIL;
    return frame;
  }

  /**
   * 从接收缓冲区里切出完整帧（原地消费 rx）。
   * 帧格式：55 AA LEN_H LEN_L CMD PAYLOAD... CRC 0D，PAYLOAD 长度 = LEN - 7。
   * 注意：不同命令的 PAYLOAD 语义不一样——
   *   0x10 / 0x20 的 PAYLOAD 第 1 字节是响应码（0x00 成功 / 0x01 受理 / 0x02 完成…）
   *   0x00 读版本的 PAYLOAD 就是 3 字节版本号，没有响应码
   * 所以这里只负责切帧，语义交给调用方，避免拿版本号当响应码用。
   *
   * @param {number[]} rx 可变数组，会被原地修改
   * @param {(frame:{cmd:number,code:number,data:Uint8Array,raw:Uint8Array})=>void} onFrame
   * @param {(type:string,text:string)=>void} [logFn]
   */
  function parseStream(rx, onFrame, logFn) {
    for (;;) {
      // 丢弃帧头之前的噪声
      while (rx.length >= 2 && !(rx[0] === HEAD1 && rx[1] === HEAD2)) rx.shift();
      if (rx.length < 4) return;
      const len = (rx[2] << 8) | rx[3];
      if (len < 7 || len > 512) {
        rx.shift();
        continue;
      }
      if (rx.length < len) return;
      const frame = rx.splice(0, len);
      if (frame[len - 1] !== TAIL) {
        if (logFn) logFn('err', '收到的帧尾不是 0x0D，已丢弃：' + hex(frame));
        continue;
      }
      onFrame({
        cmd: frame[4],
        code: frame[5], // 仅 0x10 / 0x20 等带响应码的命令有意义
        data: frame.slice(5, len - 2),
        raw: frame,
      });
    }
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
      silentCmd: 0, // 该 cmd 的收发不写日志（送图分片用）
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

      /* 新固件把 FFE3 的 WRITE_NO_RSP 去掉了，只留带响应写。这里顺手核对一次：
         还是 true 说明烧的固件没更新，或者拿到的是缓存的旧 GATT 表（断电重连即可刷新）。 */
      const wnr = !!(client.writeChar.properties && client.writeChar.properties.writeWithoutResponse);
      client.writeWithoutResponse = wnr;
      if (wnr) {
        log('err', 'FFE3 仍报告支持无响应写（writeWithoutResponse = true）：固件可能是旧版本，重新烧录后断开重连一次');
      } else {
        log('sys', 'FFE3 支持写方式：带响应写（writeWithoutResponse = false），下发一律走 ATT Write Request');
      }

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
      parseStream(client.rx, (frame) => {
        client.lastFrame = frame;
        // 心跳（0x01）几十上百条，不逐条记日志，避免把日志冲掉；
        // 页面通过 onHeartbeat 只在第一次心跳时补一条说明
        // 送图分片（silentCmd）同理：742 片只靠进度条反馈
        if (frame.code !== 0x01 && frame.cmd !== client.silentCmd) log('rx', '接收 ' + hex(frame.raw));
        if (h.onFrame) h.onFrame(frame);
      }, log);
    }

    client.cmdName = function (cmd) {
      switch (cmd) {
        case CMD.REVISION: return '读版本';
        case CMD.UPDATE_COLOR: return '刷纯色';
        case CMD.UPDATE_IMAGE: return '刷图';
        case CMD.FLASH_ERASE: return '擦除图片槽';
        case CMD.WRITE_IMAGE: return '写图片分片';
        default: return '0x' + cmd.toString(16).toUpperCase();
      }
    };

    client.responseText = function (code) {
      return RESPONSE_TEXT[code] || '未知响应 0x' + code.toString(16).toUpperCase();
    };

    /**
     * 底层写一帧。
     *
     * 固件 fe1d988 起 FFE3 只保留 WRITE 属性（不再支持 Write Command），
     * 因此一律走带响应写：ATT 响应 = 设备已收到并处理（对 0x30 就是「已入队」）。
     * 写入是严格串行的：写响应回来之前不发下一帧，否则会撞上
     * 「GATT operation already in progress」。
     *
     * @param {Uint8Array} frame
     * @param {{quiet?: boolean}} [opts] quiet = 不写 tx 日志（送图分片会写 742 次）
     */
    client.writeFrame = async function (frame, opts) {
      if (!client.connected) throw new Error('未连接设备');
      if (!(opts && opts.quiet)) {
        log('tx', '发送 ' + (frame.length > 32 ? hex(frame.subarray(0, 12)) + ' … (' + frame.length + ' 字节)' : hex(frame)));
      }
      const ch = client.writeChar;
      // 有 writeValueWithResponse 就显式用它；老浏览器只有 writeValue，
      // 它在「只支持 WRITE」的特征上同样走 Write Request，不是无响应写
      try {
        if (typeof ch.writeValueWithResponse === 'function') {
          await ch.writeValueWithResponse(frame);
        } else {
          await ch.writeValue(frame);
        }
      } catch (err) {
        // 244 字节的帧要 ATT MTU ≥ 247；MTU 只有 23 时浏览器会直接拒绝长写。
        // Web Bluetooth 没有读 MTU 的接口，只能按失败现象提示。
        if (frame.length > 20 && !(err && err.mtuHinted)) {
          const msg = (err && err.message) || String(err);
          if (/length|size|mtu|exceed|invalid|not supported/i.test(msg)) {
            err.message = msg + '（可能是 ATT MTU 不足：244 字节帧需要 MTU ≥ 247，浏览器应与设备协商到 247，' +
              '串口日志里能看到 mtu exchange: 247）';
            err.mtuHinted = true;
          }
        }
        throw err;
      }
    };

    /** 发送命令帧 */
    client.send = async function (cmd, data, opts) {
      const frame = buildFrame(cmd, data);
      await client.writeFrame(frame, opts);
      return frame;
    };

    /**
     * 发送命令并等待最终响应（DONE / ERR）。
     *
     * 刷纯色与擦除属于异步命令：先回 DOING(0x01)，完成后再推 DONE(0x02)。
     * 整屏刷新可能十几秒到几十秒，固件会在刷屏期间**持续重复发 0x01 做心跳保活**
     * （55 AA 00 08 10 01 00 0D），所以这里用的是「空闲超时」：
     * 每收到一帧同 cmd 的响应就重置计时器，只要心跳不断就一直等下去，
     * 而不是拿一个固定总超时去卡一次几十秒的刷新。
     */
    client.sendAndWait = function (cmd, data, idleMs, opts) {
      const frame = buildFrame(cmd, data);
      return client.sendFrameAndWait(frame, cmd, idleMs, opts);
    };

    /** 发送一帧自定义帧并等它的响应（送图分片只有「帧」没有「data」） */
    client.sendFrameAndWait = function (frame, cmd, idleMs, opts) {
      return new Promise((resolve, reject) => {
        const idle = idleMs || client.settings.idleTimeout;
        /* 本命令的响应 CMD 白名单：默认只有 cmd 自己；刷图（0x11）要额外接受 0x10，
           因为固件 EPD 任务的通知把 CMD 字段写死成 0x10（peripheralEPDTaskCB），
           刷图/刷纯色共用同一条通知帧。不接受的话等 0x11 永远等不到 DONE。 */
        const accept = [cmd].concat((opts && opts.acceptCmds) || []);
        let timer = null;
        let heartbeat = 0;
        const prev = h.onFrame;
        const finish = (fn, arg) => {
          clearTimeout(timer);
          h.onFrame = prev;
          fn(arg);
        };
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () =>
              finish(
                reject,
                new Error(
                  '等待响应超时（' + client.cmdName(cmd) + '）：' + idle / 1000 + ' s 内没有收到任何帧' +
                    (heartbeat ? '，上次心跳 #' + heartbeat : '')
                )
              ),
            idle
          );
        };

        h.onFrame = function (frame) {
          if (prev) prev(frame);
          if (accept.indexOf(frame.cmd) === -1) return;
          const code = frame.code;
          if (code === 0x01) {
            // DOING / 心跳保活：不结束，只续命并通知上层刷新进度
            heartbeat++;
            arm();
            if (h.onHeartbeat) h.onHeartbeat(cmd, heartbeat);
            return;
          }
          if (code === 0x00 || code === 0x02) {
            finish(resolve, frame);
            return;
          }
          // 协议级错误：只有 BUSY(0x03) 值得就地重发，其它（无效命令/数据）重试无意义
          const err = new Error(client.responseText(code) + '（0x' + code.toString(16).toUpperCase() + '）');
          err.responseCode = code;
          err.retryable = code === 0x03;
          finish(reject, err);
        };

        arm();
        client.writeFrame(frame, opts).catch((err) => finish(reject, err));
      });
    };

    /**
     * 读 IC 版本。
     * 固件对 0x00 的应答**没有响应码**：55 AA 00 0A 00 R1 R2 R3 00 0D，
     * PAYLOAD 直接就是 3 字节版本号，所以不能走 sendAndWait（那会把 R1 当响应码，
     * 实测会报「未知响应 0x10」，而 0x10 其实正是版本号的第一个字节）。
     */
    client.readRevision = function (timeout) {
      return new Promise((resolve, reject) => {
        const prev = h.onFrame;
        const finish = (fn, arg) => {
          clearTimeout(timer);
          h.onFrame = prev;
          fn(arg);
        };
        const timer = setTimeout(
          () => finish(reject, new Error('等待响应超时（读版本）')),
          timeout || 3000
        );
        h.onFrame = function (frame) {
          if (prev) prev(frame);
          if (frame.cmd !== CMD.REVISION) return;
          finish(resolve, frame);
        };
        client.send(CMD.REVISION, [0x00]).catch((err) => finish(reject, err));
      });
    };

    client.updateColor = function (colorId, idleMs) {
      if (colorId < 0 || colorId > 7) return Promise.reject(new Error('颜色编号只能是 0~7'));
      return client.sendAndWait(CMD.UPDATE_COLOR, [colorId], idleMs || 20000);
    };

    /**
     * 刷图：把某个槽里已经写好的 480×720 4bpp 数据刷到屏上（固件 EPD_MDOE_IMAGE）。
     *   55 AA 00 08 11 [image_id] 00 0D
     * 与刷纯色一样是异步的：先回 DOING(0x01)，刷屏期间持续推 0x01 心跳，刷完推
     * DONE(0x02)，失败推 0xFF（RESPONSE_CODE_ERR），所以同样用空闲超时。
     *
     * ⚠️ 固件 quirk：peripheralEPDTaskCB() 里通知帧的 CMD 写死为 0x10，刷图的完成帧
     *    到达时 CMD 也是 0x10，所以这里用 acceptCmds 把 0x10 一起接受，否则永远等不到 DONE。
     *
     * 调用前该槽必须已经写过图（0x20 擦 + 0x30 写），否则会刷出空白/残留内容。
     *
     * @param {number} imageId 0~10（固件 FLASH_IMAGE_MAX_COUNT = 11）
     * @param {object} [opts]
     *   idleMs  空闲超时，默认 20 s（与刷纯色一致）
     *   attempts 命令级重试次数，默认 3；只有 BUSY(0x03) 这类可重试错误才重发
     *   onRetry({attempt,error}) 重发前回调
     */
    client.updateImage = function (imageId, opts) {
      const o = opts || {};
      if (!(imageId >= 0 && imageId <= 10)) return Promise.reject(new Error('图片槽只能是 0~10'));
      return withRetry(
        () =>
          client.sendAndWait(CMD.UPDATE_IMAGE, [imageId], o.idleMs || 20000, {
            acceptCmds: [CMD.UPDATE_COLOR],
          }),
        o.attempts || 3,
        o.onRetry
      );
    };

    client.eraseSlot = function (imageId, opts) {
      const o = opts || {};
      if (imageId < 0 || imageId > 10) return Promise.reject(new Error('图片槽只能是 0~10'));
      // 擦除没有心跳，只能给一个更宽的空闲上限；GATT 偶发错误按 attempts 重发
      return withRetry(
        () => client.sendAndWait(CMD.FLASH_ERASE, [imageId], o.idleMs || 60000),
        o.attempts || 3,
        o.onRetry
      );
    };

    /**
     * 按 BLE_Protocol.md §5 分片写入一张图（0x30）。
     *
     * 固件 074fc03 起，成功入队的分片不再回 DOING(0x01)，所以不能「等 DOING 再发下一包」
     * —— 老写法现在会一直卡住。现在的确认方式：
     *   ATT 写响应    = 已入队 → 收到就发下一片（发送节奏的唯一依据）；
     *   DONE(0x02)   = 该片已写进 Flash → 只更新进度、最后确认落盘，不阻塞发送；
     *   BUSY(0x03)   = 队列满、这一包被丢弃 → 用**同一个 offset** 重发；
     *   E0~E7 / 0xFF = 协议错误，重发无意义，直接失败。
     *
     * 最后一片的写响应只代表入队，所以要等所有 DONE 到齐才算真正写完
     * （等落盘用空闲超时：期间还有新 DONE 就一直等）。
     *
     * 调用前必须先 0x20 擦除同一个槽并确认成功（由页面负责编排）。
     *
     * @param {number} imageId 0~10
     * @param {Uint8Array} bytes 4bpp 图像数据，长度应为 172800
     * @param {object} [opts]
     *   onProgress({index,count,offset,sent,total,done,flashed})  每片入队后回调
     *     sent = 已下发字节（ATT 已确认入队），flashed = 已确认落盘字节
     *   onRetry({index,attempt,error})  某一片重发前回调（GATT 失败或 BUSY 丢包）
     *   shouldStop()  返回 true 则在下一片前中止
     *   idleMs  等落盘的空闲超时，默认 5000
     *   attempts 单片最多尝试次数，默认 3
     * @returns {Promise<{chunks:number, bytes:number, retries:number}>}
     */
    client.writeImage = async function (imageId, bytes, opts) {
      const o = opts || {};
      if (!(imageId >= 0 && imageId <= 10)) throw new Error('图片槽只能是 0~10');
      if (!bytes || bytes.length !== IMAGE_BYTES) {
        throw new Error('图片数据必须是 ' + IMAGE_BYTES + ' 字节（480×720 4bpp），当前 ' + (bytes ? bytes.length : 0));
      }
      const count = Math.ceil(bytes.length / CHUNK_PAYLOAD);
      const attempts = o.attempts || 3;
      const idleMs = o.idleMs || 5000;
      const chunkAt = (i) => {
        const offset = i * CHUNK_PAYLOAD;
        const payload = bytes.subarray(offset, Math.min(offset + CHUNK_PAYLOAD, bytes.length));
        return { index: i, offset, frame: buildImageChunkFrame(imageId, offset, payload) };
      };

      let sentCount = 0; // 拿到 ATT 写响应的次数（含重发）
      let doneCount = 0; // 确认写进 Flash 的片数
      let busyDropped = 0; // BUSY 丢掉的包数：它们不会再有 DONE，算完成时要扣掉
      let acked = -1; // 最近一片拿到写响应的片号（BUSY 归因用）
      let fatal = null; // 设备报的协议错误帧
      let retries = 0;
      const busyOffsets = []; // BUSY 丢包：按原 offset 重发

      const prevFrame = h.onFrame;
      h.onFrame = function (frame) {
        if (prevFrame) prevFrame(frame);
        if (frame.cmd !== CMD.WRITE_IMAGE) return;
        if (frame.code === 0x02) {
          doneCount++;
          return;
        }
        if (frame.code === 0x03) {
          // 队列满、这一包被丢弃：记下片号，稍后用同一个 offset 重发
          busyDropped++;
          if (acked >= 0 && busyOffsets.indexOf(acked) === -1) busyOffsets.push(acked);
          return;
        }
        if (frame.code === 0x01) return; // 旧固件的 DOING：现在不用等，忽略
        fatal = frame;
      };

      const protocolError = () => {
        const code = fatal.code;
        const err = new Error(client.responseText(code) + '（0x' + code.toString(16).toUpperCase() + '）');
        err.responseCode = code;
        err.retryable = false;
        return err;
      };

      /** 发一片：ATT 写响应即「已入队」；BUSY 或 GATT 失败就地重发同一片 */
      const sendChunk = async (i) => {
        const chunk = chunkAt(i);
        await withRetry(
          async () => {
            if (fatal) throw protocolError();
            if (o.shouldStop && o.shouldStop()) throw new Error('已中止送图');
            // 先把片号记上：BUSY 可能和写响应一起、甚至更早到达，归因不能等写完
            acked = i;
            await client.writeFrame(chunk.frame, { quiet: true });
            sentCount++;
            // 让与写响应同一批到达的 BUSY 先被处理，再判断这一包是不是被丢了
            await yieldTask();
            const droppedAt = busyOffsets.indexOf(i);
            if (droppedAt !== -1) {
              busyOffsets.splice(droppedAt, 1);
              const err = new Error('设备忙（0x03）：这一包被丢弃');
              err.retryable = true;
              throw err;
            }
            if (o.onProgress) {
              o.onProgress({
                index: i,
                count,
                offset: chunk.offset,
                sent: Math.min(sentCount * CHUNK_PAYLOAD, bytes.length),
                flashed: Math.min(doneCount * CHUNK_PAYLOAD, bytes.length),
                done: doneCount,
                total: bytes.length,
              });
            }
          },
          attempts,
          (info) => {
            retries++;
            if (o.onRetry) o.onRetry({ index: i, attempt: info.attempt, error: info.error });
          }
        );
      };

      const silent = client.silentCmd;
      client.silentCmd = CMD.WRITE_IMAGE; // 742 片 + 742 条 DONE 不逐条写日志
      try {
        for (let i = 0; i < count; i++) {
          if (o.shouldStop && o.shouldStop()) throw new Error('已中止送图');
          // 上一片迟到的 BUSY：先把丢掉的片按原 offset 补发
          while (busyOffsets.length) await sendChunk(busyOffsets.shift());
          await sendChunk(i);
        }

        // 收尾：等所有 DONE 到齐才算落盘完成（这段不再发数据，只等通知）
        const expected = () => sentCount - busyDropped;
        let lastDone = doneCount;
        let idleFrom = Date.now();
        while (doneCount < expected() || busyOffsets.length) {
          if (fatal) throw protocolError();
          if (busyOffsets.length) {
            await sendChunk(busyOffsets.shift());
            idleFrom = Date.now();
            continue;
          }
          if (doneCount !== lastDone) {
            lastDone = doneCount;
            idleFrom = Date.now();
          } else if (Date.now() - idleFrom > idleMs) {
            throw new Error('等待 Flash 落盘超时：已确认 ' + doneCount + ' / ' + expected() + ' 片（可重试）');
          }
          if (doneCount >= expected()) break;
          await sleep(20);
        }
        return { chunks: count, bytes: bytes.length, retries };
      } finally {
        client.silentCmd = silent;
        h.onFrame = prevFrame;
      }
    };

    return client;
  }

  global.EPDBLE = {
    create,
    buildFrame,
    buildImageChunkFrame,
    parseStream,
    toUuid,
    hex,
    CMD,
    RESPONSE_TEXT,
    DEFAULTS,
    IMAGE_WIDTH,
    IMAGE_HEIGHT,
    IMAGE_BYTES,
    CHUNK_PAYLOAD,
    CHUNK_FRAME_BYTES,
    IMAGE_CHUNKS,
  };
})(window);
