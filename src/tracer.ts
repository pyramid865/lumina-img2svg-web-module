// 纯 JS 分层描色引擎（不依赖 WebAssembly，工坊 CSP 下可运行）。
//
// 管线与 vtracer 的 stacked 模式同思路，但全部自己实现：
//   1) 轻度中值去噪（去掉压缩噪点，不糊边）
//   2) Lab 空间 k-means 颜色量化（比 RGB 距离更贴近人眼）
//   3) 按面积从大到小排序颜色，逐色取掩膜
//   4) 沿像素边界追踪闭合轮廓（crack following），得到精确的直角多边形
//   5) Douglas-Peucker 简化 + 拐角保留的 Catmull-Rom 转三次贝塞尔
//   6) 小碎块过滤，输出 evenodd 填充的分层 path
//
// 相比 imagetracerjs：颜色分离更干净、边缘是平滑曲线而非锯齿折线、碎点更少。

export interface ImageDataLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface TracerOptions {
  /** 量化颜色数 */
  colors: number;
  /** 轮廓简化容差（像素），越大越简洁 */
  simplify: number;
  /** 小于该面积（像素）的连通块直接丢弃 */
  minArea: number;
  /** 中值去噪半径（0 关闭，1 = 3x3） */
  denoise: number;
  /** 平滑强度：0 关闭，1~2 为佳 */
  smooth: number;
  /** 掩膜膨胀像素数：用于盖住相邻色块之间的白缝 */
  dilate?: number;
  /** 同色描边宽度（像素）：各向同性地外扩 border/2，比方形膨胀精确，用来填相邻色块的缝 */
  stroke?: number;
  /** 曲线拟合容差（像素）：>0 启用 potrace 式最小二乘贝塞尔拟合，替代 Catmull-Rom */
  fitTol?: number;
  /** 角点判定阈值（cos）：转角余弦小于该值视为尖角，曲线在此断开 */
  cornerCos?: number;
  /** 亚像素边缘吸附幅度上限（像素）：0 关闭。把顶点沿法向推到原图颜色过渡的中点 */
  snap?: number;
  /** 超采样倍数：在放大后的网格上描摹再缩回坐标，细结构（手指/发丝）更保真 */
  supersample?: number;
  /** 标签众数滤波：0 关闭，1 = 3x3 一遍，2 = 3x3 两遍 */
  labelSmooth?: number;
  /** 调试：只输出下标为该值的颜色（-1 = 全部） */
  debugOnly?: number;
}

export const DEFAULT_OPTIONS: TracerOptions = {
  colors: 128,
  simplify: 0.4,
  minArea: 0,
  denoise: 1,
  smooth: 2,
  dilate: 0,
  stroke: 1.0,
  fitTol: 1.5,
  cornerCos: 0.0,
  snap: 0.8,
};

/** 调试用计数：未闭合的轮廓条数（正常应为 0） */
export const traceStats = { unclosed: 0, timings: {} as Record<string, number>, maxDeg: 0, degHist: [] as number[], loops: 0 };

/* ---------------------------------------------------------------- 颜色空间 */

function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const R = f(r), G = f(g), B = f(b);
  // sRGB -> XYZ (D65)
  let X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  let Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  X /= 0.95047; Y /= 1.0; Z /= 1.08883;
  const g2 = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = g2(X), fy = g2(Y), fz = g2(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = 0.95047 * inv(fx), Y = 1.0 * inv(fy), Z = 1.08883 * inv(fz);
  let r = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  let g = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  let bb = X * 0.0557 + Y * -0.204 + Z * 1.057;
  const gam = (v: number) => {
    const x = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(x * 255)));
  };
  return [gam(r), gam(g), gam(bb)];
}

/* ------------------------------------------------------------- 中值去噪 */

