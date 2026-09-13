"use client";

/**
 * SocialMenu — the Centre's own accounts, as a dropdown in the header pill.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS NOT A THIRD DROPDOWN PATTERN. IT IS THE NAV'S TWO, EACH WHERE IT ALREADY APPLIES.
 *
 * The pill already holds two menus, and they differ because their TRIGGERS differ:
 *
 *   • `StripItem` (components/site/SiteHeader.tsx:508) — a section link that also reveals its
 *     children. Its trigger is a real destination, so it opens on hover AND focus, and its panel is a
 *     plain `<ul>` of links inside a disclosure: no `role="menu"`, no roving tabindex, no arrow keys.
 *     Its own header argues that at length and the argument holds here.
 *   • `AccessibilityMenu` (components/ui/AccessibilityMenu.tsx:190) — a `<button>` that opens a panel
 *     of controls. It toggles on CLICK, closes on outside pointerdown, and restores focus.
 *
 * This control has a button trigger (there is no "socials page" to point at) and a panel of LINKS. So
 * it takes the trigger contract from the accessibility menu and the panel language from the strip, and
 * invents neither.
 *
 * ⚠ HOVER-TO-OPEN WAS DELIBERATELY NOT COPIED FROM `StripItem`, AND THE REASON IS A BUG, NOT TASTE. A
 * trigger that opens on hover and toggles on click cannot be pressed: the pointer is by definition over
 * the element when the click lands, so the click closes the panel and the very next pointer event
 * reopens it. `StripItem` escapes that only because its trigger is an anchor — a click there navigates
 * rather than toggling. A button has nowhere to go.
 *
 * ⚠ NO ARROW KEYS, AND THAT IS THE MEASURED ANSWER RATHER THAN AN OMISSION. Arrow-key movement between
 * entries is owed to a `role="menu"`, and a role="menu" is owed a roving tabindex and Home/End with it;
 * a half-built one strands focus on an element the reader cannot leave. NEITHER menu in this pill does
 * it — `StripItem`'s header refuses it in those words, and `AccessibilityMenu`'s theme group refuses it
 * again at AccessibilityMenu.tsx:246. The panel's links sit immediately after the trigger in DOM order,
 * so Tab walks straight into an open panel and out the far side, which is the behaviour the rest of the
 * navigation already has.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * OPEN STATE IS THE HEADER'S, NOT THIS COMPONENT'S, and that is what buys three behaviours for free:
 * opening this closes any strip dropdown (one panel under one pill), the scroll collapse closes it
 * (SiteHeader.tsx:301 — a panel anchored to a pill that is resizing is left hanging under nothing), and
 * a route change closes it (SiteHeader.tsx:314). A second `useState` in here would have to re-implement
 * all three and would still let two panels open at once.
 */

