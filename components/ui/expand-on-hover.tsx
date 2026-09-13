"use client";

/**
 * ExpandOnHover — a shelf of "books". Every item is a tall collapsed sliver; the active one widens
 * to a square and shows its cover large, with a scrim and a label rising from its foot. Activating
 * a card NAVIGATES: the whole card is a `next/link`, so hover expands and click follows.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO PICTURES PER CARD: THE SPINE AND THE EXPANDED COVER.
 *
 * A card is a 4rem sliver at rest and a 24rem square when it is open, and one photograph cannot be
 * composed for both. Cropping does not rescue it either — a spine is a 64px-wide vertical slice, and
 * whatever sits in the middle of a landscape cover (a patch of sky, a shoulder, a wall) is what the
 * reader gets. So an album may carry a second picture: `spine` is drawn collapsed, `expanded` is drawn
 * open, and the two cross-fade as the card widens.
 *
 * ⚠ `spine` IS OPTIONAL AND ITS ABSENCE IS THE COMMON CASE. With no spine the card renders ONE face
 * through exactly the markup it rendered before this existed — no layers, no opacity, no fade. Every
 * album that predates the spine column therefore keeps working with its cover shown in both states,
 * which is the behaviour it already had, rather than going blank because a second picture is missing.
 *
 * ⚠ REDUCED MOTION SWAPS WITHOUT ANIMATING, and the mechanism is the durations rather than the states.
 * Both faces keep the same resting opacities in both branches — 1 and 0 — and only the trip between
 * them collapses to zero, so a reader who asked for less motion still gets the expanded picture the
 * instant the card opens and never sees a half-transparent blend of two photographs. That is the
 * variants.ts rule (reduction changes how long, never what a state looks like) and contract §8's rule
 * for `(site)` routes (it may not change an `initial`, which is why `initial={false}` and the animate
 * values carry the whole state).
 *
 * ⚠ TOUCH HAS NO HOVER, AND THE ANSWER IS THE TWO-TAP DANCE BELOW — which the spine makes more useful
 * rather than less. On a phone a card shows its spine; the FIRST tap expands it, which cross-fades to
 * the expanded cover and raises the label; the SECOND tap opens the album. So a touch reader sees both
 * pictures and the album's name and count before committing, which is more than a mouse reader gets
 * from a single hover. `aria-expanded` on the link carries that state change for a touch AT user, who
 * would otherwise hear nothing at all in response to their first tap. Nothing here is hover-only: every
 * state a pointer can reach, a finger and a Tab key can reach too.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ACTIVATION MATRIX, AND WHY EACH ENTRY IS GATED THE WAY IT IS.
 *
 *   • Mouse/pen hover expands (`onPointerEnter`, non-touch pointer types only), so a mouse user's
 *     first CLICK always lands on an already-active card and navigates — hover is the preview,
 *     click is the commitment, exactly one intent per gesture.
 *   • Keyboard focus expands (`onFocus`, gated on `:focus-visible`), so Tab previews a card the
 *     same way hover does. Enter reaches the click handler as a click with `detail === 0` — no
 *     pointer was involved, so no pointerdown preceded it — and every such click is let through
 *     UNTOUCHED. A keyboard activation therefore always navigates on the first press, even on a
 *     card that is somehow still collapsed (tap-focus followed by a keyboard, an AT-dispatched
 *     activation): expansion is a preview a keyboard reader gets for free on focus, never a toll
 *     charged against their Enter. Without the `detail` check, a focused-but-collapsed card would
 *     swallow that first Enter as an expansion — an activation the reader meant is an activation
 *     the reader must get.
 *   • Touch is a TWO-TAP dance. A tap fires pointerenter (pointerType "touch" — ignored here),
 *     then POINTERDOWN, then on some browsers FOCUS, then click. The pointerdown handler snapshots
 *     "touch tap, and the card was still collapsed" into a ref BEFORE the tap's own focus event
 *     can expand anything; the click handler reads the snapshot, calls `preventDefault()`, and
 *     expands instead of navigating. The second tap snapshots an already-active card and clicks
 *     through to the link. Deciding at pointerdown rather than reading the live state at click is
 *     what makes the dance robust even on an engine that treats tap-focus as `:focus-visible`
 *     (the `isFocusVisible` catch-all deliberately does): if focus expands the card mid-tap, the
 *     live state at click says "active" and would navigate blind — the reader would open an album
 *     whose cover they never saw — while the snapshot still remembers the truth from before the
 *     tap touched anything.
 *
 * A card, once active, STAYS active until another takes over (no `onPointerLeave` reset). This is
 * the reference pattern's behaviour and it is load-bearing for touch: a collapse-on-leave would
 * fold the card a touch reader just opened the moment their finger lifted.
 *
 * WHY THE WIDTHS ARE CHOSEN IN JS RATHER THAN BY RESPONSIVE CLASSES. framer animates `width` as an
 * INLINE style, and an inline style beats any class at every breakpoint — `w-16 lg:w-20` would be
 * dead the moment the first animation ran. So the breakpoint is read once via `matchMedia` and the
 * rem values handed to framer directly. The hook is false during SSR and the first client render
 * (matching the server by construction, same reasoning as useReducedMotionPreference); a desktop
 * reader's slivers settle from 4rem to 5rem just after hydration, which is a 16px drift on an
 * element whose whole job is to change width — not a flash, because nothing changes opacity.
 *
 * AND THE READER WHOSE JAVASCRIPT NEVER ARRIVES. framer writes the collapsed width and the label's
 * `opacity: 0` into the server-rendered markup as inline styles, and nothing but the client bundle
 * ever changes them — the same trap Reveal documents, answered the same way. The `<noscript>`
 * rescue below widens every card to a fixed readable tile, shows every label, and — because the card is
 * then at its EXPANDED width — puts the expanded cover on top of the spine, so with scripting off the
 * shelf degrades to a scrollable row of labelled covers rather than a row of anonymous slivers.
 * (`!important` because the values it must beat are inline.)
 *
 * REDUCED MOTION collapses the DURATIONS to zero — the width change itself survives, because it is
 * user-driven state (their hover, their tap), not an entrance. The label's hidden state is
 * `opacity: 0` in both branches, per the variants.ts rule: reduction never changes what a state
 * looks like, only how long the trip between states takes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The label block is `aria-hidden`: it appears and disappears with hover, which is presentation,
 * and the link's `aria-label` carries the same words (title and meta) at ALL times — a screen
 * reader hears every album's name and count whether or not anything is expanded. `aria-expanded`
 * on the link carries the STATE half of that answer, flipping as the card does, so the expansion
 * is not invisible to AT: a non-visual reader hears which album is currently open, and a touch AT
 * user whose first tap previews hears the state change that tap produced instead of silence.
 */

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { Images } from "lucide-react";