function medianDenoise(img: ImageDataLike): Uint8Array {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h * 3);

  // 9 数取中值的排序网络（19 次比较，无循环无分配）。
  // 之前是每个像素每通道做一次插入排序 + 逐点边界判断，300 万像素要 1 秒多。
  const med9 = (p0: number, p1: number, p2: number, p3: number, p4: number,
                p5: number, p6: number, p7: number, p8: number): number => {
    let t: number;
    if (p1 > p2) { t = p1; p1 = p2; p2 = t; }
    if (p4 > p5) { t = p4; p4 = p5; p5 = t; }
    if (p7 > p8) { t = p7; p7 = p8; p8 = t; }
    if (p0 > p1) { t = p0; p0 = p1; p1 = t; }
    if (p3 > p4) { t = p3; p3 = p4; p4 = t; }
    if (p6 > p7) { t = p6; p6 = p7; p7 = t; }
    if (p1 > p2) { t = p1; p1 = p2; p2 = t; }
    if (p4 > p5) { t = p4; p4 = p5; p5 = t; }
    if (p7 > p8) { t = p7; p7 = p8; p8 = t; }
    if (p0 > p3) { t = p0; p0 = p3; p3 = t; }
    if (p5 > p8) { t = p5; p5 = p8; p8 = t; }
    if (p4 > p7) { t = p4; p4 = p7; p7 = t; }
    if (p3 > p6) { t = p3; p3 = p6; p6 = t; }
    if (p1 > p4) { t = p1; p1 = p4; p4 = t; }
    if (p2 > p5) { t = p2; p2 = p5; p5 = t; }
    if (p4 > p7) { t = p4; p4 = p7; p7 = t; }
    if (p4 > p2) { t = p4; p4 = p2; p2 = t; }
    if (p6 > p4) { t = p6; p6 = p4; p4 = t; }
    if (p4 > p2) { t = p4; p4 = p2; p2 = t; }
    return p4;
  };

  for (let y = 0; y < h; y++) {
    // 行基址直接用字节偏移，和列偏移（x<<2）同一量纲，否则行内会整体错位
    const y0 = (y > 0 ? y - 1 : 0) * w * 4;
    const y1 = y * w * 4;
    const y2 = (y < h - 1 ? y + 1 : h - 1) * w * 4;
    for (let x = 0; x < w; x++) {
      const x0 = (x > 0 ? x - 1 : 0) << 2;
      const x1 = x << 2;
      const x2 = (x < w - 1 ? x + 1 : w - 1) << 2;
      const i00 = y0 + x0, i01 = y0 + x1, i02 = y0 + x2;
      const i10 = y1 + x0, i11 = y1 + x1, i12 = y1 + x2;
      const i20 = y2 + x0, i21 = y2 + x1, i22 = y2 + x2;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[o + c] = med9(
          data[i00 + c], data[i01 + c], data[i02 + c],
          data[i10 + c], data[i11 + c], data[i12 + c],
          data[i20 + c], data[i21 + c], data[i22 + c],
        );
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------- k-means */

/** 确定性伪随机（mulberry32）：保证同一张图每次量化结果完全一致 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


interface QuantResult {
  labels: Uint8Array;       // 每像素的颜色下标
  palette: number[][];      // [r,g,b]
  counts: number[];
}

function quantize(rgb: Uint8Array, w: number, h: number, k: number, seed = 1337): QuantResult {
  const rng = makeRng(seed);
  const total = w * h;

  // 先归到 5-5-5 直方图：聚类在最多 32768 个格子上做，比逐像素快一个数量级
  // 直方图与查找表都用 BITS 位/通道。5 位（32 级）会先把颜色压到 32768 个格子，
  // 相邻色块在格子边界上被强行合并；6 位明显减少这种"格子化"的边界抖动。
  const BITS = 6, SHIFT = 8 - BITS;
  const BINS = 1 << (3 * BITS);
  const cnt = new Float64Array(BINS);
  const sumR = new Float64Array(BINS), sumG = new Float64Array(BINS), sumB = new Float64Array(BINS);
  for (let i = 0; i < total; i++) {
    const p = i * 3;
    const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
    const key = ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    cnt[key]++;
    sumR[key] += r; sumG[key] += g; sumB[key] += b;
  }
  const keys: number[] = [];
  for (let i = 0; i < BINS; i++) if (cnt[i] > 0) keys.push(i);
  const n = keys.length;

  // 每个格子的平均色（作为该格子的代表色）
  const binRgb = keys.map((key) => {
    const c = cnt[key];
    return [sumR[key] / c, sumG[key] / c, sumB[key] / c] as [number, number, number];
  });
  const binLab = binRgb.map(([r, g, b]) => srgbToLab(r, g, b));
  const binW = keys.map((key) => cnt[key]);

  // k-means++ 初始化（按权重抽样）
  const totalW = binW.reduce((a, b) => a + b, 0);
  const centers: number[][] = [];
  {
    let r = rng() * totalW, pick = 0;
    for (let i = 0; i < n; i++) { r -= binW[i]; if (r <= 0) { pick = i; break; } }
    centers.push([...binLab[pick]]);
  }
  const d2 = new Float64Array(n).fill(Infinity);
  while (centers.length < Math.min(k, n)) {
    const c = centers[centers.length - 1];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dl = binLab[i][0] - c[0], da = binLab[i][1] - c[1], db = binLab[i][2] - c[2];
      const dist = dl * dl + da * da + db * db;
      if (dist < d2[i]) d2[i] = dist;
      sum += d2[i] * binW[i];
    }
    if (sum <= 0) break;
    let r = rng() * sum, pick = 0;
    for (let i = 0; i < n; i++) { r -= d2[i] * binW[i]; if (r <= 0) { pick = i; break; } }
    centers.push([...binLab[pick]]);
  }

  // 加权 Lloyd 迭代
  const assign = new Int32Array(n);
  for (let iter = 0; iter < 10; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const [L, A, B] = binLab[i];
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dl = L - centers[c][0], da = A - centers[c][1], db = B - centers[c][2];
        const dist = dl * dl + da * da + db * db;
        if (dist < bestD) { bestD = dist; best = c; }
      }
      assign[i] = best;
      const acc = sums[best], wt = binW[i];
      acc[0] += L * wt; acc[1] += A * wt; acc[2] += B * wt; acc[3] += wt;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] > 0) {
        centers[c][0] = sums[c][0] / sums[c][3];
        centers[c][1] = sums[c][1] / sums[c][3];
        centers[c][2] = sums[c][2] / sums[c][3];
      }
    }
  }

  // 调色板：取各簇内实际像素的平均 sRGB（比 Lab 中心回算更准）
  const palSum = centers.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const c = assign[i], wt = binW[i];
    const acc = palSum[c];
    acc[0] += binRgb[i][0] * wt; acc[1] += binRgb[i][1] * wt; acc[2] += binRgb[i][2] * wt; acc[3] += wt;
  }
  const palette: number[][] = palSum.map(([r, g, b, c]: number[]) =>
    c > 0 ? [Math.round(r / c), Math.round(g / c), Math.round(b / c)] : [0, 0, 0],
  );

  // 像素分配：BITS-BITS-BITS 查找表。
  // 只给「图上真实出现过的格子」建表（通常几千个），而不是遍历全部 2^(3·BITS) 个格子
  // —— 6 位时那是 26 万 × 颜色数 的距离计算，纯属浪费。
  const centersRgb = centers.map(([L, a, b]) => labToRgb(L, a, b));
  const LUT = new Int16Array(BINS).fill(-1);
  const half = 1 << (SHIFT - 1);
  const perBit = (1 << BITS) - 1;
  for (let i = 0; i < n; i++) {
    const key = keys[i];
    const r = ((key >> (2 * BITS)) << SHIFT) | half;
    const g = (((key >> BITS) & perBit) << SHIFT) | half;
    const b = ((key & perBit) << SHIFT) | half;
    let best = 0, bestD = Infinity;
    for (let c = 0; c < centersRgb.length; c++) {
      const dr = r - centersRgb[c][0], dg = g - centersRgb[c][1], db = b - centersRgb[c][2];
      const dist = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (dist < bestD) { bestD = dist; best = c; }
    }
    LUT[key] = best;
  }
  const nearest = (key: number): number => {
    let v = LUT[key];
    if (v < 0) {
      // 理论上不会走到（所有出现过的格子都建了表），保险起见现算
      const r = ((key >> (2 * BITS)) << SHIFT) | half;
      const g = (((key >> BITS) & perBit) << SHIFT) | half;
      const b = ((key & perBit) << SHIFT) | half;
      let bestD = Infinity;
      let best = 0;
      for (let c = 0; c < centersRgb.length; c++) {
        const dr = r - centersRgb[c][0], dg = g - centersRgb[c][1], db = b - centersRgb[c][2];
        const dist = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (dist < bestD) { bestD = dist; best = c; }
      }
      v = LUT[key] = best;
    }
    return v;
  };

  const labels = new Uint8Array(total);
  const counts = new Array(palette.length).fill(0);
  for (let i = 0; i < total; i++) {
    const p = i * 3;
    const key = ((rgb[p] >> SHIFT) << (2 * BITS)) | ((rgb[p + 1] >> SHIFT) << BITS) | (rgb[p + 2] >> SHIFT);
    const c = nearest(key);
    labels[i] = c;
    counts[c]++;
  }
  return { labels, palette, counts };
}

/* --------------------------------------------------------------- 超采样 */

/** 双线性放大 RGBA 图像（只放大不缩小，用于超采样描摹） */
function upscale(img: ImageDataLike, s: number): ImageDataLike {
  const w = img.width, h = img.height;
  const W = w * s, H = h * s;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = (y + 0.5) / s - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < W; x++) {
      const sx = (x + 0.5) / s - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(w - 1, x0 + 1));
      const fx = Math.max(0, Math.min(1, sx - x0));
      const o = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = img.data[(y0 * w + x0) * 4 + c];
        const p10 = img.data[(y0 * w + x1) * 4 + c];
        const p01 = img.data[(y1 * w + x0) * 4 + c];
        const p11 = img.data[(y1 * w + x1) * 4 + c];
        const top = p00 + (p10 - p00) * fx;
        const bot = p01 + (p11 - p01) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
    }
  }
  return { data: out, width: W, height: H };
}

