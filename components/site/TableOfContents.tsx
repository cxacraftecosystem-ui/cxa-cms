"use client";

/**
 * TableOfContents — the article's headings, with the one you are reading marked.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THERE IS NO `aria-live` HERE AND THERE MUST NEVER BE ONE. This readout changes on every scroll
 * tick. In a live region it would interrupt a screen-reader user mid-sentence, over and over, to
 * tell them a scroll position they already have — the classic way a "helpful" indicator becomes the
 * reason somebody turns the page off. `aria-current` is the right tool: it is read when the reader
 * arrives at the entry, and never announced on its own.
 *
 * HIDDEN ENTIRELY BELOW `lg`. A floating contents panel on a phone covers the text it indexes, and
 * a collapsed one is a control competing with the article for the same thumb. `hidden lg:block` —
 * so it is not merely invisible, it is not in the tab order either, which is the difference between
 * hiding a thing and pretending to.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE IDS COME FROM `richTextHeadings()`, COMPUTED ON THE SERVER. The renderer looks each heading up
 * in the same map (`richTextHeadingIds`), so the anchor this list points at is the anchor that
 * exists — including the `-2` suffix on the second "Method". Recomputing the slugs here would be a
 * second implementation free to disagree with the first, and it would drag lib/richtext into the
 * client bundle for a list of strings the server already has.
 *
 * THE ACTIVE ENTRY FALLS BACK RATHER THAN GOING BLANK. When no heading is inside the observation
 * band — the reader is in the middle of a long section — the last heading that has scrolled past the
 * top stays marked, because "nothing is current" is never true of a page you are reading.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { TOC_MIN_ENTRIES, type RichTextHeading } from "@/lib/richtext";
import { cn } from "@/lib/utils";

export interface TableOfContentsProps {
  /** From `richTextHeadings(parseRichText(row.body))` in the page — see the header. */
  headings: readonly RichTextHeading[];
  /** The visible title, which also names the `<nav>`. */
  title?: string;
  /** Fewer entries than this and nothing renders: a contents list of one item is noise. */
  minEntries?: number;
  className?: string;
}

/*
 * ⚠ `TOC_MIN_ENTRIES` AND `tableOfContentsWillRender()` LIVE IN lib/richtext.ts, NOT HERE, AND THE
 * REASON IS A BUILD ERROR RATHER THAN TASTE. This file is `"use client"`, which makes EVERY export
 * from it a client reference — a Server Component that calls one gets "Attempted to call
 * tableOfContentsWillRender() from the server but it is on the client", at prerender, for every
 * article. The page that needs the predicate is a Server Component, so the shared rule has to sit in
 * a module that takes neither directive. lib/richtext.ts says so in its own header and already owns
 * `RichTextHeading` and `richTextHeadings()`, which is where the headings come from anyway.
 */

/**
 * Complete literal class strings — an indent built by concatenation is purged (contract §5).
 *
 * Indexed by DOCUMENT depth, not by tag. RichText clamps document level 1 to an `<h2>` so the page
 * keeps its only `<h1>`, which means levels 1 and 2 are the same visual rung.
 *
 * ⚠ EACH ENTRY CARRIES THE WHOLE PADDING, not an increment. `cn()` is a plain join and later classes
 * do NOT win (contract §5): a base `pl-4` beside a `pl-4` indent would collapse two rungs into one,
 * and beside a `pl-8` the winner would be decided by Tailwind's own emission order rather than by
 * this file.
 */
const INDENT_CLASS = ["pl-4", "pl-7", "pl-10"] as const;

/** The default when the custom property cannot be read — `--nav-clearance` is 6rem at 16px. */
const FALLBACK_CLEARANCE_PX = 96;

/**
 * The header clearance in pixels, read from the live custom property so the larger-text preference
 * (which scales the root font size) is accounted for rather than assumed away.
 */
