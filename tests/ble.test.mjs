/* ==========================================================================
   BLE 组帧 / 拆帧 / 读版本应答解析 自测（无依赖，node tests/ble.test.mjs）
   --------------------------------------------------------------------------
   回归要点：0x00 读版本的应答没有响应码，PAYLOAD 就是 3 字节版本号：
     55 AA 00 0A 00 10 84 02 00 0D
   早先的 sendAndWait 会把 0x10（版本号首字节）误当成响应码，报「未知响应 0x10」。
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const win = {};
new Function('window', readFileSync(resolve(here, '../assets/js/ble.js'), 'utf8'))(win);
const B = win.EPDBLE;

const fail = [];
const ok = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else {
    console.error('  ✗ ' + msg);
    fail.push(msg);
  }
};

console.log('BLE 组帧与解析自测');

/* 1. 组帧 */
{
  ok(B.hex(B.buildFrame(B.CMD.REVISION, [0x00])) === '55 AA 00 08 00 00 00 0D', '读版本帧 = 55 AA 00 08 00 00 00 0D');
  ok(B.hex(B.buildFrame(B.CMD.UPDATE_COLOR, [0x01])) === '55 AA 00 08 10 01 00 0D', '刷白色帧 = 55 AA 00 08 10 01 00 0D');
  ok(B.hex(B.buildFrame(B.CMD.UPDATE_COLOR, [0x03])) === '55 AA 00 08 10 03 00 0D', '刷红色帧 = 55 AA 00 08 10 03 00 0D');
  ok(B.hex(B.buildFrame(B.CMD.FLASH_ERASE, [0x01])) === '55 AA 00 08 20 01 00 0D', '擦除槽1帧 = 55 AA 00 08 20 01 00 0D');
}

/* 2. 实测的读版本应答：无响应码 */
{
  const rx = [0x55, 0xaa, 0x00, 0x0a, 0x00, 0x10, 0x84, 0x02, 0x00, 0x0d];
  const frames = [];
  B.parseStream(rx, (f) => frames.push(f));
  ok(frames.length === 1, '一个应答帧被切出');
  ok(frames[0].cmd === 0x00, 'CMD = 0x00（读版本）');
  ok(B.hex(frames[0].data) === '10 84 02', 'PAYLOAD = 10 84 02（3 字节版本号，不是响应码）');
  ok(frames[0].raw.length === 10, '帧长 = 0x0A = 10 字节');
  ok(rx.length === 0, '缓冲区被消费干净');
}

/* 3. 拆包重组 */
{
  const all = [0x55, 0xaa, 0x00, 0x0a, 0x00, 0x10, 0x84, 0x02, 0x00, 0x0d];
  const rx = [];
  const frames = [];
  for (const b of all) {
    rx.push(b);
    B.parseStream(rx, (f) => frames.push(f));
  }
  ok(frames.length === 1 && B.hex(frames[0].data) === '10 84 02', '逐字节喂入也能拼出完整帧');
}

/* 4. 粘包：两帧连在一起 */
{
  const rx = [0x55, 0xaa, 0x00, 0x08, 0x10, 0x02, 0x00, 0x0d, 0x55, 0xaa, 0x00, 0x08, 0x10, 0x01, 0x00, 0x0d];
  const frames = [];
  B.parseStream(rx, (f) => frames.push(f));
  ok(frames.length === 2, '两帧粘连时切出两帧');
  ok(frames[0].code === 0x02 && frames[1].code === 0x01, '0x10 的 PAYLOAD 首字节仍是响应码（02 完成 / 01 受理）');
}

/* 5. 帧头前有噪声 + 帧尾错误 */
{
  const rx = [0x00, 0x11, 0x55, 0xaa, 0x00, 0x08, 0x20, 0x02, 0x00, 0x0d];
  const frames = [];
  B.parseStream(rx, (f) => frames.push(f));
  ok(frames.length === 1 && frames[0].cmd === 0x20, '噪声被丢弃，正常帧保留');

  const bad = [0x55, 0xaa, 0x00, 0x08, 0x20, 0x02, 0x00, 0xff];
  const out = [];
  let warned = 0;
  B.parseStream(bad, (f) => out.push(f), () => warned++);
  ok(out.length === 0 && warned === 1, '帧尾不是 0x0D 时丢弃并告警');
}