import {
  useEffect,
  useId,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, AtSign, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { socialIcon, socialLabel } from "@/lib/socials";
import type { SocialLink } from "@/lib/settings/schema";
import { SPRING_POPOVER, useReducedMotionPreference } from "@/components/motion";
import { EXTERNAL_LINK_PROPS } from "@/components/site/NavSheet";

/**
 * The sentinel this control occupies in the header's `openMenuId` register.
 *
 * A leading underscore pair because that register otherwise holds `NavNode.id` values, which are
 * database cuids: no navigation row can ever collide with this, so an editor cannot accidentally name a
 * menu entry that opens the socials panel instead of its own children.
 */
export const SOCIAL_MENU_ID = "__socials";

export interface SocialMenuProps {
  /** `settings.social.links`, already in the editor's chosen order. */
  links: readonly SocialLink[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  className?: string;
}

/**
 * The trigger's recipe is `CONTROL_BASE` from SiteHeader — the search control and the hamburger either
 * side of it wear exactly this, so the three read as one cluster. It is restated rather than imported
 * because a complete literal class string is the only kind Tailwind's scanner can see (contract §5),
 * and exporting a constant across two files to share one string is how the two quietly drift.
 */
const TRIGGER_BASE =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-surface-100 hover:text-ink-900";

/** The strip dropdown's row, verbatim from SiteHeader.tsx:615 — one visual language, not two. */
const ROW =
  "flex min-h-10 items-center gap-2.5 rounded-md px-3 py-2 text-sm text-ink-700 transition hover:bg-surface-100 hover:text-ink-900";

export function SocialMenu({ links, open, onOpen, onClose, className }: SocialMenuProps) {
  const reduce = useReducedMotionPreference();
  const panelId = useId();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Close when a pointer lands anywhere else on the page.
   *
   * CAPTURE PHASE, exactly as AccessibilityMenu.tsx:151 does it: a control elsewhere on the page that
   * calls `stopPropagation` must not be able to strand this panel open over content the reader has
   * moved on to. The trigger lives inside `root`, so its own press falls through to the toggle below
   * rather than being closed here and immediately reopened by the same click.
   */
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target;
      if (target instanceof Node && root.contains(target)) return;
      onClose();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onClose]);

  /** Focus leaving the whole group — trigger to elsewhere, last link to elsewhere — closes it. */
  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (!open) return;
    const next = event.relatedTarget;
    // Movement WITHIN the group (trigger → first link, link → link) must not close it. A null
    // `relatedTarget` — a click on bare page, a focus lost to <body> — is genuinely "left", so it does.
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    onClose();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    // Swallowed so one Escape cannot also close the navigation sheet or a dialog this is rendered
    // inside, leaving the reader to guess which of two things they just dismissed (contract §14).
    event.stopPropagation();
    onClose();
    // Focus goes back to the trigger rather than being left on a link that is about to vanish — the
    // same restoration StripItem performs at SiteHeader.tsx:533.
    triggerRef.current?.focus();
  };

  // Rendered only when there is something to list. An empty dropdown is a control that answers a press
  // with nothing, which is worse than a control that was never there (contract §1.8) — and a fresh
  // install genuinely has no social links until an administrator adds one.
  if (links.length === 0) return null;

  return (
    <div
      ref={rootRef}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className={cn("relative", className)}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        // Only while the panel is mounted: an `aria-controls` pointing at an id that is not in the
        // document is worse than no `aria-controls` at all (contract §11).
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? onClose() : onOpen())}
        className={TRIGGER_BASE}
      >
        <AtSign aria-hidden="true" className="h-4 w-4 shrink-0" />
        {/* The icon is decorative, so this span IS the button's accessible name — and it names what
            the button OPENS, not what it does, because `aria-expanded` is already saying "opens". A
            screen reader reads "Social links, collapsed, button". */}
        <span className="sr-only">Social links</span>
        {/* The same affordance, at the same size, as a strip dropdown's chevron (SiteHeader.tsx:553):
            it is what tells a sighted reader this reveals a list rather than going somewhere. The
            rotation is a plain CSS transition, so the global reduced-motion rule collapses it to an
            instant flip — the DIRECTION is the signal and it survives either way. */}
        <ChevronDown
          aria-hidden="true"
          className={cn("h-3.5 w-3.5 shrink-0 transition", open && "rotate-180")}
        />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            id={panelId}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={reduce ? { duration: 0 } : SPRING_POPOVER}
            /*
              `right-0`, where a strip dropdown is `left-0`: this control sits in the cluster at the
              RIGHT end of the pill, and a left-aligned panel there would hang off the side of the
              viewport on a phone. `max-w-` is the second half of the same guard, for the case where
              even the pill is wider than the screen.

              z-10 is the "in-page chrome" rung and it is LOCAL: the pill's `backdrop-filter` opens a
              stacking context of its own, so this cannot escape from under the nav sheet's scrim or a
              dialog however high it climbs inside the pill (contract §6).

              ⚠ `pt-3` ON THE WRAPPER, NOT `mt-3` ON THE LIST, and that is the whole reason there are
              two elements here. The spelling is `StripItem`'s (SiteHeader.tsx:609) but the defect it
              prevents HERE is a different one, so it is worth saying rather than inheriting: a margin
              would put 12px of bare page between the trigger and the panel, and a pointer landing in
              that gap is a pointer landing OUTSIDE the root — which the capture-phase listener above
              reads as "clicked elsewhere" and closes the menu with, just as the reader was aiming at
              it. Padding is transparent, belongs to the group, and `contains()` counts it.
            */
            className="absolute right-0 top-full z-10 w-60 max-w-[calc(100vw-2rem)] pt-3"
          >
            <ul className="flex flex-col gap-0.5 rounded-lg border border-line-200 bg-card p-1.5 shadow-panel">
              {links.map((link, index) => {
                const Icon = socialIcon(link.platform);
                const name = socialLabel(link);

                return (
                  // Keyed by position as well as value: `social.links` is an editor-ordered array with
                  // no ids, and two rows pointing at the same URL would otherwise share a key.
                  <li key={`${index}-${link.url}`}>
                    <a
                      href={link.url}
                      /*
                        ⚠ `EXTERNAL_LINK_PROPS`, NEVER A HAND-TYPED PAIR — `noopener` is the security
                        half (the opened page cannot reach back through `window.opener`) and
                        `noreferrer` the privacy half, and NavSheet.tsx:67 is the one definition so the
                        menus of this site cannot disagree about what "external" means.
                      */
                      {...EXTERNAL_LINK_PROPS}
                      className={ROW}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      {/* Every outbound link in this navigation is paired with a spoken warning: a
                          reader whose focus lands in a new tab with no notice has lost their place and
                          their Back button with it. Same sentence as SiteHeader.tsx:627, verbatim, so
                          a screen-reader user hears one phrasing across the whole site. */}
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
