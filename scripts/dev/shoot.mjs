/**
 * Screenshot the running site, honestly.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `chrome --headless --screenshot`.
 *
 * Two things defeat the one-liner on this site, and both produce a picture that looks fine and is a
 * lie:
 *
 *  1. **A tall window inflates `vh`.** `--window-size=1400,9000` to "capture the whole page" makes
 *     `100vh` nine thousand pixels, so the hero — which is `min-h-screen` — grows to fill it and the
 *     screenshot is three thousand pixels of background pattern. Nothing about that is a rendering
 *     bug; the page did exactly what it was told.
 *
 *  2. **Nothing below the fold is ever revealed.** Every section on the public site enters through
 *     `components/motion/Reveal`, which is `whileInView` — an IntersectionObserver that fires when
 *     the reader scrolls. A headless run that jumps to an anchor and captures immediately gets a
 *     page of `opacity: 0` blocks, because no scroll ever happened.
 *
 * So this drives a real browser at a real viewport over the DevTools Protocol, SCROLLS THE PAGE the
 * way a reader would, waits for the observers to fire and the images to decode, and only then
 * captures. `captureBeyondViewport` then stitches the full height at the correct `vh`.
 *
 * NO DEPENDENCIES. Node 22 ships a global `WebSocket`, which is the whole of what CDP needs — adding
 * Playwright or Puppeteer to devDependencies to take a screenshot would be several hundred megabytes
 * and a browser download for a development convenience.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * USAGE
 *   node scripts/dev/shoot.mjs <url> <out.png> [width] [height] [selector]
 *
 * With a `selector`, the page is scrolled so that element is at the top and only the VIEWPORT is
 * captured — which is what you want for looking at one section. Without one, the whole document is
 * stitched.
 *
 * ⚠ PREFER THE SELECTOR FORM ON THIS SITE. `captureBeyondViewport` on a document nine thousand pixels
 * tall, carrying two dozen optimised photographs, routinely takes longer than it is worth and
 * sometimes does not return at all. A viewport capture is instant and answers the actual question.
 *
 * The server must already be running. Chrome is found at the usual Windows install paths.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`
];

const url = process.argv[2] ?? "http://localhost:3000/";
const out = process.argv[3] ?? "shot.png";
const width = Number(process.argv[4] ?? 1440);
const height = Number(process.argv[5] ?? 900);
/**
 * A CSS selector to bring to the top of the viewport. Absent → stitch the whole document.
 *
 * ⚠ Tested for a leading `--` rather than against one known flag. It used to read
 * `argv[6] !== "--print"`, which was correct while `--print` was the only flag and became a trap the
 * moment a second one existed: `shoot.mjs <url> <out> 1440 900 --dark` would have taken "--dark" as a
 * CSS selector, found nothing, and silently fallen back to a full-page stitch in the LIGHT theme.
 */
const selectorArg = process.argv[6];
const selector = selectorArg && !selectorArg.startsWith("--") ? selectorArg : null;

/**
 * `--print` renders as the PRINTER sees it, through `Emulation.setEmulatedMedia`.
 *
 * It is the only way to check the `@media print` block short of putting paper in a machine — and on
 * this site it is also the EASIEST capture to trust, because the print rules force every `Reveal`
 * to full opacity. No scrolling is needed to make the page appear, which is the thing that makes
 * every other headless capture here awkward.
 */
const printMedia = process.argv.includes("--print");

