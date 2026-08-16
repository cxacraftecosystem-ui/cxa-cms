/**
 * ProseArticle — the long-form wrapper: the house typesetting, the reading measure, the renderer, and
 * the vertical rhythm around them.
 *
 * IT IS THE READER FOR NEWS, PEOPLE, PROJECTS, RESEARCH, EVENTS AND CRAFT RECORDS — every long-form
 * record type on the site — which is why the typesetting settings are read HERE rather than page by page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE TYPESETTING IS IN THIS FILE, AND WHAT WAS ACTUALLY WRONG.
 *
 * `lib/typography/typeset.ts` and the `.prose-typeset` recipe in `app/globals.css` are a complete house
 * typesetting system: twelve settable dimensions, a settings group an administrator can change, twelve
 * licensed faces, a measure, a leading ladder, indented paragraphs, hyphenation, a drop cap. It had ONE
 * consumer — `components/sections/RichTextSection.tsx`, the page-builder's text block. **This file, which
 * draws every article, biography, project description, research area and event description on the site,
 * never read the settings at all.** So an institution could set its house style, watch it apply to a
 * block on a landing page, and see nothing change on a single piece of long-form writing. That is the
 * whole of the owner's complaint about "the typesetting of the pages that get created", and it was not a
 * missing feature — it was a finished feature reached by one caller. (This repo's recurring defect
 * class: built, correct, and never reached by anything.)
 *
 * `houseTypeset()` below is now the ONE reader of the `typography` group on the public site, and
 * `RichTextSection` imports it from here rather than keeping its own copy. ⚠ THAT IS THE POINT OF THE
 * EXPORT, NOT A TIDY-UP: two readers of the same settings group are two places that can disagree about
 * what the house style is, and the disagreement would show up as an article and a text block on the same
 * page set in two different faces.
 *
 * ⚠ IT CANNOT LIVE IN `lib/typography/typeset.ts`, WHICH IS THE OBVIOUS HOME AND IS THE WRONG ONE.
 * `lib/settings/service.ts` is `server-only`, and `components/studio/sections/RichTextForm.tsx` — a
 * CLIENT component — imports the choice maps out of `typeset.ts`. Putting the read there would put
 * `server-only` (and Prisma behind it) in a client bundle, which is a build error rather than a style
 * question. So the vocabulary stays pure and the READ lives in the server-only reader, here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * TWO BOXES, AND WHICH ONE A THING BELONGS IN IS THE ONE STRUCTURAL DECISION HERE.
 *
 *  1. **The COLUMN** — the outer element, and the only one that is ALWAYS rendered when this component
 *     renders anything at all. It carries the measure (`prose-measure` plus the house's own
 *     `ts-measure-*`) and the caller's `className`.
 *  2. **The DOCUMENT box** — inside it, carrying `.prose-typeset` and every `ts-*` class. It wraps the
 *     standfirst and the rendered prose and NOTHING ELSE.
 *
 * Everything that is not the document — the `fallback`, and `children` such as a citation block, a
 * ShareRow or a tag list — sits in the COLUMN as a SIBLING of the document box.
 *
 * ⚠ THAT SIBLING RULE IS LOAD-BEARING AND LOOKS LIKE FUSSINESS. Two rules make it so.
 *   `.prose-typeset :is(p, li)` sets the reading size on every paragraph inside the box, so a ShareRow's
 *   label or a citation's line would be dragged to 17px of body serif; and
 *   `.ts-dropcap > * > p:first-of-type::first-letter` sets a three-line capital on the first paragraph of
 *   any CHILD of the box — so a citation block, or an apology paragraph standing in for a missing body,
 *   would open with a drop cap. Keeping them siblings of the document box is also exactly what this file
 *   did before the recipe arrived, so nothing a page already renders below its prose moves.
 *
 * ⚠ AND THERE IS EXACTLY ONE FALLBACK RENDER SITE. THAT IS THE REPAIR OF A REAL DEFECT, NOT A TIDY-UP.
 *   This component used to have two: `return fallback ?? null` — BARE, with no column at all — whenever a
 *   record had neither a body, a standfirst nor children, and the same `fallback` inside the column in
 *   every other case. So the reading measure a record's apology paragraph got depended on an unrelated
 *   field. A post with an excerpt and no body took the in-column path and set at 68ch; a post with
 *   neither took the bare path and set at the full width of its grid cell — about 140 characters a line
 *   in the news column, twice the measure the whole site is built on (contract §7). The caller's
 *   `className` was silently dropped on that path as well, since the column is the only thing that wears
 *   it. `app/(site)/craft-explorer/[slug]/page.tsx` had already grown a six-line comment explaining that
 *   it must keep its own apology paragraph OUTSIDE this component for exactly this reason — a page
 *   repairing a defect downstream of its root, which is the habit this file's own header exists to break.
 *
 *   ⚠ `null` IS STILL RETURNED WHEN THERE IS GENUINELY NOTHING, and it has to be: an empty `<div>`
 *   carrying a measure where a body should be leaves the page's own `mt-*` spacing paying for a block
 *   that draws nothing. A caller that passes no `fallback` and has no body still gets nothing at all.
 *
 * ⚠ AND THE LISTEN CONTROL IS A THIRD KIND OF SIBLING, WHICH IS WHY IT IS WORTH A LINE HERE.
 *   `components/site/ReadAloud.tsx` speaks the article through `window.speechSynthesis`, and it reads
 *   its text out of the RENDERED DOM rather than from `value` or `mdx` — those are a JSON tree and a
 *   string of markdown, and a synthesiser handed either would pronounce the syntax. The document box
 *   is where the two sources have already become the same thing, so it is marked
 *   `data-read-aloud-source` and the column is marked `data-read-aloud-scope`; the control walks up to
 *   the column it was rendered into and finds the box inside it, so two articles on one page can never
 *   read each other's words. The control itself is a SIBLING of the document box for the same two
 *   reasons the fallback is — it would otherwise be set at the reading size and could take the drop cap
 *   off the first paragraph.
 *
 *   It is rendered ONLY where there is a real body. A record with nothing but a `fallback` has one
 *   apology paragraph to say, and offering to read it aloud would be a joke at the reader's expense.
 *   The control is a client component and the only one this file has: it decides for itself whether to
 *   render anything at all (the API is absent in some browsers, and the piece may be too short to be
 *   worth listening to), and a page that renders no `ProseArticle` never reaches its chunk.
 *
 * TWO SOURCES, ONE PER RECORD. The CMS writes either Tiptap JSON (`value`) or MDX (`mdx`), and the
 * editor picks one mode per post and says which (prisma/schema.prisma, `Post.mdx`). When both are
 * present the MDX wins, because a record only acquires MDX by somebody deliberately switching it —
 * and the alternative, rendering both, would print the article twice.
 *
 * ⚠ MDX IS COMPILED AT REQUEST TIME AND IS LOADED WITH A DYNAMIC `import()`. The compiler is a large
 * dependency, and a static import would put it in the module graph of every page that renders a
 * biography or a project description — none of which will ever contain MDX.
 *
 * ⚠ THERE IS NO RAW-HTML PASSTHROUGH in either branch, and there must never be one. Both sources are
 * editor input from a `Json`/`String` column that anybody with AUTHOR rank can write; MDX cannot
 * `import`, so the only components it can reach are the ones handed to it below.
 *
 * THE MEASURE COMES FROM ONE PLACE. An article and an MDX page must agree on it, which is why it is
 * `--measure` in globals.css and not a `max-width` chosen per page (contract §7). What changed is only
 * that the house style may now re-point that one number; `standard` is 68ch, which is what every page
 * had before and what an unconfigured site still gets.
 *
 * ⚠ THE COLUMN IS NOT CENTRED, deliberately. `RichTextSection` writes `mx-auto` because its block sits
 * alone in a full-width shell; a caller of THIS component renders it at the left edge of a column it
 * already owns — for news, people, projects, events and craft records that column is a grid cell beside
 * a sidebar, so centring would shift the article right and open a gap against the aside. The left edge
 * stays where it is.
 *
 * An async Server Component — it awaits the settings read and the MDX compiler. Nothing here may be
 * rendered from a client tree.
 *
 * ⚠ THIS PARAGRAPH USED TO END "long-form prose ships no JavaScript", AND THAT IS NO LONGER TRUE — the
 * listen control above is a client component. It is still very nearly true, and the distinction is the
 * one worth keeping: the typesetting read, the renderer, the MDX compiler and every word of the prose
 * remain server-only, and the single client chunk is a LEAF that drags none of them into the browser.
 * A page that renders no `ProseArticle` never loads it at all, and a reader whose browser cannot speak
 * downloads it and is shown nothing (see `ReadAloud`, which is deliberately built to decide that
 * itself rather than make this file guess).
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { ImageOff } from "lucide-react";

import { RichText, leadParagraphClassName } from "@/components/RichText";
import { ReadAloud } from "@/components/site/ReadAloud";
import { MediaImage } from "@/components/ui/MediaImage";
import { isEmptyRichText, parseRichText } from "@/lib/richtext";
import { getSettingCached } from "@/lib/settings/service";
import {
  BLOCK_TYPESET_DEFAULT,
  HOUSE_TYPESET_DEFAULT,
  resolveTypeset,
  typesetClassName,
  typesetMeasureClassName,
  type HouseTypeset,
  type ResolvedTypeset
} from "@/lib/typography/typeset";
import { cn } from "@/lib/utils";

export interface ProseArticleProps {
  /** The stored Tiptap document — pass the raw column value; it is parsed and validated here. */
  value?: unknown;
  /** MDX source, for the pieces the editor wrote in MDX mode. Wins over `value`. See the header. */
  mdx?: string | null;
  /**
   * The deck — the sentence or two an editor wrote to make somebody read the rest.
   *
   * A plain string rather than a `ReactNode`, and that is a decision rather than a shortcut: it comes
   * from a `String?` column (`Post.excerpt`, `Event.summary`), it is set as ONE paragraph, and a node
   * would let a caller nest a block element inside the `<p>` this renders. Empty or whitespace-only is
   * the same as absent, so a caller can pass the column through untouched — `standfirst={post.excerpt}`
   * — without testing it first.
   */
  standfirst?: string | null;
  /**
   * Rendered when the record has no body — an editor's own finished markup, not a document.
   *
   * It lands in the COLUMN and outside the document box, so it keeps the reading measure and takes
   * neither the house reading size nor a drop cap. Omitted, a record with no body renders nothing.
   */
  fallback?: ReactNode;
  /** Appended inside the measure, under the prose — a citation block, a ShareRow, a footnote panel. */
  children?: ReactNode;
  /** Merged onto the column, which is the element that carries the measure. */
  className?: string;
}
/*
 * ⚠ THERE IS NO `variant` AND NO `fullWidth` PROP, AND BOTH WERE REMOVED RATHER THAN LEFT UNUSED.
 *
 * `variant="compact"` chose `SCALES.compact` in `components/RichText.tsx` and, here, a document box
 * carrying the reading FACE instead of the whole recipe — a second styling of the box that no page on the
 * site ever asked for. Nothing renders `RichText` in its compact scale anywhere either (`grep -rn
 * "<RichText"` finds this file and `components/sections/RichTextSection.tsx`, neither passing a variant),
 * so the branch and the paragraph of reasoning above it described a path a reader could not reach. A
 * caller that genuinely wants a compact passage renders `<RichText variant="compact">` directly, which is
 * the same thing one level down and without a recipe to refuse.
 *
 * `fullWidth` resolved the measure to `full`. No long-form record type has a "fill the column" control
 * anywhere in the studio — `houseMeasureEnum` deliberately cannot choose `full` ("an unbounded line is a
 * per-block escape, never a policy"), and only a `PageSection` carries the per-block escape — so the prop
 * encoded a decision nobody could make. It also made `resolveTypeset`'s two refusal branches look
 * reachable from here, which they are not: see `houseProseTypeset` below.
 */

