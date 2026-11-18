import { applyWorkshopUiState, connectWorkshop } from "@lumina/workshop-sdk";
import { buildHandoffRequest, newConversion, type ConversionResult } from "./handoff.ts";
import { traceToSvg } from "./trace.ts";
import { TRACE_CONFIG } from "./config.ts";
import { MODULE_ID, MODULE_VERSION } from "./version.ts";

const PROJECT_SCHEMA = `${MODULE_ID}/v1`;
const RENDER_SCHEMA = `${MODULE_ID}-render/v1`;

// 工作网格宽度统一取自 TRACE_CONFIG；描摹引擎为纯 JS（工坊 CSP 下可用）。
const GRID_WIDTH = TRACE_CONFIG.gridWidth;

const statusEl = document.getElementById("status") as HTMLElement;
const convertBtn = document.getElementById("convert") as HTMLButtonElement;
const handoffBtn = document.getElementById("handoff") as HTMLButtonElement;
const progressEl = document.getElementById("progress") as HTMLElement;
const previewSvgEl = document.getElementById("preview-svg") as HTMLElement;
const previewPngEl = document.getElementById("preview-png") as HTMLImageElement;

let lastResult: ConversionResult | null = null;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

/** Decode picked image bytes and draw them into a canvas at the working size. */
async function decodeToCanvas(
  bytes: ArrayBuffer,
  mimeType: string,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const blob = new Blob([bytes], { type: mimeType || "image/png" });
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, GRID_WIDTH / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
    CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { canvas, width, height };
}

/** Trace canvas pixels into a layered flat-colour SVG document string (pure JS). */
function traceCanvas(canvas: HTMLCanvasElement): string {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return traceToSvg(imageData);
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("png-encode-failed");
  return blob.arrayBuffer();
}

async function main(): Promise<void> {
  // Frontend-only module: features must NOT include "backend.tasks", so the
  // SDK reports WORKSHOP_API_VERSION (1.0.0) and hosts on API 1.0.x accept it.
  const client = await connectWorkshop({
    moduleId: MODULE_ID,
    moduleVersion: MODULE_VERSION,
    features: [],
  });

  const unsubscribeUiState = client.ui.subscribeState(applyWorkshopUiState);
  applyWorkshopUiState(await client.ui.getState());
  await client.lifecycle.ready();
  setStatus("已连接宿主，点击「选择图片并转换」开始");
  convertBtn.disabled = false;

  convertBtn.addEventListener("click", async () => {
    try {
      convertBtn.disabled = true;
      handoffBtn.disabled = true;
      setStatus("正在选择图片…");
      const picked = await client.image.pick();
      if (!picked) {
        setStatus("已取消选择");
        return;
      }

      setStatus("正在读取图片…");
      const { canvas, width, height } = await decodeToCanvas(
        picked.bytes,
        picked.mimeType,
      );

      setStatus(`正在描摹（${width}×${height}，全自动档）…`);
      progressEl.textContent = "浏览器内本地描摹，请稍候";
      await new Promise((r) => setTimeout(r, 30)); // let the UI paint
      const svgText = traceCanvas(canvas);

      setStatus("正在生成交接用 PNG…");
      const pngBytes = await canvasToPngBytes(canvas);

      lastResult = newConversion({
        pngBytes,
        svgBytes: new TextEncoder().encode(svgText).buffer as ArrayBuffer,
        pixelWidth: width,
        pixelHeight: height,
        inputName: picked.name,
      });

      // Previews: SVG inline (host renderer supports it), PNG via data URL.
      previewSvgEl.innerHTML = svgText;
      const previewBlob = new Blob([pngBytes], { type: "image/png" });
      previewPngEl.src = URL.createObjectURL(previewBlob);

      handoffBtn.disabled = false;
      setStatus("描摹完成，可交给 Lumina 转换器");
      progressEl.textContent = "";
    } catch (err) {
      setStatus("描摹失败：" + (err instanceof Error ? err.message : "unknown-error"));
      progressEl.textContent = "";
    } finally {
      convertBtn.disabled = false;
    }
  });

  handoffBtn.addEventListener("click", async () => {
    if (!lastResult) return;
    try {
      handoffBtn.disabled = true;
      const library = await client.colorLibrary.read();
      const request = buildHandoffRequest(lastResult, {
        projectSchema: PROJECT_SCHEMA,
        renderSchema: RENDER_SCHEMA,
        colorLibraryId: library?.id ?? null,
      });
      const result = await client.handoff.image(request);
      setStatus(result.status === "needs-confirmation"
        ? "转换器已有工作，请确认替换后再交接一次"
        : "已交接给 Lumina 转换器");
    } catch (err) {
      setStatus("交接失败：" + (err instanceof Error ? err.message : "unknown-error"));
    } finally {
      handoffBtn.disabled = false;
    }
  });

  window.addEventListener("beforeunload", () => unsubscribeUiState());
}

void main();
