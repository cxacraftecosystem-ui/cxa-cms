---
name: gsap
description: GSAP in this repo — the two jobs it owns and why, the one hook every animation goes through, the invariant that makes scrubbed motion safe to fail, the two different reduced-motion tests, revert-not-kill, and the traps that have actually shipped here. Load before adding, changing or removing any GSAP animation.
---

# GSAP — the scrub-and-overlap exception

`gsap@3.15.0` and its `ScrollTrigger` plugin are installed. Together they are **~95 KB**, so they are
loaded by a memoised dynamic `import()` and never sit in a page's bundle.

> ⚠ **THIS FILE WAS REWRITTEN AGAINST THE REAL CODE.** An earlier version of it described a different
> product — it claimed GSAP was used by one file called `frontend/components/guide/useGsapHeadline.ts`,
> told you to gate on `useAppReducedMotion()`, to reach for factories in `guideMotion.ts`, to tear down
> with `timeline.kill()`, and to set `will-change` on animating spans. **None of those paths exist here
> and three of those four instructions are the opposite of this repo's rule.** Three independent
> auditors flagged it. If anything below disagrees with `docs/CONTRACT.md` §8, §8 wins — it is the
> project's own contract and is authoritative.

---

## 1. GSAP owns exactly two jobs, and the line against framer is ENTRANCE versus SCRUB

Everything else — every fade-up, every stagger, every hover and press — is framer-motion's. See the
`motion` skill. Reaching for GSAP to make a section fade up means two animation systems where one
would do.

**Job 1 — a timeline whose tweens deliberately OVERLAP.** This is the one thing framer cannot say.
`staggerChildren` is a fixed delay between siblings that each run their own transition, so a word's
rise begins only *after* the previous word's delay has elapsed. The homepage headline wants each word
starting **while the one before it is still moving** — an offset measured from a sibling's *start*,
which is a timeline primitive:

```ts
created.fromTo(
  node,
  { yPercent: 108, opacity: 0, rotate: 1.5 },
  { yPercent: 0, opacity: 1, rotate: 0 },
  // 0.28s AFTER THE START of the previous tween, which lasts 0.62s — so each word begins while
  // the one before it is still travelling. `"<"` is the previous tween's start.
  index === 0 ? 0 : `<${WORD_OVERLAP_SECONDS}`
);
```

One file does this: `components/sections/hero/HeroHeadline.tsx`.

**Job 2 — scroll-scrubbed motion.** Parallax, a pinned rail, a line that fills as the reader descends,
a figure that holds while its chapter passes. This is what the four narrative blocks use:

| File | Block | Scrubs |
|---|---|---|
| `components/sections/story/StoryStage.tsx` | STORY_SCROLL | per-chapter parallax, a progress rail, chapter marks |
| `components/sections/story/ParallaxStage.tsx` | PARALLAX_BANNER | layered depth on a full-bleed banner |
| `components/sections/story/RailStage.tsx` | HORIZONTAL_RAIL | a pinned horizontal travel |
| `components/sections/story/ProcessStage.tsx` + `components/sections/ProcessStepsSection.tsx` | PROCESS_STEPS | a stage line that fills, and stage marks |

---

## 2. Every animation goes through `useGsapScope` — there is no second way in

```tsx
import { useGsapScope } from "@/components/motion/gsap/useGsapScope";

const scopeRef = useGsapScope<HTMLDivElement>(({ gsap, ScrollTrigger, q, scope }) => {
  const layers = q("[data-parallax]");
  if (layers.length === 0) return;              // an empty result is the #1 silent failure
  gsap.fromTo(
    layers,
    { yPercent: -8 },
    { yPercent: 8, ease: "none", scrollTrigger: { trigger: scope, start: "top bottom", end: "bottom top", scrub: true } }
  );
}, [someDep]);

return <div ref={scopeRef}>{children}</div>;
```

