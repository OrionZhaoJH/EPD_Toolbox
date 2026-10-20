/* ==========================================================================
   E6 六色电子纸编解码核心
   --------------------------------------------------------------------------
   纯函数模块，不依赖 DOM 之外的任何东西（只用到 OffscreenCanvas/canvas 做缩放
   和预览）。可以被首页、工具页、Node 侧脚本复用。

   面板约定（E6 / 480x720 4bpp）：
     - 每个像素 4 bit，两个像素拼一个字节，**高半字节在前的像素在上方**
     - 颜色编号：黑 0 / 白 1 / 黄 2 / 红 3 / 蓝 5 / 绿 6（4、7 保留不用）
     - 扫描方向：**列优先**，外层 x = 0 → w-1，内层每字节跨 2 行
       即 byte[x][yg] = (像素(x, 2*yg) << 4) | 像素(x, 2*yg+1)
     - 一帧字节数 = w * ceil(h / 2)
   ========================================================================== */
(function (global) {
  'use strict';

  /**
   * 设备颜色编号（写进 4bpp 半字节的值）。6 个调色板索引依次对应这 6 个 id，
   * 4 / 7 是保留值，任何色板都不使用。
   * 色板（palette）只决定「量化时把哪个 RGB 当目标」，写进像素的 id 始终是这 6 个。
   */
  const PALETTE_IDS = [0, 1, 2, 3, 5, 6];

  /** 色块名称固定对应设备的 6 种颜色 */
  const PALETTE_NAMES = ['黑', '白', '黄', '红', '蓝', '绿'];

  /** "#rrggbb" 字符串 → 调色板项数组（index 是调色板下标，id 是写进像素的值） */
  function buildColors(hexes) {
    return hexes.map((hex, index) => {
      const h = hex.replace('#', '').toLowerCase();
      return {
        index,
        id: PALETTE_IDS[index],
        name: PALETTE_NAMES[index],
        hex: '#' + h,
        rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
      };
    });
  }

  /**
   * 可用色板：量化时用的 6 个目标 RGB。
   * 换色板只改「抖动往哪个颜色上靠」，打包格式与设备 id 不变。
   */
  const PALETTES = {
    e6: {
      key: 'e6',
      name: 'E6 标准色',
      colors: buildColors(['000000', 'ffffff', 'ffe600', 'e8332a', '1b57c4', '1f9d55']),
    },
    e6alt: {
      key: 'e6alt',
      name: 'E6 深色板',
      colors: buildColors(['000008', 'efffff', 'ffd700', '860000', '001c8a', '145d14']),
    },
  };

  const DEFAULT_PALETTE_KEY = 'e6';

  /** 默认色板（E6 标准色）——保留旧接口 E6Codec.PALETTE 的兼容性 */
  const PALETTE = PALETTES[DEFAULT_PALETTE_KEY].colors;

  /** 设备 id → 调色板下标（4、7 为保留位，不在表里） */
  const ID_TO_INDEX = new Map(PALETTE_IDS.map((id, index) => [id, index]));

  /** 按 key 取色板对象，未知 key 回退到默认色板 */
  function getPalette(key) {
    return PALETTES[key] || PALETTES[DEFAULT_PALETTE_KEY];
  }

  /** 误差扩散核：[dx, dy, 权重] */
  const KERNELS = {
    floydSteinberg: [
      [1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16],
    ],
    atkinson: [
      [1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8],
    ],
    jarvis: [
      [1, 0, 7 / 48], [2, 0, 5 / 48],
      [-2, 1, 3 / 48], [-1, 1, 5 / 48], [0, 1, 7 / 48], [1, 1, 5 / 48], [2, 1, 3 / 48],
      [-2, 2, 1 / 48], [-1, 2, 3 / 48], [0, 2, 5 / 48], [1, 2, 3 / 48], [2, 2, 1 / 48],
    ],
    stucki: [
      [1, 0, 8 / 42], [2, 0, 4 / 42],
      [-2, 1, 2 / 42], [-1, 1, 4 / 42], [0, 1, 8 / 42], [1, 1, 4 / 42], [2, 1, 2 / 42],
      [-2, 2, 1 / 42], [-1, 2, 2 / 42], [0, 2, 4 / 42], [1, 2, 2 / 42], [2, 2, 1 / 42],
    ],
    burkes: [
      [1, 0, 8 / 32], [2, 0, 4 / 32],
      [-2, 1, 2 / 32], [-1, 1, 4 / 32], [0, 1, 8 / 32], [1, 1, 4 / 32], [2, 1, 2 / 32],
    ],
    sierra: [
      [1, 0, 5 / 32], [2, 0, 3 / 32],
      [-2, 1, 2 / 32], [-1, 1, 4 / 32], [0, 1, 5 / 32], [1, 1, 4 / 32], [2, 1, 2 / 32],
      [-1, 2, 2 / 32], [0, 2, 3 / 32], [1, 2, 2 / 32],
    ],
    sierraLite: [[1, 0, 2 / 4], [-1, 1, 1 / 4], [0, 1, 1 / 4]],
  };

  const BAYER = {
    ordered2: [[0, 2], [3, 1]],
    ordered4: [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]],
    ordered8: [
      [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
      [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
      [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
      [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
    ],
  };

  /** 抖动量化的常用算法清单（供 UI 下拉框使用） */
  const ALGORITHMS = [
    { value: 'floydSteinberg', label: 'Floyd-Steinberg（推荐）', type: 'diffusion' },
    { value: 'atkinson', label: 'Atkinson（高对比，颗粒感）', type: 'diffusion' },
    { value: 'jarvis', label: 'Jarvis-Judice-Ninke（细腻）', type: 'diffusion' },
    { value: 'stucki', label: 'Stucki（清晰）', type: 'diffusion' },
    { value: 'burkes', label: 'Burkes', type: 'diffusion' },
    { value: 'sierra', label: 'Sierra', type: 'diffusion' },
    { value: 'sierraLite', label: 'Sierra Lite', type: 'diffusion' },
    { value: 'ordered2', label: 'Ordered 2×2', type: 'ordered' },
    { value: 'ordered4', label: 'Ordered 4×4', type: 'ordered' },
    { value: 'ordered8', label: 'Ordered 8×8', type: 'ordered' },
    { value: 'threshold', label: '阈值（无抖动）', type: 'raw' },
    { value: 'random', label: '随机噪点', type: 'raw' },
  ];

  const DEFAULT_WIDTH = 480;
  const DEFAULT_HEIGHT = 720;

  /** 单个像素的字节数：4bpp = 0.5 B，一帧 = w * ceil(h / 2) */
  function frameBytes(width, height) {
    return width * Math.ceil(height / 2);
  }

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  /**
   * 在一套色板里找最接近的颜色，返回调色板索引（0~5）。
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @param {Array} [colors] 调色板项数组，默认用 E6 标准色
   */
  function nearestIndex(r, g, b, colors) {
    const pal = colors || PALETTE;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const c = pal[i].rgb;
      const dr = r - c[0];
      const dg = g - c[1];
      const db = b - c[2];
      // 人眼对绿色更敏感，加权后黄色/白色更不容易被误判成黑白
      const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * 把源图按目标尺寸绘制到 canvas。
   * @param {CanvasImageSource} source 图片或 canvas
   * @param {number} width 目标宽
   * @param {number} height 目标高
   * @param {'contain'|'cover'|'stretch'} fit
   *   contain = 等比缩放并居中留白（白底）
   *   cover   = 等比缩放铺满后居中裁剪
   *   stretch = 直接拉伸到目标尺寸
   * @param {string} [background='#ffffff'] 留白颜色
   */
  function drawFitted(source, width, height, fit, background) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background || '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const sw = source.width || source.videoWidth || 0;
    const sh = source.height || source.videoHeight || 0;
    if (!sw || !sh) return ctx.getImageData(0, 0, width, height);

    if (fit === 'stretch') {
      ctx.drawImage(source, 0, 0, width, height);
    } else {
      const scale =
        fit === 'cover' ? Math.max(width / sw, height / sh) : Math.min(width / sw, height / sh);
      const dw = Math.max(1, Math.round(sw * scale));
      const dh = Math.max(1, Math.round(sh * scale));
      ctx.drawImage(source, Math.round((width - dw) / 2), Math.round((height - dh) / 2), dw, dh);
    }
    return ctx.getImageData(0, 0, width, height);
  }

  /** 亮度 / 对比度预处理，返回新的 ImageData */
  function preprocess(imageData, brightness, contrast) {
    const out = new ImageData(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height
    );
    const b = brightness * 2.55;
    const f = contrast === 0 ? 1 : (259 * (contrast + 255)) / (255 * (259 - contrast));
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp255(f * (d[i] + b - 128) + 128);
      d[i + 1] = clamp255(f * (d[i + 1] + b - 128) + 128);
      d[i + 2] = clamp255(f * (d[i + 2] + b - 128) + 128);
      d[i + 3] = 255;
    }
    return out;
  }

  function diffuse(data, w, h, x, y, er, eg, eb, f) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = clamp255(data[i] + er * f);
    data[i + 1] = clamp255(data[i + 1] + eg * f);
    data[i + 2] = clamp255(data[i + 2] + eb * f);
  }

  /**
   * 抖动 + 量化，主入口。
   * @param {ImageData} imageData 已按目标尺寸绘制好的源数据
   * @param {object} opts
   *   algo: ALGORITHMS 里的 value
   *   brightness: -100..100
   *   contrast: -100..100
   *   strength: 0..1 误差扩散强度
   *   serpentine: 蛇形扫描
   *   palette: 色板 key（'e6' / 'e6alt'）或色板对象，缺省用 E6 标准色
   * @returns {{ids: Uint16Array, width: number, height: number, imageData: ImageData, stats: Array}}
   */
  function dither(imageData, opts) {
    const o = opts || {};
    const w = imageData.width;
    const h = imageData.height;
    const algo = o.algo || 'floydSteinberg';
    const strength = o.strength == null ? 1 : o.strength;
    const serpentine = !!o.serpentine;
    const palette = typeof o.palette === 'string' ? getPalette(o.palette) : o.palette || getPalette();
    const pal = palette.colors;

    const src = preprocess(imageData, o.brightness || 0, o.contrast || 0);
    const data = new Float32Array(w * h * 4);
    const sd = src.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = sd[i];
      data[i + 1] = sd[i + 1];
      data[i + 2] = sd[i + 2];
      data[i + 3] = 255;
    }

    const ids = new Uint16Array(w * h);

    const runOrdered = (matrix, n) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const t = ((matrix[y % n][x % n] + 0.5) / (n * n)) * 255;
          const i = (y * w + x) * 4;
          ids[y * w + x] = nearestIndex(
            clamp255(data[i] + t - 128),
            clamp255(data[i + 1] + t - 128),
            clamp255(data[i + 2] + t - 128),
            pal
          );
        }
      }
    };

    if (algo === 'threshold') {
      for (let p = 0, i = 0; p < ids.length; p++, i += 4) {
        ids[p] = nearestIndex(data[i], data[i + 1], data[i + 2], pal);
      }
    } else if (algo === 'random') {
      for (let p = 0, i = 0; p < ids.length; p++, i += 4) {
        const n = (Math.random() - 0.5) * 90;
        ids[p] = nearestIndex(
          clamp255(data[i] + n),
          clamp255(data[i + 1] + n),
          clamp255(data[i + 2] + n),
          pal
        );
      }
    } else if (algo.startsWith('ordered')) {
      const n = algo === 'ordered2' ? 2 : algo === 'ordered4' ? 4 : 8;
      runOrdered(BAYER['ordered' + n], n);
    } else {
      const kernel = KERNELS[algo] || KERNELS.floydSteinberg;
      for (let y = 0; y < h; y++) {
        const leftToRight = !serpentine || y % 2 === 0;
        const xs = leftToRight ? 0 : w - 1;
        const xe = leftToRight ? w : -1;
        const step = leftToRight ? 1 : -1;
        for (let x = xs; x !== xe; x += step) {
          const i = (y * w + x) * 4;
          const or = data[i];
          const og = data[i + 1];
          const ob = data[i + 2];
          const idx = nearestIndex(or, og, ob, pal);
          ids[y * w + x] = idx;
          const c = pal[idx].rgb;
          data[i] = c[0];
          data[i + 1] = c[1];
          data[i + 2] = c[2];
          const er = (or - c[0]) * strength;
          const eg = (og - c[1]) * strength;
          const eb = (ob - c[2]) * strength;
          if (er === 0 && eg === 0 && eb === 0) continue;
          for (let k = 0; k < kernel.length; k++) {
            const dx = kernel[k][0];
            const dy = kernel[k][1];
            const nx = leftToRight ? x + dx : x - dx;
            diffuse(data, w, h, nx, y + dy, er, eg, eb, kernel[k][2]);
          }
        }
      }
    }

    return { ids, width: w, height: h, imageData: idsToImageData(ids, w, h, pal), stats: stats(ids, pal) };
  }

  /** 调色板索引数组 → 可直接绘制/导出的 ImageData（颜色取自传入的色板） */
  function idsToImageData(ids, w, h, colors) {
    const pal = colors || PALETTE;
    const out = new ImageData(w, h);
    const d = out.data;
    for (let p = 0, i = 0; p < ids.length; p++, i += 4) {
      const c = pal[ids[p]] || pal[0];
      d[i] = c.rgb[0];
      d[i + 1] = c.rgb[1];
      d[i + 2] = c.rgb[2];
      d[i + 3] = 255;
    }
    return out;
  }

  /**
   * 打包成面板 DTM 数据：4bpp，列优先，高半字节是上面的像素。
   * 调色板索引 → 设备 id（PALETTE_IDS）与用哪套色板无关，所以换色板不影响打包结果结构。
   * @param {Uint16Array} ids 调色板索引（0~5）
   * @returns {Uint8Array} 长度 = w * ceil(h / 2)
   */
  function pack(ids, w, h) {
    const rowsPerByte = 2;
    const bytes = new Uint8Array(frameBytes(w, h));
    let p = 0;
    for (let x = 0; x < w; x++) {
      for (let yg = 0; yg * rowsPerByte < h; yg++) {
        const y0 = yg * rowsPerByte;
        const y1 = y0 + 1;
        const hi = PALETTE_IDS[ids[y0 * w + x]] != null ? PALETTE_IDS[ids[y0 * w + x]] : 0;
        const lo = y1 < h && PALETTE_IDS[ids[y1 * w + x]] != null ? PALETTE_IDS[ids[y1 * w + x]] : 0;
        bytes[p++] = ((hi & 0x0f) << 4) | (lo & 0x0f);
      }
    }
    return bytes;
  }

  /** 反解：字节流 → 调色板索引，用于校验与回读预览 */
  function unpack(bytes, w, h) {
    const ids = new Uint16Array(w * h);
    let p = 0;
    for (let x = 0; x < w; x++) {
      for (let yg = 0; yg * 2 < h; yg++) {
        const b = bytes[p++];
        const y0 = yg * 2;
        const y1 = y0 + 1;
        const hi = (b >> 4) & 0x0f;
        const lo = b & 0x0f;
        ids[y0 * w + x] = ID_TO_INDEX.has(hi) ? ID_TO_INDEX.get(hi) : 0;
        if (y1 < h) ids[y1 * w + x] = ID_TO_INDEX.has(lo) ? ID_TO_INDEX.get(lo) : 0;
      }
    }
    return ids;
  }

  /** 每种颜色出现的次数与占比（名称 / hex 取自传入的色板） */
  function stats(ids, colors) {
    const pal = colors || PALETTE;
    const counts = new Array(pal.length).fill(0);
    for (let p = 0; p < ids.length; p++) counts[ids[p]]++;
    const total = ids.length || 1;
    return pal.map((c, i) => ({
      id: c.id,
      name: c.name,
      hex: c.hex,
      count: counts[i],
      ratio: counts[i] / total,
    }));
  }

  /** 十六进制字符串，便于贴日志 / 对比 */
  function toHex(bytes, max) {
    const n = max && max < bytes.length ? max : bytes.length;
    const parts = new Array(n);
    for (let i = 0; i < n; i++) parts[i] = bytes[i].toString(16).padStart(2, '0').toUpperCase();
    const s = parts.join(' ');
    return n < bytes.length ? s + ' …' : s;
  }

  /** 生成 C 数组源码 */
  function toCArray(bytes, name, perLine) {
    const n = perLine || 16;
    const lines = [];
    lines.push('/* E6 六色位图数据，4bpp/像素，列优先，高半字节在上 */');
    lines.push('const uint8_t ' + (name || 'gImageE6') + '[' + bytes.length + '] = {');
    for (let i = 0; i < bytes.length; i += n) {
      const chunk = [];
      for (let j = 0; j < n && i + j < bytes.length; j++) {
        chunk.push('0x' + bytes[i + j].toString(16).padStart(2, '0').toUpperCase());
      }
      lines.push('    ' + chunk.join(', ') + ',');
    }
    lines.push('};');
    return lines.join('\n');
  }

  /** 自检：随机图案 → pack → unpack 必须完全一致 */
  function selfTest() {
    const w = 12;
    const h = 9;
    const ids = new Uint16Array(w * h);
    for (let p = 0; p < ids.length; p++) ids[p] = p % PALETTE.length;
    const bytes = pack(ids, w, h);
    const back = unpack(bytes, w, h);
    if (bytes.length !== frameBytes(w, h)) return { ok: false, reason: '帧长不符' };
    for (let p = 0; p < ids.length; p++) {
      if (ids[p] !== back[p]) return { ok: false, reason: '第 ' + p + ' 像素不一致' };
    }
    return { ok: true, bytes: bytes.length };
  }

  global.E6Codec = {
    PALETTE,
    PALETTE_IDS,
    PALETTES,
    DEFAULT_PALETTE_KEY,
    getPalette,
    KERNELS,
    BAYER,
    ALGORITHMS,
    DEFAULT_WIDTH,
    DEFAULT_HEIGHT,
    frameBytes,
    nearestIndex,
    drawFitted,
    preprocess,
    dither,
    idsToImageData,
    pack,
    unpack,
    stats,
    toHex,
    toCArray,
    selfTest,
  };
})(window);
