// 纯 JS 描摹引擎：不编译 wasm 字节码，因此能在工坊的严格 CSP 下运行。
// 原 wasm 引擎（@buzz-dee/vtrace）在脚本顶层即时编译，被工坊 CSP 拦截，
// 导致 SDK 的 lifecycle.ready() 永远发不出、模块卡在"正在连接宿主"。
//
// 引擎：imagetracerjs（MIT），纯 JavaScript 栅格矢量化，输出分层填色 SVG path。
// 定稿参数来自真实插画对比：透明填白 + 32 色量化 + pathomit 10，兼顾颜色保真与去噪。
// imagetracerjs 是 CommonJS（module.exports = new ImageTracer()）；
// esbuild 的 CJS 互操作会把默认导入解析为 module.exports。
import ImageTracer from "imagetracerjs";
import { TRACE_CONFIG } from "./config.ts";

export interface ImageLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** 把透明像素填成白色：与 SVG 白底一致，避免被当作黑色描摹。 */
function flattenWhite(img: ImageLike): ImageLike {
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  return { data, width: img.width, height: img.height };
}

/**
 * 把图像描摹成分层平涂 SVG（去掉 XML 声明和注释，供 innerHTML / 交接使用）。
 * 全自动参数，无用户选项——对应桌面 7.5.6 档的"简化的、浏览器可运行的"分层风格。
 */
export function traceToSvg(img: ImageLike): string {
  const clean = flattenWhite(img);
  const svg: string = ImageTracer.imagedataToSVG(clean, {
    // 颜色：确定性采样，实测颜色还原最稳（绿/蓝/红/米背景均正确）
    numberofcolors: TRACE_CONFIG.colors,
    colorsampling: 2,
    colorquantcycles: 3,
    mincolorratio: 0.01,
    // 曲线与去噪
    ltres: 1,
    qtres: 1,
    pathomit: TRACE_CONFIG.pathomit,
    linefilter: false,
    // 渲染：分层填色、无描边、viewBox 自适应
    layering: 1,        // stacked 叠色
    strokewidth: 0,
    viewbox: true,
    roundcoords: 1,
    scale: 1,
  });
  return svg.replace(/<\?xml[^>]*\?>\s*/, "").replace(/<!--[\s\S]*?-->\s*/, "");
}