/* 6. readRevision 语义：拿到 cmd=0x00 的帧即成功，PAYLOAD 原样返回 */
{
  const handlers = { onLog() {}, onStatus() {}, onFrame() {} };
  const client = B.create(handlers);
  client.connected = true;
  client.writeChar = { writeValue: async () => {} };

  const pending = client.readRevision(500);
  // 模拟设备应答：把实测帧交给解析器，再触发页面的 onFrame
  const rx = [0x55, 0xaa, 0x00, 0x0a, 0x00, 0x10, 0x84, 0x02, 0x00, 0x0d];
  B.parseStream(rx, (f) => handlers.onFrame(f));

  const result = await pending.then(
    (f) => ({ ok: true, f }),
    (e) => ({ ok: false, e })
  );
  ok(result.ok, 'readRevision 正常 resolve（不再把 0x10 当响应码）');
  if (result.ok) ok(B.hex(result.f.data) === '10 84 02', 'resolve 的 data 就是 10 84 02');
}

/* 7. readRevision 超时 */
{
  const handlers = { onLog() {}, onStatus() {}, onFrame() {} };
  const client = B.create(handlers);
  client.connected = true;
  client.writeChar = { writeValue: async () => {} };
  const res = await client.readRevision(120).then(
    () => ({ ok: true }),
    (e) => ({ ok: false, msg: e.message })
  );
  ok(!res.ok && /超时/.test(res.msg), '设备无应答时按超时拒绝');
}

/* 8. 心跳续命：DOING(0x01) 不断时，总耗时超过空闲超时也不判失败 */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raw = (code) => new Uint8Array([0x55, 0xaa, 0x00, 0x08, 0x10, code, 0x00, 0x0d]);
  let beats = 0;
  const handlers = {
    onLog() {},
    onStatus() {},
    onFrame() {},
    onHeartbeat(cmd, n) {
      beats = n;
    },
  };
  const client = B.create(handlers);
  client.connected = true;
  client.writeChar = { writeValue: async () => {} };

  // 空闲超时 150ms，心跳每 60ms 一次共 5 次（累计 300ms），再推 DONE
  const pending = client.updateColor(0x01, 150);
  for (let i = 0; i < 5; i++) {
    await sleep(60);
    handlers.onFrame({ cmd: 0x10, code: 0x01, data: new Uint8Array([1]), raw: raw(0x01) });
  }
  handlers.onFrame({ cmd: 0x10, code: 0x02, data: new Uint8Array([2]), raw: raw(0x02) });

  const res = await pending.then(
    (f) => ({ ok: true, f }),
    (e) => ({ ok: false, e })
  );
  ok(res.ok, '刷屏期间心跳不断，总耗时超过空闲超时也能等到 DONE');
  ok(beats === 5, 'onHeartbeat 逐条计数（收到 ' + beats + ' 次）');
}

/* 9. 心跳停止后按空闲超时失败 */
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const handlers = { onLog() {}, onStatus() {}, onFrame() {}, onHeartbeat() {} };
  const client = B.create(handlers);
  client.connected = true;
  client.writeChar = { writeValue: async () => {} };

  const pending = client.updateColor(0x02, 120);
  handlers.onFrame({ cmd: 0x10, code: 0x01, data: new Uint8Array([1]), raw: new Uint8Array([0x55, 0xaa, 0, 8, 0x10, 1, 0, 0x0d]) });
  const res = await pending.then(
    () => ({ ok: true }),
    (e) => ({ ok: false, msg: e.message })
  );
  ok(!res.ok && /超时/.test(res.msg), '心跳停掉后 ' + 120 + 'ms 无新帧即失败');
  await sleep(10);
}

