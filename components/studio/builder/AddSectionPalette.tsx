"use client";

/**
 * AddSectionPalette — "add a block", as a picker rather than a dropdown of thirty shouted words.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PALETTE ANSWERS "WHAT AM I TRYING TO DO", NOT "WHAT IS THIS MADE OF".
 *
 * Every entry carries three things, and all three are needed by somebody choosing for the first time:
 * the LABEL ("Image beside text"), the DESCRIPTION saying what it does and when to reach for it, and a
 * small diagram of the SHAPE it makes on the page. A picker that shows only labels makes the person
 * adding a block guess, and a guess in a page builder is a block that has to be undone. The groups —
 * Structure, Content, Showcase, Media, Story — their descriptions and their order all come from
 * `lib/sections/registry.ts`, which is the one place that decides what a block is called.
 *
 * ⚠ THE GROUPS ARE RENDERED BY MAPPING `SECTION_GROUPS`, AND THAT IS NOT AN INCIDENTAL DETAIL. A
 * hand-written list of headings here would have silently dropped the whole "Story" group when it was
 * added to the registry — four blocks that exist, compile, render and cannot be added to a page. The
 * same goes for `SECTION_GROUP_DESCRIPTIONS`, which is a `Record` over the group union and therefore
 * fails to compile rather than printing an empty line.
 *
 * IT INSERTS WHERE THE READER IS LOOKING, NOT AT THE END. The builder passes the position, which is
 * normally directly after the block that is selected, and this panel SAYS where the new block will go
 * before the reader commits to it. A picker that always appends means every block added halfway down a
 * long page is followed by a reorder nobody wanted to do.
 *
 * A BLOCK THAT MAY ONLY APPEAR ONCE STOPS BEING OFFERED — and the fact that it has been withheld is
 * printed at the foot of the list, naming it. That is both halves of the rule: `allowMultiple: false`
 * in the registry means "stop offering it" rather than "show a disabled entry that explains itself only
 * after a click", and contract §1.6 means a list that quietly stops must say that it has.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The search matches the label, the description and the group, because an administrator looking for the
 * enquiry form searches "contact", "form" and "email" in roughly equal numbers, and the description is
 * where two of those three words are. When the search hides entries, it says how many.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchX } from "lucide-react";
import type { SectionType } from "@prisma/client";

import { cn } from "@/lib/utils";
import {
  SECTION_GROUPS,
  SECTION_GROUP_DESCRIPTIONS,
  SECTION_META,
  type SectionMeta
} from "@/lib/sections/registry";
import { Dialog } from "@/components/ui/Dialog";
import { SearchInput } from "@/components/ui/SearchInput";
import { sectionIcon } from "@/components/studio/builder/SectionCard";

// ─────────────────────────────────────────────────────────────────────────────
// The layout hints
// ─────────────────────────────────────────────────────────────────────────────
//
// A tiny abstract diagram per block, so the shape of the thing is legible before it is on the page.
// They are `aria-hidden`: the label and the description are the information, and "small purple
// rectangle above two lines" helps nobody.
//
// Fifteen shapes cover thirty blocks, because several blocks genuinely make the same shape — a grid of
// projects and a grid of people look identical from across the room, and pretending otherwise with
// thirty drawings would be thirty drawings to keep in agreement with the renderers.
//
// The four "Story" blocks are the exception, and they each got their own drawing on purpose: the whole
// reason that group exists is that those blocks make shapes nothing else on the site makes. Drawing a
// sideways rail as an ordinary grid of cards would hide the one fact somebody needs before choosing it
// — that it continues past the edge of the screen.

type HintShape =
  | "banner"
  | "prose"
  | "figures"
  | "cards"
  | "rows"
  | "panel"
  | "logos"
  | "wall"
  | "split"
  | "frame"
  | "space"
  | "story"
  | "band"
  | "rail"
  | "stages";

const HINT_SHAPES: Record<SectionType, HintShape> = {
  HERO: "banner",
  // The four narrative blocks. The exhaustive Record is what turned their omission into a compile
  // error rather than four palette entries with a blank diagram beside them.
  STORY_SCROLL: "story",
  PARALLAX_BANNER: "band",
  HORIZONTAL_RAIL: "rail",
  PROCESS_STEPS: "stages",
  // Three side-by-side panels genuinely make the "cards" shape from across the room — the fifth
  // Story block reuses it rather than adding a sixteenth drawing to keep in agreement.
  PLATFORM_PILLARS: "cards",
  // A picture beside a list — the split silhouette is the closest of the fixed shapes.
  INDIA_MAP: "split",
  // Steps read as a stack of rows; an embedded form is a framed panel from another site; a link grid
  // is cards. Added when the three "action" blocks landed — the exhaustive Record is what made the
  // omission a compile error rather than three blank tiles in the palette.
  ACTION_STEPS: "rows",
  FORM_EMBED: "frame",
  LINK_GRID: "cards",
  SPACER: "space",
  RICH_TEXT: "prose",
  STATS: "figures",
  FEATURE_GRID: "cards",
  TIMELINE: "rows",
  QUOTE: "panel",
  CTA: "panel",
  FAQ: "rows",
  CONTACT_FORM: "panel",
  RESEARCH_SHOWCASE: "cards",
  PROJECT_SHOWCASE: "cards",
  PEOPLE_SHOWCASE: "cards",
  PUBLICATION_LIST: "rows",
  NEWS_SHOWCASE: "cards",
  EVENT_SHOWCASE: "rows",
  PARTNER_LOGOS: "logos",
  CRAFT_EXPLORER: "cards",
  DOWNLOADS: "rows",
  GALLERY: "wall",
  MEDIA_SPLIT: "split",
  EMBED: "frame",
  MAP: "frame",
  // A document on the page is a framed panel from across the room, exactly as an embedded video and a
  // map are. A sixteenth drawing would have to be kept in agreement with a renderer that draws either
  // a frame or a download card depending on the file, and would be wrong half the time.
  DOCUMENT_EMBED: "frame"
};

/** Complete literal class strings throughout — a name built by concatenation is purged (contract §5). */
const HINT_FRAME =
  "flex h-11 w-16 shrink-0 flex-col overflow-hidden rounded border border-line-200 bg-surface-100 p-1";

