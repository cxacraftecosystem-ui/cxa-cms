import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ICONS } from "./icons.mjs";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const THEMES = {
  light: {
    bg0: "#F7F6FB", card: "#FFFFFF", s50: "#FAF9FD", s100: "#F3F1FA", s200: "#E9E6F5", s300: "#DCD7EE", line: "#E4E2EF",
    ink900: "#1E1B2E", ink700: "#3A3651", ink500: "#615D7A", ink300: "#A7A3BC",
    accent: "#762CB1", accentText: "#762CB1", accentSoft: "#F9F5FF", accentLine: "#E7D5FE", accentMid: "#AA69E9", onAccent: "#FFFFFF",
    gold: "#CD9200", goldSoft: "#EEC976",
    heroBg: ["#FFFFFF", "#F7F6FB", "#F2E9FE"], blobs: ["#AA69E9", "#E0AF43", "#9148D2"], blobOpacity: 0.3,
    grid: "#3A3651", gridOpacity: 0.05, wave: [0.1, 0.18],
    sweep: ["#4B1674", "#762CB1", "#9148D2", "#AD7300", "#4B1674"], still: ["#4B1674", "#762CB1"],
    footBg: ["#FFFFFF", "#F3F1FA"], shadow: "#3A3651", shadowOpacity: 0.06
  },
  dark: {
    bg0: "#110F19", card: "#1A1725", s50: "#201C2D", s100: "#262135", s200: "#2E2840", s300: "#3A3350", line: "#342E47",
    ink900: "#F2F0F9", ink700: "#D0CBDF", ink500: "#9E98B2", ink300: "#6E6884",
    accent: "#C090F5", accentText: "#D6B6FB", accentSoft: "#2F0D4B", accentLine: "#5F1C93", accentMid: "#AA69E9", onAccent: "#1A1725",
    gold: "#E0AF43", goldSoft: "#EEC976",
    heroBg: ["#110F19", "#1A1725", "#2F0D4B"], blobs: ["#762CB1", "#AD7300", "#9148D2"], blobOpacity: 0.45,
    grid: "#D0CBDF", gridOpacity: 0.045, wave: [0.18, 0.3],
    sweep: ["#F9F5FF", "#D6B6FB", "#C090F5", "#EEC976", "#F9F5FF"], still: ["#F9F5FF", "#D6B6FB"],
    footBg: ["#1A1725", "#110F19"], shadow: "#000000", shadowOpacity: 0.35
  }
};

const DISPLAY = "'Plus Jakarta Sans','Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SANS = "'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r = (n) => Math.round(n * 10) / 10;

function wrap(text, max, lines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > max && cur) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = `${kept[lines - 1].replace(/[\s,.;:]+$/, "")}…`;
    return kept;
  }
  return out;
}

