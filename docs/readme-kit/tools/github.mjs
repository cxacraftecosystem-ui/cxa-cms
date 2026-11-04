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
    const init = t.match(/^%%\{\s*init:\s*(\{.*\})\s*\}%%$/);
    if (init) {
      let cfg = null;
      try {
        cfg = JSON.parse(init[1]);
      } catch {
        found.push({ line: n, detail: `the %%{init}%% directive is not valid JSON: ${t.slice(0, 120)}` });
      }
      const tv = cfg && cfg.themeVariables;
      if (tv && tv.fontFamily && tv.fontFamily !== cfg.fontFamily) found.push({ line: n, detail: `themeVariables.fontFamily without the same top-level "fontFamily": github.com draws the labels in its own font while mermaid sizes every box for the top-level one, so text is clipped on Windows and macOS; set the stack as the top-level "fontFamily" (README_STYLE.md, Mermaid)` });
    }
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
      const vb = svg.viewBox && svg.viewBox.baseVal;
      const scale = vb && vb.width ? box.width / vb.width : 1;
      const visible = (el) => {
        for (let n = el; n && n !== svg; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
        }
        return true;
      };
      const union = (rects) => {
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (const q of rects) {
          if (!q.width && !q.height) continue;
          l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
        }
        return l === Infinity ? null : { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
      };
      const glyphs = (el) => {
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        const rects = [];
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.textContent.trim()) continue;
          range.selectNodeContents(n);
          rects.push(...range.getClientRects());
        }
        return union(rects);
      };
      const shapes = [...svg.querySelectorAll("rect, path, polygon, circle, ellipse")]
        .filter((s) => !s.closest("defs, marker, foreignObject, clipPath, mask, pattern, symbol"))
        .filter((s) => ![...s.classList].some((c) => /^activation|^pieCircle|^pieOuterCircle/.test(c)))
        .filter((s) => {
          const cs = getComputedStyle(s);
          const fill = cs.fill || "";
          return fill !== "none" && fill !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(fill) && Number(cs.fillOpacity) > 0 && visible(s);
        })
        .map((s) => ({ s, r: s.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 4 * scale && r.height > 4 * scale);
      const kindOf = (el) => {
        if (el.closest(".edgeLabel, .edgeLabels, .relationshipLabel, .er.relationshipLabel")) return "edge";
        if (el.closest(".cluster-label, .cluster")) return "cluster";
        if (el.closest(".note, .noteText") || /note/i.test(el.getAttribute("class") || "")) return "note";
        if (/actor/i.test(el.getAttribute("class") || "") || el.closest(".actor, [class*=actor]")) return "actor";
        if (el.closest(".attribute-type, .attribute-name, .attribute-keys, .attribute-comment") || /attribute/i.test(el.closest("g")?.getAttribute("class") || "")) return "attribute";
        if (el.closest(".messageText") || /messageText|labelText|loopText/.test(el.getAttribute("class") || "")) return "message";
        if (el.closest(".node, .entityBox, [id*=entity]")) return svg.getAttribute("aria-roledescription") === "er" ? "entity" : "node";
        return "label";
      };
      const TOL = 2;
      const clips = [];
      const seen = new Set();
      const owners = [...svg.querySelectorAll("foreignObject"), ...[...svg.querySelectorAll("text")].filter((t) => !t.closest("foreignObject"))];
      let font = "";
      for (const el of owners) {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || !visible(el)) continue;
        const t = el.tagName.toLowerCase() === "foreignobject" ? glyphs(el) : union([el.getBoundingClientRect()]);
        if (!t) continue;
        if (!font) {
          const leaf = el.tagName.toLowerCase() === "foreignobject" ? el.querySelector("span, p, div") || el : el;
          const cs = getComputedStyle(leaf);
          font = `${cs.fontSize} ${cs.fontFamily.split(",")[0]}`;
        }
        const over = [];
        if (el.tagName.toLowerCase() === "foreignobject") {
          const f = el.getBoundingClientRect();
          const dx = Math.max(f.left - t.left, t.right - f.right, 0) / scale;
          const dy = Math.max(f.top - t.top, t.bottom - f.bottom, 0) / scale;
          if (dx > TOL || dy > TOL) over.push({ box: "label box", dx, dy, tw: t.width / scale, bw: f.width / scale });
        }
        const cx = (t.left + t.right) / 2;
        const cy = (t.top + t.bottom) / 2;
        let best = null;
        for (const sh of shapes) {
          const r = sh.r;
          if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
          if (!best || r.width * r.height < best.r.width * best.r.height) best = sh;
        }
        if (best) {
          const r = best.r;
          const dx = Math.max(r.left - t.left, t.right - r.right, 0) / scale;
          if (dx > TOL) over.push({ box: `${best.s.tagName.toLowerCase()} shape`, dx, dy: 0, tw: t.width / scale, bw: r.width / scale });
        }
        if (!over.length) continue;
        const key = `${text}|${Math.round(cx)}|${Math.round(cy)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const o = over.sort((a, b) => Math.max(b.dx, b.dy) - Math.max(a.dx, a.dy))[0];
        clips.push({ kind: kindOf(el), text: text.slice(0, 80), box: o.box, dx: Math.round(o.dx * 10) / 10, dy: Math.round(o.dy * 10) / 10, tw: Math.round(o.tw), bw: Math.round(o.bw) });
      }
      return {
        body,
        svg: {
          role: svg.getAttribute("aria-roledescription") || "",
          w: box.width,
          h: box.height,
          nan: /NaN|Infinity/.test(svg.outerHTML),
          labels: labels.join(" │ "),
          nodes: svg.querySelectorAll("g, path, rect, text").length,
          count: owners.length,
          font,
          clips,
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
  const summary = `${inner.svg.role || "svg"} ${Math.round(inner.svg.w)}x${Math.round(inner.svg.h)}, ${inner.svg.count} labels, ${inner.svg.font}`;
  if (inner.svg.clips.length) {
    const list = inner.svg.clips.map((c) => `${c.kind} "${c.text}" ${c.tw}px in a ${c.bw}px ${c.box} (+${Math.max(c.dx, c.dy)}px)`);
    return { state: "error", clips: inner.svg.clips, detail: `clipped text: ${inner.svg.clips.length} label(s) overflow their box: ${list.join("; ")} [${summary}]` };
  }
  return { state: "ok", detail: summary };
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

function viewerFonts() {
  if (process.platform !== "linux") return { env: {}, note: `${process.platform} system fonts` };
  let listed = "";
  try {
    listed = execFileSync("fc-list", [":", "family"], { encoding: "utf8" });
  } catch {
    return { env: {}, note: "fc-list is missing, so the system font map is used" };
  }
  const have = new Set(listed.split("\n").flatMap((l) => l.split(",")).map((f) => f.trim().toLowerCase()).filter(Boolean));
  const pick = (names) => names.find((f) => have.has(f.toLowerCase()));
  const narrow = pick(["Liberation Sans Narrow", "Nimbus Sans Narrow", "DejaVu Sans Condensed", "Ubuntu Condensed", "Noto Sans Condensed"]);
  const wide = pick(["Liberation Sans", "Arimo", "Nimbus Sans", "FreeSans"]);
  if (!narrow || !wide) return { env: {}, note: `no narrow and wide sans pair among ${have.size} families, so the system font map is used` };
  const alias = (family, face) => `<match target="pattern"><test qual="any" name="family" ignore-blanks="true"><string>${family}</string></test><edit name="family" mode="prepend" binding="strong"><string>${face}</string></edit></match>`;
  const conf = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include>${["trebuchet ms", "verdana"].map((f) => alias(f, narrow)).join("")}${["helvetica", "arial", "freesans", "clean"].map((f) => alias(f, wide)).join("")}</fontconfig>\n`;
  const file = join(out, "fonts.conf");
  writeFileSync(file, conf);
  return { env: { FONTCONFIG_FILE: file }, note: `"trebuchet ms" and verdana drawn in ${narrow}, Helvetica and Arial in ${wide}, as Windows and macOS draw them narrower and wider` };
}

const fonts = viewerFonts();
console.log(`fonts: ${fonts.note}`);
const browser = await chromium.launch({ env: { ...process.env, ...fonts.env } });
const context = await browser.newContext({ viewport: VIEW, colorScheme: "light", deviceScaleFactor: 1 });
const page = await context.newPage();
const results = [];
const clipped = [];
let failed = 0;
for (const e of lintErrors) {
  failed += 1;
  results.push({ file: e.file, line: e.line, state: "error", detail: e.detail });
  console.log(`::error file=${e.file},line=${e.line}::${e.detail}`);
}

const DETERMINISTIC = /Parse error|Lexical error|Syntax error|No diagram type|Maximum text size|raw markup|clipped text|NaN|mermaid block\(s\) in the source/i;
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
    if (r.state === "ok" || r.clips) {
      await page.waitForTimeout(1500);
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
      if (r.clips) {
        for (const c of r.clips) {
          clipped.push({ file, line: r.line, ...c });
          console.log(`::error file=${file},line=${r.line}::clipped ${c.kind} label "${c.text}": ${c.tw}px of text in a ${c.bw}px ${c.box}, ${Math.max(c.dx, c.dy)}px over`);
        }
      } else console.log(`::error file=${file},line=${r.line}::GitHub cannot render this mermaid block: ${r.detail.replace(/\s+/g, " ")}`);
    }
  }
}


