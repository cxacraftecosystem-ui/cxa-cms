import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(KIT, "..", "..");
const SVG_BUDGET = 60 * 1024;
const GIF_BUDGET = 3 * 1024 * 1024;
const RASTER_BUDGET = 1024 * 1024;

const rel = (p) => relative(REPO, p).split(sep).join("/");
const errors = [];
const fail = (msg) => errors.push(msg);

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

function markdownFiles(extra) {
  const md = (p) => p.endsWith(".md");
  const files = [
    join(REPO, "README.md"),
    ...walk(KIT, md),
    ...walk(join(REPO, "docs"), md).sort(),
    ...walk(join(REPO, ".claude", "skills"), md).sort(),
    ...extra.map((p) => resolve(p)),
  ];
  return [...new Set(files.filter(existsSync))];
}

function scanFences(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  const prose = [];
  let open = null;
  lines.forEach((line, i) => {
    if (!open) {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/);
      if (m) open = { fence: m[1], lang: m[2].toLowerCase(), line: i + 1, body: [] };
      else prose.push(line);
      return;
    }
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      blocks.push({ line: open.line, lang: open.lang, text: open.body.join("\n") });
      open = null;
    } else open.body.push(line);
  });
  if (open) blocks.push({ line: open.line, lang: open.lang, text: open.body.join("\n"), unclosed: true });
  return { blocks, prose: prose.join("\n") };
}

function stripFences(md) {
  return scanFences(md).prose.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, "");
}

function fencedBlocks(file) {
  return scanFences(readFileSync(file, "utf8")).blocks.map((b) => ({ ...b, file }));
}

function mermaidBlocks(file) {
  return fencedBlocks(file).filter((b) => b.lang === "mermaid");
}

function extractMermaid(outDir, extra, strict) {
  mkdirSync(outDir, { recursive: true });
  const manifest = [];
  let n = 0;
  for (const f of markdownFiles(extra)) {
    for (const b of mermaidBlocks(f)) {
      n += 1;
      const name = `${String(n).padStart(3, "0")}.mmd`;
      writeFileSync(join(outDir, name), `${b.text}\n`);
      manifest.push(`${name}\t${rel(f)}:${b.line}`);
      if (!/^%%\{\s*init:/.test(b.text.trimStart())) {
        const msg = `${rel(f)}:${b.line}: mermaid block has no %%{init}%% directive with the kit's themeVariables`;
        if (strict) fail(msg);
        else console.log(`::warning file=${rel(f)},line=${b.line}::${msg}`);
      }
    }
  }
  writeFileSync(join(outDir, "manifest.tsv"), `${manifest.join("\n")}\n`);
  console.log(`${n} mermaid block(s) extracted to ${outDir}`);
  for (const m of manifest) console.log(`  ${m}`);
}

function imageRefs(file) {
  const md = stripFences(readFileSync(file, "utf8"));
  const refs = [];
  for (const m of md.matchAll(/<(?:img|source)\b[^>]*?\s(?:src|srcset)="([^"]+)"/g)) refs.push(m[1]);
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) refs.push(m[1]);
  return refs;
}