import { DURATION, EASE_OUT, useReducedMotionPreference } from "@/components/motion";
import { MediaImage } from "@/components/ui/MediaImage";
import type { Picture } from "@/lib/media/screens";

/**
 * ONE PICTURE THE CARD CAN DRAW — the spine or the expanded cover.
 *
 * It is a shape rather than three loose props because the card now holds TWO of them and they must carry
 * exactly the same four things. Two parallel sets of `spineSrc` / `spineAlt` / `spinePicture` /
 * `spineBlur` would be eight props whose only relationship is a naming convention, and the first one
 * somebody forgot to pass would fail as a silently unblurred or unframed picture rather than as a type
 * error.
 */
export interface ExpandOnHoverFace {
  /** A FINISHED URL (the caller resolves it via `mediaSrc`), or null for the plate fallback. */
  imageSrc: string | null;
  /** Stored alt text; `""` marks the picture decorative, and the link's own label does the naming. */
  alt: string;
  /**
   * Per-screen framing for THIS picture, already resolved by the caller (`pictureFromMap`).
   *
   * ⚠ IT IS THE ONE THING THIS ISLAND TAKES THAT IS NOT A FINISHED STRING, and the exception is
   * deliberate: a card runs from a 4rem sliver to a 24rem square, so a rectangle framed for one width is
   * wrong at the other — which is the whole reason per-screen framing exists (lib/media/screens.ts). The
   * geometry has to change at a breakpoint, and a URL cannot express that.
   *
   * Nothing else moves — but "one band" is NOT the same as "no crop", and reading it that way was a bug.
   * One band means nobody overrode anything per SCREEN; the band still carries the asset's own stored
   * rectangle, which `resolvePicture` folds in as the base of the cascade. So the card takes the `imageSrc`
   * path only when there is no crop of either kind, which is what keeps a genuinely unframed, uncropped
   * album byte-identical without dropping a crop an editor did set.
   */
  picture?: Picture | null;
  /**
   * The cover's inline blur placeholder, if the asset has one.
   *
   * ⚠ IT IS HERE BECAUSE THE `imageSrc` BRANCH BELOW HAD NO PLACEHOLDER AT ALL, which is not a missing
   * nicety — it is the difference between a card that fills in and a card that is an empty grey
   * rectangle until the bytes land. `MediaImage` passes `placeholder="blur"` for every asset that has
   * one, so every OTHER photograph on the site fades up from a blur; the shelf's plain branch is a
   * hand-rolled `<Image>` that skipped it, so the one surface whose whole job is showing covers was the
   * one surface showing none of them while they arrived. A blur is under a kilobyte and is already in
   * the row the page fetched, so it costs a string on a prop and nothing on the wire.
   */
  blurDataUrl?: string | null;
}

