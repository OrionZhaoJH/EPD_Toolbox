/* ==========================================================================
   E6 编解码自测（无依赖，直接 node tests/codec.test.mjs）
   --------------------------------------------------------------------------
   校验三件事：
     1. 帧长：480×720 → 172800 字节
     2. 位序与扫描方向：高半字节在上、列优先
     3. 六色编号映射与 pack/unpack 往返一致
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/* ---- 最小 DOM/Canvas 垫片：只为 drawFitted 存在，本测试用不到绘图 ---- */
class FakeImageData {
  constructor(a, b, c) {
    if (a instanceof Uint8ClampedArray) {
      this.data = a;
      this.width = b;
      this.height = c;
    } else {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    }
  }
}
const fakeCanvas = (w, h) => ({
  width: w,
  height: h,
  getContext: () => ({
    fillStyle: '',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    fillRect() {},
    drawImage() {},
    getImageData: (x, y, ww, hh) => new FakeImageData(ww, hh),
  }),
});
const fakeDocument = { createElement: () => fakeCanvas(1, 1) };

const win = { ImageData: FakeImageData, document: fakeDocument, navigator: {} };
const src = readFileSync(resolve(here, '../assets/js/e6-codec.js'), 'utf8');
new Function('window', 'ImageData', 'document', 'navigator', src)(win, FakeImageData, fakeDocument, {});

const C = win.E6Codec;
const fail = [];
const ok = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else {
    console.error('  ✗ ' + msg);
    fail.push(msg);
  }
};

console.log('E6 编解码自测');

/* 1. 帧长 */
ok(C.frameBytes(480, 720) === 172800, '480×720 帧长 = 172800 字节');
ok(C.frameBytes(480, 719) === 480 * 360, '奇数高度向上取整');

/* 2. 位序与扫描方向 */
{
  const w = 2;
  const h = 2;
  // ids: 调色板索引。像素(0,0)=黑(0) (0,1)=白(1) (1,0)=红(3) (1,1)=蓝(5)
  const ids = new Uint16Array(w * h);
  ids[0 * w + 0] = 0; // 调色板索引 0 → id 0（黑）
  ids[1 * w + 0] = 1; // 索引 1 → id 1（白）
  ids[0 * w + 1] = 3; // 索引 3 → id 3（红）
  ids[1 * w + 1] = 4; // 索引 4 → id 5（蓝）
  const bytes = C.pack(ids, w, h);
  ok(bytes.length === 2, '2×2 图打包成 2 字节');
  ok(bytes[0] === 0x01, '第 1 字节 = 黑<<4 | 白 = 0x01（列优先，高半字节在上）');
  ok(bytes[1] === 0x35, '第 2 字节 = 红<<4 | 蓝 = 0x35（红=3、蓝=5）');
  const back = C.unpack(bytes, w, h);
  // 列优先：位置索引 p = y * w + x，所以 (0,1) 是 back[2]，(1,0) 是 back[1]
  ok(
    back[0] === 0 && back[2] === 1 && back[1] === 3 && back[3] === 4,
    'pack → unpack 往返一致'
  );
}

/* 3. 六色编号 */
{
  const expect = { 0: 0x00, 1: 0x11, 2: 0x22, 3: 0x33, 5: 0x55, 6: 0x66 };
  let allOk = true;
  C.PALETTE.forEach((c, idx) => {
    const ids = new Uint16Array(4).fill(idx);
    const b = C.pack(ids, 2, 2);
    if (b[0] !== expect[c.id] || b[1] !== expect[c.id]) {
      allOk = false;
      console.error('    颜色 ' + c.name + ' 期望 0x' + expect[c.id].toString(16) + ' 实际 0x' + b[0].toString(16));
    }
  });
  ok(allOk, '六色编号 黑0 白1 黄2 红3 蓝5 绿6');
}

/* 4. 抖动主流程 + 大面积纯色识别 */
{
  const w = 32;
  const h = 32;
  const load = (r, g, b) => {
    const img = new FakeImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
    return img;
  };
  const cases = [
    ['黑', 0, 0, 0, 0],
    ['白', 255, 255, 255, 1],
    ['黄', 255, 230, 0, 2],
    ['红', 230, 40, 30, 3],
    ['蓝', 20, 80, 200, 4],
    ['绿', 30, 160, 80, 5],
  ];
  let pass = true;
  for (const [name, r, g, b, idx] of cases) {
    const res = C.dither(load(r, g, b), { algo: 'threshold' });
    const hit = res.stats[idx] && res.stats[idx].ratio > 0.98;
    if (!hit) {
      pass = false;
      console.error('    ' + name + ' 未被识别为调色板索引 ' + idx + '：' + JSON.stringify(res.stats.map((s) => s.name + ':' + s.ratio.toFixed(2))));
    }
  }
  ok(pass, '六种纯色经阈值量化后落回同一颜色（>98% 像素）');
}

/* 5. 各抖动算法都能跑通且输出只有合法颜色 */
{
  let pass = true;
  for (const a of C.ALGORITHMS) {
    const img = new FakeImageData(40, 30);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + ((i * 7) % 100);
      img.data[i] = v;
      img.data[i + 1] = 255 - v;
      img.data[i + 2] = (v * 3) % 255;
      img.data[i + 3] = 255;
    }
    const res = C.dither(img, { algo: a.value });
    const bad = res.ids.some((v) => v < 0 || v >= C.PALETTE.length);
    const sum = res.stats.reduce((s, x) => s + x.count, 0);
    if (bad || sum !== 40 * 30) {
      pass = false;
      console.error('    ' + a.value + ' 输出异常');
    }
  }
  ok(pass, '12 种抖动算法均输出合法索引且像素数守恒');
}

/* 6. 大图帧长与性能 */
{
  const w = 480;
  const h = 720;
  const img = new FakeImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i / 4) % 255;
    img.data[i + 1] = ((i / 4) >> 8) % 255;
    img.data[i + 2] = 90;
    img.data[i + 3] = 255;
  }
  const t0 = Date.now();
  const res = C.dither(img, { algo: 'floydSteinberg', serpentine: true });
  const bytes = C.pack(res.ids, w, h);
  const ms = Date.now() - t0;
  ok(bytes.length === 172800, '480×720 实际打包 = 172800 字节');
  ok(ms < 4000, '480×720 转换耗时 ' + ms + ' ms（< 4000 ms）');
  const back = C.unpack(bytes, w, h);
  let same = true;
  for (let p = 0; p < res.ids.length; p++) if (res.ids[p] !== back[p]) { same = false; break; }
  ok(same, '480×720 往返一致');
}

/* 7. 内置自检（面板上下反转让固件处理，codec 不再做翻转补偿） */
ok(C.selfTest().ok, 'Codec.selfTest() 通过');
ok(typeof C.flipVIds === 'undefined', 'codec 已不提供 flipVIds（方向由固件处理）');

if (fail.length) {
  console.error('\n失败 ' + fail.length + ' 项');
  process.exit(1);
}
console.log('\n全部通过');