function icon(name, x, y, size, color, weight = 2) {
  const body = ICONS[name];
  if (!body) throw new Error(`unknown icon "${name}"; known: ${Object.keys(ICONS).join(", ")}`);
  const k = size / 24;
  return `<g transform="translate(${r(x)} ${r(y)}) scale(${r(k * 1000) / 1000})" fill="none" stroke="${color}" stroke-width="${r((weight / k) * 100) / 100}" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

function textLines(lines, x, y, step, attrs) {
  return lines.map((l, i) => `<text x="${r(x)}" y="${r(y + i * step)}" ${attrs}>${esc(l)}</text>`).join("");
}

function sweepDefs(t, dur = 8) {
  const n = t.sweep.length - 1;
  const stops = t.sweep.map((c, i) => `<stop offset="${r((i / n) * 100) / 100}" stop-color="${c}"/>`).join("");
  return `<linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">${stops}<animateTransform attributeName="gradientTransform" type="translate" values="-1 0;1 0" dur="${dur}s" repeatCount="indefinite"/></linearGradient><linearGradient id="still" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.still[0]}"/><stop offset="1" stop-color="${t.still[1]}"/></linearGradient>`;
}

const BASE_CSS = `.d{font-family:${DISPLAY}}.s{font-family:${SANS}}.m{font-family:${MONO}}.rise{animation:rise .9s cubic-bezier(.2,.7,.2,1) both}@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`;
const REDUCED = `@media (prefers-reduced-motion:reduce){*{animation:none!important}.smil{display:none}.sweep{fill:url(#still)}}`;

function delays(n, step, start = 0.1) {
  return Array.from({ length: n }, (_, i) => `.r${i}{animation-delay:${r(start + i * step)}s}`).join("");
}

function doc(w, h, label, defs, css, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<defs>
<style>${BASE_CSS}${css}${REDUCED}</style>
${defs}
</defs>
${body}
</svg>
`;
}

function hero(t, c) {
  const W = 1200, H = 420, X = 64;
  const titleLines = wrap(c.name, c.titleWrap || 18, 2);
  const titleSize = titleLines.length > 1 ? 56 : 64;
  const tag = wrap(c.tagline, 60, 3);
  const eyebrowW = c.eyebrow.length * 8.7 + 50;
  let y = 172;
  const title = textLines(titleLines, X, y, titleSize * 1.08, `class="d sweep" fill="url(#sweep)" font-size="${titleSize}" font-weight="800" letter-spacing="-1.5"`);
  y += (titleLines.length - 1) * titleSize * 1.08 + 46;
  const tagline = textLines(tag, X, y, 29, `class="s" fill="${t.ink700}" font-size="19"`);
  y += (tag.length - 1) * 29 + 40;
  let cx = X;
  const chips = (c.chips || []).map((ch) => {
    const w = ch.length * 7.6 + 30;
    const g = `<g><rect x="${r(cx)}" y="${r(y)}" width="${r(w)}" height="32" rx="16" fill="${t.card}" fill-opacity=".8" stroke="${t.line}"/><text x="${r(cx + w / 2)}" y="${r(y + 21)}" class="s" fill="${t.ink700}" font-size="13" font-weight="600" text-anchor="middle">${esc(ch)}</text></g>`;
    cx += w + 10;
    return g;
  }).join("");

  const LX = 812, LY = 62, LW = 330, LH = 268;
  const warps = Array.from({ length: 11 }, (_, i) => 32 + i * 26.6);
  const rows = 7;
  const rowY = (i) => 50 + i * 22.6;
  const weft = Array.from({ length: rows }, (_, i) => {
    const pts = warps.map((x, j) => `${r(x)} ${r(rowY(i) + ((i + j) % 2 ? 3.5 : -3.5))}`);
    if (i % 2) pts.reverse();
    const color = [t.accent, t.gold, t.accentMid][i % 3];
    return `<path class="weft w${i}" d="M${pts.join(" L")}" stroke="${color}"/>`;
  }).join("");
  const serp = Array.from({ length: rows }, (_, i) => {
    const a = i % 2 ? warps[warps.length - 1] : warps[0];
    const b = i % 2 ? warps[0] : warps[warps.length - 1];
    return `${i ? "L" : "M"}${r(a)} ${r(rowY(i))} L${r(b)} ${r(rowY(i))}`;
  }).join(" ");
  const cycle = rows + 3;
  const loom = `<g transform="translate(${LX} ${LY})">
<rect width="${LW}" height="${LH}" rx="20" fill="${t.card}" fill-opacity=".72" stroke="${t.line}"/>
<rect x="18" y="20" width="${LW - 36}" height="10" rx="5" fill="${t.accent}" fill-opacity=".85"/>
<rect x="18" y="${LH - 62}" width="${LW - 36}" height="10" rx="5" fill="${t.accent}" fill-opacity=".85"/>
<g stroke="${t.ink300}" stroke-width="1.4" stroke-opacity=".75">${warps.map((x, i) => `<line class="warp${i % 2 ? " wb" : ""}" x1="${r(x)}" y1="30" x2="${r(x)}" y2="${LH - 62}"/>`).join("")}</g>
<g fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">${weft}</g>
<g class="smil"><rect x="-13" y="-5" width="26" height="10" rx="5" fill="${t.gold}" stroke="${t.card}" stroke-width="2"><animateMotion dur="${cycle}s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;${r((rows / cycle) * 100) / 100};1" calcMode="linear" path="${serp}"/></rect></g>
<line x1="24" y1="${LH - 34}" x2="${LW - 24}" y2="${LH - 34}" stroke="${t.line}"/>
<text x="${LW / 2}" y="${LH - 14}" class="m" fill="${t.ink500}" font-size="12" text-anchor="middle" letter-spacing="1.5">${esc(c.motifCaption || "warp · weft · record")}</text>
</g>`;

  const css = `.blob{animation:drift 18s ease-in-out infinite alternate}.b2{animation-duration:24s;animation-delay:-7s}.b3{animation-duration:30s;animation-delay:-13s}@keyframes drift{0%{transform:translate(0,0)}50%{transform:translate(50px,-30px)}100%{transform:translate(-40px,24px)}}.warp{animation:sway 5s ease-in-out infinite alternate;transform-box:fill-box;transform-origin:50% 0}.wb{animation-delay:-2.5s}@keyframes sway{from{transform:translateX(-1px)}to{transform:translateX(1px)}}.weft{stroke-dasharray:320;stroke-dashoffset:0;animation:weave ${cycle}s linear infinite}${Array.from({ length: rows }, (_, i) => `.w${i}{animation-delay:${i}s}`).join("")}@keyframes weave{0%{stroke-dashoffset:320}${r((1 / cycle) * 1000) / 10}%{stroke-dashoffset:0}${r(((cycle - 1) / cycle) * 1000) / 10}%{stroke-dashoffset:0}100%{stroke-dashoffset:-320}}.wa{animation:wave 11s ease-in-out infinite alternate}.wv{animation:wave 15s ease-in-out infinite alternate-reverse}@keyframes wave{from{transform:translateX(0)}to{transform:translateX(-150px)}}.live{animation:live 2.2s ease-out infinite;transform-box:fill-box;transform-origin:center}@keyframes live{0%{transform:scale(1);opacity:.7}100%{transform:scale(2.6);opacity:0}}${delays(5, 0.18)}`;
  const defs = `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.heroBg[0]}"/><stop offset=".55" stop-color="${t.heroBg[1]}"/><stop offset="1" stop-color="${t.heroBg[2]}"/></linearGradient>
${sweepDefs(t)}
<linearGradient id="wave" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.accent}"/><stop offset=".5" stop-color="${t.gold}"/><stop offset="1" stop-color="${t.accent}"/></linearGradient>
<filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="64"/></filter>
<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="${t.grid}" stroke-opacity="${t.gridOpacity}"/></pattern>
<clipPath id="card"><rect width="${W}" height="${H}" rx="24"/></clipPath>`;
  const body = `<g clip-path="url(#card)">
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#grid)"/>
<g filter="url(#blur)" opacity="${t.blobOpacity}"><circle class="blob" cx="1010" cy="70" r="180" fill="${t.blobs[0]}"/><circle class="blob b2" cx="700" cy="410" r="150" fill="${t.blobs[1]}"/><circle class="blob b3" cx="120" cy="10" r="150" fill="${t.blobs[2]}"/></g>
<path class="wv" opacity="${t.wave[0]}" fill="url(#wave)" d="M0 372 C 150 342 300 398 450 372 S 750 342 900 372 S 1200 402 1350 372 V${H} H0Z"/>
<path class="wa" opacity="${t.wave[1]}" fill="url(#wave)" d="M0 394 C 160 368 320 414 480 394 S 800 368 960 394 S 1280 414 1400 394 V${H} H0Z"/>
<g class="rise r4">${loom}</g>
<g class="rise r0"><rect x="${X}" y="62" width="${eyebrowW}" height="30" rx="15" fill="${t.accentSoft}" stroke="${t.accentLine}"/><circle cx="${X + 18}" cy="77" r="4" fill="${t.accent}"/><circle class="live" cx="${X + 18}" cy="77" r="4" fill="${t.accent}"/><text x="${X + 32}" y="81.5" class="m" fill="${t.accentText}" font-size="12" font-weight="600" letter-spacing="1.6">${esc(c.eyebrow.toUpperCase())}</text></g>
<g class="rise r1">${title}</g>
<g class="rise r2">${tagline}</g>
<g class="rise r3">${chips}</g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="24" fill="none" stroke="${t.line}"/>
</g>`;
  return doc(W, H, c.label || `${c.name}: ${c.tagline}`, defs, css, body);
}

function cards(t, c) {
  const W = 1200, P = 6, G = 20, cols = c.columns || 3, CH = c.cardHeight || 214;
  const n = c.items.length, rows = Math.ceil(n / cols);
  const CW = (W - 2 * P - (cols - 1) * G) / cols;
  const H = Math.ceil(2 * P + rows * CH + (rows - 1) * G);
  const per = Math.floor((CW - 52) / 8.1);
  const clips = [];
  const body = c.items.map((it, i) => {
    const x = P + (i % cols) * (CW + G), y = P + Math.floor(i / cols) * (CH + G);
    clips.push(`<clipPath id="k${i}"><rect x="${r(x)}" y="${r(y)}" width="${r(CW)}" height="${CH}" rx="18"/></clipPath>`);
    const lines = wrap(it.body, per, 3);
    return `<g class="rise r${i}">
<rect x="${r(x)}" y="${r(y)}" width="${r(CW)}" height="${CH}" rx="18" fill="${t.card}" stroke="${t.line}"/>
<g clip-path="url(#k${i})"><circle cx="${r(x + CW - 30)}" cy="${r(y + 20)}" r="120" fill="url(#halo)"/><rect x="${r(x)}" y="${r(y)}" width="${r(CW)}" height="3" fill="${t.accentLine}"/><rect class="shine" style="animation-delay:${r(i * 0.7)}s" x="${r(x - 180)}" y="${r(y)}" width="180" height="3" fill="url(#glint)"/></g>
<rect x="${r(x + 24)}" y="${r(y + 24)}" width="48" height="48" rx="14" fill="${t.accentSoft}" stroke="${t.accentLine}"/>
${icon(it.icon, x + 36, y + 36, 24, t.accentText)}
${it.tag ? `<text x="${r(x + CW - 24)}" y="${r(y + 46)}" class="m" fill="${t.ink500}" font-size="11" font-weight="600" letter-spacing="1.2" text-anchor="end">${esc(it.tag.toUpperCase())}</text>` : ""}
<text x="${r(x + 24)}" y="${r(y + 110)}" class="d" fill="${t.ink900}" font-size="20" font-weight="700" letter-spacing="-.3">${esc(it.title)}</text>
${textLines(lines, x + 24, y + 140, 23, `class="s" fill="${t.ink500}" font-size="15"`)}
</g>`;
  }).join("\n");
  const defs = `<radialGradient id="halo"><stop offset="0" stop-color="${t.accentMid}" stop-opacity=".16"/><stop offset="1" stop-color="${t.accentMid}" stop-opacity="0"/></radialGradient>
<linearGradient id="glint" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.accent}" stop-opacity="0"/><stop offset=".5" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.gold}" stop-opacity="0"/></linearGradient>
${clips.join("\n")}`;
  const css = `.shine{animation:shine 5.6s cubic-bezier(.5,0,.3,1) infinite}@keyframes shine{0%{transform:translateX(0)}45%,100%{transform:translateX(${r(CW + 180)}px)}}${delays(n, 0.12)}`;
  return doc(W, H, c.label, defs, css, body);
}

function pipeline(t, c) {
  const W = 1200, H = 262, Y = 92, n = c.stages.length;
  const x0 = 110, x1 = W - 110, step = (x1 - x0) / (n - 1);
  const hop = c.hop || 1.4, hold = 2.4, D = r(hop * (n - 1) + hold);
  const per = Math.max(14, Math.floor(step / 7.4));
  const xs = c.stages.map((_, i) => x0 + i * step);
  const nodes = c.stages.map((s, i) => {
    const x = xs[i];
    const sub = wrap(s.sub || "", per, 2);
    return `<g class="rise r${i}">
<circle class="ring" style="animation-delay:${r(i * hop)}s" cx="${r(x)}" cy="${Y}" r="36" fill="none" stroke="${t.accent}" stroke-width="2"/>
<circle cx="${r(x)}" cy="${Y}" r="36" fill="${t.card}" stroke="${t.accentLine}" stroke-width="2"/>
<circle cx="${r(x)}" cy="${Y}" r="27" fill="${t.accentSoft}"/>
${icon(s.icon, x - 13, Y - 13, 26, t.accentText)}
<circle cx="${r(x + 27)}" cy="${Y - 27}" r="11" fill="${t.accent}" stroke="${t.card}" stroke-width="2"/>
<text x="${r(x + 27)}" y="${Y - 23}" class="s" fill="${t.onAccent}" font-size="11" font-weight="700" text-anchor="middle">${i + 1}</text>
<text x="${r(x)}" y="${Y + 66}" class="d" fill="${t.ink900}" font-size="17" font-weight="700" text-anchor="middle">${esc(s.title)}</text>
${textLines(sub, x, Y + 90, 19, `class="s" fill="${t.ink500}" font-size="13" text-anchor="middle"`)}
</g>`;
  }).join("\n");
  const track = `M${x0} ${Y} H${x1}`;
  const len = r(x1 - x0);
  const css = `.flow{stroke-dasharray:3 13;animation:flow 1.6s linear infinite}@keyframes flow{to{stroke-dashoffset:-32}}.prog{stroke-dasharray:${len};stroke-dashoffset:0;animation:prog ${D}s linear infinite}@keyframes prog{0%{stroke-dashoffset:${len}}${r(((D - hold) / D) * 1000) / 10}%{stroke-dashoffset:0}${r(((D - 0.4) / D) * 1000) / 10}%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}.ring{opacity:0;animation:ring ${D}s ease-out infinite;transform-box:fill-box;transform-origin:center}@keyframes ring{0%{opacity:.85;transform:scale(1)}${r((1.2 / D) * 1000) / 10}%{opacity:0;transform:scale(1.55)}100%{opacity:0}}${delays(n, 0.12)}`;
  const defs = `<linearGradient id="pg" gradientUnits="userSpaceOnUse" x1="${x0}" y1="0" x2="${x1}" y2="0"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.gold}"/></linearGradient>
<filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  const body = `<path d="${track}" stroke="${t.s300}" stroke-width="4" stroke-linecap="round" fill="none"/>
<path class="prog" d="${track}" stroke="url(#pg)" stroke-width="4" stroke-linecap="round" fill="none"/>
<path class="flow" d="${track}" stroke="${t.card}" stroke-opacity=".9" stroke-width="2" stroke-linecap="round" fill="none"/>
<g class="smil"><circle r="6" fill="${t.gold}" filter="url(#glow)"><animateMotion dur="${D}s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;${r(((D - hold) / D) * 1000) / 1000};1" calcMode="linear" path="${track}"/></circle></g>
${nodes}`;
  return doc(W, H, c.label, defs, css, body);
}

