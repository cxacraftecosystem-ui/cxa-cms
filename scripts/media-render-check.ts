/**
 * media-render-check — what `MediaImage` actually emits, for each of its three paths.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHY IT IS THE MOST VALUABLE CHECK IN THIS AREA.
 *
 * `screens-check` asserts the resolver: given a framing, what bands come out. It cannot see whether the
 * COMPONENT does anything with them. That gap is exactly where the crop feature died the first time — the
 * rectangle was stored, editable and correct, and `MediaImage` never looked at it, with `tsc`, `lint`,
 * `route-check` and `smoke` all green. A resolver with no consumer and a consumer with no resolver look
 * identical from every other gate.
 *
 * So this renders the real component with `react-dom/server` and reads the markup. No browser, no dev
 * server, no database — just the three paths and what each one produces.
 *
 * THE ASSERTION THAT MATTERS MOST is in section 4: a picture of ONE band must render BYTE-IDENTICALLY to
 * no picture at all. Every uncropped image on the site depends on that, and it is the one property that
 * cannot be established by reading the code, because it is a claim about two code paths agreeing.
 *
 * ⚠ THREE PIECES OF SETUP, ALL FORCED AND NONE OF THEM A HACK:
 *
 *  1. `--tsconfig tsconfig.scripts.json`. The project's `tsconfig.json` sets `"jsx": "preserve"` because
 *     Next owns the transform, so `tsx` compiles the JSX inside `MediaImage.tsx` with the CLASSIC runtime
 *     and the render dies on "React is not defined". The override sets `react-jsx` for scripts only.
 *  2. An `.svg` object key, so `next/image` takes its `unoptimized` path. The optimiser's loader validates
 *     the hostname against a config Next injects AT BUILD TIME, which does not exist outside `next build`
 *     — an ordinary CDN URL therefore throws "hostname is not configured" here and only here. The crop
 *     geometry is produced before and independently of the loader, so bypassing it changes nothing this
 *     script looks at.
 *  3. Everything inside `main()`, with DYNAMIC imports. `lib/media/url.ts` reads `NEXT_PUBLIC_CDN_URL` at
 *     module scope, so a static import would capture an empty base and every render would come out as the
 *     "no image" placeholder. Dynamic imports need `await`, and `tsx` compiles a `.ts` file in this
 *     package to CJS — where esbuild refuses top-level `await`. Hence the function.
 *
 * ⚠ WHAT IT CANNOT SEE: whether the emitted CSS is applied by a browser, whether the breakpoint matches
 * the one the layout uses, or whether anything on a real page passes `picture` at all.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

process.env.NEXT_PUBLIC_CDN_URL = process.env.NEXT_PUBLIC_CDN_URL ?? "https://cdn.example.test/cxa";

type MediaLike = import("../lib/media/url").MediaLike;

interface Failure {
  what: string;
  detail: string;
}

async function main(): Promise<void> {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MediaImage } = await import("../components/ui/MediaImage");
  const { resolvePicture, emptyScreenFraming, setBucket } = await import("../lib/media/screens");

  const failures: Failure[] = [];
  let checks = 0;

  function check(ok: boolean, what: string, detail: string): void {
    checks += 1;
    if (!ok) failures.push({ what, detail });
  }

  /**
   * An `.svg` object key, which `MediaImage` renders `unoptimized` — see the header. No variants, so
   * `mediaSrc` falls back to the original key.
   */
  const PLAIN: MediaLike = {
    objectKey: "probe/subject.svg",
    width: 2000,
    height: 1500,
    altText: "A subject",
    blurDataUrl: null,
    cropX: null,
    cropY: null,
    cropWidth: null,
    cropHeight: null,
    variants: []
  };

  const CROPPED: MediaLike = { ...PLAIN, cropX: 0.1, cropY: 0.2, cropWidth: 0.5, cropHeight: 0.4 };

  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(MediaImage, { alt: "A subject", aspect: 1.5, ...props } as never));

  // ── 1. No crop: the path every uncropped image on the site takes ──────────
  {
    const html = render({ media: PLAIN });
    check(!html.includes("cxa-crop"), "no crop emits no crop box", html);
    check(!html.includes("<style"), "no crop emits no stylesheet", html);
    check(!html.includes("<span"), "no crop emits no wrapper", html);
    check(html.includes('data-nimg="fill"'), "and still uses next/image fill", html);
    check(html.includes("object-cover"), "and still cover-fits", html);
  }

  // ── 2. One crop for every width: inline geometry, still no stylesheet ──────
  {
    const html = render({ media: CROPPED });
    check(html.includes("<span"), "a crop emits the wrapper box", html);
    check(html.includes("width:200%") && html.includes("height:250%"), "with the computed size", html);
    check(html.includes("left:-20%") && html.includes("top:-50%"), "and the computed offset", html);
    check(!html.includes("<style"), "a single crop needs no stylesheet", html);
    check(html.includes("transform-origin:35% 40%"), "and the image pivots on the frame's centre", html);
    check(!/\d\.\d{6}/.test(html), "no floating-point noise reaches the DOM", html);

    // The studio's whole-file preview must be able to opt out.
    const whole = render({ media: CROPPED, crop: false });
    check(!whole.includes("<span"), "crop={false} draws the whole picture", whole);
    check(whole === render({ media: PLAIN }), "and is identical to an uncropped asset", "crop={false} differed");
  }

  // ── 3. Per-width framing: a stylesheet, a hashed class, no inline geometry ─
  {
    const framing = setBucket(emptyScreenFraming(), "lg", {
      mediaId: null,
      cropX: 0.3,
      cropY: 0,
      cropWidth: 0.4,
      cropHeight: 1,
      cropAspect: "free"
    });
    const picture = resolvePicture(CROPPED, framing);
    check(picture?.length === 2, "the fixture resolves to two bands", `got ${picture?.length}`);

    const html = render({ media: CROPPED, picture });
    check(html.includes("<style"), "per-width framing emits a stylesheet", html);
    check(/class="cxa-crop cxa-pic-[0-9a-z]+"/.test(html), "the box carries the hashed class", html);
    check(html.includes("cxa-crop-img"), "the image carries the origin class", html);
    check(html.includes("@media (min-width: 1024px)"), "the wider band is behind its own query", html);
    check(!/<span[^>]*style="[^"]*width:/.test(html), "the box has no inline geometry", html);
    check(!/\d\.\d{6}/.test(html), "no floating-point noise in the stylesheet", html);

    // Nothing between the style tags may be able to close them.
    const inner = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
    check(!/[<>"'\\]/.test(inner), "nothing in the stylesheet can close the element", inner);
  }

  // ── 4. THE GUARANTEE: one band is indistinguishable from no framing ───────
  {
    const onePicture = resolvePicture(CROPPED, emptyScreenFraming());
    check(onePicture?.length === 1, "an empty framing resolves to one band", `got ${onePicture?.length}`);
    check(
      render({ media: CROPPED, picture: onePicture }) === render({ media: CROPPED }),
      "a one-band picture renders byte-identically",
      "the two paths diverged"
    );

    const plainOne = resolvePicture(PLAIN, emptyScreenFraming());
    check(
      render({ media: PLAIN, picture: plainOne }) === render({ media: PLAIN }),
      "and so does an uncropped one",
      "the uncropped paths diverged"
    );
  }

  /**
   * ── 4b. A DIFFERENT PHOTOGRAPH PER SCREEN, which is what section 3 does NOT cover ──────────
   *
   * ⚠ THIS SECTION EXISTS BECAUSE ITS ABSENCE LET A REAL BUG SHIP. Section 3 sets `mediaId: null` — a
   * CROP-only framing — so every assertion in this file passed while the alternate-photograph half of the
   * feature drew nothing at all: `pictureCss` changed the rectangle at each breakpoint and the markup
   * carried one `src` from band zero. Worse than a missing feature, because `resolvePicture` restarts the
   * crop from the alternate's own stored rectangle, so above the breakpoint the ALTERNATE'S rectangle was
   * applied to the BASE's pixels. A fixture that never names a second asset cannot see any of that.
   */
  {
    /** A visibly different asset: another key, and its own stored crop, which is what made it dangerous. */
    const ALTERNATE: MediaLike = {
      ...PLAIN,
      objectKey: "probe/wide.svg",
      altText: "The wide subject",
      cropX: 0.5,
      cropY: 0.5,
      cropWidth: 0.5,
      cropHeight: 0.5
    };

    const framing = setBucket(emptyScreenFraming(), "lg", {
      mediaId: "alt-1",
      cropX: null,
      cropY: null,
      cropWidth: null,
      cropHeight: null,
      cropAspect: null
    });
    const picture = resolvePicture(CROPPED, framing, (id) => (id === "alt-1" ? ALTERNATE : null));
    check(picture?.length === 2, "an alternate resolves to two bands", `got ${picture?.length}`);
    check(
      picture?.[1]?.media.objectKey === ALTERNATE.objectKey,
      "and the wide band carries the alternate",
      String(picture?.[1]?.media.objectKey)
    );

    const html = render({ media: CROPPED, picture });
    check(html.includes("<picture>"), "an alternate emits a <picture>", html);
    check(html.includes("probe/wide.svg"), "and the alternate's own file reaches the markup", html);
    check(
      /<source[^>]*media="\(min-width: 1024px\)"/.test(html),
      "behind the band's own media query",
      html
    );
    // The fallback is the BASE, and it must still be a next/image so nothing loses the optimiser.
    check(html.includes('data-nimg="fill"'), "the fallback is still next/image", html);
    check(html.includes("probe/subject.svg"), "and it is still the base photograph", html);
    // ⚠ Widest first: `<source>` is first-match-wins over `min-width`, the opposite of the cascade.
    const firstSource = html.indexOf("<source");
    const fallbackImg = html.indexOf("<img");
    check(firstSource !== -1 && firstSource < fallbackImg, "every source precedes the fallback", html);

    /**
     * ⚠ A → B → A NEEDS THREE SOURCES, NOT ONE. Dropping the third band as "same as the fallback" leaves
     * B's `min-width: 640px` matching at 1024px, so B is served exactly where A was asked for.
     */
    const roundTrip = setBucket(
      setBucket(emptyScreenFraming(), "sm", {
        mediaId: "alt-1",
        cropX: null,
        cropY: null,
        cropWidth: null,
        cropHeight: null,
        cropAspect: null
      }),
      "lg",
      { mediaId: "base-1", cropX: null, cropY: null, cropWidth: null, cropHeight: null, cropAspect: null }
    );
    const backAgain = resolvePicture(CROPPED, roundTrip, (id) =>
      id === "alt-1" ? ALTERNATE : id === "base-1" ? CROPPED : null
    );
    const roundTripHtml = render({ media: CROPPED, picture: backAgain });
    const sourceCount = (roundTripHtml.match(/<source/g) ?? []).length;
    check(sourceCount >= 2, "a return to the base still emits its own source", `got ${sourceCount}`);
    check(
      roundTripHtml.indexOf('media="(min-width: 1024px)"') <
        roundTripHtml.indexOf('media="(min-width: 640px)"'),
      "and the wider query is still listed first",
      roundTripHtml
    );

    /** The alt text and the frame must describe band zero, not the prop, when the two differ. */
    const baseSwapped = setBucket(emptyScreenFraming(), "base", {
      mediaId: "alt-1",
      cropX: null,
      cropY: null,
      cropWidth: null,
      cropHeight: null,
      cropAspect: null
    });
    const swapped = resolvePicture(CROPPED, baseSwapped, (id) => (id === "alt-1" ? ALTERNATE : null));
    const swappedHtml = render({ media: CROPPED, picture: swapped, alt: undefined });
    check(
      swappedHtml.includes("The wide subject"),
      "a base-bucket alternate supplies its own alt text",
      swappedHtml
    );
  }

  // ── 5. The placeholder is untouched by any of this ────────────────────────
  {
    const html = render({ media: null });
    check(html.includes("No image"), "a missing asset still says so", html);
    check(!html.includes("cxa-crop"), "and grows no crop box", html);
    check(html.includes("aspect-ratio:1.5"), "and keeps the frame's ratio", html);
  }

  // ── Report ───────────────────────────────────────────────────────────────
  let failed = false;

  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} of ${checks} assertion(s):\n`);
    for (const failure of failures) {
      console.error(`  ${failure.what}`);
      console.error(`    ${failure.detail.slice(0, 400)}\n`);
    }
    failed = true;
  }

  if (checks < 20) {
    console.error(`\nFAIL — only ${checks} assertions ran. Something is wrong with this script.`);
    failed = true;
  }

  console.log(`media-render-check — ${checks} assertions over MediaImage's three paths`);

  if (failed) process.exit(1);

  console.log("PASS — the crop reaches the markup, and an unframed image renders exactly as it always did.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
