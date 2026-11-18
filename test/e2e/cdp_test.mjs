// 通过 CDP 控制 Chrome，加载宿主页，等待真实时间，读取 E2E 结果。
// Node 22 内置 WebSocket。Chrome 需用 --remote-debugging-port=9223 启动。
const CDP = "http://127.0.0.1:9223";

async function getJSON(path) {
  const r = await fetch(CDP + path);
  return r.json();
}

const targets = await getJSON("/json/list");
let page = targets.find(t => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
// 收集 console（宿主 log 用 console.log）
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled") {
    logs.push((m.params.args || []).map(a => a.value ?? a.description ?? "").join(" "));
  }
};

await send("Page.navigate", { url: "http://127.0.0.1:8791/host.html" });

// 轮询真实等待，直到 title 出现 DONE/FAIL 或超时
let result = null;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 500));
  const title = await evaluate("document.title");
  if (title && (title.startsWith("DONE") || title.startsWith("FAIL"))) {
    result = title;
    break;
  }
}
const finalTitle = result || (await evaluate("document.title"));
const resultText = await evaluate("document.getElementById('result')?.textContent");
const ready = await evaluate("window.__ready ? JSON.stringify({id:window.__ready.moduleId,ver:window.__ready.moduleVersion,api:window.__ready.apiVersion}) : null");
const handoff = await evaluate("window.__handoff ? JSON.stringify({png:window.__handoff.pngBytes?.byteLength,svg:window.__handoff.svgBytes?.byteLength,projectId:window.__handoff.projectId,engine:window.__handoff.recipeSource?.payload?.engine}) : null");

console.log("=== E2E RESULT ===");
console.log("title:", finalTitle);
console.log("result:", resultText);
console.log("ready:", ready);
console.log("handoff:", handoff);
console.log("=== HOST LOGS ===");
console.log(logs.filter(l => l.includes("[HOST]")).join("\n"));
ws.close();
process.exit(finalTitle && finalTitle.startsWith("DONE") ? 0 : 1);
