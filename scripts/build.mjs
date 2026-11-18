// Build ui/index.html: esbuild-bundle src/main.ts and inline it into the
// template. The vtrace wasm is embedded base64 inside its JS, so the whole
// module UI stays a single self-contained file (workshop package convention).
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const project = join(root, "..");

const result = await build({
  entryPoints: [join(project, "src/main.ts")],
  bundle: true,
  format: "iife",
  minify: true,
  write: false,
  charset: "utf8",
  legalComments: "none",
  logLevel: "info",
});

const js = result.outputFiles[0].text;
const template = readFileSync(join(project, "ui/template.html"), "utf8");
const html = template.replace("/*__BUNDLE__*/", () => js);
mkdirSync(join(project, "ui"), { recursive: true });
writeFileSync(join(project, "ui/index.html"), html, "utf8");
console.log("ui/index.html written:", html.length, "chars");
