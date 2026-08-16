import type { Config } from "tailwindcss";

/**
 * CxA — Centre of Excellence design tokens on Tailwind v3.
 *
 * THIS FILE + app/globals.css ARE THE SOURCE OF TRUTH for every colour, radius, shadow, easing and
 * gradient in the product, exactly as `field-repo-frontend` §3–§4 defines them. The ramps below are
 * character-for-character the Field Repository ramps: a researcher moving between the two products
 * must not perceive two design languages.
 *
 * Purple ramp: OKLCH, hue locked at 305°; purple-700 is THE action colour and never inverts.
 * Tinted neutrals (ink/line/surface/bg-0) replace grey and DO invert under [data-theme="dark"].
 * Gold is a marketing accent (hero + auth + institutional headline spans only), never a data screen.
 * Earth is a second, quieter marketing accent on the same terms — see its own header below.
 * Shadows are purple-tinted; the stock black `shadow`/`shadow-xl`/`shadow-2xl` must not be used.
 *
 * THREE DELIBERATE DIVERGENCES FROM THE FIELD REPOSITORY CONFIG, all strictly additive:
 *
 *  1. `surface` exposes the FULL 50→300 ladder. In the Field Repository only `surface: { 50 }` is
 *     declared, so `bg-surface-100/200/300` silently purge and the legacy `bg-field-100/200/300`
 *     alias is the only way to reach those rungs (skill §3.3 / §17). Declaring the rungs here makes
 *     both spellings compile; every existing `field-*` class keeps working unchanged, so this
 *     removes a footgun without breaking parity.
 *  2. `amber` is spelled `amber-100/500/800` only in the Field Repository, where it DEEP-MERGES with
 *     stock Tailwind amber and `amber-50`/`amber-200` quietly resolve to non-brand values (§3.5).
 *     Here the brand rungs are namespaced as `warn-*` as well, so a component can opt out of the
 *     merge entirely. `amber-100/500/800` are retained for wording parity with existing components.
 *  3. `earth` does not exist in the Field Repository at all. It is a NEW ramp rather than a
 *     re-pointing of an existing one, so a researcher moving between the two products still meets one
 *     design language: everything they have already seen is character-for-character where it was, and
 *     the warm rungs are simply a vocabulary this product has and that one has not yet needed.
 *
 * `fontSize`, `spacing`, `screens`, `letterSpacing` and `zIndex` stay STOCK — the z-index ladder is a
 * convention (§6.4), not a config, and inventing a rung is how overlays end up behind the nav.
 */
const neutral = (token: string) => `rgb(var(--${token}) / <alpha-value>)`;

const purple = {
  50: "oklch(0.977 0.013 305 / <alpha-value>)",
  100: "oklch(0.946 0.03 305 / <alpha-value>)",
  200: "oklch(0.9 0.058 305 / <alpha-value>)",
  300: "oklch(0.828 0.1 305 / <alpha-value>)",
  400: "oklch(0.738 0.15 305 / <alpha-value>)",
  500: "oklch(0.648 0.19 305 / <alpha-value>)",
  600: "oklch(0.56 0.205 305 / <alpha-value>)",
  700: "oklch(0.47 0.198 305 / <alpha-value>)",
  800: "oklch(0.4 0.18 305 / <alpha-value>)",
  900: "oklch(0.34 0.15 305 / <alpha-value>)",
  950: "oklch(0.255 0.108 305 / <alpha-value>)"
};

