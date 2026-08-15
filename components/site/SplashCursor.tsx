"use client";

/**
 * SplashCursor — the fluid "splash" trail that follows the pointer across the LIGHT parts of the
 * public site.
 *
 * It is the well-known WebGL fluid simulation — velocity and dye double-buffers, semi-Lagrangian
 * advection, curl/vorticity confinement, a Jacobi pressure solve and Gaussian splats — adapted from
 * Pavel Dobryakov's "WebGL Fluid Simulation" (Copyright 2017 Pavel Dobryakov, MIT licence,
 * https://github.com/PavelDoGreat/WebGL-Fluid-Simulation), which this file reproduces in substantial
 * part. It runs on a RAW WebGL context on purpose: the sim is a dozen tiny shaders ping-ponging
 * between framebuffers, which is exactly the level a wrapper library abstracts away, and pulling one
 * in would buy nothing but bundle weight.
 *
 * THIS MODULE IS LOADED BY SplashCursorMount, AFTER FIRST IDLE, AND NOWHERE ELSE — none of this is
 * in any page's first-paint bundle. The mount also declines to request the chunk at all on a device
 * with no fine pointer; the LIVE answer to that question still lives here (see `SplashCursor`
 * below), because a mouse can be plugged in or unplugged mid-visit and the mount has already made
 * its one-shot download decision by then.
 *
 * FOUR GATES, AND EVERY ONE IS A REFUSAL TO SPEND WHAT NOBODY ASKED FOR:
 *
 *   1. FINE POINTERS ONLY, live via `matchMedia("(pointer: fine)")`. A splash that trails a finger
 *      is a splash under the reader's own hand — invisible where it matters and paint everywhere
 *      the thumb scrolled. Losing the last fine pointer unmounts the canvas and tears the context
 *      down; gaining one brings it back.
 *   2. REDUCED MOTION renders NOTHING — not slower fluid, nothing. `useReducedMotionPreference()`
 *      is the JS half of the union (contract §8) and it is live, so flipping the in-app toggle
 *      tears the sim down without a reload. There is no static equivalent to pair with it because
 *      the trail carries no meaning — it is ornament, and absent ornament is a finished design.
 *   3. THE LOOP PAUSES when the tab is hidden AND when a full-screen takeover covers the page —
 *      the same two blindnesses ParticleField documents: `visibilitychange` cannot see an opaque
 *      overlay, so lib/takeover's signal is a third, independent reason to stop.
 *   4. THE LOOP ALSO STOPS ITSELF once the pointer has been still long enough for the dye to have
 *      fully dissipated. Without this, one pass of the mouse buys a 60fps canvas loop for the rest
 *      of the visit; with it, a still page costs zero frames. Any pointer move wakes it.
 *
 * ⚠ SPLATS ARE SKIPPED OVER THE PURPLE BANDS. The dark hero/story/footer carry `data-splash-off`
 * (added by those components, honoured here — one attribute, one meaning). The canvas is
 * `pointer-events-none`, so a pointermove's target is the PAGE ELEMENT under the cursor, and one
 * `closest()` call answers "is this a purple band?". The pointer is still TRACKED while over a band
 * — only the splat is withheld — so leaving the band does not smear one long streak from wherever
 * the pointer entered it.
 *
 * CONTEXT LIFECYCLE. `webglcontextlost` is expected on laptops (GPU switch, driver reset): the
 * default is prevented so the browser may restore, the loop stops, and `webglcontextrestored`
 * rebuilds every resource from scratch. On unmount every texture, framebuffer, program and buffer
 * is deleted and the context is explicitly released — browsers hard-cap live WebGL contexts, and a
 * leaked one survives client-side navigation until every later canvas on the site silently fails
 * (the same argument in ParticleField's header).
 *
 * The splat palette is the site's, not the sim's neon default: low-saturation violets around the
 * brand purple, with the occasional muted gold — and gold stays the minority for the same reason
 * the gold budget exists (contract §1.1). Resolutions are deliberately modest (96 sim / 720 dye)
 * so an integrated laptop GPU never notices it.
 *
 * z-40 is the SCRIM RUNG of the ladder (§6): the trail washes over page content but stays under
 * the z-50 header, the z-60 skip link and everything portalled above them.
 */

import { useEffect, useRef, useState } from "react";

import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { pageIsCovered, TAKEOVER_EVENT } from "@/lib/takeover";

/**
 * The tuning, in one place. SIM/DYE resolutions are the two the brief for this ornament fixed for
 * laptop GPUs; the rest are the reference implementation's shipping values except where noted.
 */