/* ------------------------------------------------------------- 孤点清除 */

/**
 * 只清除「孤立点」：某像素的 8 邻域里几乎没有同色像素时才改判。
 * 比整片众数滤波温和——不会把手指、发丝这类细结构啃掉。
 */
function despeckle(labels: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(labels);
  const counts = new Uint16Array(k);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const self = labels[i];
      let same = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (labels[yy * w + xx] === self) same++;
        }
      }
      if (same >= 2) continue;
      counts.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const c = labels[yy * w + xx];
          if (c !== self) counts[c]++;
        }
      }
      let best = self, bestC = 0;
      for (let c = 0; c < k; c++) if (counts[c] > bestC) { bestC = counts[c]; best = c; }
      if (bestC >= 2) out[i] = best;
    }
  }
  return out;
}

/** 众数滤波（更强，仅在 labelSmooth 打开时使用） */
function modeFilter(labels: Uint8Array, w: number, h: number, k: number, radius: number): Uint8Array {
  if (radius <= 0) return labels;
  const out = new Uint8Array(labels.length);
  const counts = new Uint16Array(k);
  const R = radius;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      counts.fill(0);
      const y0 = Math.max(0, y - R), y1 = Math.min(h - 1, y + R);
      const x0 = Math.max(0, x - R), x1 = Math.min(w - 1, x + R);
      let best = labels[y * w + x], bestC = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const c = labels[row + xx];
          const n = ++counts[c];
          if (n > bestC) { bestC = n; best = c; }
        }
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- 膨胀 */

/** 掩膜膨胀 1 像素，盖住相邻色块之间因简化产生的白缝 */
function dilate(mask: Uint8Array, w: number, h: number): void {
  const src = new Uint8Array(mask);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i]) continue;
      if ((x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) ||
          (y > 0 && src[i - w]) || (y < h - 1 && src[i + w])) {
        mask[i] = 1;
      }
    }
  }
}

/* ------------------------------------------------------------ 连通块过滤 */

function keepLargeComponents(mask: Uint8Array, w: number, h: number, minArea: number): void {
  if (minArea <= 1) return;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0, size = 0;
    stack[sp++] = i;
    seen[i] = 1;
    const cells: number[] = [];
    while (sp > 0) {
      const idx = stack[--sp];
      cells.push(idx);
      size++;
      const x = idx % w, y = (idx - x) / w;
      if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < w - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (y > 0 && mask[idx - w] && !seen[idx - w]) { seen[idx - w] = 1; stack[sp++] = idx - w; }
      if (y < h - 1 && mask[idx + w] && !seen[idx + w]) { seen[idx + w] = 1; stack[sp++] = idx + w; }
    }
    if (size < minArea) for (const c of cells) mask[c] = 0;
  }
}