The hook hands the builder `{ gsap, ScrollTrigger, scope, q }` and runs it inside
`gsap.context()` scoped to the element. Read its header before writing one: it exists because the four
ways to get this wrong are all easy and none of them show up in development on the first page you look
at — an unkilled ScrollTrigger, React's double-invoked effects, a teardown that beats the dynamic
import, and a timeline rebuilt on every render.

- **`q(selector)` returns an array**, and you should guard on `.length`. A builder that reads
  `q("[data-item]")` and never checks is the commonest reason a GSAP animation quietly does nothing.
- **Pass `null` as the builder to build nothing** (a block whose animation is off in its settings).
  Hook order stays the same either way — never make the hook call itself conditional.
- **State the values the builder READS in `deps`.** The builder's own identity is deliberately not a
  dependency; it is held in a ref, or every trigger would rebuild whenever any state changed.

`components/motion/gsap/runtime.ts` is the layer underneath: it memoises the import so concurrent
callers share one promise, calls `registerPlugin(ScrollTrigger)` exactly **once**, bridges Lenis to
`ScrollTrigger.update` so scrubbed layers do not trail the page by a frame, and calls
`refreshScrollTriggers()` when a late image or font swap changes the document height. Import from the
runtime only if you are extending the runtime.

---

## 3. ⚠ THE INVARIANT THAT MAKES SCRUBBED MOTION SAFE TO FAIL

**Every element GSAP scrubs is already in its final, readable position in the HTML.** A parallax layer
at rest *is* the layer. A sticky figure with no JavaScript *is* a sticky figure — the stickiness is
`position: sticky` in a Server Component's classes and GSAP never touches it.

Three consequences fall out rather than being arranged:

1. **Reduced motion builds nothing at all** — not a faster version, not a shorter one — and what is
   left is a complete page.
2. **A failed chunk costs the drift and nothing else.** `useGsapScope`'s `.catch` is empty on purpose,
   because there is nothing to tell the reader.
3. **There is no `opacity: 0` to rescue and no `<noscript>` rule to write.**

> **A new GSAP animation that needs something hidden until JavaScript runs is a `Reveal` that has been
> written in the wrong library.**

**The one exception, and what it costs.** The headline (job 1) is an *entrance*, so its words genuinely
do start at `opacity-0`. That single exception carries **three** separate rescues, and any new entrance
would owe the same three: a `settle()` under reduced motion, a `settle()` in the import's `.catch`, and
a `<noscript>` block that restores opacity for a reader with no JavaScript at all. Read the foot of
`HeroHeadline.tsx` — the `<noscript>` rules are deliberately written *without* `!important` so that
inline styles from a real animation always win and the rescue only ever applies where nothing will
animate.

---

## 4. Reduced motion: two tests, and they are NOT the same test

```ts
const reduce = useReducedMotionPreference();          // in the dependency list
// ...
if (!scope || !builder || reduce || prefersLessMotionNow()) return;
```

Both are load-bearing:

- **`useReducedMotionPreference()`** unions the OS media query with the in-app `data-reduced-motion`
  attribute and watches it with a `MutationObserver`. Keeping it in `deps` is what lets a reader who
  flips the toggle *mid-page* have the context reverted under them, removing every transform GSAP
  wrote.
- **`prefersLessMotionNow()`** (from `runtime.ts`) is a synchronous read. The hook reports `false` on
  the first render **by design** — contract §8: the value must not change the prerendered HTML — and
  that first render is the one whose effect starts the download. Without the synchronous test, every
  reader who asked for less motion still fetches ~95 KB, above the fold, to then not use it. **This
  shipped as a real bug and was caught by the motion audit.**

Never gate on framer's `useReducedMotion()` directly: it sees only the OS half.

---

## 5. Teardown: `revert()`, never `kill()`

```ts
return () => {
  cancelled = true;
  context?.revert();
};
```