/**
 * The house typesetting style, or its built-in defaults — THE ONE READER OF THE `typography` GROUP.
 *
 * ⚠ THE `catch` IS NOT DEFENSIVE PADDING. `getSettingCached` reaches the database, and the one thing a
 * reader must never do is fail to render a page's prose because a settings row could not be read — the
 * defaults ARE the house style until somebody changes them, so falling back to them costs nothing a
 * visitor can see. `lib/settings/service.ts` already repairs a partly-invalid document field by field
 * and warns; this covers the case where the read itself did not happen.
 *
 * `getSettingCached` is `cache()`-wrapped, so a page holding an article and twelve text blocks pays for
 * ONE query, and a layout that has already read the settings pays for none.
 */
export async function houseTypeset(): Promise<HouseTypeset> {
  try {
    return await getSettingCached("typography");
  } catch (error) {
    console.error(
      `[typography] the typography settings could not be read, so the built-in house style is in use: ${String(error)}`
    );
    return HOUSE_TYPESET_DEFAULT;
  }
}

/**
 * The house style RESOLVED — what every class-name helper in `lib/typography/typeset.ts` takes.
 *
 * This is the entry point for a page that sets a passage which is not a stored document: a publication's
 * abstract (`app/(site)/publications/[slug]/page.tsx` reads it for exactly that), a citation, a
 * plain-text biography written before the rich editor existed. It hands back the same `ResolvedTypeset`
 * this component uses on itself, so `typesetFaceClassName(resolved)` on a lone paragraph puts it in the
 * same reading face as the article beside it.
 *
 * There are no per-block overrides to combine here — `BLOCK_TYPESET_DEFAULT` is every field on
 * `inherit`, which is the honest way to say "this passage has no opinions of its own". Only a
 * `PageSection` carries overrides, and only `RichTextSection` reads them.
 *
 * ⚠ IT TAKES NO ARGUMENTS, AND `alignment` AND `width` ARE FIXED HERE RATHER THAN OFFERED.
 *
 * It had both as options and nothing ever passed either, which made two branches of `resolveTypeset`
 * look reachable from here when no code path could produce them. Both are fixed to the only value this
 * entry point can honestly claim:
 *
 *  • `alignment: "left"` — the two refusals in `resolveTypeset` (a drop cap and justification both need
 *    a flush left edge) exist for a block whose alignment an editor chose, which is a `PageSection`
 *    field read by `RichTextSection`. A long-form record has no alignment control at all, and a page
 *    that centres a lone paragraph does it with a `text-center` of its own, which this function neither
 *    sees nor should override.
 *  • `width: "narrow"` — "wide" resolves the measure to `full`, i.e. no reading width. That is the
 *    per-block escape a `PageSection` can choose (`MEASURE_CHOICES.full`); it is not something a record
 *    type gets, which is why `houseMeasureEnum` cannot choose it either.
 *
 * If a caller ever genuinely needs one of them, add the parameter back WITH the caller in the same edit.
 */