function stats(t, c) {
  const W = 1200, P = 6, G = 20, n = c.tiles.length, H = 170;
  const TW = (W - 2 * P - (n - 1) * G) / n;
  const body = c.tiles.map((s, i) => {
    const x = P + i * (TW + G), y = P, h = H - 2 * P;
    const vw = String(s.value).length * 27;
    return `<g class="rise r${i}">
<rect x="${r(x)}" y="${y}" width="${r(TW)}" height="${h}" rx="18" fill="${t.card}" stroke="${t.line}"/>
<rect x="${r(x + 22)}" y="${y + 22}" width="34" height="34" rx="10" fill="${t.accentSoft}" stroke="${t.accentLine}"/>
${icon(s.icon, x + 30, y + 30, 18, t.accentText)}
<text x="${r(x + 68)}" y="${y + 44}" class="s" fill="${t.ink500}" font-size="13" font-weight="600" letter-spacing=".6">${esc((s.kicker || "").toUpperCase())}</text>
<text x="${r(x + 22)}" y="${y + 108}" class="d" fill="${t.ink900}" font-size="44" font-weight="800" letter-spacing="-1">${esc(s.value)}${s.unit ? `<tspan class="s" fill="${t.ink500}" font-size="18" font-weight="600" dx="6">${esc(s.unit)}</tspan>` : ""}</text>
<path class="bar" style="animation-delay:${r(0.3 + i * 0.15)}s" d="M${r(x + 23)} ${y + 122} h${Math.min(vw, 60)}" stroke="${t.accent}" stroke-width="3" stroke-linecap="round"/>
<text x="${r(x + 22)}" y="${y + 146}" class="s" fill="${t.ink700}" font-size="14">${esc(s.label)}</text>
</g>`;
  }).join("\n");
  const css = `.bar{stroke-dasharray:60;stroke-dashoffset:0;animation:bar 1.1s cubic-bezier(.2,.7,.2,1) both}@keyframes bar{from{stroke-dashoffset:60}to{stroke-dashoffset:0}}${delays(n, 0.12)}`;
  return doc(W, H, c.label, "", css, body);
}

