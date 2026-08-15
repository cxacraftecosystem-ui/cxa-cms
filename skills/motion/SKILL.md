---
name: motion
description: Declarative animation in this repo — the one reduced-motion hook and the two switches it unions, the spring and duration tokens you must not invent numbers beside, the variants factories, Reveal and its noscript rescue, the public-site rule that reduced motion changes durations and never the initial state, Lenis, and the traps that have shipped here. Load before adding or changing ANY declarative animation.
---

# Motion (framer-motion v12) — the declarative half

`framer-motion@12.43.0` is installed and **is** Motion — the library was renamed to `motion` at v12 and
`framer-motion` remains a published alias of the same code. **Do not add the `motion` package
alongside it**: two copies of one library means two `MotionConfig` contexts, two reduced-motion
subscriptions and layout animations that fight. Import from `framer-motion`, which is what every file
here already does.

GSAP is installed too and owns exactly two things — an overlapping timeline and scroll-scrubbed motion.
See the `gsap` skill. **Framer owns everything else, including every entrance.**

> ⚠ **THIS FILE WAS REWRITTEN AGAINST THE REAL CODE.** An earlier version described a different product:
> it told you to import `useAppReducedMotion` from `@/components/guide/useAppReducedMotion`, to use
> factories called `springy()`/`layoutSpring()` from `components/guide/guideMotion.ts`, and to set
> `will-change` on animating spans. **`components/guide/` does not exist here**, and the `will-change`
> advice is the opposite of this repo's rule. Three independent auditors flagged it. If anything below
> disagrees with `docs/CONTRACT.md` §8, §8 wins.

---

## 1. There is ONE reduced-motion hook, and it unions TWO switches

```ts
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";

const reduce = useReducedMotionPreference();
```

**Never call framer-motion's `useReducedMotion()` in a component.** It subscribes to the OS media query
`prefers-reduced-motion: reduce` and to nothing else. This site has a *second* switch — the in-app
Accessibility toggle, which stamps `data-reduced-motion` on the document — and framer cannot see it. A
reader who turned reduced motion on in the menu still got every spring.

`useReducedMotionPreference()` unions the two and watches the attribute with a `MutationObserver`, so
flipping the toggle takes effect **without a reload**.

CSS already honours both, because `app/globals.css` pairs its `@media (prefers-reduced-motion: reduce)`
block with a `[data-reduced-motion]` block — a media query cannot be OR-ed with a selector, so it is
written twice. JavaScript has no such twin, which is why the hook exists.

Reduced motion is a **floor, never a ceiling**: the in-app preference can only ever turn motion *down*,
and can never switch the OS preference off.

---

## 2. ⚠ ON THE PUBLIC SITE, REDUCED MOTION CHANGES DURATIONS — NEVER THE `initial` STATE

This is the rule that is easiest to get backwards, and the two halves of the product have **opposite**
answers:

- **On `(site)` routes**, pages are prerendered. `useReducedMotionPreference()` reads `false` on the
  server and on the first client render *by design*, then flips a tick later. So an `initial` that
  branches on it produces a **flash** — the prerendered HTML disagrees with the corrected client tree.
  Gate the *duration and displacement*, never the initial state, and never make an element's
  **existence** depend on `reduce`.
- **Inside `/studio`**, nothing is prerendered for an anonymous reader, so branching `initial` is fine.

**Do not copy either pattern across the boundary.** Anything using `motion.*` or these hooks needs
`"use client"`.

---

## 3. Use the shared vocabulary — do not invent a spring number

`components/motion/constants.ts` (contract §8 reproduces this table, and they must agree):

| Spring | Value | Job |
|---|---|---|
| `SPRING_ISLAND` | `260 / 30` | header layout, sheet slide |
| `SPRING_PRESS` | `380 / 30 / 0.7` | every press and hover response |
| `SPRING_LAYOUT` | `260 / 32 / 0.9` | layout changes, accordion height |
| `SPRING_SCROLL` | `140 / 30 / 0.4` | scroll-linked spines |
| `SPRING_POINTER` | `110 / 24 / 0.6` | the hero pointer wash |
| `SPRING_POPOVER` | `520 / 38 / 0.6` | popovers |
| `SPRING_TOAST` | `420 / 34 / 0.7` | toasts |

`EASE_OUT = [0.16, 1, 0.3, 1]` — the house cubic, **identical to the `ease-out` Tailwind token**. ⚠ The
bare CSS keyword `ease-out` in handwritten CSS is the *spec* curve, a different and much lazier curve
spelled the same way (contract §4). If you change a curve, change the token, not the copy, or CSS
transitions and JS animations on one surface drift apart.

`DURATION`: `scrim` 0.18 · `swapOut` 0.16 · `swapIn` 0.28 · `page` 0.22 · `slide` 0.4 · `rise` 0.5 ·
`words` 0.62.
`STAGGER`: `loose` 0.08 · `default` 0.06 · `cards` 0.05 · `grid` 0.045 · `tight` 0.04 · `rows` 0.035 ·
`dense` 0.025.

**Match these rather than inventing neighbours.** A ninth duration 30ms from an existing one is not a
design decision, it is drift.

---

## 4. The variants factories — gating lives at the source

`components/motion/variants.ts`. **Every factory takes `reduce` and collapses to a zero-duration,
zero-displacement version of itself.** That is deliberate: gating at the source means a new animation
cannot ship without honouring the preference, which is the failure mode a per-call-site check invites.

