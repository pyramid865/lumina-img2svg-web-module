// 描摹入口：调用自研的纯 JS 分层描色引擎（见 tracer.ts）。
//
// 历史：最早用内嵌 WASM 的 vtracer，被工坊 CSP 拦下（不许编译 WASM），模块卡在
// "正在连接宿主"；随后临时换成 imagetracerjs，能跑但碎点很多、边缘锯齿。
// 现在是自研实现：Lab 空间量化 → 标签去噪 → marching squares 轮廓 → 简化 + 贝塞尔。
// 全程纯 JavaScript，不调用任何 WebAssembly API。
import { traceImage, type ImageDataLike } from "./tracer.ts";
import { TRACE_CONFIG } from "./config.ts";

export interface ImageLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** 把透明像素填成白色：与 SVG 白底一致，避免被当作黑色描摹。 */
function flattenWhite(img: ImageLike): ImageDataLike {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (img.data[p + 3] < 128) {
      data[p] = 255; data[p + 1] = 255; data[p + 2] = 255; data[p + 3] = 255;
    } else {
      data[p] = img.data[p];
      data[p + 1] = img.data[p + 1];
      data[p + 2] = img.data[p + 2];
      data[p + 3] = 255;
    }
  }
  return { data, width: img.width, height: img.height };
}

/** 把图像描摹成分层平涂 SVG。全自动参数，无用户选项。 */
export function traceToSvg(img: ImageLike): string {
  const svg = traceImage(flattenWhite(img), {
    colors: TRACE_CONFIG.colors,
    simplify: TRACE_CONFIG.simplify,
    fitTol: TRACE_CONFIG.fitTol,
    cornerCos: TRACE_CONFIG.cornerCos,
    snap: TRACE_CONFIG.snap,
    stroke: TRACE_CONFIG.stroke,
    minArea: TRACE_CONFIG.minArea,
    denoise: TRACE_CONFIG.denoise,
    // 走曲线拟合路线；Catmull-Rom 的 smooth 与方形膨胀 dilate 不再使用
    smooth: 0,
    dilate: 0,
  });
  return svg
    .replace(/<\?xml[^>]*\?>\s*/, "")
    .replace(/<!--[\s\S]*?-->\s*/, "");
}