const gold = {
  100: "oklch(0.95 0.045 90 / <alpha-value>)",
  200: "oklch(0.9 0.08 88 / <alpha-value>)",
  300: "oklch(0.85 0.11 86 / <alpha-value>)",
  400: "oklch(0.78 0.135 84 / <alpha-value>)",
  500: "oklch(0.7 0.145 80 / <alpha-value>)",
  600: "oklch(0.6 0.13 75 / <alpha-value>)",
  700: "oklch(0.5 0.11 70 / <alpha-value>)"
};

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE EARTH RAMP — terracotta, ochre and umber: the colours of the materials this Centre documents.
 *
 * WHERE THE VALUES CAME FROM, because a warm ramp invented by eye is how a site ends up with three
 * browns that nearly match. Rung 500 is not invented at all: it is `logo.terracotta` — `#CC785C`,
 * already declared below and already on every piece of the mark — converted to OKLCH, where it lands
 * at oklch(0.658 0.113 39.2). The ramp is that one measured colour carried in both directions, so an
 * ochre accent on a page and the terracotta in the logo are the same pigment at two strengths rather
 * than two warm colours that happen to sit near each other.
 *
 * ⚠ THE HUE DRIFTS — 72° at the top to 45° at the foot — WHICH `purple` MUST NEVER DO AND `gold`
 * ALREADY DOES (90 → 70). Purple is an IDENTITY: one hue, eleven strengths, and a drift in it would
 * read as the brand printing badly. This is a PIGMENT FAMILY, and the family is the whole point: a
 * yellow earth (ochre, raw sienna) genuinely is a different hue from a red-brown one (burnt sienna,
 * umber), and locking them to one figure gives a light end that looks like weak gold and a dark end
 * that looks like mud. Chroma peaks in the middle and falls at both ends for the same reason a real
 * pigment does — thinned to a wash it loses saturation, burnt to an umber it loses it again.
 *
 * MEASURED, NOT ESTIMATED — the two figures anybody spending this ramp on a light page needs.
 * Against `--bg-0` in the light theme (#f7f6fb, relative luminance 0.927):
 *
 *   • earth-700 (≈ #91492F) …… luminance 0.110 → 6.1:1  ✓ small text, 13px eyebrow capitals included
 *   • earth-600 …………………………… luminance 0.179 → 4.3:1  ✗ decoration and large text only (WCAG 1.4.3)
 *
 * So 700 is the rung a WORD may be set in and 600 is not, however alike the two look side by side.
 * earth-50 (≈ #FCF5EC) is a paper wash rather than a colour: it is there to be laid under a block.
 *
 * ⚠ IT IS LITERAL OKLCH, LIKE `purple` AND `gold`, AND IT MUST NEVER BE GIVEN A DARK TWIN. Brand
 * colour does not invert, which is exactly what makes an earth rule or an earth hairline safe over a
 * photograph — and `scripts/theme-check.ts` reads the `[data-theme="dark"]` block of app/globals.css
 * and FAILS on any `--token` redefined there that its own `INVERTING` list has not heard of. Putting
 * `--earth-*` into that block would break `npm run check` until somebody edited the script. There is
 * no reason to; this note is the reason not to.
 *
 * WHERE IT IS ACTUALLY SPENT TODAY, because a ramp with no callers is a ramp nobody can judge:
 * `--earth-700` in app/globals.css tints the eyebrow of every LIGHT block on the hero-led front page,
 * and `ring-earth-500/25` is the fillet on the hero's second contact sheet. That is the whole of it,
 * and it is meant to stay close to that: the brand is purple and gold, and this is seasoning.
 * ⚠ A rung nobody writes out IN FULL compiles to nothing (§5) — which is the right cost for a token
 * library and the fatal one for a class name assembled from data.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const earth = {
  50: "oklch(0.972 0.014 72 / <alpha-value>)",
  100: "oklch(0.942 0.034 70 / <alpha-value>)",
  200: "oklch(0.888 0.062 66 / <alpha-value>)",
  300: "oklch(0.822 0.09 60 / <alpha-value>)",
  400: "oklch(0.752 0.11 50 / <alpha-value>)",
  // #CC785C, the mark's own terracotta, stated in the space the rest of this file is stated in.
  500: "oklch(0.658 0.113 39.2 / <alpha-value>)",
  600: "oklch(0.575 0.112 38 / <alpha-value>)",
  700: "oklch(0.49 0.105 40 / <alpha-value>)",
  800: "oklch(0.405 0.085 42 / <alpha-value>)",
  900: "oklch(0.33 0.062 45 / <alpha-value>)"
};

/** Brand status rungs. Literal hex on purpose: a status must read the same in both themes. */
const warn = { 100: "#fef3c7", 500: "#f59e0b", 800: "#92400e" };
const success = { 100: "#dcfce7", 600: "#15803d" };
const danger = { 100: "#fee2e2", 200: "#fecaca", 600: "#dc2626", 700: "#b91c1c" };

const config: Config = {
  content: ["./app/**/*.{ts,tsx,mdx}", "./components/**/*.{ts,tsx,mdx}", "./lib/**/*.{ts,tsx}"],
  // globals.css stamps data-theme onto <html> before first paint; the custom selector wins over
  // "class", so `class="dark"` on a container does NOTHING (§5). `dark:` is an exception mechanism.
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      /**
       * THE TYPE LIBRARY. Twelve local variable faces; `lib/typography/fonts.ts` says what each is FOR
       * and `app/layout.tsx` is what actually defines the custom properties named here.
       *
       * ⚠ THE FOUR ORIGINAL KEYS ARE UNTOUCHED, INCLUDING THE TWO THAT LIE. Everything below `mono` is
       * strictly additive. Repointing `sans`, `display`, `serif` or `mono` would silently restyle every
       * existing use of them across the public site and ~40 studio screens, which is not a typography
       * change anybody asked for — a new voice is a new key.
       *
       * ⚠ A CLASS THAT IS NOT WRITTEN OUT IN FULL SOMEWHERE UNDER ./app, ./components OR ./lib IS
       * PURGED. `font-${face.tailwindKey}` compiles to nothing and fails silently, so the manifest
       * carries `fontClass` as a complete literal string for every face and a picker emits that
       * (CONTRACT.md §5). The literals in lib/typography/fonts.ts are also what keeps these keys alive
       * in the build even before a component uses one.
       */
      fontFamily: {
        // Jakarta-first since the owner made it the site's default voice; the `body` rule in
        // globals.css carries the identical stack and the two must move together.
        sans: ["var(--font-jakarta)", "var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-jakarta)", "var(--font-inter)", "ui-sans-serif", "sans-serif"],
        // Legacy slot. NOT a serif — it is Plus Jakarta Sans (§2). Never use it to mean "serif".
        serif: ["var(--font-jakarta)", "var(--font-inter)", "ui-sans-serif", "sans-serif"],
        // ⚠ `--font-mono` IS DEFINED NOWHERE, so `font-mono` has always resolved to the system
        // monospace — 83 places across 40 files. Kept exactly as it is: JetBrains Mono is a separate
        // key below, so a screen opts into the real face rather than all forty files changing at once
        // in a commit about adding fonts. See app/layout.tsx.
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],

        // ── Text serifs. Fall back through the generic serif stack, never through a sans: a
        // sans-to-serif swap re-wraps every line, which is the reflow `adjustFontFallback` exists to
        // avoid. Each has a true drawn italic.
        "source-serif": ["var(--font-source-serif)", "ui-serif", "Georgia", "Cambria", "serif"],
        newsreader: ["var(--font-newsreader)", "ui-serif", "Georgia", "Cambria", "serif"],
        lora: ["var(--font-lora)", "ui-serif", "Georgia", "Cambria", "serif"],
        crimson: ["var(--font-crimson)", "ui-serif", "Georgia", "Cambria", "serif"],

        // ── Display serifs. Headlines and pull quotes only.
        fraunces: ["var(--font-fraunces)", "ui-serif", "Georgia", "Cambria", "serif"],
        playfair: ["var(--font-playfair)", "ui-serif", "Georgia", "Cambria", "serif"],

        // ── Sans alternatives and a condensed grotesque. These fall back through `--font-inter`
        // first, exactly as `display` does: Inter is already loaded on every page, so it is a closer
        // match than the OS default while the chosen face is still in flight.
        "work-sans": ["var(--font-work-sans)", "var(--font-inter)", "ui-sans-serif", "sans-serif"],
        figtree: ["var(--font-figtree)", "var(--font-inter)", "ui-sans-serif", "sans-serif"],
        "archivo-narrow": [
          "var(--font-archivo-narrow)",
          "var(--font-inter)",
          "ui-sans-serif",
          "sans-serif"
        ],

        // ── Monospace with tabular figures, for citations, identifiers and columns of numbers.
        // Deliberately a DIFFERENT key from `mono` — see the note on `mono` above.
        "jetbrains-mono": [
          "var(--font-jetbrains-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace"
        ]
      },
      colors: {
        purple,
        gold,
        earth,
        ink: {
          DEFAULT: neutral("ink-900"),
          900: neutral("ink-900"),
          700: neutral("ink-700"),
          500: neutral("ink-500"),
          300: neutral("ink-300"),
          body: neutral("ink-700"),
          muted: neutral("ink-500"),
          soft: neutral("ink-300")
        },
        line: { 200: neutral("line-200"), 300: neutral("surface-300") },
        surface: {
          50: neutral("surface-50"),
          100: neutral("surface-100"),
          200: neutral("surface-200"),
          300: neutral("surface-300")
        },
        "bg-0": neutral("bg-0"),
        // Legacy `field` scale, shifted by one stop so the NAME LIES (§3.4): field-500 → purple-600,
        // field-600 → purple-700 (the action colour), field-700 → purple-800. Kept for parity.
        field: {
          50: neutral("surface-50"),
          100: neutral("surface-100"),
          200: neutral("surface-200"),
          300: neutral("surface-300"),
          400: purple[400],
          500: purple[600],
          600: purple[700],
          700: purple[800],
          900: neutral("ink-900")
        },
        thread: { DEFAULT: gold[500], soft: gold[200] },
        logo: { cream: "#FAF9F5", terracotta: "#CC785C", ink: "#181715" },
        amber: warn,
        warn,
        success,
        error: { 100: danger[100], 200: danger[200], 600: danger[600], 700: danger[700] },
        background: neutral("bg-0"),
        foreground: neutral("ink-900"),
        card: neutral("card"),
        popover: neutral("card"),
        border: neutral("line-200"),
        input: neutral("line-200"),
        ring: purple[600],
        accent: purple[50],
        "accent-foreground": purple[700],
        primary: purple[700],
        "primary-foreground": "#ffffff",
        secondary: neutral("ink-500"),
        "secondary-foreground": neutral("card"),
        destructive: danger[600],
        "destructive-foreground": "#ffffff",
        muted: neutral("surface-50"),
        "muted-foreground": neutral("ink-500")
      },
      borderRadius: {
        // Overrides stock. NOTE `rounded` stays 4px (tighter than `sm`) and `rounded-2xl` stays 1rem,
        // numerically IDENTICAL to `lg` — reading a class name is not enough to know the radius (§4).
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "24px"
      },
      boxShadow: {
        sm: "0 1px 2px rgba(46, 16, 101, 0.06)",
        soft: "0 1px 2px rgba(46, 16, 101, 0.06)",
        md: "0 4px 16px rgba(46, 16, 101, 0.08)",
        lg: "0 8px 32px rgba(46, 16, 101, 0.12)",
        panel: "0 8px 32px rgba(46, 16, 101, 0.12)",
        island: "0 4px 16px rgba(46, 16, 101, 0.12), 0 1px 2px rgba(46, 16, 101, 0.06)",
        cta: "0 8px 24px oklch(0.47 0.198 305 / 0.28)",
        glow: "0 8px 24px oklch(0.47 0.198 305 / 0.28)",
        "glow-soft": "0 4px 16px oklch(0.47 0.198 305 / 0.16)",
        // Cinematic surfaces only (hero cards, media lightbox chrome) — still purple-tinted.
        cinema: "0 24px 80px rgba(46, 16, 101, 0.18), 0 2px 8px rgba(46, 16, 101, 0.08)"
      },
      transitionTimingFunction: {
        // `ease-out` the CLASS is the brand expo curve. `ease-out` inside handwritten CSS is the spec
        // curve — the two look identical in source and are different curves (§4).
        out: "cubic-bezier(0.16, 1, 0.3, 1)",
        spring: "cubic-bezier(0.34, 1.56, 0.64, 1)"
      },
      keyframes: {
        // Field Repository parity. Dead scaffold there; live here (components/ui/Accordion.tsx sets
        // --accordion-content-height from a ResizeObserver rather than relying on Radix).
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--accordion-content-height, auto)" }
        },
        "accordion-up": {
          from: { height: "var(--accordion-content-height, auto)" },
          to: { height: "0" }
        },
        // The news ticker. Translating a duplicated track by exactly -50% is what makes the seam
        // invisible; any other figure shows a jump once per lap.
        "ticker-track": {
          from: { transform: "translate3d(0, 0, 0)" },
          to: { transform: "translate3d(-50%, 0, 0)" }
        },
        /*
         * ⚠ THERE IS NO `sweep` KEYFRAME HERE, AND ITS ABSENCE IS THE FIX RATHER THAN AN OMISSION.
         *
         * `animation.sweep` below names a keyframe that is HAND-WRITTEN in app/globals.css, beside
         * `@keyframes fr-row-flash`. Three things forced that split, and undoing any one of them
         * reintroduces a defect:
         *
         *  1. THE KEYFRAME HAS TWO CONSUMERS AND ONLY ONE OF THEM IS A TAILWIND CLASS. `.skeleton`
         *     (globals.css, ~20 call sites across the studio) drives it from a raw `animation:`
         *     declaration on a pseudo-element, because a `::after` cannot wear a utility. Tailwind
         *     emits a `@keyframes` block ONLY when the matching `animate-*` utility survives the
         *     content scan — so declaring `keyframes.sweep` here would make every skeleton in the CMS
         *     depend on `components/ui/ProgressBar.tsx` continuing to write the literal string
         *     `animate-sweep`. Drop that one class and twenty placeholders stop animating, silently,
         *     with no error anywhere. Declared in globals.css it is plain CSS outside every `@layer`
         *     and can never be purged.
         *  2. THE PREVIOUS ARRANGEMENT SHIPPED THE KEYFRAME TWICE. `shimmer` was declared here AND
         *     hand-written in globals.css, so the compiled stylesheet carried two `@keyframes shimmer`
         *     blocks and the later one (globals.css's, since Tailwind's output is injected at the
         *     `@tailwind utilities` on line 3) silently won for BOTH callers. They happened to be
         *     identical, so nothing was visibly wrong — which is exactly why it would have survived
         *     until somebody edited the one that loses.
         *  3. `animation` STILL BELONGS HERE, because `animate-sweep` has to be a real utility for
         *     ProgressBar to write as a complete literal (§5). A `animation-name` with no matching
         *     `@keyframes` in Tailwind's own output is not a dangling reference: CSS resolves an
         *     animation name against every `@keyframes` in the document, and globals.css is the same
         *     document.
         *
         * WHAT IT REPLACED: `shimmer`, which moved `background-position` — a property no engine
         * composites, on an `infinite` animation. Twenty row skeletons on a loading table were twenty
         * permanent main-thread repaint loops, on precisely the screens whose main thread is already
         * blocked on the fetch the skeletons are standing in for. The replacement translates a child
         * inside an overflow-hidden frame, which is compositor-only and free.
         */
        /*
         * ⚠ `fr-row-flash` IS NOT DECLARED HERE EITHER, FOR THE SAME REASON AND WITH THE SAME HISTORY.
         * `.flash-row[data-flash="true"]` in globals.css drives it from a raw `animation:` declaration,
         * so globals.css hand-writes the keyframe. A copy here was dead — nothing in the repository
         * writes the literal `animate-fr-row-flash`, so Tailwind purged both the utility and its
         * keyframe and globals.css's copy was the only one that ever reached a browser. Leaving a
         * purged duplicate in place is a trap rather than a spare: the first person to write
         * `animate-fr-row-flash` would have resurrected a SECOND `@keyframes fr-row-flash`, and which
         * of the two won would have been decided by source order rather than by anybody's intention.
         */
        "caret-blink": {
          "0%, 70%, 100%": { opacity: "1" },
          "20%, 50%": { opacity: "0" }
        }
      },
      /*
       * ⚠ EVERY ANIMATION IN THIS PRODUCT THAT IS NOT FRAMER-MOTION IS IN THIS TABLE, AND EVERY ONE OF
       * THEM MOVES `transform` OR `opacity` ONLY — with a single, bounded, documented exception.
       *
       * The exception is `accordion-down` / `accordion-up`, which animate `height`, a LAYOUT property
       * that contract §8 otherwise forbids outright. It stays because CSS genuinely cannot animate to
       * `height: auto` and there is no transform that expresses "this box grew": a `scaleY` would
       * squash the text inside the panel rather than reveal it, and a `max-height` guess either clips
       * a long answer or spends the animation on empty space. It is bounded in a way nothing else here
       * is — 0 ↔ ONE measured pixel value, 0.2s, one panel at a time, on a box the reader has just
       * pressed — and `components/ui/Accordion.tsx` measures that pixel value with a ResizeObserver
       * rather than guessing it. Do not copy the exception to anything else.
       *
       * `fr-row-flash` moves `background-color`, which is paint rather than layout. It is a 700ms
       * ONE-SHOT (`1`, not `infinite`) on a single row the reader just caused to change, and the
       * transform-and-opacity version of it would need an absolutely-positioned overlay child inside
       * each row — which `components/studio/DataTable.tsx` puts on a `<tr>`, where an absolutely
       * positioned pseudo-element does not lay out as a reliable overlay across engines. A repaint of
       * one row, once, is the cheaper of the two mistakes; see the note above the recipe in globals.css.
       */
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "ticker-track": "ticker-track var(--ticker-duration, 40s) linear infinite",
        // ⚠ The keyframe is in app/globals.css, NOT above. See the long note in `keyframes` — moving
        // it back here is what would make every `.skeleton` in the CMS depend on ProgressBar's class
        // string surviving a refactor.
        //
        // ⚠ AND THIS TIMING IS STATED TWICE, HERE AND ON `.skeleton::after` IN app/globals.css, WHICH
        // IS DELIBERATE. The two callers of `@keyframes sweep` must sweep at the same rate — a loading
        // table and the upload bar beside it are on the same screen — so if you retime one, retime the
        // other. Collapsing the duplication by having `.skeleton::after` `@apply animate-sweep` would
        // make ~20 CMS placeholders depend on this key existing, which is the same class of coupling
        // the `keyframes` note above rejects. The reasoning is written out in full above `@keyframes
        // sweep` at the foot of globals.css.
        sweep: "sweep 1.8s ease-in-out infinite",
        "fr-row-flash": "fr-row-flash 700ms ease-out 1",
        "caret-blink": "caret-blink 1.2s ease-out infinite"
      }
    }
  },
  plugins: []
};

export default config;