const SIM_RESOLUTION = 96;
const DYE_RESOLUTION = 720;
/** How fast the colour fades. Higher than the reference's default — the trail is a wash, not paint. */
const DENSITY_DISSIPATION = 4.6;
const VELOCITY_DISSIPATION = 2;
const PRESSURE = 0.1;
const PRESSURE_ITERATIONS = 20;
/** Vorticity confinement. Low: enough curl to look alive, not enough to look like smoke. */
const CURL = 3;
/** In percent of the shorter canvas edge; divided by 100 where it reaches the shader. */
const SPLAT_RADIUS = 0.12;
const SPLAT_FORCE = 4200;
/** How quickly the splat colour drifts through the palette, in cycles of the 0..1 timer per second. */
/*
 * ⚠ 1.2, DOWN FROM THE REFERENCE'S 10 — this constant was the flicker. At 10 the pointer took a
 * NEW hue every ~100ms, and with generateSplatColor jumping RANDOMLY around the wheel the trail
 * strobed through unrelated colours several times a second (the owner's "screen colour flicker").
 * At 1.2 the colour turns over about once a second, and the generator below now DRIFTS the hue a
 * step at a time instead of jumping, so successive splats are neighbours on the wheel — the trail
 * reads as one iridescent ribbon slowly cycling, never a strobe.
 */
const COLOR_UPDATE_SPEED = 1.2;
/**
 * Device-pixel-ratio cap, same value and same reason as ParticleField: a 2× screen would render
 * four times the pixels for dye that is deliberately soft and gains nothing from them.
 */
const MAX_DPR = 1.5;
/** A frame longer than this is a tab that was asleep, not a slow machine — do not integrate it. */
const MAX_STEP_SECONDS = 1 / 60;
/**
 * How long after the last splat the loop keeps running before stopping itself. At a dissipation of
 * 3.2 the dye is at e^-16 of its splat value after five seconds — invisible for two of them — so
 * stopping here is not a visible cut, and the last presented frame simply stays on screen.
 */
const IDLE_STOP_MS = 5000;

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The component pair: `SplashCursor` answers "may this run at all?", `SplashCanvas` runs it.
 * Splitting them keeps the teardown honest — when a gate closes, the canvas UNMOUNTS and the
 * effect's cleanup releases the GL context, rather than a paused sim squatting on GPU memory.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