function svgFiles(extra) {
  const set = new Set(walk(KIT, (p) => p.endsWith(".svg")));
  for (const md of markdownFiles(extra)) {
    for (const ref of imageRefs(md)) {
      if (/^[a-z]+:/i.test(ref) || ref.startsWith("#")) continue;
      const p = resolve(dirname(md), ref.split(/[?#]/)[0]);
      if (p.endsWith(".svg") && existsSync(p)) set.add(p);
    }
  }
  return [...set].sort();
}

function checkSvg(file) {
  const name = rel(file);
  const size = statSync(file).size;
  const s = readFileSync(file, "utf8");
  if (size > SVG_BUDGET) fail(`${name}: ${size} bytes, over the ${SVG_BUDGET}-byte budget`);
  if (/<script\b/i.test(s)) fail(`${name}: contains <script>`);
  if (/<foreignObject\b/i.test(s)) fail(`${name}: contains <foreignObject>`);
  if (/\son[a-z]+\s*=/i.test(s)) fail(`${name}: contains an event-handler attribute`);
  if (/@import\b/i.test(s)) fail(`${name}: contains @import`);
  if (/@font-face\b/i.test(s)) fail(`${name}: contains @font-face`);
  for (const m of s.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/g)) {
    if (!m[1].startsWith("#")) fail(`${name}: external reference href="${m[1]}"`);
  }
  for (const m of s.matchAll(/url\(\s*['"]?([^'")\s]*)/g)) {
    if (!m[1].startsWith("#")) fail(`${name}: external reference url(${m[1]})`);
  }
  if (/<image\b/i.test(s)) fail(`${name}: contains <image>`);
  if (!/<title>[^<]+<\/title>/.test(s)) fail(`${name}: no <title>`);
  if (!/<svg\b[^>]*\saria-label="[^"]+"/.test(s)) fail(`${name}: the root <svg> has no aria-label`);
  if (!/<svg\b[^>]*\srole="img"/.test(s)) fail(`${name}: the root <svg> has no role="img"`);
  const animated = /\banimation\s*:|<animate/i.test(s);
  if (animated && !/prefers-reduced-motion\s*:\s*reduce/.test(s)) fail(`${name}: animated but has no prefers-reduced-motion rule`);
  if (/<animate/i.test(s) && !/class="[^"]*\b(?:smil|sweep)\b/.test(s)) fail(`${name}: SMIL animation with nothing for the reduced-motion rule to switch off (use class "smil" or "sweep")`);
}

function checkSvgs(listFile, extra) {
  const files = svgFiles(extra);
  files.forEach(checkSvg);
  if (listFile) writeFileSync(listFile, `${files.join("\n")}\n`);
  console.log(`${files.length} SVG file(s) checked`);
}

function checkRefs(extra) {
  let n = 0;
  for (const md of markdownFiles(extra)) {
    for (const ref of imageRefs(md)) {
      if (/^[a-z]+:/i.test(ref) || ref.startsWith("#")) continue;
      n += 1;
      const p = resolve(dirname(md), ref.split(/[?#]/)[0]);
      if (!existsSync(p)) {
        fail(`${rel(md)}: image "${ref}" does not exist`);
        continue;
      }
      const size = statSync(p).size;
      const ext = extname(p).toLowerCase();
      if (ext === ".gif" && size > GIF_BUDGET) fail(`${rel(md)}: ${ref} is ${size} bytes, over the 3 MB GIF budget`);
      if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext) && size > RASTER_BUDGET) fail(`${rel(md)}: ${ref} is ${size} bytes, over the 1 MB raster budget`);
    }
    const src = stripFences(readFileSync(md, "utf8"));
    const opened = (src.match(/<picture>/g) || []).length;
    const closed = (src.match(/<\/picture>/g) || []).length;
    if (opened !== closed) fail(`${rel(md)}: ${opened} <picture> but ${closed} </picture>`);
    for (const m of src.matchAll(/<picture>([\s\S]*?)<\/picture>/g)) {
      if (!/media="\(prefers-color-scheme: dark\)"/.test(m[1])) fail(`${rel(md)}: a <picture> has no (prefers-color-scheme: dark) source`);
      if (!/<img\b[^>]*\salt="[^"]*"/.test(m[1])) fail(`${rel(md)}: a <picture> fallback <img> has no alt attribute (use alt="" only for decoration)`);
    }
    for (const b of fencedBlocks(md)) {
      if (b.unclosed) fail(`${rel(md)}:${b.line}: code fence is never closed`);
    }
  }
  console.log(`${n} local image reference(s) resolved`);
}

function checkRendered(htmlFile, mdFile) {
  const html = readFileSync(htmlFile, "utf8");
  const src = stripFences(readFileSync(mdFile, "utf8"));
  const name = rel(resolve(mdFile));
  if (html.trim().length < 20) fail(`${name}: GitHub rendered almost nothing`);
  const prose = html.replace(/<pre[^]*?<\/pre>/g, "").replace(/<code[^]*?<\/code>/g, "").replace(/<[^>]*>/g, "");
  for (const tag of ["picture", "source", "img", "p", "div", "table", "td", "tr", "br", "sub", "b", "a"]) {
    if (new RegExp(`&lt;/?${tag}\\b`).test(prose)) fail(`${name}: GitHub escaped a <${tag}> tag, so the HTML around it is malformed`);
  }
  if (/```|~~~/.test(prose)) fail(`${name}: an unclosed code fence leaked into the rendered page`);
  const want = (src.match(/<picture>/g) || []).length;
  const got = (html.match(/<picture>/g) || []).length;
  if (want !== got) fail(`${name}: ${want} <picture> in the source, ${got} after rendering`);
  const wantMermaid = mermaidBlocks(resolve(mdFile)).length;
  const gotMermaid = (html.match(/data-type="mermaid"/g) || []).length;
  if (gotMermaid !== wantMermaid) fail(`${name}: ${wantMermaid} mermaid block(s) in the source, ${gotMermaid} recognised after rendering`);
  console.log(`${name}: rendered ${html.length} bytes, ${got} <picture>, ${gotMermaid} mermaid block(s)`);
}

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

if (cmd === "mermaid") {
  const out = flag("--out") || join(REPO, ".readme-check", "mermaid");
  const strict = args.includes("--strict");
  extractMermaid(out, args.filter((a) => a !== "--strict"), strict);
} else if (cmd === "svg") {
  checkSvgs(flag("--list"), args);
} else if (cmd === "refs") {
  checkRefs(args);
} else if (cmd === "rendered") {
  checkRendered(args[0], args[1]);
} else if (cmd === "files") {
  for (const f of markdownFiles(args)) console.log(rel(f));
} else {
  console.error("usage: check.mjs mermaid [--out dir] | svg [--list file] | refs | rendered <html> <md> | files");
  process.exit(2);
}

for (const e of errors) console.error(`FAIL ${e}`);
if (errors.length) process.exit(1);