export async function houseProseTypeset(): Promise<ResolvedTypeset> {
  return resolveTypeset({
    block: BLOCK_TYPESET_DEFAULT,
    house: await houseTypeset(),
    alignment: "left",
    width: "narrow"
  });
}

/**
 * The rhythm for the MDX branch — what the house recipe does NOT own, and nothing it does.
 *
 * Complete literal class strings, so the content scanner sees them (contract §5).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ EVERY MARGIN AND EVERY LEADING THAT USED TO BE IN THIS LIST HAS BEEN REMOVED, AND THE ARITHMETIC
 *   FOR WHY IS THE WHOLE NOTE.
 *
 * The recipe beats what `components/RichText.tsx` writes because RichText puts a plain utility on an
 * element — `mt-5`, specificity (0,1,0) — and every rule in the recipe is a class plus an element,
 * (0,1,1). **An arbitrary DESCENDANT variant is not a plain utility.** `[&_p]:mt-5` compiles to
 * `.\[\&_p\]\:mt-5 p`, which is also (0,1,1) — a TIE with the recipe. Tailwind emits `@layer utilities`
 * after `@layer components`, where the recipe lives, so on a tie the utility wins.
 *
 * So while this list restated the rhythm, the recipe reached the Tiptap branch and was cancelled in the
 * MDX one: `[&_p]:mt-5` beat `--prose-gap`, `[&_h2]:mt-12` beat the heading rhythm that is the single
 * fix the recipe was written for, `[&_h2]:leading-snug` beat `line-height: 1.15`, `[&_blockquote]:text-lg`
 * beat the quotation size, and `[&_h4]:text-lg` beat the `max()` guard that stops a Feature-sized
 * paragraph overtaking its own heading. An MDX page and a Tiptap page sitting next to each other in a
 * listing would have read as two different publications — which is the exact thing this constant's own
 * comment claimed it existed to prevent.
 *
 * WHAT IS STILL HERE, AND WHY EACH ONE IS NOT THE RECIPE'S BUSINESS (its header says so in full):
 *  • **Heading SIZES.** The recipe cannot set them: RichText clamps document levels 1 and 2 to the same
 *    `<h2>` tag, so a CSS rule on `h2` cannot tell them apart and any size there would flatten an H1 on
 *    every page. The numbers match RichText's `article` scale so the two branches agree.
 *  • **The PROMOTED LEVEL 1** (`[data-mdx-h1]`), which is the same clamp in the MDX branch — see
 *    `MdxTitle`. ⚠ ITS SIZE CANNOT BE A CLASS ON THE ELEMENT, and that is this list's own trap read
 *    backwards. `<h2 className="text-3xl sm:text-4xl">` is (0,1,0) per utility, and `[&_h2]:text-2xl`
 *    three lines below is (0,1,1) — so the obvious fix renders a promoted `<h1>` at level-2 size and
 *    looks like it worked. An attribute inside an arbitrary variant is (0,2,0) and wins, which is the
 *    same mechanism `PROSE_NODE_HOOK_CLASS` uses for the lead paragraph. Leading is deliberately NOT
 *    restated: the recipe's `.prose-typeset h2 { line-height: 1.15 }` already reaches it, exactly as it
 *    reaches a Tiptap level 1, and the two branches must agree.
 *  • **Colour, weight, tracking, list markers, borders** — none of it is in the recipe, by design.
 *  • **`pre`, `table` and `figure` margins.** The recipe deliberately leaves block furniture alone; its
 *    `* + <element>` rules cover p, li, ul, ol, hr, blockquote and the headings, and nothing else.
 *  • **`text-base leading-7 text-ink-700` on the box.** Kept on purpose, to mirror RichText's own root
 *    `<div>`: the recipe sets size and leading on the ELEMENTS precisely because that class exists, and
 *    anything the recipe does not reach — a bare table cell — must still match the Tiptap branch.
 *  • **The heading FACE is gone from here.** `DISPLAY_FACE_CLASS` in lib/typography/typeset.ts sets it
 *    from the house `headingFace`, in the same (0,1,1) shape — so `[&_h2]:font-display` here would tie
 *    with it and an administrator who chose Playfair would get it on Tiptap articles and not on MDX ones.
 *
 * ⚠ THE LEVEL-3 SIZE IS AN ARBITRARY `max()` RATHER THAN `text-xl`, and it is the one place this list
 * reproduces a recipe rule instead of deleting it. globals.css guards a level-3 heading against a large
 * reading size only BELOW `sm` (a `sm:` variant carries no specificity, so an unguarded rule would delete
 * the responsive step at every width). That guard is (0,1,1) and would lose the tie to a `text-xl` here,
 * so the guard is written out instead of defeated. `1.25rem` IS `text-xl`, so nothing moves at the
 * reading sizes where the guard is inert.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const MDX_RHYTHM = cn(
  "text-base leading-7 text-ink-700",
  // Still earning its place: the `pre`, `table` and `figure` margins below are block furniture the
  // recipe does not own, and a document that opens with a code block or a table must not open with a
  // gap above it. (0,2,0), so it beats them. The recipe's own `* + <element>` rules never reach a first
  // child in the first place — there is nothing before it to be spaced from.
  "[&>*:first-child]:mt-0",
  // ⚠ The breakpoint goes OUTSIDE the arbitrary variant — `sm:[&_h2]:text-3xl`, never
  // `[&_h2]:sm:text-3xl`. Only the first spelling is the documented order, and the wrong one is a
  // class that compiles to nothing and fails silently.
  // The promoted level 1. (0,2,0), so it beats the `[&_h2]` sizes below at (0,1,1); everything else a
  // heading needs — the display face, the weight, the tracking, the colour, the recipe's margins and its
  // 1.15 leading — already reaches it, because the element genuinely IS an `<h2>`.
  "[&_[data-mdx-h1]]:text-3xl sm:[&_[data-mdx-h1]]:text-4xl",
  "[&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-ink-900 sm:[&_h2]:text-3xl",
  "[&_h3]:text-[max(1.25rem,calc(var(--prose-size,1.0625rem)*1.14))] [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:text-ink-900 sm:[&_h3]:text-2xl",
  "[&_h4]:font-semibold [&_h4]:tracking-tight [&_h4]:text-ink-900",
  "[&_ul]:list-disc [&_ul]:pl-6",
  "[&_ol]:list-decimal [&_ol]:pl-6",
  "[&_li]:marker:text-ink-300",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-purple-300 [&_blockquote]:pl-5",
  "[&_pre]:mt-6 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-line-200 [&_pre]:bg-surface-100 [&_pre]:p-4 [&_pre]:text-sm [&_pre]:leading-6",
  "[&_code]:font-mono [&_code]:text-[0.9em]",
  "[&_hr]:border-line-200",
  "[&_strong]:font-semibold [&_strong]:text-ink-900",
  // A wide table scrolls inside its own box; letting it widen the page turns every other section on
  // the page into a sideways-scrolling one.
  "[&_table]:mt-8 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:text-left",
  "[&_th]:px-3 [&_th]:py-2 [&_th]:text-sm [&_th]:font-semibold [&_th]:text-ink-900",
  "[&_td]:px-3 [&_td]:py-2 [&_td]:text-sm"
);

/**
 * The gap between a standfirst and the body it introduces.
 *
 * ⚠ IT IS A UTILITY ON THE BODY'S OWN ROOT, NOT A WRAPPER, and swapping it for a wrapper `<div>` breaks
 * the drop cap. `.ts-dropcap > * > p:first-of-type` in globals.css means "the first paragraph inside the
 * ONE wrapper RichText renders" — deliberately two levels, so a capital cannot appear inside a callout or
 * a quotation. One more element between the recipe and that paragraph and the selector matches nothing.
 * `RichText` merges a `className` into its root, which is why this is passed rather than wrapped.
 *
 * `mt-10` is the gap `app/(site)/news/[slug]/page.tsx` already put between its excerpt and its body
 * before the standfirst moved in here, so moving it changes the words' position by nothing.
 */