export interface ExpandOnHoverItem {
  href: string;
  /**
   * The picture the OPEN card shows — the album's cover, composed for a wide frame.
   *
   * Required, because a card must always have something to draw. With no spine below it, this is drawn
   * in both states and the card behaves exactly as it always has.
   */
  expanded: ExpandOnHoverFace;
  /**
   * The picture the COLLAPSED card shows — the book's spine. Null when the album has only one picture.
   *
   * ⚠ NULL IS THE BACKWARDS-COMPATIBLE PATH AND IT IS NOT A DEGRADED ONE. Every album that predates the
   * spine column has one photograph, and for those this stays null, the two-layer branch below does not
   * run at all, and the card emits exactly the markup it emitted before any of this existed — one
   * picture, no opacity layers, no cross-fade. That is the same guarantee `resolvePicture` makes with a
   * single band and for the same reason: a feature nobody has used must cost nothing and change nothing.
   *
   * The caller decides what "has a spine" means and must not pass a face that is merely a second copy of
   * `expanded` — two identical layers would cross-fade a picture into itself, which is a frame of
   * pointless work and, at 50% through the fade, a visibly half-transparent card.
   */
  spine?: ExpandOnHoverFace | null;
  /**
   * Fetch this card's pictures eagerly rather than lazily.
   *
   * ⚠ `next/image` IS LAZY BY DEFAULT, AND ON THIS PAGE THAT IS THE WRONG DEFAULT FOR THE FIRST ROW.
   * The first shelf sits directly under the hero and is on screen at first paint on any laptop, but a
   * lazy image is not requested until the browser has laid the page out and the intersection observer
   * has fired — so the covers a reader is already looking at start downloading last, behind everything
   * below the fold. `priority` puts a preload in the head for exactly the ones that are already visible.
   *
   * The caller decides, and it must stay a small number: contract §13's rule that "more than one or two
   * per page and none of them is a priority" is the whole reason this is a per-item flag rather than a
   * shelf-wide one. See `EAGER_COVERS` in app/(site)/gallery/page.tsx.
   */
  priority?: boolean;
  title: string;
  /** One short line under the title — "March 2026 · 84 pictures". Plain text; it is also read
   *  into the link's accessible name, where markup would be noise. */
  meta?: string;
}

export interface ExpandOnHoverProps {
  items: ExpandOnHoverItem[];
  className?: string;
}

const MotionLink = motion.create(Link);

/**
 * The geometry, in rem strings framer can interpolate. The ACTIVE widths equal the row heights on
 * the `<ul>` below (`h-64` = 16rem, `lg:h-96` = 24rem), which is what makes the expanded card a
 * square without an aspect-ratio rule fighting the width animation.
 */
