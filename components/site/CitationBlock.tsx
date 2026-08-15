"use client";

/**
 * CitationBlock — the style switcher and the copy buttons on a publication.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT TAKES FORMATTED STRINGS, NEVER THE PUBLICATION ROW. All four citations and the BibTeX entry are
 * built on the server (`buildCitations` / `resolveBibtex`) and handed over ready-made. Two reasons:
 *
 *   1. lib/citation.ts is a thousand lines of punctuation rules that never change after the page is
 *      rendered. Shipping it to the browser would put it in the bundle of every publications page for
 *      no behaviour at all.
 *   2. The string the reader COPIES is then the very string they are looking at. A client-side
 *      formatter is a second implementation, and the first time the two disagree the citation on
 *      screen and the citation in the reader's manuscript are different — which is the one failure a
 *      citation tool must not have.
 *
 * COPYING HAS TWO PATHS AND BOTH ARE REAL. `navigator.clipboard` is **undefined on an insecure
 * origin** — plain `http://`, which is where a staging preview and a demo laptop live — and it also
 * rejects when the document is not focused. So the async API is tried first and a
 * `document.execCommand("copy")` selection is the fallback. A copy button that silently does nothing
 * on http is a support ticket, and worse: the reader walks away believing they have the citation.
 *
 * SUCCESS AND FAILURE BOTH ANNOUNCE, THROUGH THE TOAST. Deliberately not by swapping the icon for a
 * tick: that is a confirmation only a sighted reader who happened to be looking at that button
 * receives (the same argument as `components/site/ShareRow.tsx`). The toast viewport is the one live
 * region this product announces through, and the failure notice names the remedy rather than the
 * error.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A CITATION IS SET AS A REFERENCE, NOT AS INTERFACE TEXT — AND THAT IS THE WHOLE OF `CITATION_TEXT`.
 *
 * It used to be `text-sm leading-relaxed` in the interface face inside a tinted box: the same type as a
 * caption, a help line or a table cell. But a citation is not a label. It is the one string on the page
 * a reader intends to lift into their own manuscript, it is the thing they came here for, and in every
 * bibliography ever printed it is set in the reading face with a HANGING INDENT — first line flush,
 * continuation lines pushed in — because that is what makes a list of references scannable by author
 * surname. Four of them stacked in the `all` layout with no hanging indent is a wall of small grey
 * text in which no entry has a visible beginning. That is the "dense small text run together" the
 * baseline sweep recorded on this page.
 *
 * ⚠ THE TWO SIDES ARE WRITTEN SEPARATELY: a right padding, and an explicit LEFT padding as a `calc()`
 *   arbitrary value — never a two-sided `px-*` shorthand plus a `pl-*` override. Both of those would be
 *   (0,1,0) utilities, so which one wins is decided by Tailwind's emission order rather than by the
 *   order they are written in the class attribute (contract §5) — and a padding that depends on the
 *   generator's internal sort is a padding that can change under a minor upgrade. Writing the two sides
 *   separately removes the collision instead of betting on it. The left value is the box's own
 *   `0.875rem` PLUS the `1.5em` the negative `text-indent` takes back, so the first line still starts
 *   exactly where it always did and only the continuation lines move.
 *
 * ⚠ AND THE ACTUAL UTILITY IS NOT RESTATED IN THIS COMMENT, WHICH IS NOT PEDANTRY. Read it on
 *   `CITATION_TEXT` below instead. An earlier draft of this paragraph wrote the token out with an
 *   elided value as a placeholder, and the content scanner does not know prose from markup: it
 *   extracted that placeholder as a real candidate and Tailwind emitted a rule for it, whose
 *   declaration was an unparseable `calc()` the browser then discarded (contract §5 — a class written
 *   anywhere under `./app`, `./components` or `./lib` is a class that ships). Proven by compiling this
 *   file through `node node_modules/tailwindcss/lib/cli.js` with a content glob of nothing else: the
 *   invalid rule appeared in the output immediately above the intended one, and disappeared when the
 *   token did. `px-*` and `pl-*` above are safe for the same reason inverted: neither is a complete
 *   candidate, so neither generates anything.
 *
 * ⚠ AND THE READING FACE ARRIVES AS A PROP, WHICH LOOKS LIKE PLUMBING AND IS A HARD CONSTRAINT. This is
 *   a Client Component. The house reading face lives in the `typography` settings group, whose only
 *   reader is `houseProseTypeset()` in components/site/ProseArticle.tsx, and everything behind it —
 *   `lib/settings/service.ts` — is `import "server-only"` with Prisma underneath. Reading it here would
 *   not be a style mistake, it would be a build failure. So the SERVER page resolves it and hands the
 *   finished class down. The prop is optional because `CitationBlock` has two callers and only one of
 *   them is inside this work's file set; without it the citation keeps the interface face, which is
 *   what it had before, and the hanging indent still applies.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useState } from "react";
import { Braces, Quote } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/ToastProvider";
import { cn } from "@/lib/utils";
import type { CitationStyle } from "@/lib/citation";

/**
 * The presentation order and the labels.
 *
 * Written out here rather than imported from lib/citation.ts, which does not export them — and that is
 * the happier accident: importing anything from that module would pull the whole formatter into this
 * Client Component's bundle. Four strings duplicated is the cheaper price, and `Record<CitationStyle,
 * string>` means adding a fifth style to the union is a type error here rather than a missing tab.
 */