const STANDFIRST_GAP = "mt-10";

/**
 * The gap under the listen control.
 *
 * ⚠ IT IS PASSED TO `ReadAloud` RATHER THAN PUT ON A WRAPPER HERE, and that is the whole reason it is
 * a `mb-*` on the controls instead of an `mt-*` on the document box. `ReadAloud` renders an empty,
 * class-less host element until it has confirmed after mount that the browser can speak and that the
 * piece is long enough to be worth speaking — so on a browser with no `speechSynthesis`, or above a
 * short record, this margin is attached to nothing and the prose starts exactly where it always did.
 * A margin written here, on an element this file always renders, would open 32px above every article
 * on the site for a feature most of those readers never see.
 */
const LISTEN_GAP = "mb-8";

/**
 * The deck, as a real lead paragraph.
 *
 * ⚠ BOTH HALVES ARE REQUIRED AND THE ATTRIBUTE IS THE LOAD-BEARING ONE. The class comes from
 * `components/RichText.tsx`, so this paragraph and a `leadParagraph` node an editor inserted are the same
 * paragraph drawn from the same string. `data-lead` is the studio's own marker for that node
 * (`components/studio/editor/extensions.ts`), and INSIDE the recipe it is the attribute rather than the
 * class that carries the size: `PROSE_NODE_HOOK_CLASS` reaches it at (0,2,0), where the class's
 * `text-lg sm:text-xl` is (0,1,0) and loses to `.prose-typeset :is(p, li)` at (0,1,1). A deck without the
 * attribute renders at body size — which is precisely the fault this component was opened to fix.
 *
 * The scale is `leadParagraphClassName`'s own default, the `article` one. Both branches of this component
 * set their body at that scale, so a deck cannot end up smaller than the body it introduces.
 */