/* ------------------------------------------------------- 轮廓（沿像素边界） */

type Pt = [number, number];

/**
 * 去掉共线的中间点，只保留方向变化的拐点。
 * marching squares 的输出是每半像素一个点、方向只有水平和垂直，
 * 一段直边会带几十个共线点；先压掉它们，后面的简化/吸附/拟合都能快好几倍。
 */
function compressCollinear(loop: Pt[]): Pt[] {
  const n = loop.length;
  if (n < 3) return loop;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = loop[(i - 1 + n) % n], c = loop[i], q = loop[(i + 1) % n];
    const d1x = c[0] - p[0], d1y = c[1] - p[1];
    const d2x = q[0] - c[0], d2y = q[1] - c[1];
    if (d1x !== d2x || d1y !== d2y) out.push(c);
  }
  return out.length >= 3 ? out : loop;
}

/**
 * 沿像素边界追踪闭合轮廓（marching squares）。
 *
 * 用 2x2 像素格的 16 种组合决定线段，线段端点落在格边中点。
 * 每个中点只被两个相邻格子共享，因此每个端点恰好接 2 条线段 —— 走线天然不歧义，
 * 不会像「沿顶点走边」那样在对角相接处跳错分支。
 */
function traceContours(mask: Uint8Array, w: number, h: number): Pt[][] {
  const W = w + 2, H = h + 2;
  // 铺成带 1 像素 0 边的缓冲，走格时直接下标访问。
  // 原来每格调 4 次带边界判断的 at()，A 图里是上亿次函数调用，纯这一项就要几秒。
  const pad = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) {
    const src = y * w, dst = (y + 1) * W + 1;
    for (let x = 0; x < w; x++) if (mask[src + x]) pad[dst + x] = 1;
  }

  // 端点键：横向边 y*W+x，纵向边整体偏移 W*H
  const KEYN = 2 * W * H;
  const head = new Int32Array(KEYN).fill(-1);
  // 每条线段同时挂在两个端点的链上，用两个 next 数组区分方向
  let cap = 2048, cnt = 0;
  let ea = new Int32Array(cap), eb = new Int32Array(cap);
  let nA = new Int32Array(cap), nB = new Int32Array(cap);
  let used = new Uint8Array(cap);

  const grow = () => {
    cap *= 2;
    const a2 = new Int32Array(cap); a2.set(ea); ea = a2;
    const b2 = new Int32Array(cap); b2.set(eb); eb = b2;
    const c2 = new Int32Array(cap); c2.set(nA); nA = c2;
    const d2 = new Int32Array(cap); d2.set(nB); nB = d2;
    const u2 = new Uint8Array(cap); u2.set(used); used = u2;
  };
  const push = (a: number, b: number) => {
    if (cnt === cap) grow();
    ea[cnt] = a; eb[cnt] = b;
    nA[cnt] = head[a]; head[a] = cnt;
    nB[cnt] = head[b]; head[b] = cnt;
    cnt++;
  };

  const VOFF = W * H;
  for (let y = 0; y < H - 1; y++) {
    const row = y * W, row2 = (y + 1) * W;
    for (let x = 0; x < W - 1; x++) {
      const tl = pad[row + x], tr = pad[row + x + 1];
      const bl = pad[row2 + x], br = pad[row2 + x + 1];
      const c = tl | (tr << 1) | (br << 2) | (bl << 3);
      if (c === 0 || c === 15) continue;
      const T = row + x, B = row2 + x;
      const L = VOFF + row + x, R = VOFF + row + x + 1;
      switch (c) {
        case 1: case 14: push(L, T); break;
        case 2: case 13: push(T, R); break;
        case 3: case 12: push(L, R); break;
        case 4: case 11: push(R, B); break;
        case 6: case 9: push(T, B); break;
        case 7: case 8: push(L, B); break;
        case 5: push(L, T); push(R, B); break;
        case 10: push(T, R); push(B, L); break;
      }
    }
  }

  const pos = (k: number): Pt => {
    if (k < VOFF) {
      const x = k % W, y = (k - x) / W;
      // 横向边连的是像素 (x-1,y-1) 与 (x,y-1)：分界线在 x = x 上，纵向在像素行中心 y-0.5
      return [x, y - 0.5];
    }
    const kk = k - VOFF;
    const x = kk % W, y = (kk - x) / W;
    // 纵向边连的是像素 (x-1,y-1) 与 (x-1,y)：分界线在 y = y 上，横向在像素列中心 x-0.5
    return [x - 0.5, y];
  };

  // 诊断：统计每个端点的度数（正常应恒为 2）
  let maxDeg = 0;
  const hist = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < KEYN; k++) {
    if (head[k] < 0) continue;
    let d = 0, i = head[k];
    while (i >= 0) { d++; i = ea[i] === k ? nA[i] : nB[i]; if (d > 5) break; }
    if (d > 5) d = 5;
    hist[d]++;
    if (d > maxDeg) maxDeg = d;
  }
  traceStats.maxDeg = maxDeg;
  traceStats.degHist = hist;

  const loops: Pt[][] = [];
  for (let s = 0; s < cnt; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const startA = ea[s];
    const loop: Pt[] = [pos(startA)];
    let cur = eb[s];
    let guard = 0;
    let closed = false;
    while (guard++ < cnt * 2) {
      loop.push(pos(cur));
      // 在 cur 的链上找一条还没走过的线段
      let i = head[cur], nextId = -1;
      while (i >= 0) {
        if (!used[i]) { nextId = i; break; }
        i = ea[i] === cur ? nA[i] : nB[i];
      }
      if (nextId < 0) { closed = cur === startA; break; }
      used[nextId] = 1;
      cur = ea[nextId] === cur ? eb[nextId] : ea[nextId];
      if (cur === startA) { closed = true; break; }
    }
    if (closed && loop.length >= 4) loops.push(loop);
    else traceStats.unclosed++;
  }
  traceStats.loops = loops.length;
  return loops;
}