const STYLE_ORDER: readonly CitationStyle[] = ["apa", "mla", "chicago", "ieee"];

const STYLE_LABELS: Record<CitationStyle, string> = {
  apa: "APA",
  mla: "MLA",
  chicago: "Chicago",
  ieee: "IEEE"
};

/**
 * Complete literal class strings — a name assembled by concatenation is purged (contract §5).
 *
 * `CHIP_BASE` carries a bare `border` and the ON/OFF pair names its colour, exactly as
 * components/site/FilterBar.tsx does. ⚠ The two halves must always be composed together: `border`
 * alone is preflight's literal gray-200, which does not invert (contract §3).
 */
const CHIP_BASE =
  "inline-flex min-h-9 items-center rounded-full border px-3 py-1 text-xs font-medium transition";
const CHIP_OFF =
  "border-line-200 bg-card text-ink-700 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700";
const CHIP_ON = "border-purple-700 bg-purple-700 text-white hover:bg-purple-800";

/**
 * One citation, set as a bibliography entry. See the header for the two decisions in it.
 *
 * `0.9375rem` — 15px — rather than `text-sm`'s 14px, because the reading faces on this site's roster are
 * text serifs (Source Serif 4 is the house default) and a serif at 14px in a tinted box is the "dense
 * small text" this was opened to fix. It is deliberately still a step BELOW the body: a reference is
 * material a reader consults, not material they read through.
 */
const CITATION_TEXT =
  "rounded-md border border-line-200 bg-surface-50 py-3 pr-3.5 pl-[calc(0.875rem+1.5em)] -indent-[1.5em] text-[0.9375rem] leading-relaxed text-ink-700";

export type CitationBlockLayout = "switcher" | "all";

export interface CitationBlockProps {
  /** Every style, formatted on the server. See the header. */
  citations: Record<CitationStyle, string>;
  /** `resolveBibtex()` output — the stored entry when there is one, a generated one otherwise. */
  bibtex: string;
  /**
   * Names the group of controls, and disambiguates the copy buttons when a page carries twenty of
   * these: "Cite Weaving futures in Bagru", not "Cite".
   */
  label: string;
  /**
   * `switcher` shows one style at a time behind a picker — the listing row. `all` lists every style,
   * for a publication's own page where the reader came specifically to take a reference.
   */
  layout?: CitationBlockLayout;
  /** Which style the switcher opens on. APA, because it is the house default. */
  defaultStyle?: CitationStyle;
  /** Show the BibTeX source. Defaults on for the `all` layout, off for a listing row. */
  showBibtex?: boolean;
  /**
   * The house reading face, as a complete Tailwind class — `typesetFaceClassName(await houseProseTypeset())`.
   *
   * ⚠ IT HAS TO COME FROM A SERVER COMPONENT AND IT CANNOT BE READ HERE. See the header: the settings
   * reader is `server-only` and this file is `"use client"`, so a resolved class string is the only
   * shape the answer can take at this boundary.
   *
   * Omitted, the citation is set in the interface face — which is what it had before this prop existed,
   * so a caller that does not pass it loses nothing it already had. It is NOT defaulted to a face id
   * here: guessing "probably the serif" in a component that cannot see the setting is precisely how two
   * places end up disagreeing about the house style.
   *
   * ⚠ The BibTeX entry below deliberately does NOT take it. That block is source code an author pastes
   * into a `.bib` file, and `font-mono` is a statement about what it is.
   */
  readingFaceClassName?: string;
  className?: string;
}

/**
 * The legacy copy path: a real, selectable, off-screen textarea.
 *
 * `execCommand` copies the current SELECTION, so the element has to be selectable — which rules out
 * `display: none`, `visibility: hidden` and a zero-size box. `position: fixed` keeps it out of the
 * scroll flow so the page does not jump, `readonly` stops iOS opening the keyboard, and the caller's
 * selection and focus are both put back afterwards: taking the reader's cursor away to copy a
 * citation is a worse bug than the one this is fixing.
 */