function standfirstParagraph(deck: string): ReactNode {
  if (deck.length === 0) return null;
  return (
    <p data-lead="" className={leadParagraphClassName()}>
      {deck}
    </p>
  );
}

/**
 * Links inside MDX.
 *
 * Anything that is not a path, an anchor or a query is another origin: it opens in a new tab with
 * the `rel` pair, and says so, because a reader whose focus lands in a new tab with no warning has
 * lost their place and their Back button with it.
 */
const LINK_CLASSES =
  "text-purple-700 underline decoration-purple-300 underline-offset-2 transition-colors hover:decoration-purple-700 dark:text-purple-300 dark:decoration-purple-300/50 dark:hover:decoration-purple-300";

function MdxLink({ href, children }: { href?: string; children?: ReactNode }) {
  const target = href ?? "";
  if (target.startsWith("/") || target.startsWith("#") || target.startsWith("?")) {
    return (
      <Link href={target} className={LINK_CLASSES}>
        {children}
      </Link>
    );
  }
  const external = /^https?:/i.test(target);
  return (
    <a
      href={target}
      className={LINK_CLASSES}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
      {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </a>
  );
}

/**
 * A markdown `# heading` — rendered as an `<h2>`, exactly as the Tiptap branch renders a document's
 * level 1.
 *
 * ⚠ THIS IS AN ACCESSIBILITY CLAMP, NOT A STYLING CHOICE, AND ITS ABSENCE WAS A REAL DEFECT. The page
 * owns the only `<h1>` (contract §11), and `#` is the most natural first line anybody writes in markdown.
 * Without this the MDX branch emitted a second `<h1>` on the page — and, because Tailwind's preflight is
 * on and both `MDX_RHYTHM` and the recipe style `h2`/`h3`/`h4` only, it emitted it as
 * `font-size: inherit; font-weight: inherit; margin: 0`: a screen-reader user heard two document titles
 * while a sighted reader saw no heading at all. `components/RichText.tsx` has clamped level 1 to an
 * `<h2>` since it was written (`HEADING_TAGS`); this is the same clamp for the other source.
 *
 * ⚠ THE SIZE IS AN ATTRIBUTE, NOT A CLASS ON THIS ELEMENT. See `MDX_RHYTHM` — `[&_h2]:text-2xl` there is
 * (0,1,1) and would beat any utility written here. The attribute is inert on its own; the rule that reads
 * it lives in that constant, which is also the only file Tailwind's scanner needs to see it in.
 *
 * `children` is the only prop taken. Nothing in this pipeline gives a heading an `id` — there is no
 * `rehype-slug` in the options below — so there is no anchor to forward, and inventing one here would
 * produce a link target the page's table of contents does not know about.
 */
function MdxTitle({ children }: { children?: ReactNode }) {
  return <h2 data-mdx-h1="">{children}</h2>;
}

/**
 * A media-library figure, exposed to MDX as `<MediaFigure objectKey="…" alt="…" />`.
 *
 * This is the ONLY way an image reaches an MDX page, because every image on this site goes through
 * `MediaImage` (contract) — which needs a storage key so the derivative pipeline can pick a width.
 * A markdown `![](url)` has no key and no dimensions, so it renders the note below instead of a bare
 * `<img>` that would resize the layout as it loads.
 */
function MediaFigure({
  objectKey,
  alt = "",
  caption,
  width,
  height
}: {
  objectKey: string;
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
}) {
  return (
    <figure className="mt-8">
      <MediaImage
        media={{ objectKey, width, height, altText: alt }}
        alt={alt}
        sizes="(min-width: 1024px) 48rem, 100vw"
        className="border border-line-200"
      />
      {caption ? <figcaption className="mt-2 text-sm leading-6 text-ink-500">{caption}</figcaption> : null}
    </figure>
  );
}

/** SAY SO RATHER THAN LEAVE A GAP (contract §1.6) — a dropped image is invisible to the one person
 *  who could fix it. */
function MdxImageNotice() {
  return (
    <span className="mt-8 flex items-center gap-3 rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-6 text-sm text-ink-500">
      <ImageOff className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span>
        This image was written as plain markdown and cannot be shown. Insert it from the media
        library instead, as <code className="font-mono">{"<MediaFigure objectKey=… alt=… />"}</code>.
      </span>
    </span>
  );
}

export async function ProseArticle({
  value,
  mdx,
  standfirst,
  fallback,
  children,
  className
}: ProseArticleProps) {
  const source = typeof mdx === "string" ? mdx.trim() : "";
  const deck = typeof standfirst === "string" ? standfirst.trim() : "";

  const typeset = await houseProseTypeset();

  /**
   * The COLUMN. The measure and the caller's own class, and nothing else — see the header's two boxes.
   *
   * `typesetMeasureClassName` writes `prose-measure` AND the house's `ts-measure-*`, which is what
   * re-points `--measure` on this element (lib/typography/typeset.ts). EVERY branch below renders it, so
   * the reading measure a record gets never depends on which of the branches it took.
   */
  const column = cn(typesetMeasureClassName(typeset), className);

  /** The DOCUMENT box: the recipe plus every `ts-*` class, on one element, around the prose alone. */
  const documentClass = typesetClassName(typeset);

  if (source.length > 0) {
    // Loaded here, not at module scope. See the header.
    const [{ compileMDX }, { default: remarkGfm }] = await Promise.all([
      import("next-mdx-remote/rsc"),
      import("remark-gfm")
    ]);

    const { content } = await compileMDX({
      source,
      options: { mdxOptions: { remarkPlugins: [remarkGfm] } },
      // ⚠ `h1` IS A CLAMP THIS MAP MUST CARRY, not a style override — see `MdxTitle`. Without it a
      // markdown `# heading` becomes a second `<h1>` on the page (contract §11) with no size and no
      // margin at all, because preflight strips both and nothing here styles an `h1`.
      components: { a: MdxLink, img: MdxImageNotice, h1: MdxTitle, MediaFigure }
    });

    return (
      <div className={column} data-read-aloud-scope="">
        {/* An MDX record only exists because somebody wrote a body, so there is always something to
            read aloud on this branch. See the header. */}
        <ReadAloud className={LISTEN_GAP} />
        <div className={documentClass} data-read-aloud-source="">
          {standfirstParagraph(deck)}
          <div className={cn(MDX_RHYTHM, deck ? STANDFIRST_GAP : undefined)}>{content}</div>
        </div>
        {children}
      </div>
    );
  }

  // Parsed here rather than inferred from `RichText` returning null, so the fallback decision is
  // made from the document itself. A document holding one empty paragraph is EMPTY — that is the
  // shape Tiptap writes for a field somebody merely clicked into (lib/richtext.ts).
  const doc = parseRichText(value);
  const hasBody = doc !== null && !isEmptyRichText(doc);
  const hasDocument = hasBody || deck.length > 0;

  /**
   * Is there a fallback to draw at all?
   *
   * ⚠ TESTED AGAINST THE THREE VALUES JSX ITSELF DROPS — `undefined`, `null`, `false` — rather than for
   * truthiness, because those three are exactly what "no fallback" means to React and nothing else is.
   * A caller writes `fallback={person.bio?.trim() ? <div…/> : <p…/>}`, whose falsy arm is often `null`;
   * a bare `!fallback` would agree about that and then also drop a `0`, which React renders as text.
   * This is the only test in the file that decides whether the component draws anything at all, so it
   * says precisely what it means rather than approximately.
   */
  const hasFallback = fallback !== undefined && fallback !== null && fallback !== false;

  /**
   * NOTHING AT ALL IS `null`, AND IT IS THE ONLY EARLY RETURN LEFT.
   *
   * It returns before the `<div>` rather than an empty one: a column carrying a measure where a body
   * should be still occupies the `mt-*` the page above it already paid for, so an unwritten biography
   * would push the rest of the page down by the height of nothing. Compare `RichText` itself, which
   * returns `null` for an empty document for the same reason.
   *
   * ⚠ IT DOES NOT RETURN THE FALLBACK. That is the defect this component was reopened for — see the
   * header. Every visible thing goes through the ONE column below, whichever combination of body, deck,
   * fallback and children a record turns out to have.
   */
  if (!hasDocument && !hasFallback && !children) return null;

  return (
    <div className={column} data-read-aloud-scope="">
      {/*
        ⚠ `hasBody`, NOT `hasDocument`. A record with a deck and no body has one sentence in its
        document box, and a "read aloud" control over a single sentence is a control that costs more
        attention than the sentence does. `ReadAloud` applies its own minimum length on top of this,
        measured from the rendered text — this test is only about whether there is an article here at
        all. (It is also why the control is not offered beside a `fallback`: see the header.)
      */}
      {hasBody ? <ReadAloud className={LISTEN_GAP} /> : null}
      {hasDocument ? (
        <div className={documentClass} data-read-aloud-source="">
          {standfirstParagraph(deck)}
          {/*
            ⚠ THE STANDFIRST'S GAP IS PASSED INTO `RichText`, NOT WRAPPED AROUND IT. See `STANDFIRST_GAP`
            — one more element between this box and the document's first paragraph and the drop-cap
            selector matches nothing.
          */}
          {hasBody ? (
            <RichText value={doc} className={deck ? STANDFIRST_GAP : undefined} />
          ) : null}
        </div>
      ) : null}
      {/*
        ⚠ THE FALLBACK IS RENDERED INSIDE THE COLUMN AND OUTSIDE THE DOCUMENT BOX — the same place
        `children` land, and the same place on every path. It is not a document: every caller passes their
        own finished markup — "No description has been published for this event yet" — already carrying its
        own size and colour. Setting it in the house reading face at the house size would make an apology
        look like the article that is missing, and `.ts-dropcap > * > p:first-of-type` would put a
        three-line capital on it. Inside the column it still gets the one thing every line of text on this
        site gets, which is the reading measure.

        No `hasFallback` test here on purpose: React drops `undefined`, `null` and `false` on its own, and
        a second guard saying so would read as though it were guarding something. `hasFallback` is used
        once, above, where the answer decides whether this component renders at all.
      */}
      {hasBody ? null : fallback}
      {children}
    </div>
  );
}