const WIDTH = {
  collapsedSmall: "4rem",
  collapsedLarge: "5rem",
  activeSmall: "16rem",
  activeLarge: "24rem"
} as const;

/**
 * The `sizes` hint, written once because both layers below must state the SAME slot width.
 *
 * 384px is `WIDTH.activeLarge` (24rem) and 256px is `WIDTH.activeSmall` (16rem) — the widest this card
 * ever gets on each side of `lg`. A collapsed sliver is far narrower, but `sizes` has to describe the
 * WIDEST the slot reaches: it is resolved once, when the picture is fetched, and the card widens after
 * that without a second chance to choose a file.
 */
const COVER_SIZES = "(min-width: 1024px) 384px, 256px";

/**
 * The source width to ask `MediaImage` for. READ THE REASONING — THIS NUMBER WAS THE BUG.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE FRAMED BRANCH USED TO PASS NO `targetWidth` AT ALL, so it took `MediaImage`'s default of 1600
 * (`DEFAULT_TARGET_WIDTH`, tuned for a full-bleed hero) for a card that is 384 CSS px at its very widest.
 * That alone is a four-fold over-fetch. The part that made it a RENDERING fault rather than a waste is
 * what `MediaImage` then does with it: a crop needs a bigger source than the frame does, so it asks for
 * `targetWidth / crop.width` — and at 1600 a perfectly ordinary crop keeping 40% of the width asks for
 * 4000px. Nothing in the derivative pipeline is that wide (`VARIANT_WIDTHS` stops at 2560), so
 * `pickVariant` finds no variant at or above it, `mediaSrc`'s "a derivative narrower than the original
 * is never served into a slot that asked for more" clause fires, and the answer is **the original file** —
 * the untouched camera upload, retained for ever by design and frequently many megabytes.
 *
 * So the albums an editor had taken the trouble to crop were precisely the ones whose covers were served
 * as full-size originals, twelve to a page, each needing its own on-demand `sharp` pass in the image
 * optimiser before a single byte could reach the browser. That is the "the images are there but they do
 * not render" report: on a cold optimiser cache the request is still in flight (or has fallen over) while
 * the reader hovers. An UNcropped album took the `imageSrc` branch, which correctly asks for 1080 — which
 * is why the fault looked arbitrary from the outside, appearing on some albums and not others.
 *
 * 768 = 384 CSS px × 2, the widest this card is drawn on a 2× screen. For an uncropped cover that lands
 * on the `md` (1080) derivative — the same file the `imageSrc` branch has always asked for, so the two
 * branches finally agree. For a cover cropped to 40% it asks for 1920 and lands on `xl` (2560) where one
 * exists, which is a real derivative instead of the original.
 *
 * ⚠ IT IS NOT A CAP, AND MUST NOT BECOME ONE. `MediaImage` still scales the request by the crop, and that
 * scaling is correct: showing 40% of a photograph at 768 device px genuinely needs 1920px of source, and
 * capping it would trade a slow picture for a soft one. What is fixed here is the BASE the scaling starts
 * from, which was describing a hero rather than this card.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const COVER_TARGET_WIDTH = 768;

/**
 * The no-JS rescue — see the header. One fixed width for every viewport, because a stylesheet that
 * cannot run JavaScript cannot know which card the reader wanted large; a uniform 16rem tile keeps
 * every cover recognisable and every label readable inside the scrolling row.
 */
const NOSCRIPT_CSS =
  "[data-expand-card]{width:16rem!important}[data-expand-label]{opacity:1!important}" +
  // ⚠ AND IT MUST FLIP THE TWO FACES, not just widen the card. framer writes the RESTING state into the
  // server-rendered markup — spine at `opacity: 1`, expanded at `opacity: 0` — and with no JavaScript
  // nothing ever changes them. The rescue widens every card to its EXPANDED geometry, so leaving the
  // spine on top would show a picture composed for a 4rem sliver stretched across a 16rem tile, which is
  // a worse picture than the one it is hiding. The expanded cover is the right face for that width.
  '[data-expand-face="spine"]{opacity:0!important}[data-expand-face="expanded"]{opacity:1!important}';

