"use client";

/**
 * ExpandOnHover — a shelf of "books". Every item is a tall collapsed sliver; the active one widens
 * to a square and shows its cover large, with a scrim and a label rising from its foot. Activating
 * a card NAVIGATES: the whole card is a `next/link`, so hover expands and click follows.
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
 * rescue below widens every card to a fixed readable tile and shows every label, so with scripting
 * off the shelf degrades to a scrollable row of labelled covers rather than a row of anonymous
 * slivers. (`!important` because the values it must beat are inline.)
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

export interface ExpandOnHoverItem {
  href: string;
  /** A FINISHED URL (the caller resolves it via `mediaSrc`), or null for the plate fallback. */
  imageSrc: string | null;
  /** Stored alt text; `""` marks the cover decorative, and the link's own label does the naming. */
  alt: string;
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
 * The no-JS rescue — see the header. One fixed width for every viewport, because a stylesheet that
 * cannot run JavaScript cannot know which card the reader wanted large; a uniform 16rem tile keeps
 * every cover recognisable and every label readable inside the scrolling row.
 */
const NOSCRIPT_CSS =
  "[data-expand-card]{width:16rem!important}[data-expand-label]{opacity:1!important}";

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
                {item.imageSrc ? (
                  // `fill` + `object-cover`: the cover re-crops live as the width animates, which
                  // is the reference behaviour — a collapsed card shows a sliver OF the picture.
                  <Image
                    src={item.imageSrc}
                    alt={item.alt}
                    fill
                    sizes="(min-width: 1024px) 384px, 256px"
                    className="object-cover"
                  />
                ) : (
                  // The plate for an album with no cover — the shelf equivalent of EntityCard's
                  // `mediaFallback`. A glyph, not initials: an album title's initials are not a
                  // short form of anything (see CraftPlate's header). The card's name still
                  // reaches every reader through the link label above.
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    <Images className="h-6 w-6 text-ink-300" />
                  </span>
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
