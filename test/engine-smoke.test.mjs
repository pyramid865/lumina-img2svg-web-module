// Engine smoke test: the bundled vtracer wasm traces a real test image into a
// multi-path, per-layer-coloured stacked SVG (the handoff payload format).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Build a deterministic 3-colour test image via Pillow (available locally).
const tmp = path.join(root, "test", "_smoke");
execSync(`python ${JSON.stringify(path.join(root, "test", "_smoke_img.py"))}`, {
  cwd: root,
  stdio: "inherit",
});
const px = JSON.parse(readFileSync(path.join(tmp, "px.json"), "utf8"));

const { VTrace } = await import("@buzz-dee/vtrace");

function trace(imageData) {
  const v = new VTrace(imageData, {
    colorMode: "color",
    clustering: "color-cluster",
    hierarchical: "stacked",
    mode: "spline",
    filterSpeckle: 4,
    colorPrecision: 6,
    layerDifference: 16,
    maxColors: 128,
  });
  v._ensureProcessed();
  const raw = v._pathData;
  return raw.replace(/<\?xml[^>]*\?>\s*/, "").replace(/<!--[\s\S]*?-->\s*/, "");
}

test("wasm 引擎输出多层彩色 stacked SVG", () => {
  const svg = trace({ data: new Uint8ClampedArray(px.px), width: px.w, height: px.h });
  assert.ok(!svg.includes("<?xml"), "输出应为干净 SVG 文档");
  const paths = (svg.match(/<path/g) || []).length;
  const fills = new Set(svg.match(/fill="[^"]+"/g) || []);
  assert.ok(paths >= 3, `3 色测试图应至少 3 条 path，实际 ${paths}`);
  assert.ok(fills.size >= 3, `应至少 3 种填充色，实际 ${fills.size}`);
  assert.ok(svg.includes('hierarchical') === false && !svg.includes('fill="black"'),
    "不得出现单色黑输出（getSVG 的缺陷行为）");
  // Exact colour fidelity: the test image uses exact RGB fills.
  assert.ok(svg.toUpperCase().includes("#DC3C3C"), "红色应精确还原 (#DC3C3C)");
  assert.ok(svg.toUpperCase().includes("#2850C8"), "蓝色应精确还原 (#2850C8)");
  writeFileSync(path.join(tmp, "smoke.svg"), svg);
});