function timeline(t, c) {
  const W = 1200, H = 244, Y = 112, n = c.items.length;
  const x0 = 110, x1 = W - 110, step = n > 1 ? (x1 - x0) / (n - 1) : 0;
  const nowIdx = Math.max(0, c.items.findIndex((it) => it.now));
  const xNow = x0 + nowIdx * step;
  const per = Math.max(14, Math.floor(step / 7.2));
  const items = c.items.map((it, i) => {
    const x = x0 + i * step, past = i <= nowIdx;
    const sub = wrap(it.sub || "", per, 2);
    return `<g class="rise r${i}">
<text x="${r(x)}" y="${Y - 30}" class="m" fill="${past ? t.accentText : t.ink500}" font-size="12" font-weight="600" letter-spacing="1.2" text-anchor="middle">${esc(String(it.date).toUpperCase())}</text>
${it.now ? `<circle class="halo" cx="${r(x)}" cy="${Y}" r="10" fill="${t.accent}"/>` : ""}
<circle cx="${r(x)}" cy="${Y}" r="${it.now ? 10 : 8}" fill="${it.now ? t.accent : t.card}" stroke="${past ? t.accent : t.s300}" stroke-width="3"/>
<text x="${r(x)}" y="${Y + 44}" class="d" fill="${t.ink900}" font-size="16" font-weight="700" text-anchor="middle">${esc(it.title)}</text>
${textLines(sub, x, Y + 67, 19, `class="s" fill="${t.ink500}" font-size="13" text-anchor="middle"`)}
</g>`;
  }).join("\n");
  const len = r(xNow - x0) || 1;
  const css = `.prog{stroke-dasharray:${len};stroke-dashoffset:0;animation:prog 2.4s cubic-bezier(.4,0,.2,1) .2s both}@keyframes prog{from{stroke-dashoffset:${len}}to{stroke-dashoffset:0}}.halo{animation:halo 2.4s ease-out infinite;transform-box:fill-box;transform-origin:center}@keyframes halo{0%{transform:scale(1);opacity:.55}100%{transform:scale(2.8);opacity:0}}.ahead{stroke-dasharray:2 10}${delays(n, 0.16)}`;
  const defs = `<linearGradient id="pg" gradientUnits="userSpaceOnUse" x1="${x0}" y1="0" x2="${r(Math.max(xNow, x0 + 1))}" y2="0"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.accentMid}"/></linearGradient>`;
  const body = `<path class="ahead" d="M${x0 - 40} ${Y} H${x1 + 40}" stroke="${t.s300}" stroke-width="3" stroke-linecap="round" fill="none"/>
${nowIdx > 0 ? `<path class="prog" d="M${x0} ${Y} H${r(xNow)}" stroke="url(#pg)" stroke-width="4" stroke-linecap="round" fill="none"/>` : ""}
${items}`;
  return doc(W, H, c.label, defs, css, body);
}