/* 10. 0x30 写图片分片帧格式（BLE_Protocol.md §5） */
{
  const full = new Uint8Array(233).fill(0xaa);
  const f0 = B.buildImageChunkFrame(0, 0, full);
  ok(f0.length === 244, '满片帧长 = 244 字节');
  ok(B.hex(f0.subarray(0, 9)) === '55 AA 00 F4 30 00 00 00 00', '帧头/长度/cmd/image_id/offset = 55 AA 00 F4 30 00 00 00 00');
  ok(f0[9] === 0xaa && f0[241] === 0xaa, 'payload 位于偏移 9~241');
  ok(f0[242] === 0x00 && f0[243] === 0x0d, 'crc=0、帧尾 0x0D');

  const f1 = B.buildImageChunkFrame(0, 233, full);
  ok(B.hex(f1.subarray(6, 9)) === '00 00 E9', '第二片 offset=233=0x0000E9（大端 3 字节）');

  const lastPayload = new Uint8Array(147).fill(0x55);
  const fl = B.buildImageChunkFrame(3, 172653, lastPayload);
  ok(fl.length === 158, '最后一片（147 字节 payload）帧长 = 11 + 147 = 158');
  ok(B.hex(fl.subarray(2, 4)) === '00 9E', '最后一片长度字段 = 0x009E（158）');
  ok(fl[5] === 3, 'image_id 正确写入');
}

/* 11. writeImage：742 片、offset 递增 233、每片等 DONE */
{
  const handlers = { onLog() {}, onStatus() {}, onFrame() {}, onHeartbeat() {} };
  const client = B.create(handlers);
  client.connected = true;
  const frames = [];
  client.writeChar = {
    writeValue: async (frame) => {
      frames.push(Uint8Array.from(frame));
      handlers.onFrame({ cmd: 0x30, code: 0x02, data: new Uint8Array([2]), raw: new Uint8Array([0x55, 0xaa, 0, 8, 0x30, 2, 0, 0x0d]) });
    },
  };
  const data = new Uint8Array(B.IMAGE_BYTES);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

  let progress = 0;
  const res = await client.writeImage(0, data, { onProgress: () => progress++ });
  ok(B.IMAGE_BYTES === 172800 && B.IMAGE_CHUNKS === 742, '常量：172800 字节 / 742 片');
  ok(frames.length === 742 && res.chunks === 742, '实际发出 742 片');
  ok(progress === 742, 'onProgress 回调 742 次');

  const off = (f) => (f[6] << 16) | (f[7] << 8) | f[8];
  let offsetsOk = true;
  for (let i = 0; i < frames.length; i++) {
    if (off(frames[i]) !== i * 233) { offsetsOk = false; break; }
  }
  ok(offsetsOk, 'offset 依次为 0, 233, 466 …');

  const last = frames[frames.length - 1];
  ok(last.length === 158, '最后一片帧长 158（payload 147）');
  ok(off(last) === 172653 && off(last) + 147 === 172800, '最后一片 offset 172653 + 147 = 172800');

  // payload 与源数据对应
  ok(frames[1][9] === data[233] && frames[1][10] === data[234], '第二片 payload 接续源数据');
  ok(last[9] === data[172653] && last[155] === data[172799], '最后一片首尾字节与源数据一致');
}

/* 12. writeImage：中止与长度校验 */
{
  const handlers = { onLog() {}, onStatus() {}, onFrame() {} };
  const client = B.create(handlers);
  client.connected = true;
  let sent = 0;
  client.writeChar = {
    writeValue: async () => {
      sent++;
      handlers.onFrame({ cmd: 0x30, code: 0x02, data: new Uint8Array([2]), raw: new Uint8Array([0x55, 0xaa, 0, 8, 0x30, 2, 0, 0x0d]) });
    },
  };
  const data = new Uint8Array(B.IMAGE_BYTES);

  const aborted = await client
    .writeImage(1, data, { shouldStop: () => sent >= 3 })
    .then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message }));
  ok(!aborted.ok && /中止/.test(aborted.msg), 'shouldStop 后中止并报错');
  ok(sent === 3, '中止前只发了 3 片（实际 ' + sent + '）');

  const bad = await client.writeImage(1, new Uint8Array(1000)).then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message }));
  ok(!bad.ok && /172800/.test(bad.msg), '长度不对时直接拒绝，不发出任何帧');
}

if (fail.length) {
  console.error('\n失败 ' + fail.length + ' 项');
  process.exit(1);
}
console.log('\n全部通过');
