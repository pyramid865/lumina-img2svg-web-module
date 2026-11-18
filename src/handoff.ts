import type { WorkshopImageHandoff } from "@lumina/workshop-sdk";
import { TRACE_CONFIG } from "./config.ts";
import { MODULE_ID, MODULE_VERSION } from "./version.ts";

// Conservative print size at 300 dpi; the host re-validates everything we send.
const MM_PER_PIXEL = 25.4 / 300;

export interface ConversionResult {
  projectId: string;
  pngBytes: ArrayBuffer;
  svgBytes: ArrayBuffer | null;
  pixelWidth: number;
  pixelHeight: number;
  inputName: string;
}

export function newConversion(input: {
  pngBytes: ArrayBuffer;
  svgBytes: ArrayBuffer | null;
  pixelWidth: number;
  pixelHeight: number;
  inputName: string;
}): ConversionResult {
  return {
    ...input,
    // The host identifies "confirm replace" by the same moduleId + projectId.
    // Generate it once per conversion, never per handoff click.
    projectId: crypto.randomUUID(),
  };
}

export interface HandoffContext {
  projectSchema: string;
  renderSchema: string;
  colorLibraryId: string | null;
}

export function buildHandoffRequest(
  result: ConversionResult,
  ctx: HandoffContext,
): WorkshopImageHandoff {
  // The SDK puts pngBytes/svgBytes into postMessage's transfer list, which
  // DETACHES them. Copy from the stored result at the send boundary, every
  // single time, so repeated handoffs of the same result keep working.
  const pngBytes = result.pngBytes.slice(0);
  const svgBytes = result.svgBytes ? result.svgBytes.slice(0) : undefined;
  return {
    moduleId: MODULE_ID,
    moduleVersion: MODULE_VERSION,
    projectId: result.projectId,
    pngBytes,
    ...(svgBytes ? { svgBytes } : {}),
    pixelWidth: result.pixelWidth,
    pixelHeight: result.pixelHeight,
    recommendedWidthMm: Math.round(result.pixelWidth * MM_PER_PIXEL * 100) / 100,
    recommendedHeightMm: Math.round(result.pixelHeight * MM_PER_PIXEL * 100) / 100,
    preserveCanvasBounds: true,
    colorLibraryId: ctx.colorLibraryId,
    recipeSource: {
      manifestSchemaVersion: 1,
      moduleId: MODULE_ID,
      moduleVersion: MODULE_VERSION,
      projectSchemaVersion: ctx.projectSchema,
      renderSchemaVersion: ctx.renderSchema,
      payload: {
        source: result.inputName,
        engine: "layered-js",
        colors: TRACE_CONFIG.colors,
        simplify: TRACE_CONFIG.simplify,
        fitTol: TRACE_CONFIG.fitTol,
        snap: TRACE_CONFIG.snap,
        stroke: TRACE_CONFIG.stroke,
        minArea: TRACE_CONFIG.minArea,
        gridWidth: TRACE_CONFIG.gridWidth,
      },
    },
  };
}