function navClearancePx(): number {
  if (typeof window === "undefined") return FALLBACK_CLEARANCE_PX;
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const raw = styles.getPropertyValue("--nav-clearance").trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return FALLBACK_CLEARANCE_PX;
  if (raw.endsWith("rem")) {
    const rootSize = Number.parseFloat(styles.fontSize);
    return value * (Number.isFinite(rootSize) ? rootSize : 16);
  }
  return value;
}

export function TableOfContents({
  headings,
  title = "On this page",
  minEntries = TOC_MIN_ENTRIES,
  className
}: TableOfContentsProps) {
  const titleId = useId();
  const [activeId, setActiveId] = useState<string | null>(null);

  const entries = useMemo(() => headings.filter((heading) => heading.id.length > 0), [headings]);
  // A stable dependency for the effect: the parent re-renders with a new array on every navigation,
  // and re-attaching an IntersectionObserver on every render would reset the observation each time.
  const signature = entries.map((heading) => heading.id).join("|");

  // The ids the observer is currently reporting as visible. A ref rather than state: it changes
  // several times per scroll tick and only the DERIVED active id is worth a render.
  const visibleRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const ids = signature.length > 0 ? signature.split("|") : [];
    if (ids.length === 0) return;

    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;

    const visible = visibleRef.current;
    visible.clear();

    const clearance = navClearancePx();

    const pick = () => {
      // Document order, so a section whose heading and subheading are both in the band resolves to
      // the parent rather than flickering between the two.
      for (const id of ids) {
        if (visible.has(id)) {
          setActiveId(id);
          return;
        }
      }

      let last: string | null = null;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top - clearance <= 0) last = node.id;
        else break;
      }
      setActiveId(last ?? ids[0] ?? null);
    };

    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (record.isIntersecting) visible.add(record.target.id);
          else visible.delete(record.target.id);
        }
        pick();
      },
      {
        // The band starts just below the fixed header and ends well before the fold, so a heading
        // counts as "current" while its section fills the screen — not the instant it appears at the
        // very bottom of the viewport.
        rootMargin: `-${Math.round(clearance)}px 0px -65% 0px`,
        threshold: 0
      }
    );

    for (const node of nodes) observer.observe(node);
    // The first pass matters: a page opened at a `#hash`, or restored mid-scroll by the browser,
    // fires no intersection change until the reader moves.
    pick();

    return () => observer.disconnect();
  }, [signature]);

  if (entries.length < minEntries) return null;

  return (
    <nav aria-labelledby={titleId} className={cn("hidden lg:block", className)}>
      <div
        className="sticky z-10 overflow-y-auto"
        // Inline rather than an arbitrary Tailwind value: `calc()` needs spaces around its
        // operators, which an arbitrary class has to smuggle through as underscores. This is
        // legible and cannot be got subtly wrong.
        style={{
          top: "calc(var(--nav-clearance) + 1.5rem)",
          maxHeight: "calc(100vh - var(--nav-clearance) - 3rem)"
        }}
      >
        <p id={titleId} className="field-label">
          {title}
        </p>

        <ol className="mt-3 border-l border-line-200">
          {entries.map((heading) => {
            const depth = Math.min(Math.max(heading.level - 2, 0), INDENT_CLASS.length - 1);
            const current = heading.id === activeId;

            return (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  // "location", not "page": this marks a position WITHIN the current document.
                  // `aria-current="page"` would claim the entry is a different page.
                  aria-current={current ? "location" : undefined}
                  className={cn(
                    "-ml-px block border-l py-1.5 text-sm leading-snug transition-colors",
                    INDENT_CLASS[depth],
                    current
                      ? // Two signals, not one: the rule turns purple AND the text goes semibold, so
                        // the marker survives a monochrome screen (contract §11).
                        "border-purple-700 font-semibold text-purple-700"
                      : "border-transparent text-ink-500 hover:border-line-300 hover:text-ink-900"
                  )}
                >
                  {heading.text}
                </a>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