/* --------------------------------------------------------- 亚像素边缘吸附 */

/**
 * 把轮廓顶点沿法向推到「原图颜色过渡的中点」，消除半像素级的系统性偏移。
 *
 * marching squares 给出的边界落在像素中心之间，而原图边缘因为抗锯齿，
 * 真实几何边界在亚像素位置。做法是把顶点附近的颜色投影到
 * 「本块颜色 → 外侧颜色」连线上得到混合比例 α，α = 0.5 处就是边界。
 *
 * 只在过渡清晰（α 确实穿过 0.5）时移动，幅度限制在 maxShift 内，
 * 所以不会把噪声当边缘、也不会把曲线拉歪。
 */
function snapToEdge(
  pts: Pt[],
  rgb: Uint8Array, w: number, h: number,
  inner: [number, number, number],
  isInside: (x: number, y: number) => boolean,
  maxShift: number,
): Pt[] {
  const n = pts.length;
  if (n < 3) return pts;
  const at = (x: number, y: number): [number, number, number] => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const get = (xi: number, yi: number, c: number) => {
      const cx = xi < 0 ? 0 : xi >= w ? w - 1 : xi;
      const cy = yi < 0 ? 0 : yi >= h ? h - 1 : yi;
      return rgb[(cy * w + cx) * 3 + c];
    };
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = get(x0, y0, c), b = get(x0 + 1, y0, c);
      const d = get(x0, y0 + 1, c), e = get(x0 + 1, y0 + 1, c);
      const top = a + (b - a) * fx;
      const bot = d + (e - d) * fx;
      out[c] = top + (bot - top) * fy;
    }
    return out;
  };

  const out: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    let tx = next[0] - prev[0], ty = next[1] - prev[1];
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-9) { out[i] = p; continue; }
    tx /= tl; ty /= tl;
    // 法向（候选两个方向，稍后用 mask 判断哪边是外侧）
    let nx = -ty, ny = tx;
    if (isInside(p[0] + nx * 0.8, p[1] + ny * 0.8)) { nx = -nx; ny = -ny; }

    // 外侧参考色：往外多走一点，直到离开本块（最多 3px）
    let ox = 1.6;
    while (ox < 3.2 && isInside(p[0] + nx * ox, p[1] + ny * ox)) ox += 0.6;
    const B = at(p[0] + nx * ox, p[1] + ny * ox);

    const dr = B[0] - inner[0], dg = B[1] - inner[1], db = B[2] - inner[2];
    const denom = dr * dr + dg * dg + db * db;
    if (denom < 400) { out[i] = p; continue; } // 内外颜色太接近，边界不可靠

    // 沿法向在 ±maxShift 内扫，找 α 穿过 0.5 的位置
    const range = Math.max(1, maxShift);
    const STEPS = 15;
    let crossT: number | null = null, crossDist = Infinity;
    let prevA: number | null = null, prevT = 0;
    for (let k = 0; k < STEPS; k++) {
      const t = -range + (2 * range * k) / (STEPS - 1);
      const c = at(p[0] + nx * t, p[1] + ny * t);
      const alpha = ((c[0] - inner[0]) * dr + (c[1] - inner[1]) * dg + (c[2] - inner[2]) * db) / denom;
      if (prevA !== null && (prevA - 0.5) * (alpha - 0.5) <= 0) {
        // 线性插值到 α = 0.5，就是这一点的真实几何边界
        const frac = alpha === prevA ? 0 : (0.5 - prevA) / (alpha - prevA);
        const tz = prevT + (t - prevT) * frac;
        if (Math.abs(tz) <= maxShift && Math.abs(tz) < crossDist) { crossDist = Math.abs(tz); crossT = tz; }
      }
      prevA = alpha; prevT = t;
    }
    if (crossT === null) { out[i] = p; continue; }
    out[i] = [p[0] + nx * crossT, p[1] + ny * crossT];
  }
  return out;
}

/* ------------------------------------------------------------- 简化与平滑 */

function rdp(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let d2: number;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d2 > maxD) { maxD = d2; maxI = i; }
    }
    if (maxD > eps2 && maxI > 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** 闭合折线的简化：必须从两个相距最远的点断开，否则首尾相邻会被压成一条线 */
function rdpClosed(points: Pt[], eps: number): Pt[] {
  const n = points.length;
  if (n < 5) return points.slice();
  // 找离 0 号点最远的点作为第二个锚点
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = points.slice(0, far + 1);
  const b = points.slice(far).concat([points[0]]);
  const sa = rdp(a, eps);
  const sb = rdp(b, eps);
  // 去掉重复的接头点
  const out = sa.slice(0, -1).concat(sb.slice(0, -1));
  return out.length >= 3 ? out : points.slice();
}

/** 找出需要保留的拐角（转角大于阈值的点），用于平滑时不被抹圆 */
function cornerFlags(points: Pt[], cosThreshold = -0.2): boolean[] {
  const n = points.length;
  const flags = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const p = points[(i - 1 + n) % n], c = points[i], q = points[(i + 1) % n];
    const v1x = c[0] - p[0], v1y = c[1] - p[1];
    const v2x = q[0] - c[0], v2y = q[1] - c[1];
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
    if (cos > cosThreshold) flags[i] = true; // 夹角明显，视为拐角
  }
  return flags;
}