function copyWithExecCommand(text: string): boolean {
  if (typeof document === "undefined") return false;

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.width = "1px";
  area.style.height = "1px";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.appendChild(area);

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  let copied = false;
  try {
    area.select();
    // iOS Safari ignores `select()` on a readonly textarea; the explicit range is what makes it work
    // there, and it is harmless everywhere else.
    area.setSelectionRange(0, text.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    area.remove();
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    active?.focus();
  }

  return copied;
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Not a dead end: a rejection here is usually a permissions prompt or an unfocused document,
      // and the selection-based path below is not subject to either.
    }
  }
  return copyWithExecCommand(text);
}

export function CitationBlock({
  citations,
  bibtex,
  label,
  layout = "switcher",
  defaultStyle = "apa",
  showBibtex,
  readingFaceClassName,
  className
}: CitationBlockProps) {
  const { toast } = useToast();
  const [style, setStyle] = useState<CitationStyle>(defaultStyle);
  const withBibtex = showBibtex ?? layout === "all";

  /**
   * Composed ONCE, so the switcher's single citation and the `all` layout's four are provably the same
   * type. `cn` is a plain join that drops falsy entries, so an absent face adds nothing at all rather
   * than an empty class (contract §5).
   */
  const citationClass = cn(CITATION_TEXT, readingFaceClassName);

  const copy = async (text: string, what: string) => {
    const done = await copyText(text);
    if (done) {
      toast({ tone: "success", title: `${what} copied`, description: text });
      return;
    }
    toast({
      tone: "error",
      title: `${what} could not be copied`,
      description:
        "This browser refused access to the clipboard. Select the text on the page and copy it by hand."
    });
  };

  const current = citations[style];

  return (
    <div role="group" aria-label={label} className={cn("flex flex-col gap-3", className)}>
      {layout === "switcher" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {STYLE_ORDER.map((option) => {
              const on = option === style;
              return (
                <button
                  key={option}
                  type="button"
                  // `aria-pressed` carries the state to the accessibility tree; the fill carries it to
                  // the eye. Neither is the only signal (contract §11).
                  aria-pressed={on}
                  onClick={() => setStyle(option)}
                  className={cn(CHIP_BASE, on ? CHIP_ON : CHIP_OFF)}
                >
                  {STYLE_LABELS[option]}
                  <span className="sr-only"> citation style</span>
                </button>
              );
            })}
          </div>

          {/*
            A status region, mounted from the first render so it is registered before its content ever
            changes, and it only changes in answer to a press. Without it the switcher is four buttons
            that visibly rewrite a paragraph a screen-reader user is never told about.
          */}
          <p role="status" className={citationClass}>
            {current}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              icon={Quote}
              onClick={() => copy(current, `${STYLE_LABELS[style]} citation`)}
            >
              Copy citation
            </Button>
            {/* Only when the entry is not shown below with its own button — two controls doing one
                thing is two tab stops and a moment's hesitation about whether they differ. */}
            {withBibtex ? null : (
              <Button variant="secondary" icon={Braces} onClick={() => copy(bibtex, "BibTeX entry")}>
                Copy BibTeX
              </Button>
            )}
          </div>
        </>
      ) : (
        <ul className="flex flex-col gap-4">
          {STYLE_ORDER.map((option) => (
            <li key={option} className="flex flex-col gap-2">
              <p className="field-label">{STYLE_LABELS[option]}</p>
              <p className={citationClass}>{citations[option]}</p>
              <div>
                <Button
                  variant="secondary"
                  icon={Quote}
                  onClick={() => copy(citations[option], `${STYLE_LABELS[option]} citation`)}
                >
                  Copy {STYLE_LABELS[option]} citation
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {withBibtex ? (
        <div className="mt-1 flex flex-col gap-2">
          <p className="field-label">BibTeX</p>
          {/*
            A wide entry scrolls inside its own box. Letting a long `url = {…}` line widen the page
            turns every other section into a sideways-scrolling one, and the region is focusable
            because a scroller only a mouse can reach is not keyboard operable.
          */}
          <pre
            role="region"
            aria-label={`BibTeX entry for ${label}`}
            tabIndex={0}
            className="overflow-x-auto rounded-md border border-line-200 bg-surface-50 p-3.5 font-mono text-xs leading-relaxed text-ink-700"
          >
            {bibtex}
          </pre>
          <div>
            <Button variant="secondary" icon={Braces} onClick={() => copy(bibtex, "BibTeX entry")}>
              Copy BibTeX
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