/**
 * `--dark` and `--reduced-motion` — the two renders nobody ever looks at.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE DARK THEME WENT UNPHOTOGRAPHED FOR THE WHOLE PROJECT, AND IT COST FIVE BUGS.
 *
 * Defect class 15 in docs/OUTSTANDING.md: five surfaces used a THEMED neutral as the scrim under
 * unconditionally-white text, so in the dark theme each became a near-white plate carrying white text —
 * including the CC BY attribution chip, whose entire job is to be readable, and the lightbox, which
 * opened as a white flash. Every one was invisible in the light theme, and the light theme is what a
 * developer, a screenshot and the print stylesheet all default to. `scripts/theme-check.ts` now catches
 * that specific pattern statically, but it cannot see colours that meet across two elements, and it says
 * nothing about contrast. The only thing that sees those is a picture.
 *
 * SO IT IS EMULATED, NOT SEEDED. `lib/preferences.ts`'s boot script stamps `data-theme` before paint from
 * localStorage, and falls back to `matchMedia("(prefers-color-scheme: dark)")` when nothing is stored.
 * Emulating the media feature therefore drives the real code path a real reader with a dark OS takes,
 * pre-paint, with no storage to seed and no attribute flipped after the fact — which would miss anything
 * that reads the theme during render.
 *
 * `--reduced-motion` is the same argument for the other preference: under it GSAP and Lenis are never
 * fetched and no timeline is built, so it is the capture that shows what the page looks like with every
 * scrubbed layer at rest. A `Reveal` stuck at `opacity: 0` shows up here and nowhere else.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const darkTheme = process.argv.includes("--dark");
const reducedMotion = process.argv.includes("--reduced-motion");

/** A free-ish port. Fixed rather than random so a stranded browser is easy to find and kill. */
const PORT = 9333;

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chrome) {
  console.error("Chrome was not found at any of:\n  " + CHROME_CANDIDATES.join("\n  "));
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const child = spawn(
  chrome,
  [
    "--headless=new",
    /*
     * ⚠ SOFTWARE WEBGL, NOT NO WEBGL. `--disable-gpu` alone leaves a headless Chrome with no WebGL
     * implementation at all, and a page carrying a maplibre canvas — `/craft-explorer`, the archive's
     * centrepiece — then never finishes initialising, so the capture hangs until the timeout rather
     * than failing. SwiftShader is a software rasteriser: slower, and it actually completes.
     *
     * `--enable-unsafe-swiftshader` is required because Chrome refuses the software path by default
     * on a headless run; "unsafe" here means "not hardware accelerated", not a security relaxation.
     */
    "--disable-gpu",
    "--use-gl=swiftshader",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    // A throwaway profile. Without it Chrome may attach to an already-running instance and the
    // debugging port never opens — which presents as a hang rather than as an error.
    `--user-data-dir=${path.join(process.env.TEMP ?? ".", `cxa-shoot-${Date.now()}`)}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${width},${height}`,
    "about:blank"
  ],
  { stdio: "ignore" }
);

let socket = null;
let nextId = 1;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function main() {
  // Wait for the debugging port. Chrome writes the endpoint only once it is ready to accept.
  let target = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      target = targets.find((entry) => entry.type === "page");
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome's debugging port never opened.");

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  // The viewport a reader actually has. `mobile: false` and dsf 1 keep `vh` honest.
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });

  /*
   * ONE call, because `setEmulatedMedia` REPLACES the whole emulation state rather than merging into it
   * — a second call with only `features` would silently drop `media: "print"`, and a print capture in
   * the dark theme would come back in screen media looking perfectly fine.
   */
  const features = [];
  if (darkTheme) features.push({ name: "prefers-color-scheme", value: "dark" });
  if (reducedMotion) features.push({ name: "prefers-reduced-motion", value: "reduce" });
  if (printMedia || features.length > 0) {
    await send("Emulation.setEmulatedMedia", {
      ...(printMedia ? { media: "print" } : {}),
      ...(features.length > 0 ? { features } : {})
    });
  }

  await send("Page.navigate", { url });

  // Wait for the load event rather than a fixed sleep.
  await new Promise((resolve) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Page.loadEventFired") {
        socket.removeEventListener("message", onMessage);
        resolve();
      }
    };
    socket.addEventListener("message", onMessage);
    setTimeout(resolve, 20000);
  });

  /*
   * SCROLL THE WHOLE PAGE, THEN COME BACK.
   *
   * This is the step that makes the screenshot true. Every `Reveal` is an IntersectionObserver, and
   * an observer only fires for an element that has actually been in the viewport. Walking down in
   * viewport-sized steps reveals each section in turn, exactly as a reader does; returning to the top
   * afterwards means the capture starts where the page starts.
   *
   * The pauses are not decoration: an observer callback runs on the next frame, and a lazily-decoded
   * photograph needs longer than that.
   */
  await send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `
      (async () => {
        const step = window.innerHeight * 0.8;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await wait(220);
        }
        window.scrollTo(0, document.body.scrollHeight);
        await wait(500);
        window.scrollTo(0, 0);
        await wait(700);
        // Every image that has not finished decoding, given one last chance together.
        await Promise.all(
          Array.from(document.images)
            .filter((img) => !img.complete)
            /*
             * EACH IMAGE IS RACED AGAINST A TIMEOUT, AND THAT IS NOT BELT-AND-BRACES.
             *
             * An image element whose request never settles fires neither "load" nor "error", so a
             * bare promise on those two events waits for ever. That is exactly what /craft-explorer
             * does: maplibre requests map tiles from a provider that may be unreachable, and the
             * capture hung until the outer timeout killed it -- which read as "headless cannot render
             * the map" and cost an afternoon of chasing the wrong thing (swiftshader, GPU flags)
             * before the real cause was found here, in the screenshot tool itself.
             *
             * 3s is generous for an image the page has already begun fetching, and a picture that has
             * not arrived by then is one this capture is better off without.
             *
             * NO BACKTICKS ANYWHERE IN THIS COMMENT. It sits inside the template literal handed to
             * Runtime.evaluate, so one would terminate the literal and break the file.
             */
            .map((img) => Promise.race([
              new Promise((r) => { img.onload = r; img.onerror = r; }),
              wait(3000)
            ]))
        );
        await wait(400);
        return document.body.scrollHeight;
      })()
    `
  });

  if (selector) {
    /*
     * Bring the requested element to the top of the viewport and settle.
     *
     * `scrollIntoView` rather than a computed offset, so the element's own `scroll-margin-top` — which
     * globals.css sets to `--nav-clearance` on every anchor target — is honoured and the section does
     * not land underneath the floating header.
     */
    await send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `
        (async () => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return "MISSING";
          node.scrollIntoView({ block: "start", behavior: "instant" });
          await new Promise((r) => setTimeout(r, 900));
          return "OK";
        })()
      `
    });
  }

  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    // Stitching the whole document is only asked for when no selector was given — see the header:
    // on a page this tall it is slow and occasionally does not return.
    ...(selector ? {} : { captureBeyondViewport: true })
  });

  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, Buffer.from(data, "base64"));
  console.log(`wrote ${out}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    socket?.close();
  } catch {
    // Already gone.
  }
  child.kill();
}