await browser.close();
writeFileSync(join(out, "report.tsv"), results.map((r) => `${r.state}\t${r.file}:${r.line}\t${(r.detail || "").replace(/\s+/g, " ")}`).join("\n") + "\n");
writeFileSync(join(out, "clipped.tsv"), clipped.map((c) => [`${c.file}:${c.line}`, c.kind, c.text, c.tw, c.bw, c.box, Math.max(c.dx, c.dy)].join("\t")).join("\n") + (clipped.length ? "\n" : ""));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.state === "ok" ? "ok" : "**fail**"} | \`${r.file}:${r.line}\` | ${(r.detail || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 300)} |`);
  const clipRows = clipped.map((c) => `| \`${c.file}:${c.line}\` | ${c.kind} | ${c.text.replace(/\|/g, "\\|")} | ${c.tw} | ${c.bw} |`);
  const clipTable = clipped.length ? `#### Clipped labels\n\n| Block | Kind | Label | Text px | Box px |\n|---|---|---|---|---|\n${clipRows.join("\n")}\n\n` : "";
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Mermaid on github.com at ${sha.slice(0, 7)}\n\n| | Block | Result |\n|---|---|---|\n${rows.join("\n")}\n\n${clipTable}`);
}
console.log(`${results.length} block(s) opened on github.com, ${failed} failed, ${clipped.length} clipped label(s) in ${new Set(clipped.map((c) => `${c.file}:${c.line}`)).size} block(s)`);
process.exit(failed ? 1 : 0);