function divider(t, c) {
  const W = 1200, H = 40, Y = 20, M = W / 2;
  const label = c && c.label ? c.label : "Section divider";
  const css = `.glint{animation:glint 6s cubic-bezier(.5,0,.3,1) infinite}@keyframes glint{0%{transform:translateX(0)}70%,100%{transform:translateX(1500px)}}.spin{animation:spin 9s linear infinite;transform-box:fill-box;transform-origin:center}@keyframes spin{to{transform:rotate(360deg)}}`;
  const defs = `<linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="${t.accentMid}" stop-opacity="0"/><stop offset=".5" stop-color="${t.accentMid}" stop-opacity=".7"/><stop offset="1" stop-color="${t.accentMid}" stop-opacity="0"/></linearGradient>
<linearGradient id="gl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.accent}" stop-opacity="0"/><stop offset=".6" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.gold}" stop-opacity="0"/></linearGradient>
<clipPath id="lane"><rect x="0" y="${Y - 3}" width="${M - 26}" height="6"/><rect x="${M + 26}" y="${Y - 3}" width="${M - 26}" height="6"/></clipPath>`;
  const body = `<rect x="0" y="${Y - 0.75}" width="${M - 26}" height="1.5" fill="url(#fade)"/>
<rect x="${M + 26}" y="${Y - 0.75}" width="${M - 26}" height="1.5" fill="url(#fade)"/>
<g clip-path="url(#lane)"><rect class="glint" x="-260" y="${Y - 1.5}" width="220" height="3" rx="1.5" fill="url(#gl)"/></g>
<circle cx="${M - 18}" cy="${Y}" r="2" fill="${t.accentMid}"/><circle cx="${M + 18}" cy="${Y}" r="2" fill="${t.accentMid}"/>
<g transform="rotate(45 ${M} ${Y})"><rect class="spin" x="${M - 9}" y="${Y - 9}" width="18" height="18" rx="3" fill="none" stroke="${t.accentLine}" stroke-width="1.5"/></g>
<rect x="${M - 5}" y="${Y - 5}" width="10" height="10" rx="2" fill="${t.accent}" transform="rotate(45 ${M} ${Y})"/>`;
  return doc(W, H, label, defs, css, body);
}