/* ------------------------------------------------- 曲线拟合（potrace 思路） */

/**
 * 三次贝塞尔最小二乘解：端点与端点切向固定，只求两个控制柄长度。
 *
 * B(t) = D(t) + α1·E1(t) + α2·E2(t)，其中 D 只含端点、E 只含切向，
 * 对 Σ|B(t_k) − P_k|² 求偏导得到 2×2 线性方程组，直接解出 α1、α2。
 * 参数 t 用累积弧长归一化（比均匀 t 更贴合实际点分布）。
 */
function solveBezier(points: Pt[], tStart: Pt, tEnd: Pt): [number, number] {
  const n = points.length;
  const P0 = points[0], P3 = points[n - 1];
  const cum = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    cum.push(total);
  }
  const chord = Math.hypot(P3[0] - P0[0], P3[1] - P0[1]);
  if (total <= 1e-9) return [0, 0];

  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 1; i < n - 1; i++) {
    const t = cum[i] / total;
    const mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const Dx = b0 * P0[0] + b3 * P3[0];
    const Dy = b0 * P0[1] + b3 * P3[1];
    const E1x = b1 * tStart[0], E1y = b1 * tStart[1];
    const E2x = -b2 * tEnd[0], E2y = -b2 * tEnd[1]; // C2 = P3 − α2·tEnd
    const rx = points[i][0] - Dx, ry = points[i][1] - Dy;
    c00 += E1x * E1x + E1y * E1y;
    c01 += E1x * E2x + E1y * E2y;
    c11 += E2x * E2x + E2y * E2y;
    x0 += rx * E1x + ry * E1y;
    x1 += rx * E2x + ry * E2y;
  }
  const det = c00 * c11 - c01 * c01;
  // 两点列几乎共线时 E1 与 E2 同向，方程组病态，解出来的柄长会爆掉。
  // 用相对判据识别，返回负值让调用方退回直线/二分。
  const scale = c00 * c11;
  if (scale <= 1e-12 || Math.abs(det) < 1e-3 * scale) return [-1, -1];
  let a1 = (x0 * c11 - x1 * c01) / det;
  let a2 = (c00 * x1 - c01 * x0) / det;
  // 柄长为负说明方向相反；过长会在拐弯处鼓包。都钳到几何上合理的区间。
  const lim = Math.max(chord * 1.2, 1e-6);
  if (!(a1 >= 0) || !(a2 >= 0)) return [-1, -1];
  if (a1 > lim || a2 > lim) return [-1, -1];
  return [a1, a2];
}

/** 拟合误差：返回 [最大距离, 最大距离所在的点下标] */
function bezierError(points: Pt[], tStart: Pt, tEnd: Pt, a1: number, a2: number): [number, number] {
  const n = points.length;
  const P0 = points[0], P3 = points[n - 1];
  const C1: Pt = [P0[0] + a1 * tStart[0], P0[1] + a1 * tStart[1]];
  const C2: Pt = [P3[0] - a2 * tEnd[0], P3[1] - a2 * tEnd[1]];
  const cum = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    cum.push(total);
  }
  if (total <= 1e-9) return [0, 0];
  let worst = 0, worstI = Math.max(1, (n - 1) >> 1);
  for (let i = 1; i < n - 1; i++) {
    const t = cum[i] / total;
    const mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const bx = b0 * P0[0] + b1 * C1[0] + b2 * C2[0] + b3 * P3[0];
    const by = b0 * P0[1] + b1 * C1[1] + b2 * C2[1] + b3 * P3[1];
    const d = Math.hypot(points[i][0] - bx, points[i][1] - by);
    if (d > worst) { worst = d; worstI = i; }
  }
  return [worst, worstI];
}

/**
 * 把闭合折线拟合成「线段 + 三次贝塞尔」。
 *
 * 流程：
 *   1) 先按转角分出角点（尖锐处），角点之间是待拟合的平滑段
 *   2) 每段做最小二乘贝塞尔拟合，误差超阈值就在最大误差处切开重拟合（递归）
 *   3) 段太短（≤2 个点）直接用直线
 *
 * 相比「过所有点的 Catmull-Rom」：节点数少一到两个数量级，曲线是拟合出来的、
 * 不会在噪声点上鼓包，也不会因为点太稀而切角。
 */
