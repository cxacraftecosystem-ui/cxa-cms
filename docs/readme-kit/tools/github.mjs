import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(KIT, "..", "..");
const require = createRequire(join(resolve(process.env.PLAYWRIGHT_DIR || "node_modules"), "noop.js"));
const { chromium } = require("playwright");

const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.RENDER_SHA || process.env.GITHUB_SHA;
const out = resolve(process.argv[2] || join(REPO, ".readme-check", "github"));
const only = process.argv.slice(3);
if (!repo || !sha) {
  console.error("GITHUB_REPOSITORY and RENDER_SHA (or GITHUB_SHA) must name the commit to open on github.com");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const ERROR_TEXT = /Unable to render rich display|Syntax error in text|Parse error on line|Lexical error on line|No diagram type detected|Maximum text size in diagram exceeded|Error parsing|Unsupported markdown/i;
const GARBLED_TEXT = /<br\b|<\/?(?:b|i|u|em|strong|span|div|sub|sup|small|code|p)\b[^>]*>|&(?:lt|gt|amp|quot|nbsp);|#(?:lt|gt|amp|quot);/i;
const WAIT_MS = 90000;

function mermaidBlocks(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let open = null;
  lines.forEach((line, i) => {
    if (!open) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/);
      if (m) open = { fence: m[1], lang: m[2].toLowerCase(), line: i + 1, body: [] };
      return;
    }
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      if (open.lang === "mermaid") blocks.push({ line: open.line, body: open.body });
      open = null;
    } else open.body.push({ n: i + 1, text: line });
  });
  return blocks;
}

function lint(block) {
  const found = [];
  for (const { n, text } of block.body) {
    const t = text.trim();
    if (!t || t.startsWith("%%")) continue;
    const entity = t.match(/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/);
    if (entity) found.push({ line: n, detail: `"${entity[0]}" is decoded by GitHub before mermaid reads it; write mermaid's own entity code (#lt; #gt; #quot; #amp;) instead: ${t.slice(0, 120)}` });
    const bare = t.replace(/"[^"]*"/g, '""').replace(/#[a-zA-Z0-9]+;/g, "");
    if (/;\s*\S/.test(bare)) found.push({ line: n, detail: `a ";" ends the mermaid statement, so the rest of the label becomes stray nodes: ${t.slice(0, 120)}` });
  }
  return found;
}

const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: REPO, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((f) => !f.split("/").some((p) => p === "node_modules"));
const files = tracked
  .map((f) => ({ file: f, lines: mermaidBlocks(readFileSync(join(REPO, f), "utf8")) }))
  .filter((f) => f.lines.length && (!only.length || only.includes(f.file)));
const lintErrors = files.flatMap(({ file, lines }) => lines.flatMap((b) => lint(b).map((e) => ({ file, ...e }))));
for (const f of files) f.lines = f.lines.map((b) => b.line);

const slug = (f) => f.replace(/[^A-Za-z0-9._-]+/g, "_");
const blobUrl = (f) => `https://github.com/${repo}/blob/${sha}/${f.split("/").map(encodeURIComponent).join("/")}`;

async function open(page, url) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    const status = res ? res.status() : 0;
    if (status === 200) return;
    if (status !== 429 && status < 500) throw new Error(`${url} answered HTTP ${status}`);
    await page.waitForTimeout(15000 * attempt);
  }
  throw new Error(`${url} kept answering 429/5xx`);
}

async function inspect(section) {
  const outer = await section.evaluate((el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("iframe").forEach((f) => f.remove());
    return { text: clone.innerText || "", hasFrame: !!el.querySelector("iframe") };
  });
  if (ERROR_TEXT.test(outer.text)) return { state: "error", detail: outer.text.trim().slice(0, 400) };
  if (!outer.hasFrame) return { state: "pending" };
  const handle = await section.$("iframe");
  const frame = handle && (await handle.contentFrame());
  if (!frame) return { state: "pending" };
  const inner = await frame
    .evaluate(() => {
      const body = document.body ? document.body.innerText || "" : "";
      const svgs = [...document.querySelectorAll("svg")].filter((s) => s.closest("[id^=mermaid], .mermaid-view, body"));
      const svg = svgs.find((s) => s.getAttribute("aria-roledescription")) || svgs.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
      if (!svg) return { body, svg: null };
      const box = svg.getBoundingClientRect();
      const labels = [...svg.querySelectorAll("text, foreignObject")].map((n) => n.textContent || "");
      return {
        body,
        svg: {
          role: svg.getAttribute("aria-roledescription") || "",
          w: box.width,
          h: box.height,
          nan: /NaN|Infinity/.test(svg.outerHTML),
          labels: labels.join(" │ "),
          nodes: svg.querySelectorAll("g, path, rect, text").length,
        },
      };
    })
    .catch((e) => ({ body: "", svg: null, err: String(e) }));
  if (ERROR_TEXT.test(inner.body)) return { state: "error", detail: inner.body.trim().slice(0, 400) };
  if (!inner.svg) return { state: "pending" };
  if (inner.svg.role === "error") return { state: "error", detail: `mermaid drew its error diagram: ${inner.body.trim().slice(0, 300)}` };
  if (inner.svg.w < 20 || inner.svg.h < 20 || inner.svg.nodes < 3) return { state: "pending", detail: `svg ${inner.svg.w}x${inner.svg.h}` };
  if (inner.svg.nan) return { state: "error", detail: "the SVG has NaN or Infinity coordinates, so the layout is broken" };
  const g = inner.svg.labels.match(GARBLED_TEXT);
  if (g) return { state: "error", detail: `a label shows raw markup "${g[0]}": ${inner.svg.labels.slice(Math.max(0, g.index - 60), g.index + 60)}` };
  return { state: "ok", detail: `${inner.svg.role || "svg"} ${Math.round(inner.svg.w)}x${Math.round(inner.svg.h)}` };
}