function footer(t, c) {
  const W = 1200, H = 210;
  const sparks = [[140, 150, 0], [260, 120, -2], [420, 160, -4], [780, 140, -1], [940, 118, -3], [1080, 156, -5]]
    .map(([x, y, d], i) => `<circle class="spark" style="animation-delay:${d}s" cx="${x}" cy="${y}" r="${i % 2 ? 2 : 2.6}" fill="${i % 3 ? t.accentMid : t.gold}"/>`).join("");
  const css = `.wa{animation:wave 10s ease-in-out infinite alternate}.wv{animation:wave 14s ease-in-out infinite alternate-reverse}@keyframes wave{from{transform:translateX(0)}to{transform:translateX(-150px)}}.spark{opacity:0;animation:spark 6s ease-in-out infinite}@keyframes spark{0%{opacity:0;transform:translateY(0)}30%{opacity:.9}100%{opacity:0;transform:translateY(-60px)}}`;
  const defs = `<linearGradient id="fb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.footBg[0]}"/><stop offset="1" stop-color="${t.footBg[1]}"/></linearGradient>
<linearGradient id="wave" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.accent}"/><stop offset=".5" stop-color="${t.gold}"/><stop offset="1" stop-color="${t.accent}"/></linearGradient>
${sweepDefs(t, 9)}
<clipPath id="c"><rect width="${W}" height="${H}" rx="22"/></clipPath>`;
  const body = `<g clip-path="url(#c)">
<rect width="${W}" height="${H}" fill="url(#fb)"/>
<path class="wv" opacity="${t.wave[0] + 0.08}" fill="url(#wave)" d="M0 140 C 150 104 300 176 450 140 S 750 104 900 140 S 1200 176 1350 140 V${H} H0Z"/>
<path class="wa" opacity="${t.wave[1] + 0.1}" fill="url(#wave)" d="M0 168 C 160 134 320 198 480 168 S 800 134 960 168 S 1280 198 1400 168 V${H} H0Z"/>
${sparks}
<text x="${W / 2}" y="74" class="d sweep" fill="url(#sweep)" font-size="32" font-weight="800" text-anchor="middle" letter-spacing="-.6">${esc(c.title)}</text>
<text x="${W / 2}" y="106" class="m" fill="${t.ink500}" font-size="14" text-anchor="middle" letter-spacing=".4">${esc(c.sub)}</text>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="22" fill="none" stroke="${t.line}"/>
</g>`;
  return doc(W, H, c.label || `${c.title} ${c.sub}`, defs, css, body);
}

