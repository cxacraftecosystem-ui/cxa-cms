"use client";

/**
 * Accordion — a disclosure whose height is animated by CSS, not by JavaScript.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ A CLOSED PANEL IS HIDDEN, NOT UNMOUNTED — AND THIS FILE USED TO SAY THE OPPOSITE
 *
 * The previous version destroyed a closed panel's children and called that "a behavioural contract,
 * not an optimisation". It was changed for one reason: **a printed page could not contain it.**
 *
 * `app/globals.css` carries a full paper edition of this site, and its own group 7 recorded this as
 * the limit of what a stylesheet can do — *"a closed accordion section is not in the document, so no
 * stylesheet can print it. A page whose body is a set of disclosures prints as its open one; making
 * the paper edition print all of them is a change in `ui/Accordion`, not here."* Both callers are FAQ
 * lists (`components/sections/faq/FaqList.tsx`, and the project record's own questions), which is to
 * say: the one thing a researcher is most likely to print — a page of questions and answers — printed
 * as a column of questions with a single answer under one of them.
 *
 * `display: none` is what closes it now, and it buys the two guarantees the unmount was providing:
 * an element that is not rendered is not in the accessibility tree and cannot take focus. So a closed
 * section is exactly as unreachable by keyboard and by screen reader as it was before. What changed is
 * that it is in the DOM, where `@media print` can reveal it — which the print block now does, keyed on
 * `data-accordion-panel` below.
 *
 * ⚠ WHY NOT `beforeprint`, WHICH WOULD HAVE KEPT THE UNMOUNT. Opening every panel from a `beforeprint`
 * listener (with `flushSync`, since the browser snapshots the page as soon as the handler returns) is
 * the obvious alternative and it fails silently in the cases that matter most: `page.pdf()` in
 * Puppeteer/Playwright and DevTools' "emulate CSS media type" both render with print styles applied
 * and never fire the event. A paper edition that is correct only when a human presses Ctrl+P is worse
 * than one that is always correct, because the automated check that would have caught the regression
 * is precisely the thing that cannot see it.
 *
 * WHAT THIS CHANGES FOR A CALLER, stated plainly because the old warning said the reverse:
 *
 *   • Children are MOUNTED while the section is shut. Effects run once, on first render, not on every
 *     reopening — so a lazy loader in a child no longer re-fires, and local state in a panel now
 *     survives being closed. Both are strictly friendlier than the behaviour they replace, and no
 *     existing caller depended on the old one: both put plain text in a panel and both say so.
 *   • ⚠ BUT THE CHILDREN ARE REAL. A panel whose contents are expensive to RENDER — a rich-text
 *     editor, a media picker, a map — now pays that cost on the first paint of the page rather than
 *     on the first press. `display: none` costs no layout and no paint, so the cost is React's alone,
 *     but it is not zero. A screen that wants twenty heavy panels should render its own
 *     `{open ? <Editor/> : null}` inside the panel and keep this component for the disclosure.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * HEIGHT IS ANIMATED THROUGH `--accordion-content-height`, which the `accordion-down` /
 * `accordion-up` keyframes in tailwind.config.ts read. CSS cannot animate to `height: auto`, so the
 * real measured height has to be handed to the keyframes as a number. A `ResizeObserver` on the
 * content writes it DIRECTLY TO THE NODE rather than through React state: the observer fires on every
 * content resize, and routing that through a render would lay out the panel again and wake the
 * observer that caused it.
 *
 * The variable is written in a LAYOUT effect, before paint, because a CSS animation resolves its
 * keyframe values when it starts — set the variable afterwards and the first open animates to the
 * `auto` fallback, which is not animatable and simply snaps.
 *
 * ⚠ AND THE EFFECT IS GATED ON VISIBILITY RATHER THAN ON THE PANEL EXISTING, which is the one place
 * the change above could have broken the animation. `offsetHeight` is 0 for a `display: none`
 * element, and a `ResizeObserver` watching one reports a zero box — so measuring a shut panel would
 * write `--accordion-content-height: 0px` and the next opening would animate from nothing to nothing.
 * The gate is `visible`, and because React runs layout effects AFTER it has committed the DOM change
 * that removed `hidden` and BEFORE the browser paints, the measurement on the opening pass reads the
 * real height — exactly as it did when the node was being created in that commit.
 *
 * There is no framer-motion here and therefore no JS reduced-motion branch: the global rule in
 * globals.css collapses CSS animation duration to 0.01ms, `animationend` still fires, and the panel
 * simply appears. That is the whole of the reduced-motion story for this component (contract §1.3).
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** `useLayoutEffect` warns when a client component is server-rendered; effects never run there. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The Tailwind animation is 0.2s, so this is twice its length and never races it.
 *
 * ⚠ THIS COMMENT USED TO SAY "the panel must still unmount", WHICH THE PANEL NO LONGER DOES — the
 * change described at length in the header is exactly that a shut panel stays in the document. What
 * the timer still guarantees is the thing that actually matters for a reader: a panel whose closing
 * animation never reports itself finished must still reach `phase === "closed"`, because `closed` is
 * what applies `hidden` — and `hidden` is what takes the panel out of the accessibility tree and out
 * of the tab order. Miss it and a section the reader has closed is still reachable by Tab and still
 * read out, while looking shut on screen: the accessible state and the visible state disagree, which
 * is worse than either being wrong on its own.
 *
 * `animationend` can genuinely be missed — the element is removed from the render tree by an ancestor
 * mid-animation, or the tab is backgrounded across the whole 0.2s. It is a safety net that normally
 * never fires, not a timer the component depends on.
 */