`revert()` kills the tweens **and** the ScrollTriggers **and** puts back every inline style GSAP wrote.
`kill()` stops the animation and leaves the element frozen at whatever mid-scrub transform it happened
to be holding. `useGsapScope` already does this; you only need it if you are writing a raw timeline
(job 1), where `timeline.kill()` is correct because a completed entrance has settled anyway.

Unlike a tween, **a ScrollTrigger registers itself with a module-level list and keeps recalculating
after its component has gone.** In the App Router, moving between two pages that each carry a story
block leaves the first page's triggers measuring elements no longer in the document — and the second
page then scrubs against the first page's numbers.

---

## 6. Rules for the scrub itself

- **`ease: "none"` for anything scrubbed, always.** An eased scrub moves the picture at a different
  speed from the reader's own hand, which is the thing that reads as the page being laggy rather than
  as depth.
- **Animate `transform` and `opacity` only.** `stroke-dashoffset` is neither, and repainted a
  multi-viewport block on the main thread every scroll frame until it was replaced by a scrubbed
  `scaleY` on a div. Same for `background-position`.
- **Find elements by `data-*` attribute, never by class name.** A Tailwind class is a styling decision
  somebody will change; `data-story-figure` is a contract between two files and reads as one at both
  ends.
- **The trigger is the section, not the sticky element.** A sticky figure stops moving relative to the
  viewport the moment it sticks, so a trigger on the figure reports almost no progress for most of the
  chapter and the drift happens in a rush at each end.
- **Parallax travel must stay inside the overscan.** A parallax image is drawn at `scale(1.18)`
  centred, which leaves exactly 9% of the frame's height spare beyond each edge; `MAX_SAFE_DRIFT = 8`
  keeps 1% in hand, because an `aspect-ratio` frame resolves to a fractional height and the scale
  rounds separately from the translate. Overrun shows as a hairline of `bg-surface-100` along one edge
  at the far end of the scrub. **More drift means a bigger overscan in `StoryPicture`/`CraftPhoto`,
  never a bigger number in the stage.**
- **Pair every motion-only signal with a static one** (contract §1.5). The progress rail has a chapter
  count in text beside it; each chapter mark has its own number. Information must never live only in
  the motion.

---

## 7. Traps — every one of these has actually happened in this repo

- **A top-level `import { gsap } from "gsap"`** in a component — puts ~95 KB in that route's bundle.
  Type-only imports (`import type { gsap } from "gsap"`) are erased and are fine.
- **`kill()` instead of `revert()`** — leaves the element frozen mid-scrub.
- **Relying on the `reduce` hook alone** — it is `false` for the render that starts the download.
- **`will-change` keyed off a render-time prop.** It promoted a compositor layer per photograph for the
  whole life of the page, including under reduced motion where nothing animates — roughly **5.8 MB of
  GPU memory per full-bleed photograph, eight per story.** GSAP's `force3D: "auto"` already promotes an
  element for the duration of a tween and reverts it after, which *is* "set while animating, clear
  after", done by the library. **Do not add `will-change` for GSAP.**
- **Both libraries on one element** — they each write `transform` on their own schedule and the result
  is jitter that reads as a rendering bug. GSAP owns the headline's word spans and the narrative
  blocks' scrubbed layers; framer owns everything else.
- **An unguarded `q()` result** — an empty selector match is a silent no-op.
- **Two indicators, two geometries.** A chapter dot that ends at its own chapter while the rail beside
  it is scrubbed monotonically gives you a filled purple rail threaded through grey dots — which reads
  as a rendering bug, and a bug attracts far more attention than the motion was asking for. Both
  indicators must share one geometry.
- **`SplitText`** — a paid GSAP Club plugin and not a dependency here. Split by hand, once, and keep
  the trailing space *outside* the `inline-block` span or the line stops breaking and the text stops
  copying as prose. The heading's `textContent` and accessible name must not change.