function iconTile(name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="${esc(name)}">
<title>${esc(name)}</title>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#762CB1"/><stop offset="1" stop-color="#2F0D4B"/></linearGradient></defs>
<rect x="1" y="1" width="46" height="46" rx="13" fill="url(#g)" stroke="#C090F5" stroke-opacity=".55" stroke-width="1.5"/>
${icon(name, 12, 12, 24, "#F9F5FF")}
</svg>
`;
}

export const TEMPLATES = { hero, cards, pipeline, stats, timeline, divider, footer };

function build(configPath, outDir) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const f of readdirSync(outDir)) if (/-(light|dark)\.svg$/.test(f)) rmSync(join(outDir, f));
  for (const [key, value] of Object.entries(config)) {
    const [name, variant] = key.split(":");
    const fn = TEMPLATES[name];
    if (!fn) continue;
    if (variant !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(variant)) throw new Error(`kit.json: "${key}" needs a lower-case variant name after the colon`);
    const base = variant ? `${name}-${variant}` : name;
    for (const [mode, t] of Object.entries(THEMES)) {
      const file = join(outDir, `${base}-${mode}.svg`);
      writeFileSync(file, fn(t, value));
      written.push(file);
    }
  }
  const iconDir = join(outDir, "icons");
  if (existsSync(iconDir)) rmSync(iconDir, { recursive: true });
  mkdirSync(iconDir, { recursive: true });
  const wanted = config.icons === "all" || !config.icons ? Object.keys(ICONS) : config.icons;
  for (const name of wanted) {
    const file = join(iconDir, `${name}.svg`);
    writeFileSync(file, iconTile(name));
    written.push(file);
  }
  return written;
}

const configPath = resolve(process.argv[2] || join(KIT, "kit.json"));
const outDir = resolve(process.argv[3] || join(KIT, "assets"));
const files = build(configPath, outDir);
console.log(`${files.length} files written to ${outDir}`);
for (const f of readdirSync(outDir).filter((f) => f.endsWith(".svg"))) console.log(`  ${f}`);