const VIEW = { width: 1280, height: 1000 };

async function shoot(page, section, path) {
  const box = await section.boundingBox().catch(() => null);
  const h = box ? Math.ceil(box.height) + 320 : VIEW.height;
  if (h > VIEW.height) await page.setViewportSize({ width: VIEW.width, height: Math.min(h, 16000) });
  await section
    .evaluate((el) => {
      el.scrollIntoView({ block: "start" });
      window.scrollBy(0, -200);
    })
    .catch(() => {});
  await page.waitForTimeout(h > VIEW.height ? 1500 : 500);
  const clip = await section.boundingBox().catch(() => null);
  if (clip) await page.screenshot({ path, clip: { x: clip.x, y: Math.max(0, clip.y), width: clip.width, height: clip.height } }).catch(() => {});
  else await section.screenshot({ path }).catch(() => {});
  if (h > VIEW.height) await page.setViewportSize(VIEW);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEW, colorScheme: "light", deviceScaleFactor: 1 });
const page = await context.newPage();
const results = [];
let failed = 0;
for (const e of lintErrors) {
  failed += 1;
  results.push({ file: e.file, line: e.line, state: "error", detail: e.detail });
  console.log(`::error file=${e.file},line=${e.line}::${e.detail}`);
}

const DETERMINISTIC = /Parse error|Lexical error|Syntax error|No diagram type|Maximum text size|raw markup|NaN|mermaid block\(s\) in the source/i;
const ATTEMPTS = 3;

async function checkFile(file, lines) {
  const url = blobUrl(file);
  const found = [];
  try {
    await open(page, url);
    await page.waitForSelector("article.markdown-body, .markdown-body", { timeout: 60000 });
    await page.waitForFunction((n) => document.querySelectorAll('section[data-type="mermaid"]').length >= n, lines.length, { timeout: 30000 }).catch(() => {});
  } catch (e) {
    return lines.map((line) => ({ file, line, state: "error", detail: `page did not load: ${e.message}` }));
  }
  const sections = await page.$$('section[data-type="mermaid"]');
  if (sections.length !== lines.length) {
    writeFileSync(join(out, `${slug(file)}.html`), await page.content());
    found.push({ file, line: lines[0], state: "error", detail: `${lines.length} mermaid block(s) in the source, ${sections.length} on ${url}` });
  }
  for (const [i, section] of sections.entries()) {
    const line = lines[i] ?? lines[lines.length - 1];
    await section.scrollIntoViewIfNeeded().catch(() => {});
    const deadline = Date.now() + WAIT_MS;
    let r = { state: "pending" };
    while (Date.now() < deadline) {
      r = await inspect(section).catch((e) => ({ state: "pending", detail: String(e) }));
      if (r.state !== "pending") break;
      await page.waitForTimeout(1000);
    }
    if (r.state === "ok") {
      await page.waitForTimeout(800);
      r = await inspect(section).catch((e) => ({ state: "error", detail: String(e) }));
    }
    if (r.state === "pending") r = { state: "error", detail: `no diagram after ${WAIT_MS / 1000}s${r.detail ? ` (${r.detail})` : ""}` };
    await shoot(page, section, join(out, `${slug(file)}-L${line}.png`));
    found.push({ file, line, ...r });
  }
  const full = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: VIEW.width, height: Math.min(Math.max(full, VIEW.height), 16000) });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, `${slug(file)}.png`), fullPage: true }).catch(() => {});
  await page.setViewportSize(VIEW);
  return found;
}

for (const { file, lines } of files) {
  let found = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    found = await checkFile(file, lines);
    const bad = found.filter((r) => r.state !== "ok");
    if (!bad.length || bad.every((r) => DETERMINISTIC.test(r.detail || "")) || attempt === ATTEMPTS) break;
    console.log(`::warning file=${file}::attempt ${attempt}: ${bad.length} block(s) did not draw (${bad[0].detail.replace(/\s+/g, " ").slice(0, 160)}); opening the page again`);
  }
  for (const r of found) {
    results.push(r);
    if (r.state === "ok") console.log(`ok    ${file}:${r.line}  ${r.detail}`);
    else {
      failed += 1;
      console.log(`::error file=${file},line=${r.line}::GitHub cannot render this mermaid block: ${r.detail.replace(/\s+/g, " ")}`);
    }
  }
}


await browser.close();
writeFileSync(join(out, "report.tsv"), results.map((r) => `${r.state}\t${r.file}:${r.line}\t${(r.detail || "").replace(/\s+/g, " ")}`).join("\n") + "\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.state === "ok" ? "ok" : "**fail**"} | \`${r.file}:${r.line}\` | ${(r.detail || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 300)} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Mermaid on github.com at ${sha.slice(0, 7)}\n\n| | Block | Result |\n|---|---|---|\n${rows.join("\n")}\n\n`);
}
console.log(`${results.length} block(s) opened on github.com, ${failed} failed`);
process.exit(failed ? 1 : 0);