export function SplashCursor() {
  const reduce = useReducedMotionPreference();

  // False on the server and the first client render — the ornament appearing a beat after
  // hydration is invisible; a hydration mismatch is not.
  const [finePointer, setFinePointer] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(pointer: fine)");
    const sync = () => setFinePointer(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  if (reduce || !finePointer) return null;
  return <SplashCanvas />;
}

function SplashCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Null means "this machine cannot host it" (no WebGL, no renderable half-float target, a
    // driver that refused a shader). The ornament is simply absent; nothing falls back to CPU.
    let sim = createFluidSim(canvas);

    // Hidden tab and covered page are two independent reasons to stop; either alone must not
    // restart the loop while the other still objects, so both are re-read on every signal.
    const syncRunning = () => sim?.setRunning(!document.hidden && !pageIsCovered());
    syncRunning();

    const onPointerMove = (event: PointerEvent) => {
      // The canvas never captures the pointer, so `target` is the real page element under the
      // cursor — which is what lets one `closest()` honour the purple bands' `data-splash-off`.
      // Optional-chained because a target can be a Document, which has no `closest`.
      const overPurpleBand = (event.target as Element | null)?.closest?.("[data-splash-off]") != null;
      sim?.handleMove(event.clientX, event.clientY, !overPurpleBand);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("visibilitychange", syncRunning);
    window.addEventListener(TAKEOVER_EVENT, syncRunning);

    const onContextLost = (event: Event) => {
      // Without preventDefault the browser considers the loss permanent and never restores.
      event.preventDefault();
      // `false`: the resources died with the context, and explicitly releasing a context the
      // browser intends to restore would cancel that restoration.
      sim?.destroy(false);
      sim = null;
    };
    const onContextRestored = () => {
      // getContext() on the same canvas returns the SAME, now-restored context; every texture,
      // framebuffer and program must still be rebuilt from nothing.
      sim = createFluidSim(canvas);
      syncRunning();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    return () => {
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      window.removeEventListener(TAKEOVER_EVENT, syncRunning);
      document.removeEventListener("visibilitychange", syncRunning);
      window.removeEventListener("pointermove", onPointerMove);
      sim?.destroy(true);
      sim = null;
    };
  }, []);

  return (
    // Pure ornament: out of the accessibility tree, transparent to every click. z-40 per the header.
    <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none fixed inset-0 z-40" />
  );
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The simulation. Everything below is framework-free: a factory that owns one WebGL context and
 * returns the three verbs the component needs.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

interface FluidSim {
  /** Track the pointer; splat only when `allowSplat` (false over the purple bands). */
  handleMove(clientX: number, clientY: number, allowSplat: boolean): void;
  /** The visibility/takeover gate. False cancels the frame loop; true lets a move restart it. */
  setRunning(running: boolean): void;
  /** Idempotent. `releaseContext` deletes every GL resource and gives the context back. */
  destroy(releaseContext: boolean): void;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface TexFormat {
  internalFormat: number;
  format: number;
}

interface FBO {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  /** Bind to texture unit `id` and return `id`, so a call can sit inline in a uniform1i. */
  attach(id: number): number;
}

/** Read/write pair for the ping-pong passes; `swap` after each write. */
interface DoubleFBO {
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  read: FBO;
  write: FBO;
  swap(): void;
}

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
}

/**
 * "This GPU cannot run the sim" — thrown by `must` and the shader helpers, caught once in
 * `createFluidSim`, and turned into a null return. Anything else escaping is a real bug and is
 * deliberately NOT swallowed.
 */
class SimUnsupportedError extends Error {}

function must<T>(resource: T | null): T {
  if (resource === null) throw new SimUnsupportedError("a WebGL allocation returned null");
  return resource;
}

function createFluidSim(canvas: HTMLCanvasElement): FluidSim | null {
  const context = getWebGLContext(canvas);
  if (!context) return null;
  const { gl, halfFloatTexType, supportLinearFiltering, formatRGBA, formatRG, formatR } = context;
  // No renderable half-float format at all — nothing to simulate into. Rebound to fresh consts
  // because the null-guard's narrowing does not survive into the hoisted closures below.
  if (!formatRGBA || !formatRG || !formatR) return null;
  const dyeFormat: TexFormat = formatRGBA;
  const velocityFormat: TexFormat = formatRG;
  const scalarFormat: TexFormat = formatR;

  try {
    /* ── Programs ─────────────────────────────────────────────────────────────────────────── */

    // Tracked flat so destroy() can walk them; the FBOs are tracked by name below because they
    // are replaced on resize and a stale list would double-free.
    const programs: WebGLProgram[] = [];
    const shaders: WebGLShader[] = [];
    const buffers: WebGLBuffer[] = [];

    function compile(type: number, source: string, keywords: string[] = []): WebGLShader {
      const prefixed = keywords.map((keyword) => `#define ${keyword}\n`).join("") + source;
      const shader = must(gl.createShader(type));
      shaders.push(shader);
      gl.shaderSource(shader, prefixed);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new SimUnsupportedError(gl.getShaderInfoLog(shader) ?? "shader failed to compile");
      }
      return shader;
    }

    function link(fragmentSource: string, keywords: string[] = []): ProgramInfo {
      const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource, keywords);
      const program = must(gl.createProgram());
      programs.push(program);
      gl.attachShader(program, baseVertex);
      gl.attachShader(program, fragment);
      // Pinned rather than queried: the blit quad configures attribute 0 once for the whole
      // context, so every program must agree where aPosition lives.
      gl.bindAttribLocation(program, 0, "aPosition");
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new SimUnsupportedError(gl.getProgramInfoLog(program) ?? "program failed to link");
      }
      const uniforms = new Map<string, WebGLUniformLocation>();
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
      for (let index = 0; index < count; index += 1) {
        const info = gl.getActiveUniform(program, index);
        if (!info) continue;
        const location = gl.getUniformLocation(program, info.name);
        if (location) uniforms.set(info.name, location);
      }
      return { program, uniforms };
    }

    const bind = (info: ProgramInfo) => gl.useProgram(info.program);
    // `?? null` because a Map miss is `undefined` and the gl.uniform* setters accept only
    // `WebGLUniformLocation | null` — a null location is a spec-defined silent no-op.
    const u = (info: ProgramInfo, name: string) => info.uniforms.get(name) ?? null;

    const baseVertex = compile(gl.VERTEX_SHADER, BASE_VERTEX_SHADER);
    const copyProgram = link(COPY_SHADER);
    const clearProgram = link(CLEAR_SHADER);
    const splatProgram = link(SPLAT_SHADER);
    // Without linear filtering on half-float textures (old mobile GPUs) the advection shader
    // bilinearly interpolates by hand — the reference implementation's MANUAL_FILTERING path.
    const advectionProgram = link(ADVECTION_SHADER, supportLinearFiltering ? [] : ["MANUAL_FILTERING"]);
    const divergenceProgram = link(DIVERGENCE_SHADER);
    const curlProgram = link(CURL_SHADER);
    const vorticityProgram = link(VORTICITY_SHADER);
    const pressureProgram = link(PRESSURE_SHADER);
    const gradientSubtractProgram = link(GRADIENT_SUBTRACT_SHADER);
    /*
     * ⚠ NO SHADING KEYWORD, AND THIS WAS THE FLICKER — the third face of it, after dissipation
     * and hue strobing. The shaded display pass samples the dye texture's NEIGHBOURS to fake a
     * lit surface, and this port fed it texel offsets computed from the CANVAS (≈1440px) while
     * the dye is 720 — every neighbour sample landed half a dye-texel off, and on real hardware
     * with linear filtering that is a high-frequency sparkle crawling over the whole trail as it
     * advects. (Headless SwiftShader rendered no dye at all, which is why two tuning passes
     * chased the wrong constants.) At a 12%-intensity glaze the fake lighting added nothing —
     * so the class of bug is removed, not re-tuned: flat dye, no neighbour sampling.
     */
    const displayProgram = link(DISPLAY_SHADER);

    /* ── The one quad every pass draws ────────────────────────────────────────────────────── */

    const vertexBuffer = must(gl.createBuffer());
    buffers.push(vertexBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    const indexBuffer = must(gl.createBuffer());
    buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    function blit(target: FBO | null): void {
      if (target === null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

    /* ── Framebuffers ─────────────────────────────────────────────────────────────────────── */

    function createFBO(
      width: number,
      height: number,
      internalFormat: number,
      format: number,
      type: number,
      filterParam: number
    ): FBO {
      gl.activeTexture(gl.TEXTURE0);
      const texture = must(gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterParam);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterParam);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);

      const fbo = must(gl.createFramebuffer());
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      return {
        texture,
        fbo,
        width,
        height,
        texelSizeX: 1 / width,
        texelSizeY: 1 / height,
        attach(id: number): number {
          gl.activeTexture(gl.TEXTURE0 + id);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          return id;
        }
      };
    }

    function disposeFBO(target: FBO): void {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.fbo);
    }

    function createDoubleFBO(
      width: number,
      height: number,
      internalFormat: number,
      format: number,
      type: number,
      filterParam: number
    ): DoubleFBO {
      const double: DoubleFBO = {
        width,
        height,
        texelSizeX: 1 / width,
        texelSizeY: 1 / height,
        read: createFBO(width, height, internalFormat, format, type, filterParam),
        write: createFBO(width, height, internalFormat, format, type, filterParam),
        swap() {
          const held = double.read;
          double.read = double.write;
          double.write = held;
        }
      };
      return double;
    }

    function disposeDoubleFBO(target: DoubleFBO): void {
      disposeFBO(target.read);
      disposeFBO(target.write);
    }

    /**
     * Grow/shrink a buffer to the new size, KEEPING its contents by copying the old texture
     * through the copy shader. ⚠ The old FBO is deleted here — the reference implementation
     * leaks it, and GL memory does not come back with garbage collection.
     */
    function resizeFBO(
      target: FBO,
      width: number,
      height: number,
      internalFormat: number,
      format: number,
      type: number,
      filterParam: number
    ): FBO {
      const next = createFBO(width, height, internalFormat, format, type, filterParam);
      bind(copyProgram);
      gl.uniform1i(u(copyProgram, "uTexture"), target.attach(0));
      blit(next);
      disposeFBO(target);
      return next;
    }

    function resizeDoubleFBO(
      target: DoubleFBO,
      width: number,
      height: number,
      internalFormat: number,
      format: number,
      type: number,
      filterParam: number
    ): DoubleFBO {
      if (target.width === width && target.height === height) return target;
      // Only `read` carries state worth copying; `write` is scratch and is simply replaced.
      target.read = resizeFBO(target.read, width, height, internalFormat, format, type, filterParam);
      disposeFBO(target.write);
      target.write = createFBO(width, height, internalFormat, format, type, filterParam);
      target.width = width;
      target.height = height;
      target.texelSizeX = 1 / width;
      target.texelSizeY = 1 / height;
      return target;
    }

    // Definite-assignment: all five are created by the initFramebuffers() call a few lines down,
    // before any frame or splat can read them. The `dye ? … : …` inside it relies on the variable
    // being `undefined` at runtime on that very first pass.
    let dye!: DoubleFBO;
    let velocity!: DoubleFBO;
    let divergence!: FBO;
    let curl!: FBO;
    let pressure!: DoubleFBO;

    function getResolution(resolution: number): { width: number; height: number } {
      let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
      if (aspectRatio < 1) aspectRatio = 1 / aspectRatio;
      const min = Math.round(resolution);
      const max = Math.round(resolution * aspectRatio);
      return gl.drawingBufferWidth > gl.drawingBufferHeight
        ? { width: max, height: min }
        : { width: min, height: max };
    }

    function initFramebuffers(): void {
      const simRes = getResolution(SIM_RESOLUTION);
      const dyeRes = getResolution(DYE_RESOLUTION);
      const filtering = supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
      gl.disable(gl.BLEND);

      // Dye and velocity SURVIVE a resize (their contents are the picture); the three solver
      // targets are recomputed every frame from velocity, so they are simply rebuilt.
      dye = dye
        ? resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, dyeFormat.internalFormat, dyeFormat.format, halfFloatTexType, filtering)
        : createDoubleFBO(dyeRes.width, dyeRes.height, dyeFormat.internalFormat, dyeFormat.format, halfFloatTexType, filtering);
      velocity = velocity
        ? resizeDoubleFBO(velocity, simRes.width, simRes.height, velocityFormat.internalFormat, velocityFormat.format, halfFloatTexType, filtering)
        : createDoubleFBO(simRes.width, simRes.height, velocityFormat.internalFormat, velocityFormat.format, halfFloatTexType, filtering);

      if (divergence) disposeFBO(divergence);
      divergence = createFBO(simRes.width, simRes.height, scalarFormat.internalFormat, scalarFormat.format, halfFloatTexType, gl.NEAREST);
      if (curl) disposeFBO(curl);
      curl = createFBO(simRes.width, simRes.height, scalarFormat.internalFormat, scalarFormat.format, halfFloatTexType, gl.NEAREST);
      if (pressure) disposeDoubleFBO(pressure);
      pressure = createDoubleFBO(simRes.width, simRes.height, scalarFormat.internalFormat, scalarFormat.format, halfFloatTexType, gl.NEAREST);
    }

    /* ── Pointer and loop state ───────────────────────────────────────────────────────────── */

    const pointer = {
      texcoordX: 0,
      texcoordY: 0,
      prevTexcoordX: 0,
      prevTexcoordY: 0,
      deltaX: 0,
      deltaY: 0,
      moved: false,
      color: generateSplatColor()
    };
    // Until the first real move arrives, texcoords hold a made-up (0,0) — priming on that first
    // move (current AND previous set to it) is what prevents an opening streak from the corner.
    let primed = false;

    let rafId: number | null = null;
    let running = true;
    let destroyed = false;
    let released = false;
    let lastUpdateTime = performance.now();
    // -Infinity, not 0: performance.now() is near zero this early in the page's life, so a zero
    // seed would sit INSIDE the idle window and buy five seconds of empty frames before any move.
    let lastInteraction = Number.NEGATIVE_INFINITY;
    let colorUpdateTimer = 0;

    function scaleByPixelRatio(input: number): number {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      return Math.floor(input * pixelRatio);
    }

    function resizeCanvas(): boolean {
      const width = Math.max(1, scaleByPixelRatio(canvas.clientWidth));
      const height = Math.max(1, scaleByPixelRatio(canvas.clientHeight));
      if (canvas.width === width && canvas.height === height) return false;
      canvas.width = width;
      canvas.height = height;
      return true;
    }

    function calcDeltaTime(): number {
      const now = performance.now();
      const dt = Math.min((now - lastUpdateTime) / 1000, MAX_STEP_SECONDS);
      lastUpdateTime = now;
      return dt;
    }

    function updateColors(dt: number): void {
      colorUpdateTimer += dt * COLOR_UPDATE_SPEED;
      if (colorUpdateTimer < 1) return;
      colorUpdateTimer %= 1;
      pointer.color = generateSplatColor();
    }

    function applyInputs(): void {
      if (!pointer.moved) return;
      pointer.moved = false;
      const dx = pointer.deltaX * SPLAT_FORCE;
      const dy = pointer.deltaY * SPLAT_FORCE;
      splat(pointer.texcoordX, pointer.texcoordY, dx, dy, pointer.color);
    }

    // The delta corrections keep a diagonal gesture feeling the same on any aspect ratio; the
    // radius correction keeps a splat circular rather than an ellipse stretched to the canvas.
    function correctDeltaX(delta: number): number {
      const aspectRatio = canvas.width / canvas.height;
      return aspectRatio < 1 ? delta * aspectRatio : delta;
    }

    function correctDeltaY(delta: number): number {
      const aspectRatio = canvas.width / canvas.height;
      return aspectRatio > 1 ? delta / aspectRatio : delta;
    }

    function correctRadius(radius: number): number {
      const aspectRatio = canvas.width / canvas.height;
      return aspectRatio > 1 ? radius * aspectRatio : radius;
    }

    function splat(x: number, y: number, dx: number, dy: number, color: RGB): void {
      // Blend may still be on from the last display pass; a splat is an overwrite, not a mix.
      gl.disable(gl.BLEND);
      bind(splatProgram);
      gl.uniform1i(u(splatProgram, "uTarget"), velocity.read.attach(0));
      gl.uniform1f(u(splatProgram, "aspectRatio"), canvas.width / canvas.height);
      gl.uniform2f(u(splatProgram, "point"), x, y);
      gl.uniform3f(u(splatProgram, "color"), dx, dy, 0);
      gl.uniform1f(u(splatProgram, "radius"), correctRadius(SPLAT_RADIUS / 100));
      blit(velocity.write);
      velocity.swap();

      gl.uniform1i(u(splatProgram, "uTarget"), dye.read.attach(0));
      gl.uniform3f(u(splatProgram, "color"), color.r, color.g, color.b);
      blit(dye.write);
      dye.swap();
    }

    /* ── One simulation step: the classic Stam pipeline ───────────────────────────────────── */

    function step(dt: number): void {
      gl.disable(gl.BLEND);

      bind(curlProgram);
      gl.uniform2f(u(curlProgram, "texelSize"), velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(u(curlProgram, "uVelocity"), velocity.read.attach(0));
      blit(curl);

      bind(vorticityProgram);
      gl.uniform2f(u(vorticityProgram, "texelSize"), velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(u(vorticityProgram, "uVelocity"), velocity.read.attach(0));
      gl.uniform1i(u(vorticityProgram, "uCurl"), curl.attach(1));
      gl.uniform1f(u(vorticityProgram, "curl"), CURL);
      gl.uniform1f(u(vorticityProgram, "dt"), dt);
      blit(velocity.write);
      velocity.swap();

      bind(divergenceProgram);
      gl.uniform2f(u(divergenceProgram, "texelSize"), velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(u(divergenceProgram, "uVelocity"), velocity.read.attach(0));
      blit(divergence);

      // The pressure field is damped toward zero rather than cleared: PRESSURE is how much of the
      // previous solve seeds the next one, which is what lets 20 Jacobi iterations look like 60.
      bind(clearProgram);
      gl.uniform1i(u(clearProgram, "uTexture"), pressure.read.attach(0));
      gl.uniform1f(u(clearProgram, "value"), PRESSURE);
      blit(pressure.write);
      pressure.swap();

      bind(pressureProgram);
      gl.uniform2f(u(pressureProgram, "texelSize"), velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(u(pressureProgram, "uDivergence"), divergence.attach(0));
      for (let iteration = 0; iteration < PRESSURE_ITERATIONS; iteration += 1) {
        gl.uniform1i(u(pressureProgram, "uPressure"), pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
      }

      bind(gradientSubtractProgram);
      gl.uniform2f(u(gradientSubtractProgram, "texelSize"), velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(u(gradientSubtractProgram, "uPressure"), pressure.read.attach(0));
      gl.uniform1i(u(gradientSubtractProgram, "uVelocity"), velocity.read.attach(1));
      blit(velocity.write);
      velocity.swap();

      bind(advectionProgram);
      gl.uniform2f(u(advectionProgram, "texelSize"), velocity.texelSizeX, velocity.texelSizeY);
      if (!supportLinearFiltering) {
        gl.uniform2f(u(advectionProgram, "dyeTexelSize"), velocity.texelSizeX, velocity.texelSizeY);
      }
      const velocityId = velocity.read.attach(0);
      gl.uniform1i(u(advectionProgram, "uVelocity"), velocityId);
      gl.uniform1i(u(advectionProgram, "uSource"), velocityId);
      gl.uniform1f(u(advectionProgram, "dt"), dt);
      gl.uniform1f(u(advectionProgram, "dissipation"), VELOCITY_DISSIPATION);
      blit(velocity.write);
      velocity.swap();

      if (!supportLinearFiltering) {
        gl.uniform2f(u(advectionProgram, "dyeTexelSize"), dye.texelSizeX, dye.texelSizeY);
      }
      gl.uniform1i(u(advectionProgram, "uVelocity"), velocity.read.attach(0));
      gl.uniform1i(u(advectionProgram, "uSource"), dye.read.attach(1));
      gl.uniform1f(u(advectionProgram, "dissipation"), DENSITY_DISSIPATION);
      blit(dye.write);
      dye.swap();
    }

    function render(): void {
      // Premultiplied-style blend over the page: where there is no dye there is no alpha, and the
      // drawing buffer (preserveDrawingBuffer: false) arrives cleared to transparent every frame.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.BLEND);
      bind(displayProgram);
      gl.uniform1i(u(displayProgram, "uTexture"), dye.read.attach(0));
      blit(null);
    }

    function frame(): void {
      rafId = null;
      if (destroyed || !running) return;
      // Gate 4 in the header: the dye has long since dissipated, so stop scheduling frames. The
      // next handleMove() wakes the loop; the last presented frame stays on the canvas, invisible.
      if (performance.now() - lastInteraction > IDLE_STOP_MS) return;
      try {
        const dt = calcDeltaTime();
        if (resizeCanvas()) initFramebuffers();
        updateColors(dt);
        applyInputs();
        step(dt);
        render();
      } catch (thrown) {
        // An ornament must never take the page with it. Whatever the driver did, fall silent —
        // context loss, the recoverable case, is handled by the component's event pair instead.
        destroyed = true;
        console.warn("[splash-cursor] the fluid simulation stopped after a WebGL error", thrown);
        return;
      }
      rafId = requestAnimationFrame(frame);
    }

    function wake(): void {
      if (destroyed || !running || rafId !== null) return;
      // Reset the clock so the first frame after a pause integrates a normal step, not the gap.
      lastUpdateTime = performance.now();
      rafId = requestAnimationFrame(frame);
    }

    // Size the drawing buffer and allocate every field once, before the first frame can need them.
    resizeCanvas();
    initFramebuffers();

    return {
      handleMove(clientX: number, clientY: number, allowSplat: boolean): void {
        if (destroyed) return;
        const width = canvas.clientWidth || 1;
        const height = canvas.clientHeight || 1;
        const texcoordX = clientX / width;
        const texcoordY = 1 - clientY / height;
        if (!primed) {
          primed = true;
          pointer.texcoordX = texcoordX;
          pointer.texcoordY = texcoordY;
        }
        pointer.prevTexcoordX = pointer.texcoordX;
        pointer.prevTexcoordY = pointer.texcoordY;
        pointer.texcoordX = texcoordX;
        pointer.texcoordY = texcoordY;
        pointer.deltaX = correctDeltaX(texcoordX - pointer.prevTexcoordX);
        pointer.deltaY = correctDeltaY(texcoordY - pointer.prevTexcoordY);
        // Over a purple band the pointer is tracked but never splats — returning HERE, after the
        // coordinates are written, is what keeps the band's far edge streak-free.
        if (!allowSplat) return;
        if (pointer.deltaX === 0 && pointer.deltaY === 0) return;
        pointer.moved = true;
        lastInteraction = performance.now();
        wake();
      },

      setRunning(next: boolean): void {
        running = next;
        if (!next) {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          return;
        }
        // Harmless if the idle window has passed: the woken frame notices and stops itself.
        wake();
      },

      destroy(releaseContext: boolean): void {
        destroyed = true;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (!releaseContext || released) return;
        released = true;
        for (const program of programs) gl.deleteProgram(program);
        for (const shader of shaders) gl.deleteShader(shader);
        for (const buffer of buffers) gl.deleteBuffer(buffer);
        disposeDoubleFBO(dye);
        disposeDoubleFBO(velocity);
        disposeFBO(divergence);
        disposeFBO(curl);
        disposeDoubleFBO(pressure);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    };
  } catch (thrown) {
    if (thrown instanceof SimUnsupportedError) {
      // One honest line for a developer; a reader just gets a site without the ornament.
      console.warn("[splash-cursor] this GPU cannot host the fluid simulation; the trail is off", thrown);
      return null;
    }
    throw thrown;
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Context and format negotiation.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

interface GLContext {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  halfFloatTexType: number;
  supportLinearFiltering: boolean;
  formatRGBA: TexFormat | null;
  formatRG: TexFormat | null;
  formatR: TexFormat | null;
}

function getWebGLContext(canvas: HTMLCanvasElement): GLContext | null {
  // `preserveDrawingBuffer: false` is load-bearing: the buffer self-clears each frame, which is
  // what lets render() skip a clear and still leave transparent pixels wherever there is no dye.
  const attributes: WebGLContextAttributes = {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: false
  };

  const gl2 = canvas.getContext("webgl2", attributes);
  if (gl2) {
    // Renderability of half-float targets is PROBED below, not assumed from the extension.
    gl2.getExtension("EXT_color_buffer_float");
    const supportLinearFiltering = gl2.getExtension("OES_texture_float_linear") != null;
    const type = gl2.HALF_FLOAT;
    return {
      gl: gl2,
      halfFloatTexType: type,
      supportLinearFiltering,
      formatRGBA: getSupportedFormat(gl2, gl2.RGBA16F, gl2.RGBA, type),
      formatRG: getSupportedFormat(gl2, gl2.RG16F, gl2.RG, type),
      formatR: getSupportedFormat(gl2, gl2.R16F, gl2.RED, type)
    };
  }

  const gl1 = canvas.getContext("webgl", attributes);
  if (!gl1) return null;
  const halfFloat = gl1.getExtension("OES_texture_half_float");
  if (!halfFloat) return null;
  const supportLinearFiltering = gl1.getExtension("OES_texture_half_float_linear") != null;
  const type = halfFloat.HALF_FLOAT_OES;
  // WebGL1 has no sized single/dual-channel float formats; everything runs in RGBA.
  const rgba = getSupportedFormat(gl1, gl1.RGBA, gl1.RGBA, type);
  return {
    gl: gl1,
    halfFloatTexType: type,
    supportLinearFiltering,
    formatRGBA: rgba,
    formatRG: rgba,
    formatR: rgba
  };
}

/**
 * The reference implementation's fallback ladder: a GPU that cannot RENDER to R16F may manage
 * RG16F, and one that cannot manage that may still take RGBA16F. Null means not even that.
 */
function getSupportedFormat(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  internalFormat: number,
  format: number,
  type: number
): TexFormat | null {
  if (supportRenderTextureFormat(gl, internalFormat, format, type)) return { internalFormat, format };
  if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) {
    switch (internalFormat) {
      case gl.R16F:
        return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
      case gl.RG16F:
        return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
    }
  }
  return null;
}

/** Try it for real: allocate a 4×4 target and ask the driver whether it is framebuffer-complete. */
function supportRenderTextureFormat(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  internalFormat: number,
  format: number,
  type: number
): boolean {
  const texture = gl.createTexture();
  if (!texture) return false;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

  const fbo = gl.createFramebuffer();
  if (!fbo) {
    gl.deleteTexture(texture);
    return false;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(texture);
  return status === gl.FRAMEBUFFER_COMPLETE;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Colour.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * A splat in the site's voice instead of the sim's neon defaults: three violets in four, drawn
 * from the hue band around the brand purple, and one muted gold — the minority, exactly as the
 * gold budget keeps it everywhere else (contract §1.1). Saturation sits well under the reference
 * implementation's 1.0, and the final ×0.15 is its own dimming, which the premultiplied display
 * blend turns into a soft glaze over the page rather than a paint spill.
 */
let huePhase = 0.74; // Starts on the brand violet; drifts the full wheel over ~40s of movement.

function generateSplatColor(): RGB {
  // A STEP, not a jump: 0.03 of the wheel per colour change keeps successive splats neighbours,
  // which is what makes many hues read as iridescence instead of flicker (see COLOR_UPDATE_SPEED).
  huePhase = (huePhase + 0.03) % 1;
  const { r, g, b } = hsvToRgb(huePhase, 1, 1);
  return { r: r * 0.12, g: g * 0.12, b: b * 0.12 };
}

function hsvToRgb(h: number, s: number, v: number): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    default:
      r = v;
      g = p;
      b = q;
      break;
  }
  return { r, g, b };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Shaders — GLSL ES 1.00, verbatim from the reference implementation except where commented.
 * Every fragment program shares the one vertex shader, which precomputes the four neighbour
 * texcoords so the finite-difference passes read them as varyings instead of doing the adds per
 * fragment.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

const BASE_VERTEX_SHADER = /* glsl */ `
  precision highp float;

  attribute vec2 aPosition;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform vec2 texelSize;

  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const COPY_SHADER = /* glsl */ `
  precision mediump float;
  precision mediump sampler2D;

  varying highp vec2 vUv;
  uniform sampler2D uTexture;

  void main () {
    gl_FragColor = texture2D(uTexture, vUv);
  }
`;

const CLEAR_SHADER = /* glsl */ `
  precision mediump float;
  precision mediump sampler2D;

  varying highp vec2 vUv;
  uniform sampler2D uTexture;
  uniform float value;

  void main () {
    gl_FragColor = value * texture2D(uTexture, vUv);
  }
`;

/**
 * The display pass. SHADING is always defined here: it reads the dye's neighbours as a height
 * field and lights it faintly from the front, which is what gives the wash its liquid sheen. The
 * alpha line is the transparent-canvas variant of the reference implementation — the brightest
 * channel becomes coverage, so bare page shows wherever there is no dye.
 */
const DISPLAY_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler2D;

  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;
  uniform vec2 texelSize;

  void main () {
    vec3 c = texture2D(uTexture, vUv).rgb;

    #ifdef SHADING
      vec3 lc = texture2D(uTexture, vL).rgb;
      vec3 rc = texture2D(uTexture, vR).rgb;
      vec3 tc = texture2D(uTexture, vT).rgb;
      vec3 bc = texture2D(uTexture, vB).rgb;

      float dx = length(rc) - length(lc);
      float dy = length(tc) - length(bc);

      vec3 n = normalize(vec3(dx, dy, length(texelSize)));
      vec3 l = vec3(0.0, 0.0, 1.0);

      float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
      c *= diffuse;
    #endif

    float a = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c, a);
  }
`;

const SPLAT_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler2D;

  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;

  void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`;

const ADVECTION_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler2D;

  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform vec2 dyeTexelSize;
  uniform float dt;
  uniform float dissipation;

  vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
    vec2 st = uv / tsize - 0.5;
    vec2 iuv = floor(st);
    vec2 fuv = fract(st);

    vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
    vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
    vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
    vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
  }

  void main () {
    #ifdef MANUAL_FILTERING
      vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
      vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      vec4 result = texture2D(uSource, coord);
    #endif
    float decay = 1.0 + dissipation * dt;
    gl_FragColor = result / decay;
  }
`;

/** The boundary conditions reflect velocity at the edges, so dye piles against them like a wall. */
const DIVERGENCE_SHADER = /* glsl */ `
  precision mediump float;
  precision mediump sampler2D;

  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;

  void main () {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;

    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }

    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`;

const CURL_SHADER = /* glsl */ `
  precision mediump float;
  precision mediump sampler2D;

  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;

  void main () {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
  }
`;

const VORTICITY_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler2D;

  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curl;
  uniform float dt;

  void main () {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;

    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;

    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity += force * dt;
    velocity = min(max(velocity, -1000.0), 1000.0);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const PRESSURE_SHADER = /* glsl */ `
  precision mediump float;
  precision mediump sampler2D;

  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;

  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`;

const GRADIENT_SUBTRACT_SHADER = /* glsl */ `
  precision mediump float;
  precision mediump sampler2D;

  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;

  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;