function LayoutHint({ shape }: { shape: HintShape }) {
  return (
    <span aria-hidden="true" className={HINT_FRAME}>
      {shape === "banner" ? (
        <span className="flex flex-1 flex-col items-center justify-center gap-1 rounded bg-purple-200">
          <span className="h-1 w-9 rounded-full bg-purple-700" />
          <span className="h-0.5 w-6 rounded-full bg-purple-400" />
        </span>
      ) : null}

      {shape === "prose" ? (
        <span className="flex flex-1 flex-col justify-center gap-1">
          <span className="h-1 w-6 rounded-full bg-purple-700" />
          <span className="h-0.5 w-full rounded-full bg-ink-300" />
          <span className="h-0.5 w-full rounded-full bg-ink-300" />
          <span className="h-0.5 w-8 rounded-full bg-ink-300" />
        </span>
      ) : null}

      {shape === "figures" ? (
        <span className="flex flex-1 items-center justify-between gap-1">
          {[0, 1, 2].map((slot) => (
            <span key={slot} className="flex flex-1 flex-col items-center gap-1">
              <span className="h-2 w-3 rounded-sm bg-purple-700" />
              <span className="h-0.5 w-4 rounded-full bg-ink-300" />
            </span>
          ))}
        </span>
      ) : null}

      {shape === "cards" ? (
        <span className="flex flex-1 items-stretch gap-1">
          {[0, 1, 2].map((slot) => (
            <span key={slot} className="flex-1 rounded-sm bg-purple-200" />
          ))}
        </span>
      ) : null}

      {shape === "rows" ? (
        <span className="flex flex-1 flex-col justify-center gap-1">
          {[0, 1, 2].map((slot) => (
            <span key={slot} className="h-1.5 w-full rounded-sm bg-purple-200" />
          ))}
        </span>
      ) : null}

      {shape === "panel" ? (
        <span className="flex flex-1 flex-col items-center justify-center gap-1 rounded bg-purple-700">
          <span className="h-0.5 w-8 rounded-full bg-purple-200" />
          <span className="h-1.5 w-5 rounded-full bg-white" />
        </span>
      ) : null}

      {shape === "logos" ? (
        <span className="flex flex-1 flex-col justify-center gap-1.5">
          {[0, 1].map((row) => (
            <span key={row} className="flex items-center justify-between gap-1">
              {[0, 1, 2, 3].map((slot) => (
                <span key={slot} className="h-1 flex-1 rounded-full bg-ink-300" />
              ))}
            </span>
          ))}
        </span>
      ) : null}

      {shape === "wall" ? (
        <span className="flex flex-1 items-start gap-1">
          <span className="flex flex-1 flex-col gap-1">
            <span className="h-4 rounded-sm bg-purple-200" />
            <span className="h-2 rounded-sm bg-purple-200" />
          </span>
          <span className="flex flex-1 flex-col gap-1">
            <span className="h-2 rounded-sm bg-purple-200" />
            <span className="h-4 rounded-sm bg-purple-200" />
          </span>
          <span className="h-7 flex-1 rounded-sm bg-purple-200" />
        </span>
      ) : null}

      {shape === "split" ? (
        <span className="flex flex-1 items-stretch gap-1">
          <span className="w-1/2 rounded-sm bg-purple-200" />
          <span className="flex w-1/2 flex-col justify-center gap-1">
            <span className="h-1 w-5 rounded-full bg-purple-700" />
            <span className="h-0.5 w-full rounded-full bg-ink-300" />
            <span className="h-0.5 w-full rounded-full bg-ink-300" />
          </span>
        </span>
      ) : null}

      {shape === "frame" ? (
        <span className="flex flex-1 items-center justify-center rounded-sm bg-purple-200">
          <span className="h-2.5 w-2.5 rounded-full bg-purple-700" />
        </span>
      ) : null}

      {/*
        One picture, several chapters of words beside it — deliberately NOT the "split" drawing, which
        is one picture and one paragraph. The number of text runs is the difference between the two
        blocks and it is the thing to show.
      */}
      {shape === "story" ? (
        <span className="flex flex-1 items-stretch gap-1">
          <span className="w-2/5 rounded-sm bg-purple-200" />
          <span className="flex w-3/5 flex-col justify-center gap-1">
            <span className="h-0.5 w-full rounded-full bg-ink-300" />
            <span className="h-1 w-4 rounded-full bg-purple-700" />
            <span className="h-0.5 w-full rounded-full bg-ink-300" />
            <span className="h-0.5 w-5 rounded-full bg-ink-300" />
          </span>
        </span>
      ) : null}

      {/*
        Words over a photograph, which is why the band is `ink-500` rather than brand purple: the point
        of the drawing is that the background is somebody's picture, not the Centre's colour. The lines
        are `bg-0`, so the pairing stays legible in both themes — light type on mid grey in one, dark
        type on lighter grey in the other.
      */}
      {shape === "band" ? (
        <span className="flex flex-1 flex-col justify-center gap-1 rounded-sm bg-ink-500 px-1.5">
          <span className="h-0.5 w-4 rounded-full bg-bg-0" />
          <span className="h-1 w-8 rounded-full bg-bg-0" />
        </span>
      ) : null}

      {/*
        Cards that run off the right-hand edge — the frame is `overflow-hidden`, so the fourth one is
        genuinely clipped rather than drawn smaller. That clipping IS the diagram.
      */}
      {shape === "rail" ? (
        <span className="flex flex-1 items-stretch gap-1">
          {[0, 1, 2, 3].map((slot) => (
            <span key={slot} className="w-5 shrink-0 rounded-sm bg-purple-200" />
          ))}
        </span>
      ) : null}

      {/* Stages alternating either side of a line, in the order they happen. */}
      {shape === "stages" ? (
        <span className="flex flex-1 flex-col justify-center gap-1.5">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-purple-700" />
            <span className="h-0.5 flex-1 rounded-full bg-ink-300" />
          </span>
          <span className="flex flex-row-reverse items-center gap-1">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-purple-700" />
            <span className="h-0.5 flex-1 rounded-full bg-ink-300" />
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-purple-700" />
            <span className="h-0.5 flex-1 rounded-full bg-ink-300" />
          </span>
        </span>
      ) : null}

      {shape === "space" ? (
        <span className="flex flex-1 flex-col justify-between">
          <span className="h-1.5 w-full rounded-sm bg-ink-300" />
          <span className="h-3 w-full rounded-sm border border-dashed border-purple-300" />
          <span className="h-1.5 w-full rounded-sm bg-ink-300" />
        </span>
      ) : null}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wording helpers
// ─────────────────────────────────────────────────────────────────────────────

/** "A", "A and B", "A, B and C" — house style, no comma before the "and". */
function listWords(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  const tail = items[items.length - 1] ?? "";
  return `${head} and ${tail}`;
}

function matches(meta: SectionMeta, query: string): boolean {
  if (query === "") return true;
  const haystack = `${meta.label} ${meta.description} ${meta.group}`.toLowerCase();
  // Every word must appear somewhere, so "photo grid" finds the gallery and "grid photo" finds it too.
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

// ─────────────────────────────────────────────────────────────────────────────
// The palette
// ─────────────────────────────────────────────────────────────────────────────

export interface AddSectionPaletteProps {
  open: boolean;
  onClose: () => void;
  /** The 0-based position the new block will take. */
  insertAt: number;
  /** How many blocks the page has now, for the wording. */
  total: number;
  /** The name of the block the new one will sit after, or null when it goes first. */
  insertAfterName: string | null;
  /** Every type already on the page, so a block that may only appear once stops being offered. */
  usedTypes: readonly SectionType[];
  /** True while the chosen block is being added. */
  isAdding?: boolean;
  /**
   * True when the page is on the public site (published or scheduled). The server then creates the new
   * block HIDDEN — otherwise its placeholder wording would be live the moment it lands — and this
   * dialog has to say so before the reader commits, not after.
   */
  pageIsLive?: boolean;
  onAdd: (type: SectionType) => void;
}

export function AddSectionPalette({
  open,
  onClose,
  insertAt,
  total,
  insertAfterName,
  usedTypes,
  isAdding = false,
  pageIsLive = false,
  onAdd
}: AddSectionPaletteProps) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<SectionType | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // A fresh search every time it opens. A palette that remembers last week's search shows one entry and
  // looks broken.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setChosen(null);
  }, [open]);

  const used = useMemo(() => new Set<SectionType>(usedTypes), [usedTypes]);

  /** Blocks this page may not have a second of. Named at the foot of the list — see the header. */
  const withheld = useMemo(
    () => SECTION_META.filter((meta) => !meta.allowMultiple && used.has(meta.type)),
    [used]
  );

  const offered = useMemo(
    () => SECTION_META.filter((meta) => meta.allowMultiple || !used.has(meta.type)),
    [used]
  );

  const visible = useMemo(() => offered.filter((meta) => matches(meta, query)), [offered, query]);
  const hiddenBySearch = offered.length - visible.length;

  const where =
    insertAfterName === null
      ? total === 0
        ? "It will be the first block on the page."
        : "It will go at the very top of the page, above everything else."
      : insertAt >= total
        ? `It will go at the end of the page, after ${insertAfterName}.`
        : `It will go straight after ${insertAfterName}, at position ${insertAt + 1} of ${total + 1}.`;

  // Said HERE, before the reader commits, because the surprise runs the other way on a live page: the
  // block does not appear on the site, and an editor who was not told why concludes adding is broken.
  const placement = pageIsLive
    ? `${where} Because this page is live on the site, the new block arrives hidden — switch it on from its row once its wording is ready for readers.`
    : where;

  const choose = (type: SectionType) => {
    setChosen(type);
    onAdd(type);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a block"
      description={placement}
      size="lg"
      initialFocusRef={searchRef}
      footer={
        <button type="button" onClick={onClose} className="field-button-secondary">
          Cancel
        </button>
      }
    >
      <SearchInput
        ref={searchRef}
        label="Search the kinds of block"
        placeholder="Search — try “photo”, “form”, “figures”"
        value={query}
        onValueChange={setQuery}
        clearLabel="Clear the block search"
      />

      {visible.length === 0 ? (
        <div className="mt-5 flex flex-col items-center gap-2 rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-8 text-center">
          <SearchX aria-hidden="true" className="h-5 w-5 text-ink-500" />
          <p className="text-sm font-medium text-ink-900">Nothing matches “{query}”</p>
          <p className="prose-measure text-xs leading-relaxed text-ink-500">
            Clear the search to see all {offered.length} kinds of block. The search looks at each
            block&rsquo;s name and its description, so a word from either will find it.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-6">
          {SECTION_GROUPS.map((group) => {
            const entries = visible.filter((meta) => meta.group === group);
            if (entries.length === 0) return null;

            return (
              <section key={group}>
                {/* h3: the Dialog's title is the h2 of this document region (see Dialog.tsx), so the
                    groups sit one level under it and nothing skips (contract §11). */}
                <h3 className="font-display text-sm font-semibold text-ink-900">{group}</h3>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                  {SECTION_GROUP_DESCRIPTIONS[group]}
                </p>

                <ul className="mt-3 space-y-2">
                  {entries.map((meta) => {
                    const Icon = sectionIcon(meta.type);
                    const pending = isAdding && chosen === meta.type;

                    return (
                      <li key={meta.type}>
                        <button
                          type="button"
                          onClick={() => choose(meta.type)}
                          // Disabled only while a block is actually being added — a second press
                          // would add two. This is not a permission check; a reader who may not edit
                          // the page never reaches this dialog (contract §1.8).
                          disabled={isAdding}
                          aria-busy={pending || undefined}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-md border bg-card p-3 text-left transition",
                            "hover:border-purple-300 hover:bg-purple-50 focus-visible:ring-4 focus-visible:ring-purple-600/15",
                            pending ? "border-purple-600" : "border-line-200",
                            isAdding && !pending && "cursor-not-allowed opacity-60"
                          )}
                        >
                          <LayoutHint shape={HINT_SHAPES[meta.type]} />

                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
                              <span className="text-sm font-medium text-ink-900">{meta.label}</span>
                              {pending ? (
                                // A word, not a spinner: the wait has to reach a reader who is not
                                // looking at a rotating glyph (contract §1.4).
                                <span className="text-xs font-medium text-purple-700">Adding…</span>
                              ) : null}
                            </span>
                            <span className="mt-1 block text-xs leading-relaxed text-ink-500">
                              {meta.description}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {hiddenBySearch > 0 && visible.length > 0 ? (
        <p className="mt-5 border-t border-line-200 pt-3 text-xs leading-relaxed text-ink-500">
          {hiddenBySearch === 1
            ? "One other kind of block is hidden by the search."
            : `${hiddenBySearch} other kinds of block are hidden by the search.`}{" "}
          Clear the box to see all {offered.length}.
        </p>
      ) : null}

      {withheld.length > 0 ? (
        /*
          Stated, not silently omitted (contract §1.6). Without this sentence a builder looking for the
          hero banner concludes the studio has lost it.
        */
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          {listWords(withheld.map((meta) => `“${meta.label}”`))}{" "}
          {withheld.length === 1 ? "is" : "are"} not listed because a page may only have one of{" "}
          {withheld.length === 1 ? "it" : "each"} and this page already{" "}
          {withheld.length === 1 ? "has it" : "has them"}. Edit or delete the one that is there instead.
        </p>
      ) : null}
    </Dialog>
  );
}
