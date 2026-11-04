import { createRequire } from "node:module";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(KIT, "assets");
const out = resolve(process.argv[2] || "readme-preview");
const mermaidDir = process.argv[3] ? resolve(process.argv[3]) : null;
const renderedDir = process.argv[4] ? resolve(process.argv[4]) : null;
const REPO = resolve(KIT, "..", "..");
const require = createRequire(join(resolve(process.env.PUPPETEER_DIR || "node_modules"), "noop.js"));
const puppeteer = require("puppeteer");

mkdirSync(out, { recursive: true });
const WIDTH = 1012;
const url = (p) => pathToFileURL(p).href;
const order = ["hero", "stats", "divider", "cards", "pipeline", "timeline", "footer"];
const rank = (n) => {
  const i = order.indexOf(n.split("-")[0]);
  return i < 0 ? order.length : i;
};
const themed = (mode) =>
  readdirSync(ASSETS)
    .filter((f) => f.endsWith(`-${mode}.svg`))
    .map((f) => f.slice(0, -`-${mode}.svg`.length))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const icons = readdirSync(join(ASSETS, "icons")).filter((f) => f.endsWith(".svg")).sort();
const diagrams = mermaidDir && existsSync(mermaidDir) ? readdirSync(mermaidDir).filter((f) => f.endsWith(".svg")).sort() : [];

function size(file) {
  const head = readFileSync(file, "utf8").slice(0, 400);
  const w = Number((head.match(/\swidth="([\d.]+)"/) || [])[1] || 1200);
  const h = Number((head.match(/\sheight="([\d.]+)"/) || [])[1] || 400);
  return { w, h };
}

function embed(file, framed) {
  if (!framed) return `<img src="${url(file)}" width="100%">`;
  const { w, h } = size(file);
  const k = WIDTH / w;
  return `<iframe src="${url(file)}" scrolling="no" style="border:0;display:block;width:${w}px;height:${h}px;zoom:${k}"></iframe>`;
}

function page(mode, framed) {
  const bg = mode === "dark" ? "#0d1117" : "#ffffff";
  const fg = mode === "dark" ? "#e6edf3" : "#1f2328";
  const blocks = themed(mode)
    .map((n) => `<h3>${n}</h3>${embed(join(ASSETS, `${n}-${mode}.svg`), framed)}`)
    .join("\n");
  const iconRow = icons.map((f) => `<figure><img src="${url(join(ASSETS, "icons", f))}" width="40"><figcaption>${f.replace(".svg", "")}</figcaption></figure>`).join("");
  const mm = framed ? "" : diagrams.map((f) => `<h3>${f}</h3><img src="${url(join(mermaidDir, f))}" style="max-width:100%">`).join("\n");
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px 32px;background:${bg};color:${fg};font:14px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;width:${WIDTH}px}h3{margin:28px 0 8px;font-size:13px;opacity:.6}figure{display:inline-block;margin:6px;text-align:center;width:88px}figcaption{font-size:10px;opacity:.7}</style>
${blocks}
<h3>icons</h3><div>${iconRow}</div>
${mm}`;
}

function manifest() {
  if (!mermaidDir || !existsSync(join(mermaidDir, "manifest.tsv"))) return [];
  return readFileSync(join(mermaidDir, "manifest.tsv"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .map(([name, origin]) => ({ svg: join(mermaidDir, name.replace(/\.mmd$/, ".svg")), file: origin.replace(/:\d+$/, "") }));
}

function readmePage(mode, md) {
  const html = join(renderedDir, `${md.replace(/\//g, "_")}.html`);
  if (!existsSync(html)) return null;
  const base = dirname(join(REPO, md));
  const diagrams = manifest().filter((m) => m.file === md);
  let k = 0;
  const body = readFileSync(html, "utf8")
    .replace(/<section[^>]*data-type="mermaid"[\s\S]*?<\/section>/g, () => {
      const d = diagrams[k++];
      return d && existsSync(d.svg) ? `<p><img src="${url(d.svg)}" style="max-width:100%"></p>` : "<p><em>mermaid block did not render</em></p>";
    })
    .replace(/(src|srcset)="(?!https?:|data:|file:|#)([^"]+)"/g, (_, a, p) => `${a}="${url(resolve(base, p))}"`);
  const dark = mode === "dark";
  const css = `body{margin:0;padding:32px 40px;background:${dark ? "#0d1117" : "#ffffff"};color:${dark ? "#e6edf3" : "#1f2328"};font:16px/1.5 -apple-system,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif;width:${WIDTH}px}
a{color:${dark ? "#4493f8" : "#0969da"}}h1,h2{border-bottom:1px solid ${dark ? "#3d444d" : "#d1d9e0"};padding-bottom:.3em}
table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid ${dark ? "#3d444d" : "#d1d9e0"};padding:6px 13px}tr:nth-child(2n){background:${dark ? "#151b23" : "#f6f8fa"}}
code{background:${dark ? "#656c7633" : "#818b981f"};padding:.2em .4em;border-radius:6px;font-size:85%}pre{background:${dark ? "#151b23" : "#f6f8fa"};padding:16px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
img{max-width:100%}`;
  return `<!doctype html><meta charset="utf-8"><style>${css}</style><article>${body}</article>`;
}

const browser = await puppeteer.launch({ args: ["--no-sandbox", "--allow-file-access-from-files"] });
try {
  for (const mode of ["light", "dark"]) {
    for (const reduced of [false, true]) {
      const file = join(out, `preview-${mode}${reduced ? "-reduced" : ""}.html`);
      writeFileSync(file, page(mode, reduced));
      const tab = await browser.newPage();
      await tab.setViewport({ width: WIDTH + 64, height: 12000, deviceScaleFactor: 1 });
      if (reduced) await tab.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await tab.goto(url(file), { waitUntil: "load" });
      await new Promise((ok) => setTimeout(ok, reduced ? 800 : 6500));
      const png = join(out, `preview-${mode}${reduced ? "-reduced" : ""}.png`);
      await tab.screenshot({ path: png, fullPage: true });
      console.log(png);
      await tab.close();
    }
  }
  const pages = renderedDir ? ["README.md", "docs/README.md"] : [];
  for (const md of pages) {
    for (const mode of ["light", "dark"]) {
      const htmlPage = readmePage(mode, md);
      if (!htmlPage) continue;
      const stem = `rendered-${md.replace(/[\/.]/g, "_")}-${mode}`;
      const file = join(out, `${stem}.html`);
      writeFileSync(file, htmlPage);
      const tab = await browser.newPage();
      await tab.setViewport({ width: WIDTH + 80, height: 2000, deviceScaleFactor: 1 });
      await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: mode }]);
      await tab.goto(url(file), { waitUntil: "load" });
      await new Promise((ok) => setTimeout(ok, 6500));
      const png = join(out, `${stem}.png`);
      await tab.screenshot({ path: png, fullPage: true });
      console.log(png);
      await tab.close();
    }
  }
} finally {
  await browser.close();
}