| Factory | Use for |
|---|---|
| `staggerParent(reduce, stagger?)` | a parent that releases children one after another |
| `riseItem(reduce, distance?)` | the standard rise-and-fade for a revealed element |
| `slideItem(reduce, distance?)` | where a rise would fight the reading direction (chips, rails) |
| `fadeItem(reduce)` | opacity only, where any displacement would be wrong |
| `scaleIn(reduce, from?)` | something that grows into place (a popover, a badge) |
| `swapVariants(reduce)` | one readout replacing another in the same box |
| `press(reduce, lift?)` | interactive press/hover response; returns a `PressMotion` |

```tsx
<motion.ul variants={staggerParent(reduce)} initial="hidden" animate="show">
  {items.map((item) => (
    <motion.li key={item.id} variants={riseItem(reduce)}>{item.label}</motion.li>
  ))}
</motion.ul>
```

Adding an eighth kind of entrance is almost always wrong. If a surface genuinely needs one, **add a
factory that takes `reduce`** — never an inline `transition={{ … }}` the preference cannot reach.

---

## 5. `Reveal` owns scroll entrances

`components/motion/Reveal.tsx` is the standard "this rises into view once" wrapper:
`as` · `delay` · `distance` · `once` · `amount` · `className`.

⚠ **`amount` is a threshold that can be UNREACHABLE.** `whileInView` fires when the requested fraction
of the element is visible — but an element taller than the viewport can never reach a high fraction, so
a section 3200px tall in an 800px window (max ratio 0.25) against the default 0.3 **never animates and
stays at `opacity: 0` for ever.** `Reveal` now measures the achievable ratio and falls back to `"some"`.
Never raise `amount` on a tall section without doing that arithmetic.

`RevealNoScriptRescue` is the companion: `Reveal` genuinely does start hidden, so a reader with no
JavaScript needs the opacity restored. Written **without `!important`**, so a real animation's inline
styles always win and the rescue only applies where nothing will animate.

---

## 6. Layout animation

- Pair `layout` / `layoutId` with `SPRING_LAYOUT`, not the default transition.
- A `layout` element must **not** also animate `width`/`height` in `animate` — the two fight and stutter.
- `layoutId` must be unique across the whole tree at a given moment. Two mounted elements sharing one id
  is how a card appears to fly to the wrong place.
- Prefer `layout="position"` when only position should animate — a *size* layout animation under a
  scaling entrance distorts the card.
- Under `reduce` the layout spring is zero-duration, which is right: the element still arrives in the
  correct place, instantly.

---

## 7. Scroll: Lenis, and where it must not go

`components/motion/SmoothScroll.tsx` owns Lenis (`lenis@1.3.25`) and exports `subscribeToLenis` and
`scrollToElement`.

- **Lenis is mounted on `(site)` routes only.** A CMS that scrolls with inertia feels broken when you
  are trying to hit a row, so it must never be mounted inside `/studio`.
- **It is disabled entirely under reduced motion.** Smooth scrolling *is* motion.
- `subscribeToLenis` is how GSAP's runtime bridges scroll frames to `ScrollTrigger.update`. It calls
  back immediately with the current instance and again on every change.
- For `useScroll`/`useTransform`, pass the flag through and **collapse the output range to a constant**
  rather than skipping the hook — hook order must stay stable across renders.
- If a scrolled-to element hides under the header, that is a missing `scroll-mt-*` utility, not a
  scroll-offset bug.

---

## 8. Traps — every one of these has actually happened here

- **framer's `useReducedMotion()`** — sees only the OS switch. Always `useReducedMotionPreference()`.
- **Branching `initial` on `reduce` on a `(site)` route** — a flash, because the value is `false` for the
  first render by design.
- **Adding the `motion` package** — it is the same library as the installed `framer-motion@12`.
- **Inline `transition={{ … }}`** — invisible to the preference. Use a factory.
- **Centring a framer-animated element with a translate class** — framer writes an inline `transform`
  and the class loses. Centre with margins.
- **Animating a layout property.** `margin-left` under `transition-all` relaid out a row — and, through
  normal flow, everything below it — on each of ~9 frames. It was the Reduced-motion switch itself: the
  one animation a reader cannot switch off before reaching it was the one that janked. Use
  `transition-transform` + `translate-x-*`.
- **`background-position` and `stroke-dashoffset`** — neither is `transform` or `opacity`, so both repaint
  on the main thread every frame.
- **`will-change` left on permanently.** Keyed off a render-time prop it promoted a compositor layer per
  photograph for the whole visit, including under reduced motion — ~5.8 MB of GPU memory per full-bleed
  photograph. Set it while animating and clear it after, or let the library do it (GSAP's `force3D`
  already does).
- **`whileHover` on touch surfaces** — it sticks after a tap. Prefer `whileTap` with `press(reduce)`.
- **Motion on a value a screen reader announces** — animate the container; never re-render the text in
  pieces, or the accessible name changes mid-animation. `CountUp` is the one animation applied to factual
  content, and a statistic is more authoritative standing still.
- **Motion as the only carrier of information** (contract §1.5). Every motion-only signal needs a static
  twin: the switch's "On"/"Off" word, the progress bar's track colour, the toast's icon and tone word.
- **An animation that keeps running when nobody is there.** Observe with `useInView` and pin the target at
  its resting value with `{ duration: 0 }` — deliberately the same shape as the `reduce` branch, so "no
  motion now" has one spelling in the file.
- **Ornaments that are not `aria-hidden`** — and never put `aria-live` on a scroll-position readout; it
  would interrupt a screen-reader user on every scroll with information they already have.