const CLOSE_FALLBACK_MS = 400;

type Phase = "closed" | "open" | "closing";

export interface AccordionProps {
  children: ReactNode;
  className?: string;
}

/** A plain group with hairlines between the items. It holds no state: each item owns its own. */
export function Accordion({ children, className }: AccordionProps) {
  return (
    <div className={cn("divide-y divide-line-200 rounded-lg border border-line-200 bg-card", className)}>
      {children}
    </div>
  );
}

export interface AccordionItemProps {
  /** The trigger's visible label. It is also its accessible name, so keep it a phrase, not a sentence. */
  title: ReactNode;
  /** One line under the title, readable while the section is shut. */
  description?: string;
  icon?: LucideIcon;
  /** A count, a status chip — anything that belongs on the right of the row. */
  meta?: ReactNode;
  /** Controlled mode. Omit it and the item keeps its own state from `defaultOpen`. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function AccordionItem({
  title,
  description,
  icon: Icon,
  meta,
  open,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  className,
  children
}: AccordionItemProps) {
  const controlled = open !== undefined;
  const [selfOpen, setSelfOpen] = useState(defaultOpen);
  const isOpen = controlled ? open : selfOpen;

  const panelId = useId();
  const triggerId = useId();

  const [phase, setPhase] = useState<Phase>(isOpen ? "open" : "closed");
  // False until the reader has actually toggled something. An item that starts open must not play its
  // opening animation on the first paint of the page.
  const [animating, setAnimating] = useState(false);
  const previousOpen = useRef(isOpen);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (previousOpen.current === isOpen) return;
    previousOpen.current = isOpen;
    setAnimating(true);
    setPhase(isOpen ? "open" : "closing");
  }, [isOpen]);

  /**
   * Is the panel RENDERED? It is always in the document now (see the header); this is what decides
   * whether it is displayed, and therefore whether there is anything to measure or to animate.
   */
  const visible = phase !== "closed";

  useIsomorphicLayoutEffect(() => {
    // ⚠ Nothing may be measured while the panel is `display: none`: `offsetHeight` answers 0 there and
    // a ResizeObserver reports a zero box, so writing either into `--accordion-content-height` would
    // leave the NEXT opening animating from nothing to nothing. See the header.
    if (!visible) return;

    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const write = () => {
      wrapper.style.setProperty("--accordion-content-height", `${content.offsetHeight}px`);
    };

    write();
    const observer = new ResizeObserver(write);
    observer.observe(content);
    return () => observer.disconnect();
  }, [visible]);