function fitPath(points: Pt[], tol: number, cornerCos: number, coordScale = 1): string {
  if (coordScale !== 1) {
    points = points.map(([x, y]) => [x * coordScale, y * coordScale] as Pt);
    tol *= coordScale;
  }
  const n = points.length;
  if (n < 4) return "";
  const f = (v: number) => {
    let s = v.toFixed(2);
    // 只有真的带小数点时才裁尾随 0，否则 "500".replace(/\.?0+$/, "") 会变成 "5"
    if (s.includes(".")) s = s.replace(/\.?0+$/, "");
    return s === "-0" ? "0" : s;
  };
  const unit = (dx: number, dy: number): Pt => {
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };

  // 角点：转角明显（夹角小于约 70°）的顶点，曲线在那里断开
  const isCorner = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const p = points[(i - 1 + n) % n], c = points[i], q = points[(i + 1) % n];
    const v1 = unit(c[0] - p[0], c[1] - p[1]);
    const v2 = unit(q[0] - c[0], q[1] - c[1]);
    if (v1[0] * v2[0] + v1[1] * v2[1] < cornerCos) isCorner[i] = true;
  }
  // 一个角点都没有（近似圆形）：强行取对径两点断开
  if (!isCorner.some(Boolean)) {
    isCorner[0] = true;
    isCorner[n >> 1] = true;
  }
  const corners: number[] = [];
  for (let i = 0; i < n; i++) if (isCorner[i]) corners.push(i);
  if (corners.length < 2) {
    const extra = (corners[0] + (n >> 1)) % n;
    if (extra !== corners[0]) corners.push(extra);
    corners.sort((a, b) => a - b);
  }
  if (corners.length < 2) return "";

  /**
   * 一段点列 -> path 片段（从首点出发、终止于末点）。
   * 误差达标就输出一条贝塞尔；超标就在最大误差处切一刀递归；
   * 近似共线或最小二乘病态时退回直线/二分。
   */
  const piece = (pts: Pt[]): string => {
    const m = pts.length;
    if (m < 2) return "";
    const end = pts[m - 1];
    const line = `L${f(end[0])} ${f(end[1])}`;
    if (m === 2) return line;
    const P0 = pts[0];
    const cx = end[0] - P0[0], cy = end[1] - P0[1];
    const cl = Math.hypot(cx, cy);
    if (cl < 1e-9) return line;
    const ux = cx / cl, uy = cy / cl;
    let maxPerp = 0, perpAt = 0;
    for (let i = 1; i < m - 1; i++) {
      const perp = Math.abs((pts[i][0] - P0[0]) * -uy + (pts[i][1] - P0[1]) * ux);
      if (perp > maxPerp) { maxPerp = perp; perpAt = i; }
    }
    // 几乎一条直线：不用贝塞尔（共线时最小二乘矩阵奇异，会鼓出畸形弧）
    if (m <= 3 || maxPerp <= tol * 0.4) return line;

    const t0 = unit(pts[1][0] - P0[0], pts[1][1] - P0[1]);
    const t1 = unit(end[0] - pts[m - 2][0], end[1] - pts[m - 2][1]);
    const [a1, a2] = solveBezier(pts, t0, t1);
    if (a1 < 0) {
      // 病态解：对半切开分别拟合；再不行就退化直线，宁可直不可歪
      if (m <= 6) {
        const h = perpAt;
        if (h > 0 && h < m - 1) return piece(pts.slice(0, h + 1)) + piece(pts.slice(h));
        return line;
      }
      const h = m >> 1;
      return piece(pts.slice(0, h + 1)) + piece(pts.slice(h));
    }
    const [err, worst] = bezierError(pts, t0, t1, a1, a2);
    if (err <= tol || worst <= 0 || worst >= m - 1) {
      const c1: Pt = [P0[0] + a1 * t0[0], P0[1] + a1 * t0[1]];
      const c2: Pt = [end[0] - a2 * t1[0], end[1] - a2 * t1[1]];
      return `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(end[0])} ${f(end[1])}`;
    }
    return piece(pts.slice(0, worst + 1)) + piece(pts.slice(worst));
  };

  let d = `M${f(points[corners[0]][0])} ${f(points[corners[0]][1])}`;
  for (let k = 1; k < corners.length; k++) {
    d += piece(points.slice(corners[k - 1], corners[k] + 1));
  }
  // 收尾：从最后一个角点绕过 0 点回到第一个角点
  const lastC = corners[corners.length - 1], firstC = corners[0];
  if (lastC < n - 1 || firstC > 0) {
    d += piece(points.slice(lastC).concat(points.slice(0, firstC + 1)));
  } else {
    d += piece(points.slice(lastC).concat([points[0]]));
  }
  return d + "Z";
}

/**
 * 闭合折线 -> SVG path。
 * 平滑模式：Catmull-Rom 转三次贝塞尔；拐角点的控制点收敛到自身，保持尖角不被抹圆。
 */
