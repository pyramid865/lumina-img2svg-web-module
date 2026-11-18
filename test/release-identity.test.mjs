// Release-identity regression: execute the REAL built ui/index.html inline
// bundle, capture the ready message the SDK sends, and validate it against the
// manifest identity — including apiVersion === "1.0.0" (frontend-only module).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "ui/index.html"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));

function extractInlineScript(htmlText) {
  const m = htmlText.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error("no inline <script> found in built ui/index.html");
  return m[1];
}

import { MessageChannel } from "node:worker_threads";
import { WORKSHOP_RPC_VERSION } from "@lumina/workshop-sdk";

function bootModule() {
  const sent = [];
  const listeners = new Set();
  const { port1: modulePort, port2: hostPort } = new MessageChannel();

  // Fake host: on ready, reply with connect carrying the module's port, then
  // answer every RPC request so the module boots to "ready" cleanly.
  const parent = {
    postMessage(msg) {
      sent.push({ msg, transfer: [] });
      if (msg && msg.type === "lumina.workshop.ready") {
        queueMicrotask(() => {
          for (const fn of [...listeners]) {
            fn({
              source: parent,
              data: { type: "lumina.workshop.connect", sessionId: "test-session" },
              ports: [modulePort],
            });
          }
        });
      }
    },
  };
  hostPort.onmessage = (event) => {
    const req = event.data;
    if (req?.kind !== "request") return;
    hostPort.postMessage({
      protocol: "lumina-workshop-rpc",
      version: WORKSHOP_RPC_VERSION,
      kind: "response",
      requestId: req.requestId,
      ok: true,
      result: { locale: "zh-CN", theme: "light", tokens: {} },
    });
  };
  hostPort.start();

  const noop = () => {};
  const document = {
    getElementById: () => ({
      textContent: "",
      innerHTML: "",
      disabled: true,
      src: "",
      addEventListener: noop,
      removeEventListener: noop,
    }),
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => null,
      addEventListener: noop,
    }),
    addEventListener: noop,
    removeEventListener: noop,
    body: { appendChild() {} },
    documentElement: { dataset: {}, style: { setProperty() {} } },
  };
  const sandbox = {
    window: {
      parent,
      addEventListener(type, fn) {
        if (type === "message") listeners.add(fn);
      },
      removeEventListener(type, fn) {
        listeners.delete(fn);
      },
      postMessage: noop,
      location: new URL("https://localhost/"),
      crypto,
      setTimeout,
      clearTimeout,
    },
    document,
    parent,
    console,
    crypto,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    // SDK has a code path that touches the Node-style global; the real host
    // (Chromium webview) satisfies it, the bare vm sandbox needs a stand-in.
    Buffer,
    Blob: class {
      constructor() {}
    },
    URL: { createObjectURL: () => "blob:x" },
    Image: class {},
    fetch: async () => ({ ok: false }),
    performance,
    queueMicrotask,
  };
  sandbox.window.document = document;
  sandbox.self = sandbox.window;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(extractInlineScript(html), ctx, { timeout: 15000 });
  return { sent, close: () => { modulePort.close(); hostPort.close(); } };
}

test("ready 身份与 manifest 一致且上报 API 1.0.0（纯前端）", async () => {
  const { sent, close } = bootModule();
  try {
    await new Promise((r) => setTimeout(r, 300));
  const ready = sent.map((s) => s.msg).find((m) => m && m.type === "lumina.workshop.ready");
    assert.ok(ready, "SDK 必须发出 lumina.workshop.ready");
    assert.equal(ready.moduleId, manifest.id);
    assert.equal(ready.moduleVersion, manifest.version);
    assert.equal(ready.apiVersion, "1.0.0",
      "前端-only 模块必须上报 API 1.0.0（features 不含 backend.tasks）");
  } finally {
    close();
  }
});

test("manifest 是 v1 纯前端形态且无 backend 字段", () => {
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.workshopApi.min, "1.0.0");
  assert.ok(manifest.entrypoints.ui, "v1 必须声明 ui 入口");
  assert.ok(!("backend" in manifest), "纯前端 manifest 不得声明 backend");
  assert.equal(manifest.id, "community.img2svg.web");
});

test("构建产物内嵌 wasm 引擎与 7.5.6 档参数", () => {
  // @buzz-dee/vtrace embeds its wasm payload as base64 inside the JS.
  assert.ok(html.length > 300_000, "bundle 应包含内嵌 wasm（>300KB）");
  assert.ok(/AGFzbQ/.test(html), "应含 base64 wasm 魔数（AGFzbQ = \\0asm）");
  assert.ok(html.includes("color-cluster"), "应配置彩色聚类");
  assert.ok(html.includes('"stacked"'), "应配置 stacked 叠色");
});