  // The safety net described above. Cleared as soon as the animation reports itself finished.
  useEffect(() => {
    if (phase !== "closing") return;
    const handle = window.setTimeout(() => setPhase("closed"), CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(handle);
  }, [phase]);

  const toggle = () => {
    const next = !isOpen;
    if (!controlled) setSelfOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className={cn("overflow-hidden first:rounded-t-lg last:rounded-b-lg", className)}>
      <h3 className="m-0">
        {/*
          The heading wraps the button rather than sitting beside it, so assistive technology reports
          "Materials, collapsed, button, heading level 3" — one node carrying both facts.

          `aria-controls` is now UNCONDITIONAL, and that is a consequence of the change described in the
          header rather than a relaxation. It used to be set only while the panel was in the document,
          because pointing at a missing id is worse than not pointing (contract §11) — and the panel
          used to leave. It never leaves now, so the relationship is always true and always stated.

          ⚠ `data-accordion-trigger` IS NOT DECORATION AND IT IS NOT FOR STYLING. The print block in
          app/globals.css removes `button[type="button"]` wholesale — that is its precise spelling of
          "a control that triggers JavaScript", and every such control is meaningless on paper. This
          button is the exception, because the thing inside it is not a label for an action: it is the
          QUESTION, and every caller of this component is a list of questions and answers. Without the
          hook, group 4 of that stylesheet deletes every question on a printed FAQ page and leaves the
          answers standing on their own. The rule there excludes this attribute by name.
        */}
        <button
          type="button"
          data-accordion-trigger=""
          id={triggerId}
          aria-expanded={isOpen}
          aria-controls={panelId}
          disabled={disabled}
          onClick={toggle}
          className={cn(
            "flex w-full items-center gap-3 px-4 py-3.5 text-left transition",
            disabled ? "cursor-not-allowed opacity-60" : "hover:bg-surface-50"
          )}
        >
          {Icon ? <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" /> : null}

          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink-900">{title}</span>
            {description ? (
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{description}</span>
            ) : null}
          </span>

          {meta ? <span className="shrink-0 text-xs text-ink-500">{meta}</span> : null}

          {/* A plain CSS transition, so the global reduced-motion rule collapses it to an instant
              flip. The DIRECTION the chevron points is the signal, and it survives either way. */}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-4 w-4 shrink-0 text-ink-500 transition-transform duration-200 ease-out",
              isOpen && "rotate-180"
            )}
          />
        </button>
      </h3>

      {/*
        ⚠ ALWAYS IN THE DOCUMENT, DISPLAYED ONLY WHILE `visible`. The header explains at length why the
        unmount had to go; the two hooks below are what the rest of the system keys on.

        `hidden` (the attribute, not the utility) is what shuts it: an element that is not rendered is
        out of the accessibility tree and cannot be focused, so a closed section is exactly as
        unreachable as it was when it did not exist. ⚠ The `display: none` it implies is declared
        EXPLICITLY in app/globals.css as `[data-accordion-panel][hidden]`, not left to the user-agent
        stylesheet — a UA declaration loses to any author rule whatever its specificity, so the day
        somebody adds a `block` or `flex` utility to this element the panel would silently stop
        closing. The author rule cannot be beaten by a utility.

        `data-accordion-panel` is the print hook. A stable attribute rather than a class, matching
        every other selector in that stylesheet, so restyling this component cannot quietly empty the
        paper edition.
      */}
      <div
        ref={wrapperRef}
        id={panelId}
        data-accordion-panel=""
        hidden={!visible}
        role="region"
        aria-labelledby={triggerId}
        onAnimationEnd={(event) => {
          // Only this element's own animation counts; anything inside the panel that animates would
          // otherwise bubble up here and close the section that just opened.
          if (event.target !== wrapperRef.current) return;
          if (phase === "closing") setPhase("closed");
        }}
        className={cn(
          "overflow-hidden",
          // ⚠ `visible &&` is load-bearing now that the element persists. Without it a settled-closed
          // panel would keep `animate-accordion-down` on it (the ternary's else-branch answers for
          // "closed" as well as for "open"), and the class would then already be present when
          // `hidden` is removed — leaving whether the animation replays to display-change restart
          // semantics rather than to this component. Adding the class in the same commit that
          // displays the panel is the arrangement that was always intended.
          animating &&
            visible &&
            (phase === "closing" ? "animate-accordion-up" : "animate-accordion-down")
        )}
      >
        <div ref={contentRef} className="px-4 pb-4 pt-0 text-sm leading-relaxed text-ink-700">
          {children}
        </div>
      </div>
    </div>
  );
}