/** False on the server and the first client render, so hydration sees what SSR drew. */
function useLargeViewport(): boolean {
  const [large, setLarge] = useState(false);

  useEffect(() => {
    // Tailwind's `lg`, restated here because framer's inline widths are out of CSS's reach anyway.
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setLarge(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return large;
}

/**
 * Whether this focus should read as DELIBERATE (keyboard) rather than incidental (tap, click).
 * The try/catch is for an engine that predates the selector, where every focus is treated as
 * deliberate — the failure mode is an expansion, not a lost navigation.
 */
function isFocusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * ONE picture of a card, by whichever of the three paths its data calls for.
 *
 * Extracted so the spine and the expanded cover cannot drift: they are the same three branches, the same
 * `sizes`, the same source width and the same fallback plate, and the moment they were written out twice
 * one of them would quietly lose the crop test or the blur. It renders a positioned layer in every
 * branch, so it drops into the single-face card and into either half of the two-layer stack unchanged.
 */
function ShelfFace({ face, priority }: { face: ExpandOnHoverFace; priority?: boolean }) {
  if (face.picture && (face.picture.length > 1 || face.picture[0].crop)) {
    /*
      THE CROPPED OR FRAMED PICTURE. `MediaImage` owns the per-width geometry — one `<style>` block of
      custom properties per band, which is the only way a crop can change at a breakpoint (see its own
      header).

      ⚠ `|| face.picture[0].crop` IS NOT BELT-AND-BRACES; WITHOUT IT A CROP WAS IGNORED HERE. The test
      used to be `length > 1` alone, on the reasoning that one band means "nobody overrode anything". One
      band means nobody overrode anything PER SCREEN — the band still carries the asset's OWN stored
      rectangle, because `resolvePicture` folds `storedCrop` in as the base of the cascade. So an album
      whose FILE an editor had cropped drew uncropped on this shelf while a per-screen framing drew
      cropped: two albums side by side obeying different rules, and the cropped one silently losing the
      decision.

      A picture with no crop and no framing still takes the plain `<Image>` branch below, so that case
      stays byte-identical.

      ⚠ THE `absolute inset-0` GOES ON A WRAPPER, NOT THROUGH `className`. `MediaImage` renders a
      `position: relative` frame, and `.relative` is defined AFTER `.absolute` in Tailwind's own output —
      so an `absolute` passed in loses on source order and the layer would sit in flow inside a link that
      has no height of its own. `aspect="none"` because the card's height is the shelf's, not the
      photograph's.
    */
    return (
      <span className="absolute inset-0 block">
        <MediaImage
          media={face.picture[0].media}
          picture={face.picture}
          alt={face.alt}
          aspect="none"
          rounded="none"
          sizes={COVER_SIZES}
          // See `COVER_TARGET_WIDTH`. Without it this branch asked for a hero-sized source and, on any
          // cropped picture, for the full-size original.
          targetWidth={COVER_TARGET_WIDTH}
          priority={priority}
          className="h-full w-full"
        />
      </span>
    );
  }

  if (face.imageSrc) {
    // `fill` + `object-cover`: the picture re-crops live as the width animates, which is the reference
    // behaviour — a collapsed card shows a sliver OF the photograph.
    return (
      <Image
        src={face.imageSrc}
        alt={face.alt}
        fill
        sizes={COVER_SIZES}
        priority={priority}
        // The blur the rest of the site gets through `MediaImage` and this branch did not — see
        // `blurDataUrl` on the face. `blurDataURL` is next/image's capitalisation and the column is
        // `blurDataUrl`; getting it the wrong way round is a silent no-op.
        placeholder={face.blurDataUrl ? "blur" : "empty"}
        blurDataURL={face.blurDataUrl ?? undefined}
        className="object-cover"
      />
    );
  }

  // The plate for an album with no picture at all — the shelf equivalent of EntityCard's
  // `mediaFallback`. A glyph, not initials: an album title's initials are not a short form of anything
  // (see CraftPlate's header). The card's name still reaches every reader through the link label.
  return (
    <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
      <Images className="h-6 w-6 text-ink-300" />
    </span>
  );
}

export function ExpandOnHover({ items, className }: ExpandOnHoverProps) {
  const reduce = useReducedMotionPreference();
  const large = useLargeViewport();
  const [active, setActive] = useState<number | null>(null);

  /**
   * Did the CURRENT tap begin, at pointerdown, as a touch on a still-collapsed card? Recorded
   * before the tap's own focus and click events can change anything — see the header's touch
   * bullet for why the click handler must trust this snapshot over the live state. One ref serves
   * the whole shelf because one tap cannot span two cards: its pointerdown and its click land on
   * the same link, and the click handler consumes and clears it either way. A ref rather than
   * state, because recording it must not re-render mid-gesture.
   */
  const touchTapOnCollapsed = useRef(false);

  // DURATION.page is the contract's width-change duration; scrim is its bare-opacity one (§8).
  const widthTransition = { duration: reduce ? 0 : DURATION.page, ease: EASE_OUT };
  const labelTransition = { duration: reduce ? 0 : DURATION.scrim, ease: EASE_OUT };

  return (
    <div className={className}>
      {/* `overflow-x-auto` is the narrow-screen answer: the slivers keep their readable width and
          the shelf scrolls, rather than shrinking every book to an unusable thread. The `p-1` keeps
          the global focus outline (2px + 2px offset) inside the scroll container instead of clipped
          by it. */}
      <ul className="flex h-64 gap-2 overflow-x-auto p-1 lg:h-96">
        {items.map((item, index) => {
          const isActive = active === index;
          const width = isActive
            ? large
              ? WIDTH.activeLarge
              : WIDTH.activeSmall
            : large
              ? WIDTH.collapsedLarge
              : WIDTH.collapsedSmall;

          return (
            <li key={item.href} className="h-full shrink-0">
              <MotionLink
                href={item.href}
                aria-label={item.meta ? `${item.title} — ${item.meta}` : item.title}
                // The state half of the accessible answer (the label above is the name half): the
                // expansion is otherwise pure geometry, invisible to anyone not looking at it.
                aria-expanded={isActive}
                data-expand-card=""
                initial={false}
                animate={{ width }}
                transition={widthTransition}
                onPointerEnter={(event) => {
                  // Touch taps also fire pointerenter; they are handled by the click branch below
                  // so the first tap previews instead of hovering-and-navigating in one gesture.
                  if (event.pointerType !== "touch") setActive(index);
                }}
                onPointerDown={(event) => {
                  // The snapshot the click handler trusts: taken here because pointerdown is the
                  // one moment in a tap that nothing else has run yet — focus and click both come
                  // after it, so neither can pollute this reading. See the header's touch bullet.
                  touchTapOnCollapsed.current = event.pointerType === "touch" && active !== index;
                }}
                onFocus={(event) => {
                  // Keyboard only — see the header for why tap-focus must NOT activate here. Even
                  // where an engine disagrees about what `:focus-visible` covers, the pointerdown
                  // snapshot above keeps a touch tap's click from navigating off this expansion.
                  if (isFocusVisible(event.currentTarget)) setActive(index);
                }}
                onClick={(event) => {
                  const firstTapOnCollapsed = touchTapOnCollapsed.current;
                  touchTapOnCollapsed.current = false;

                  // Keyboard activation arrives as a click with `detail === 0` (no pointer, so no
                  // pointerdown either). It always NAVIGATES: focus already ran the preview when
                  // it was going to, and preventDefault-ing an Enter — even on a card that is
                  // still collapsed — would swallow an activation the reader meant. The header's
                  // keyboard bullet is the full argument.
                  if (event.detail === 0) return;

                  // The second half of the two-tap dance: a touch tap that BEGAN on a collapsed
                  // card becomes its expansion, and the next tap clicks through. `!isActive`
                  // remains as the backstop for any pointer click that somehow reached a
                  // collapsed card without a preceding hover — an expansion, never a blind
                  // navigation.
                  if (firstTapOnCollapsed || !isActive) {
                    event.preventDefault();
                    setActive(index);
                  }
                }}
                className="relative block h-full overflow-hidden rounded-lg border border-line-200 bg-surface-100"
              >
                {item.spine ? (
                  /*
                    TWO PICTURES, STACKED, CROSS-FADING — the spine morphing into the expanded cover.

                    ⚠ THIS BRANCH RUNS ONLY FOR AN ALBUM THAT HAS A SECOND PICTURE. With `spine` null the
                    `else` below emits exactly one face and exactly the markup this card emitted before
                    the spine existed — no layers, no opacity, no cross-fade. That is the whole
                    backwards-compatibility guarantee and it is structural rather than a value that
                    happens to be equal: an album with one picture cannot take a code path that assumes
                    two.

                    ⚠ BOTH LAYERS ARE ALWAYS MOUNTED, never swapped with a conditional. Mounting the
                    expanded picture on first hover would start its download on first hover, so the
                    reader would watch a blank card fill in every single time — which is the "expanded
                    image is not rendering" complaint rebuilt out of new parts. Two `absolute inset-0`
                    layers at opposite opacities cost one extra element and let the browser fetch both
                    while the shelf is idle.

                    ⚠ THE FADE USES THE WIDTH'S OWN TRANSITION, deliberately. The picture must finish
                    changing exactly as the card finishes widening; give the two different durations and
                    one gesture reads as two events — the card stops moving and then, separately, the
                    photograph changes its mind.
                  */
                  <>
                    <motion.span
                      /*
                        `aria-hidden` because it is the SAME ALBUM as the layer below it. The link's
                        `aria-label` already names the album at all times, and the expanded layer carries
                        the real alt text — announcing a second picture of the same thing would be the
                        duplication the label block below is also `aria-hidden` to avoid.
                      */
                      aria-hidden="true"
                      data-expand-face="spine"
                      initial={false}
                      animate={{ opacity: isActive ? 0 : 1 }}
                      transition={widthTransition}
                      className="absolute inset-0 block"
                    >
                      {/* The priority flag rides the layer that is actually PAINTED at rest. Putting it
                          on both would put two preloads in the head for one card, for a picture nobody
                          has hovered yet — see `priority` on the item. */}
                      <ShelfFace face={item.spine} priority={item.priority} />
                    </motion.span>

                    <motion.span
                      data-expand-face="expanded"
                      initial={false}
                      animate={{ opacity: isActive ? 1 : 0 }}
                      transition={widthTransition}
                      className="absolute inset-0 block"
                    >
                      <ShelfFace face={item.expanded} />
                    </motion.span>
                  </>
                ) : (
                  <ShelfFace face={item.expanded} priority={item.priority} />
                )}

                {/* The scrim and label as ONE fading layer. The gradient is literal purple-950 —
                    the site's one photographic ground — because the text on it is unconditionally
                    white, so its scrim must be unconditionally dark (see ImageCredit). The inner
                    spans hold a FIXED width (active width minus the padding) so the words do not
                    rewrap while the card is still travelling. */}
                <motion.span
                  aria-hidden="true"
                  data-expand-label=""
                  initial={false}
                  animate={{ opacity: isActive ? 1 : 0 }}
                  transition={labelTransition}
                  className="pointer-events-none absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-purple-950/85 via-purple-950/40 to-transparent p-4"
                >
                  <span className="block w-56 text-sm font-semibold leading-snug text-white lg:w-[22rem]">
                    {item.title}
                  </span>
                  {item.meta ? (
                    <span className="mt-1 block w-56 text-xs text-white/80 lg:w-[22rem]">
                      {item.meta}
                    </span>
                  ) : null}
                </motion.span>
              </MotionLink>
            </li>
          );
        })}
      </ul>

      {/* Parsed only when scripting is off — the same mechanism as Reveal's rescue, and outside
          the `<ul>` because `<noscript>` is not a permitted child of a list. */}
      <noscript className="hidden">
        <style>{NOSCRIPT_CSS}</style>
      </noscript>
    </div>
  );
}
