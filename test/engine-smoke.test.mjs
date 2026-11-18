// 引擎冒烟：自研纯 JS 描色引擎把一张 3 色测试图分成干净的色块。
// 关键点：不调用任何 WebAssembly；路径数量必须收敛（不能像逐像素描摹那样炸成几千条）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { traceToSvg } from "../src/trace.ts";

const W = 240, H = 240;
const data = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
  data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
}
// 红圆
for (let y = 40; y < 180; y++) {
  for (let x = 40; x < 180; x++) {
    if ((x - 110) ** 2 + (y - 110) ** 2 <= 70 ** 2) {
      const i = (y * W + x) * 4;
      data[i] = 220; data[i + 1] = 60; data[i + 2] = 60;
    }
  }
}
// 蓝方块
for (let y = 20; y <= 90; y++) {
  for (let x = 150; x <= 220; x++) {
    const i = (y * W + x) * 4;
    data[i] = 40; data[i + 1] = 80; data[i + 2] = 200;
  }
}

const svg = traceToSvg({ data, width: W, height: H });

test("自研引擎输出分层色块 SVG", () => {
  assert.ok(svg.startsWith("<svg"), "应输出 SVG");
  const paths = (svg.match(/<path/g) || []).length;
  assert.ok(paths >= 2, `至少 2 个色块，实际 ${paths}`);
  assert.ok(paths <= 200, `路径数应收敛（不是逐像素描摹），实际 ${paths}`);
  assert.ok(svg.includes('fill-rule="evenodd"'), "应使用 evenodd 处理镂空");
});

test("三种原色都能还原", () => {
  const fills = [...svg.matchAll(/fill="rgb\((\d+),(\d+),(\d+)\)"/g)]
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  const near = (target, tol = 18) =>
    fills.some((f) => f.every((v, i) => Math.abs(v - target[i]) <= tol));
  assert.ok(near([220, 60, 60]), `应保留红色，实际色板 ${JSON.stringify(fills)}`);
  assert.ok(near([40, 80, 200]), "应保留蓝色");
  assert.ok(near([255, 255, 255], 12), "应保留白色背景");
});

test("产物不含 WebAssembly 字样", () => {
  assert.ok(!svg.includes("WebAssembly"), "SVG 不应提到 wasm");
});