function pathFromLoop(points: Pt[], smooth: number, precision = 1, coordScale = 1): string {
  if (coordScale !== 1) points = points.map(([x, y]) => [x * coordScale, y * coordScale] as Pt);
  const prec = coordScale < 1 ? 2 : precision;
  const n = points.length;
  if (n < 3) return "";
  const f = (v: number) => {
    const s = v.toFixed(prec);
    return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  };

  if (smooth <= 0) {
    let d = `M${f(points[0][0])} ${f(points[0][1])}`;
    for (let i = 1; i < n; i++) d += `L${f(points[i][0])} ${f(points[i][1])}`;
    return d + "Z";
  }

  const corners = cornerFlags(points);
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const t = 1 / 6;
    const c1x = corners[i] ? p1[0] : p1[0] + (p2[0] - p0[0]) * t;
    const c1y = corners[i] ? p1[1] : p1[1] + (p2[1] - p0[1]) * t;
    const c2x = corners[(i + 1) % n] ? p2[0] : p2[0] - (p3[0] - p1[0]) * t;
    const c2y = corners[(i + 1) % n] ? p2[1] : p2[1] - (p3[1] - p1[1]) * t;
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

/** 调试：只做量化，输出调色板画面（RGBA），用于判断量化本身是否正常 */
export function quantizePreview(img: ImageDataLike, k: number, doDespeckle = false): ImageDataLike {
  const w = img.width, h = img.height;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = img.data[i * 4];
    rgb[i * 3 + 1] = img.data[i * 4 + 1];
    rgb[i * 3 + 2] = img.data[i * 4 + 2];
  }
  const q = quantize(rgb, w, h, k);
  const palette = q.palette;
  const labels = doDespeckle ? despeckle(q.labels, w, h, palette.length) : q.labels;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = palette[labels[i]];
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

/* ----------------------------------------------------------------- 主流程 */

export function traceImage(img: ImageDataLike, opts: Partial<TracerOptions> = {}): string {
  const o: TracerOptions = { ...DEFAULT_OPTIONS, ...opts };
  const S = Math.max(1, Math.round(o.supersample ?? 1));
  const srcW = img.width, srcH = img.height;
  if (S > 1) img = upscale(img, S);
  const w = img.width, h = img.height;

  const T: Record<string, number> = {};
  let ts = Date.now();
  let rgb: Uint8Array;
  if (o.denoise > 0) {
    rgb = medianDenoise(img);
  } else {
    rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = img.data[i * 4];
      rgb[i * 3 + 1] = img.data[i * 4 + 1];
      rgb[i * 3 + 2] = img.data[i * 4 + 2];
    }
  }

  T.denoise = Date.now() - ts; ts = Date.now();
  const q = quantize(rgb, w, h, o.colors);
  T.quantize = Date.now() - ts; ts = Date.now();
  let labels = q.labels;
  const palette = q.palette;
  // 去噪：默认只清孤立点（保细结构）；labelSmooth 才启用更强的众数滤波
  labels = despeckle(labels, w, h, palette.length);
  const ls = o.labelSmooth ?? 0;
  if (ls >= 1) labels = modeFilter(labels, w, h, palette.length, 1);
  if (ls >= 2) labels = modeFilter(labels, w, h, palette.length, 1);
  // 平滑后重新统计各色面积（顺序按最终面积排）
  const counts = new Array(palette.length).fill(0);
  for (let i = 0; i < labels.length; i++) counts[labels[i]]++;

  T.despeckle = Date.now() - ts; ts = Date.now();
  // 颜色按面积从大到小：大块先画，细节后画（叠在最上面）
  const order = palette.map((_, i) => i).sort((a, b) => counts[b] - counts[a]);

  // 每种颜色的包围盒：逐色只扫盒内，避免 128 色 × 全图像素的浪费
  const bbox = palette.map(() => [w, h, -1, -1]);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const c = labels[row + x];
      const b = bbox[c];
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }

  T.bbox = Date.now() - ts; ts = Date.now();
  const parts: string[] = [];
  const fitTol = o.fitTol ?? 0;
  const T2 = { mask: 0, trace: 0, rdp: 0, snap: 0, fit: 0 };
  for (const ci of order) {
    if (o.debugOnly !== undefined && o.debugOnly >= 0 && ci !== o.debugOnly) continue;
    const [bx0, by0, bx1, by1] = bbox[ci];
    if (bx1 < bx0) continue;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    // 只在包围盒内取掩膜：128 色 × 全图会慢十倍
    const m = new Uint8Array(bw * bh);
    let any = false;
    for (let y = 0; y < bh; y++) {
      const src = (by0 + y) * w + bx0;
      const dst = y * bw;
      for (let x = 0; x < bw; x++) {
        if (labels[src + x] === ci) { m[dst + x] = 1; any = true; }
      }
    }
    if (!any) continue;
    let ts2 = Date.now();
    keepLargeComponents(m, bw, bh, o.minArea);
    for (let d = 0; d < (o.dilate ?? 1); d++) dilate(m, bw, bh);

    T2.mask += Date.now() - ts2; ts2 = Date.now();
    const loops = traceContours(m, bw, bh);
    T2.trace += Date.now() - ts2; ts2 = Date.now();
    if (!loops.length) continue;

    let d = "";
    const snap = o.snap ?? 0;
    const isIn = snap > 0
      ? (x: number, y: number) => {
          const lx = Math.round(x - bx0), ly = Math.round(y - by0);
          return lx >= 0 && ly >= 0 && lx < bw && ly < bh && m[ly * bw + lx] === 1;
        }
      : null;
    const inner = palette[ci] as [number, number, number];
    for (const loop of loops) {
      const simplified = rdpClosed(loop, o.simplify);
      if (simplified.length < 3) continue;
      let shifted: Pt[] = simplified.map(([x, y]) => [x + bx0, y + by0]);
      T2.rdp += Date.now() - ts2; ts2 = Date.now();
      if (snap > 0 && isIn) shifted = snapToEdge(shifted, rgb, w, h, inner, isIn, snap);
      T2.snap += Date.now() - ts2; ts2 = Date.now();
      d += fitTol > 0
        ? fitPath(shifted, fitTol, o.cornerCos ?? 0.34, 1 / S)
        : pathFromLoop(shifted, o.smooth, 1, 1 / S);
    }
    T2.fit += Date.now() - ts2;
    if (!d) continue;
    const [r, g, b] = palette[ci];
    const sw = o.stroke ?? 0;
    const extra = sw > 0
      ? ` stroke="rgb(${r},${g},${b})" stroke-width="${Number((sw / S).toFixed(2))}" stroke-linejoin="round"`
      : "";
    parts.push(`<path fill="rgb(${r},${g},${b})"${extra} fill-rule="evenodd" d="${d}"/>`);
  }

  T.loop = Date.now() - ts;
  Object.assign(T, T2);
  traceStats.timings = T;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${srcW} ${srcH}" width="${srcW}" height="${srcH}" shape-rendering="geometricPrecision">${parts.join("")}</svg>`;
}
