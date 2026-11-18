// 引擎冒烟测试：纯 JS imagetracerjs 把一张 3 色测试图描摹成分层彩色 SVG。
// 关键：不调用任何 WebAssembly API（工坊 CSP 下必须可用）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ImageTracer = require("imagetracerjs");
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 构造一张确定性的 3 色测试图（不依赖 Pillow）：白底 + 红圆 + 蓝方块。
const W = 200, H = 200;
const data = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
  data[i*4] = 255; data[i*4+1] = 255; data[i*4+2] = 255; data[i*4+3] = 255;
}
for (let y = 40; y < 160; y++) for (let x = 40; x < 160; x++)
  if ((x-100)**2 + (y-100)**2 <= 60**2) {
    const i = (y*W+x)*4; data[i]=220; data[i+1]=60; data[i+2]=60;
  }
for (let y = 20; y <= 180; y++) for (let x = 80; x <= 120; x++) {
  const i = (y*W+x)*4; data[i]=40; data[i+1]=80; data[i+2]=200;
}

const svg = ImageTracer.imagedataToSVG({ data, width: W, height: H }, {
  numberofcolors: 32, colorsampling: 2, colorquantcycles: 3, mincolorratio: 0.01,
  ltres: 1, qtres: 1, pathomit: 10, linefilter: false,
  layering: 1, strokewidth: 0, viewbox: true, roundcoords: 1, scale: 1,
});

test("纯 JS 引擎输出多层彩色 SVG", () => {
  const paths = (svg.match(/<path/g) || []).length;
  assert.ok(paths >= 2, `测试图应至少 2 条 path，实际 ${paths}`);
  // imagetracerjs 输出 rgb(...) 填色；验证三种原色都精确还原
  assert.ok(svg.includes("rgb(220,60,60)") || svg.includes("rgb(219,59,59)") || svg.includes("rgb(220, 60, 60)"),
    "应还原红色圆 (rgb 220,60,60)");
  assert.ok(svg.includes("rgb(40,80,200)") || svg.includes("rgb(40, 80, 200)"),
    "应还原蓝色块 (rgb 40,80,200)");
});

test("描摹引擎源码不含 WebAssembly 调用", () => {
  const src = readFileSync(path.join(root, "src", "trace.ts"), "utf8");
  assert.ok(!src.includes("WebAssembly"), "trace.ts 不得引用 WebAssembly");
});
