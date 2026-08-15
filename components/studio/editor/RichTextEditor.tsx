"use client";

/**
 * RichTextEditor — the studio's writing surface.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHAT THIS EDITOR CAN PRODUCE, components/RichText.tsx MUST BE ABLE TO DRAW. The node and mark
 *   set is fixed in components/studio/editor/extensions.ts and checked against `lib/richtext.ts` on
 *   every mount in development, because an editor that can produce a node the renderer does not draw
 *   is a way for an author to write content that SILENTLY VANISHES WHEN PUBLISHED: the studio shows
 *   the block, the published page shows a gap, and nobody is told.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT IS CONTROLLED-ISH, AND THAT MATTERS MORE THAN IT SOUNDS. It initialises from `value` and reports
 * every change, but it does NOT re-set its own content whenever `value` changes. A studio form
 * autosaves: the parent's state updates on every keystroke and the saved row comes back a few seconds
 * later, so an editor that obeyed `value` literally would replace the document — and move the caret to
 * the very start — while the author was mid-sentence. Content is only re-applied when the incoming
 * document is genuinely different from the last one this editor emitted, and never while it has focus
 * (that change is held and applied on blur, so a revision restored in another panel still lands).
 *
 * THE COMPARISON IS KEY-ORDER INDEPENDENT. Prisma stores these documents in a `jsonb` column and
 * Postgres reorders object keys inside jsonb — so the document read back from the database is byte-
 * different from the one that was sent while being the same document. A plain `JSON.stringify`
 * comparison reports "changed" on the first autosave response and jumps the caret to the top of the
 * article. `fingerprint()` sorts keys.
 *
 * `immediatelyRender: false` IS TIPTAP'S SSR GUARD. Without it the editor renders during the server
 * pass and hydration reports a mismatch on the whole document.
 *
 * PASTE IS SANITISED, NOT TRUSTED. Word and Google Docs paste a wall of markup; ProseMirror already
 * discards anything outside the schema, but three things need doing by hand — remote `<img>` elements
 * (which would store somebody else's URL, see the picture node), headings below level 4 (which would
 * silently flatten), and foreign `<figure>` wrappers (whose caption would be discarded along with the
 * remote picture the schema will not accept). All three are handled and ALL THREE ARE ANNOUNCED,
 * because a paste that quietly loses three photographs is the same bug class as a list that quietly
 * stops (contract §1.6).
 *
 * PICTURES COME FROM THE MEDIA LIBRARY AND ARE STORED AS A KEY, NEVER A URL. The picker itself belongs
 * to another screen; this component asks for one through `onRequestMedia` and inserts what comes back
 * as a FIGURE — the picture plus a caption the author can write, link and italicise, rather than the
 * flat attribute a caption used to be. Bare `image` nodes remain fully renderable; nothing migrates.
 *
 * MOTION: none, deliberately. No reveal, no scroll effects. The studio is calm and dense (contract
 * §0) and a writing surface that animates is a writing surface that is in the way.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { ImageOff, TriangleAlert, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { emptyRichTextDoc, parseRichText, type RichTextDoc } from "@/lib/richtext";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EditorToolbar } from "@/components/studio/editor/EditorToolbar";
import { LinkDialog, type PageLinkSearch } from "@/components/studio/editor/LinkDialog";
import { SlashCommands } from "@/components/studio/editor/SlashCommands";
import { TableControls } from "@/components/studio/editor/TableControls";
import {
  createRichTextExtensions,
  describeSchemaDrift,
  imageAttrsFromMedia,
  EDITOR_SHORTCUT_GROUPS,
  type EditorMediaSelection
} from "@/components/studio/editor/extensions";

export interface RichTextEditorProps {
  /** The stored document — a `Json` column value, or an already-parsed one. Anything else is empty. */
  value: unknown;
  /** Every edit, as a normalised document ready to be written back to the column. */
  onChange: (doc: RichTextDoc) => void;
  /**
   * Fired on every edit the author makes.
   *
   * A themed control fires no native input event, so a form's `onInput` dirty-tracker never sees this
   * field (contract §10). Call it from here or the Save bar will say "no changes" about an article
   * somebody has just rewritten.
   */
  onDirty?: () => void;
  /** Shown in an empty document. Read once, when the editor is created. */
  placeholder?: string;
  /** The minimum height of the writing area, in pixels. Default 320. */
  minHeight?: number;
  /**
   * Opens the media picker and resolves with the chosen asset, or null if the author changed their
   * mind. Omitted → there is no way to insert a picture and no button offering to.
   *
   * ⚠ A CALLBACK RATHER THAN THE PICKER ITSELF, so this file does not depend on
   * components/studio/media/MediaPicker.tsx and either can be worked on without the other.
   */
  onRequestMedia?: () => Promise<EditorMediaSelection | null>;
  /** Replaces the link dialog's page search. See LinkDialog. */
  searchPages?: PageLinkSearch;
  /** False for a read-only view. The toolbar and the "/" menu stand down with it. */
  editable?: boolean;
  /** The writing area's accessible name. Say which field it is: "Article body". */
  label?: string;
  /** Ids of any help or error text belonging to this field, for `aria-describedby`. */
  describedById?: string;
  className?: string;
}

/**
 * The prose styles, written out literally.
 *
 * Tailwind's typography plugin is not installed and must not be added (contract §13): it knows
 * nothing about the ink/line/surface ladders, which are the only reason this inverts correctly under
 * `data-theme="dark"`. Every rule below is an arbitrary variant on the ProseMirror element, so the
 * class strings are literal text in this file and survive the content scan (contract §5).
 *
 * The sizes deliberately track the `article` scale in components/RichText.tsx. They are not identical
 * — the studio is denser, and the editor has a toolbar above it rather than a page of whitespace —
 * but a heading that looks like a heading here must look like a heading there.
 */
const EDITOR_PROSE_CLASS = [
  // The surface itself. `outline-none` because the box around it carries the focus ring.
  "min-h-full px-4 py-3 text-base leading-7 text-ink-700 outline-none",

  // Paragraphs
  "[&_p]:mt-4 [&_p:first-child]:mt-0",

  // Headings. The document's own 1–4; the public renderer clamps level 1 to an `<h2>` so the page
  // keeps its only `<h1>`, but here the author must see the level they chose.
  "[&_h1]:mt-8 [&_h1]:font-display [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:leading-tight [&_h1]:tracking-tight [&_h1]:text-ink-900",
  "[&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:leading-snug [&_h2]:tracking-tight [&_h2]:text-ink-900",
  "[&_h3]:mt-6 [&_h3]:font-display [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:leading-snug [&_h3]:tracking-tight [&_h3]:text-ink-900",
  "[&_h4]:mt-6 [&_h4]:font-display [&_h4]:text-lg [&_h4]:font-semibold [&_h4]:leading-snug [&_h4]:tracking-tight [&_h4]:text-ink-900",
  "[&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0 [&_h4:first-child]:mt-0",

  // Lists
  "[&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-6",
  "[&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_li]:mt-1.5 [&_li]:marker:text-ink-300",
  // A list inside a list item must not take the top margin twice.
  "[&_li>ul]:mt-1.5 [&_li>ol]:mt-1.5 [&_li>p]:mt-0",

  // Quote
  "[&_blockquote]:mt-5 [&_blockquote]:border-l-2 [&_blockquote]:border-purple-300 [&_blockquote]:pl-4 [&_blockquote]:text-ink-700",

  // Code. All `code` gets the inline treatment, then the copy inside a `pre` is reset — a
  // `:not(pre code)` selector would be doing the same job with a rule browsers disagree about.
  "[&_code]:rounded [&_code]:bg-surface-200 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-ink-900",
  "[&_pre]:mt-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-line-200 [&_pre]:bg-surface-100 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:leading-6",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-sm",

  // Standfirst and drop cap. Both are their own node types, so both are plain `<p>` elements carrying
  // a marker attribute — and an attribute selector (0,2,0) beats the bare `[&_p]` rules above (0,1,1),
  // which is why they do not need `!`.
  "[&_[data-lead]]:mt-5 [&_[data-lead]]:text-lg [&_[data-lead]]:leading-8 [&_[data-lead]]:text-ink-900",
  "[&_[data-drop-cap]]:first-letter:float-left [&_[data-drop-cap]]:first-letter:mr-2.5 [&_[data-drop-cap]]:first-letter:mt-1 [&_[data-drop-cap]]:first-letter:font-display [&_[data-drop-cap]]:first-letter:text-5xl [&_[data-drop-cap]]:first-letter:font-bold [&_[data-drop-cap]]:first-letter:leading-[0.78] [&_[data-drop-cap]]:first-letter:text-ink-900",
  // The float has to be closed inside the paragraph that owns it, or a short opening line lets the
  // next block wrap around the cap. Same trap as the renderer's — see RichText.tsx's DROP_CAP note.
  "[&_[data-drop-cap]]:after:block [&_[data-drop-cap]]:after:clear-left [&_[data-drop-cap]]:after:content-['']",

  // Pull quote. It IS a `<blockquote>`, so it inherits the purple left rule above and has to put it
  // back — the rules above and below are what say "lifted out of the argument", and a left bar as well
  // would make it read as an ordinary quote that had been shouted.
  "[&_[data-pull-quote]]:my-6 [&_[data-pull-quote]]:border-y [&_[data-pull-quote]]:border-l-0 [&_[data-pull-quote]]:border-line-200 [&_[data-pull-quote]]:py-5 [&_[data-pull-quote]]:pl-0 [&_[data-pull-quote]]:text-center [&_[data-pull-quote]]:font-display [&_[data-pull-quote]]:text-2xl [&_[data-pull-quote]]:font-medium [&_[data-pull-quote]]:leading-snug [&_[data-pull-quote]]:tracking-tight [&_[data-pull-quote]]:text-ink-900",

  // The credit line closing either kind of quote. The em dash is drawn here rather than typed, so an
  // author cannot end up with two of them, and it is `content` so it never enters the document.
  "[&_[data-attribution]]:mt-3 [&_[data-attribution]]:text-sm [&_[data-attribution]]:not-italic [&_[data-attribution]]:leading-6 [&_[data-attribution]]:text-ink-500",
  "[&_[data-attribution]]:before:content-['—_']",

  // Side note: quieter than a quote, unboxed unlike a callout.
  "[&_[data-side-note]]:mt-5 [&_[data-side-note]]:border-l [&_[data-side-note]]:border-line-200 [&_[data-side-note]]:pl-4 [&_[data-side-note]]:text-sm [&_[data-side-note]]:leading-6 [&_[data-side-note]]:text-ink-500",
  "[&_[data-side-note]>p:first-child]:mt-0",

  // Definition list
  "[&_dl]:mt-5",
  "[&_dt]:mt-4 [&_dt]:font-semibold [&_dt]:text-ink-900 [&_dt:first-child]:mt-0",
  "[&_dd]:mt-1 [&_dd]:border-l [&_dd]:border-line-200 [&_dd]:pl-4",

  /**
   * Multi-column passages.
   *
   * ⚠ THE ATTRIBUTE VALUE MUST BE QUOTED. An unquoted CSS attribute value has to be a valid
   * identifier and an identifier may not begin with a digit, so `[data-columns=2]` is invalid CSS —
   * the browser drops the whole rule and the passage silently stays in one column. The `[data-callout=note]`
   * selectors further down are safe unquoted only because their values are words.
   *
   * One column below `sm` for the same reason the published page does it: two columns of prose in a
   * narrow studio panel is four words a line.
   */
  "[&_[data-columns]]:mt-5 [&_[data-columns]]:gap-8",
  "sm:[&_[data-columns='2']]:columns-2",
  "sm:[&_[data-columns='3']]:columns-2 lg:[&_[data-columns='3']]:columns-3",
  "[&_[data-columns]_figure]:break-inside-avoid [&_[data-columns]_pre]:break-inside-avoid",

  // Figures. The caption is a real editable node, so it gets the caption treatment and a prompt when
  // empty (see `placeholderForNode` in extensions.ts) — an invisible zero-height box is a box nobody
  // knows is there.
  "[&_figure]:mt-4",
  "[&_figure_img]:mt-0",
  "[&_figcaption]:mt-2 [&_figcaption]:text-sm [&_figcaption]:leading-6 [&_figcaption]:text-ink-500",

  // Rule, and its ornament variant.
  //
  // ⚠ A KNOWN, BOUNDED DIFFERENCE FROM THE PUBLISHED PAGE. The renderer draws the ornament as three
  // round dots inside a `<div role="separator">`; an `<hr>` is a void element and cannot hold them,
  // and ProseMirror's DOM for this node is an `<hr>`. So the studio shows the same idea in the only
  // form the element allows — a short, centred, dotted rule. It is unmistakably not a hairline, which
  // is the distinction an author is making when they choose it.
  "[&_hr]:my-6 [&_hr]:border-line-200",
  "[&_hr[data-rule=ornament]]:mx-auto [&_hr[data-rule=ornament]]:w-24 [&_hr[data-rule=ornament]]:border-t-2 [&_hr[data-rule=ornament]]:border-dotted [&_hr[data-rule=ornament]]:border-ink-300",

  // A code block's language, printed above it exactly as the published page prints it. The label text
  // comes from `data-language-label`, which `RichTextBlockAttributes` writes — the stock extension
  // stores the language only as a class name on the inner `<code>`, and CSS `attr()` cannot read one.
  "[&_pre[data-language]]:before:mb-2 [&_pre[data-language]]:before:block [&_pre[data-language]]:before:font-sans [&_pre[data-language]]:before:text-xs [&_pre[data-language]]:before:font-semibold [&_pre[data-language]]:before:uppercase [&_pre[data-language]]:before:tracking-wide [&_pre[data-language]]:before:text-ink-500 [&_pre[data-language]]:before:content-[attr(data-language-label)]",

  // Links, matching the renderer's own treatment — including the lighter rung on a dark canvas,
  // because purple-700 does not invert and is unreadable on `bg-0` in dark mode.
  "[&_a]:text-purple-700 [&_a]:underline [&_a]:decoration-purple-300 [&_a]:underline-offset-2",
  "dark:[&_a]:text-purple-300",

  // Marks
  "[&_strong]:font-semibold [&_strong]:text-ink-900",
  "[&_u]:underline [&_u]:underline-offset-2",
  "[&_mark]:rounded [&_mark]:bg-warn-100 [&_mark]:px-0.5 [&_mark]:text-warn-800",

  // Small caps. `font-variant-caps` has no stock utility, so it is an arbitrary property; the face has
  // no real small-cap glyphs and the browser synthesises them, which is the same thing the published
  // page does. See the `SmallCaps` mark for why that is still the right property.
  "[&_[data-small-caps]]:[font-variant-caps:small-caps]",

  // Letter spacing and text colour: three named steps each, on stock Tailwind's own scales. Attribute
  // values here are words, so they need no quoting — unlike `data-columns` above.
  "[&_[data-tracking=tight]]:tracking-tight [&_[data-tracking=wide]]:tracking-wide [&_[data-tracking=wider]]:tracking-wider",
  // ⚠ These three must beat `[&_strong]:text-ink-900` on a bold coloured run, and they do: an
  // attribute selector scores (0,2,0) against a type selector's (0,1,1). The renderer solves the same
  // problem by nesting order instead — see the mark-order ⚠ in RichText.tsx.
  "[&_[data-colour=strong]]:text-ink-900 [&_[data-colour=muted]]:text-ink-500",
  "[&_[data-colour=brand]]:text-purple-700 dark:[&_[data-colour=brand]]:text-purple-300",

  // Pictures. The amber outline is the studio's nag for a missing description: not an error — a
  // picture without one still publishes — but the author is the only person who can write it.
  "[&_img]:mt-4 [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-line-200",
  "[&_img[data-alt-missing]]:outline [&_img[data-alt-missing]]:outline-2 [&_img[data-alt-missing]]:outline-offset-2 [&_img[data-alt-missing]]:outline-warn-500",

  // Tables. `.tableWrapper` and `.selectedCell` are prosemirror-tables' own class names; without the
  // second one a multi-cell selection is invisible and "Merge" looks broken.
  "[&_.tableWrapper]:mt-4 [&_.tableWrapper]:overflow-x-auto",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-left",
  "[&_th]:border [&_th]:border-line-200 [&_th]:bg-surface-100 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:align-top [&_th]:text-sm [&_th]:font-semibold [&_th]:text-ink-900",
  "[&_td]:border [&_td]:border-line-200 [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top [&_td]:text-sm",
  "[&_.selectedCell]:bg-purple-100",

  // Callouts. The left bar carries the tone as a colour AND the `::before` carries it as the very word
  // the published page prints (contract §11 — colour never carries meaning alone). The four words are
  // CALLOUT_TONE_LABELS; changing one means changing both.
  "[&_[data-callout]]:mt-5 [&_[data-callout]]:rounded-md [&_[data-callout]]:border [&_[data-callout]]:border-line-200 [&_[data-callout]]:border-l-4 [&_[data-callout]]:bg-surface-50 [&_[data-callout]]:p-3",
  "[&_[data-callout]]:before:mb-1 [&_[data-callout]]:before:block [&_[data-callout]]:before:text-xs [&_[data-callout]]:before:font-semibold [&_[data-callout]]:before:uppercase [&_[data-callout]]:before:tracking-wide [&_[data-callout]]:before:text-ink-500",
  "[&_[data-callout=note]]:border-l-purple-700 [&_[data-callout=note]]:before:content-['Note']",
  "[&_[data-callout=tip]]:border-l-success-600 [&_[data-callout=tip]]:before:content-['Tip']",
  "[&_[data-callout=warning]]:border-l-warn-500 [&_[data-callout=warning]]:before:content-['Warning']",
  "[&_[data-callout=danger]]:border-l-error-600 [&_[data-callout=danger]]:before:content-['Important']",
  "[&_[data-callout]>p:first-child]:mt-0",

  // Footnotes sit inline while they are being written and move to the foot of the published page.
  "[&_[data-footnote]]:rounded [&_[data-footnote]]:bg-purple-100 [&_[data-footnote]]:px-1 [&_[data-footnote]]:align-super [&_[data-footnote]]:text-[0.75em] [&_[data-footnote]]:text-purple-700",

  // The placeholder. `data-placeholder` is written by the Placeholder extension; the pseudo-element is
  // floated so it occupies no space and the caret sits in front of it.
  "[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-ink-300 [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",

  /**
   * Prompts for the four blocks that are INVISIBLE WHEN EMPTY.
   *
   * A caption, a definition term, a description and a credit line all have zero height with nothing in
   * them: an author inserts a figure, sees a picture, and has no way of knowing there is a caption
   * underneath waiting to be written. These four rules are the only thing that makes the box findable.
   *
   * ⚠ ONLY THESE FOUR SELECTORS, even though `Placeholder` is configured with `includeChildren` and
   * therefore puts `is-empty` and `data-placeholder` on EVERY empty block. `placeholderForNode` returns
   * `""` for everything else, so an unstyled empty paragraph would render an empty pseudo-element —
   * harmless, but styling `p.is-empty` here would whisper "Start writing" into every blank line of a
   * fifteen-paragraph article.
   */
  "[&_figcaption.is-empty]:before:pointer-events-none [&_figcaption.is-empty]:before:float-left [&_figcaption.is-empty]:before:h-0 [&_figcaption.is-empty]:before:text-ink-300 [&_figcaption.is-empty]:before:content-[attr(data-placeholder)]",
  "[&_dt.is-empty]:before:pointer-events-none [&_dt.is-empty]:before:float-left [&_dt.is-empty]:before:h-0 [&_dt.is-empty]:before:font-normal [&_dt.is-empty]:before:text-ink-300 [&_dt.is-empty]:before:content-[attr(data-placeholder)]",
  "[&_dd.is-empty]:before:pointer-events-none [&_dd.is-empty]:before:float-left [&_dd.is-empty]:before:h-0 [&_dd.is-empty]:before:text-ink-300 [&_dd.is-empty]:before:content-[attr(data-placeholder)]",
  // The credit line already draws an em dash in `::before`, so its prompt has to be `::after` — two
  // rules cannot share one pseudo-element, and losing the dash would make an empty credit line
  // indistinguishable from an empty paragraph.
  "[&_[data-attribution].is-empty]:after:pointer-events-none [&_[data-attribution].is-empty]:after:text-ink-300 [&_[data-attribution].is-empty]:after:content-[attr(data-placeholder)]"
].join(" ");

/**
 * Elements a paste may never contribute, whatever they contained.
 *
 * ProseMirror would ignore most of them anyway — nothing in the schema matches a `<form>` — but
 * `<script>` and `<style>` leak their TEXT into the document as prose, which is how a paste from a
 * web page ends up with a stylesheet in the middle of a paragraph.
 */
const PASTE_STRIP_SELECTOR =
  "script,style,link,meta,noscript,iframe,object,embed,svg,canvas,form,input,button,select,textarea,video,audio";

interface PasteReport {
  html: string;
  /** Remote pictures dropped. Stated on screen — see the header. */
  images: number;
  /** Headings below level 4 that were levelled up to 4 rather than flattened into prose. */
  demotedHeadings: number;
  /** Foreign figures unwrapped, whose captions became ordinary paragraphs. Also stated on screen. */
  unwrappedFigures: number;
}

/**
 * Coerce pasted HTML into something the schema can hold.
 *
 * ⚠ AN INTERNAL COPY IS LEFT ALONE. ProseMirror marks its own clipboard HTML with `data-pm-slice`,
 * and that HTML contains the `<img>` elements of any picture the author copied. Sanitising it would
 * mean copying and pasting a picture inside one document quietly lost it.
 */
function sanitisePastedHtml(html: string): PasteReport {
  if (html.includes("data-pm-slice") || typeof DOMParser === "undefined") {
    return { html, images: 0, demotedHeadings: 0, unwrappedFigures: 0 };
  }

  const document_ = new DOMParser().parseFromString(html, "text/html");
  const body = document_.body;

  for (const element of Array.from(body.querySelectorAll(PASTE_STRIP_SELECTOR))) {
    element.remove();
  }

  /**
   * Foreign figures are unwrapped and their captions become paragraphs.
   *
   * ⚠ WITHOUT THIS THE CAPTION'S WORDS WOULD BE LOST. Our `figure` node requires a picture child, and
   * the picture in a pasted figure is a remote `<img>` that the rule below is about to remove — so
   * ProseMirror would be asked to build a figure it cannot build and would discard the whole thing,
   * caption included. Unwrapping first keeps the sentence, which is usually the part worth keeping:
   * the credit line under a photograph.
   *
   * The caption is converted BEFORE the figure is unwrapped, so the two queries cannot race over a
   * node list that is being rearranged underneath them.
   */
  const figures = body.querySelectorAll("figure");
  const unwrappedFigures = figures.length;
  for (const caption of Array.from(body.querySelectorAll("figcaption"))) {
    const replacement = document_.createElement("p");
    replacement.innerHTML = caption.innerHTML;
    caption.replaceWith(replacement);
  }
  for (const figure of Array.from(figures)) {
    figure.replaceWith(...Array.from(figure.childNodes));
  }

  // Remote pictures. The picture node stores a media-library key, never a URL, so an `<img>` from
  // somebody else's site cannot be represented — and hotlinking it would be wrong even if it could.
  const images = body.querySelectorAll("img");
  const imageCount = images.length;
  for (const image of Array.from(images)) image.remove();

  // h5/h6 become h4. The heading ladder stops at 4 (see EDITOR_HEADING_LEVELS); left alone these
  // would match no parse rule and their text would arrive as an ordinary paragraph, so a pasted
  // document would lose the bottom of its outline without saying so.
  const deep = body.querySelectorAll("h5,h6");
  const demotedHeadings = deep.length;
  for (const heading of Array.from(deep)) {
    const replacement = document_.createElement("h4");
    replacement.innerHTML = heading.innerHTML;
    heading.replaceWith(replacement);
  }

  return { html: body.innerHTML, images: imageCount, demotedHeadings, unwrappedFigures };
}

/**
 * A deterministic string for a document, with object keys sorted.
 *
 * Sorted because Postgres reorders the keys inside a `jsonb` column: without this, the document that
 * comes back from a save is "different" from the one that was sent and the editor would reset itself
 * mid-sentence. See the header.
 */
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${fingerprint(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function readDoc(value: unknown): RichTextDoc {
  return parseRichText(value) ?? emptyRichTextDoc();
}

export function RichTextEditor({
  value,
  onChange,
  onDirty,
  placeholder,
  minHeight = 320,
  onRequestMedia,
  searchPages,
  editable = true,
  label = "Body",
  describedById,
  className
}: RichTextEditorProps) {
  // The callbacks go through refs, because the editor's own handlers are created once — at editor
  // creation — and would otherwise keep calling the first render's `onChange` forever.
  const onChangeRef = useRef(onChange);
  const onDirtyRef = useRef(onDirty);
  useEffect(() => {
    onChangeRef.current = onChange;
    onDirtyRef.current = onDirty;
  }, [onChange, onDirty]);

  /** The fingerprint of the last document this editor produced or was given. */
  const lastDocRef = useRef<string>("");
  /** An external change that arrived while the author was typing. Applied on blur. */
  const pendingRef = useRef<RichTextDoc | null>(null);
  /** Set by an effect, so a keyboard shortcut created at editor-creation time can reach React state. */
  const openLinkRef = useRef<() => void>(() => {});

  const [notice, setNotice] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [linkDialog, setLinkDialog] = useState<{
    open: boolean;
    href: string | null;
    text: string | null;
  }>({ open: false, href: null, text: null });

  /**
   * Read ONCE, in a state initialiser.
   *
   * A document is only handed to `content` at creation; every later change goes through the sync
   * effect below, which knows how to avoid moving the caret. The initialiser form matters: a plain
   * `readDoc(value)` in the render body would re-parse the whole document on every keystroke of the
   * form around it, and these documents run to thousands of nodes.
   */
  const [initialContent] = useState<RichTextDoc>(() => readDoc(value));
  const extensions = useMemo(() => createRichTextExtensions({ placeholder }), [placeholder]);

  const editor = useEditor(
    {
      // TIPTAP'S SSR GUARD. See the header.
      immediatelyRender: false,
      extensions,
      content: initialContent,
      editable,
      editorProps: {
        attributes: {
          class: EDITOR_PROSE_CLASS,
          /**
           * `role="textbox"` + `aria-multiline`, and an explicit name.
           *
           * Without a role the editable div is announced as a group of unnamed content; with it, it is
           * announced as the field it is. It also settles a real conflict: the document may contain an
           * `<h1>`, the studio page already has one, and a textbox's contents are its value rather
           * than a second outline for the page (contract §11).
           */
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": label,
          ...(describedById ? { "aria-describedby": describedById } : {}),
          spellcheck: "true"
        },
        handleKeyDown: (_view, event) => {
          const mod = event.metaKey || event.ctrlKey;
          // Mod+K is bound here rather than in an extension: the shortcut has to open a React dialog,
          // and an extension command has no way to reach one.
          if (mod && !event.altKey && (event.key === "k" || event.key === "K")) {
            event.preventDefault();
            openLinkRef.current();
            return true;
          }
          return false;
        },
        transformPastedHTML: (html) => {
          const report = sanitisePastedHtml(html);
          if (report.images > 0 || report.demotedHeadings > 0 || report.unwrappedFigures > 0) {
            // Said out loud. A paste that quietly drops three photographs is the bug class §1.6 is
            // about, and the author is the only person who can put them back.
            const parts: string[] = [];
            if (report.images > 0) {
              parts.push(
                report.images === 1
                  ? "One picture was left out because pictures have to come from the media library."
                  : `${report.images} pictures were left out because pictures have to come from the media library.`
              );
            }
            if (report.demotedHeadings > 0) {
              parts.push(
                report.demotedHeadings === 1
                  ? "One small heading became a Heading 4."
                  : `${report.demotedHeadings} small headings became Heading 4.`
              );
            }
            if (report.unwrappedFigures > 0) {
              parts.push(
                report.unwrappedFigures === 1
                  ? "One caption became an ordinary paragraph, because its picture could not come with it."
                  : `${report.unwrappedFigures} captions became ordinary paragraphs, because their pictures could not come with them.`
              );
            }
            // Deferred out of the ProseMirror callback: setting React state inside a paste handler
            // renders in the middle of the transaction that is still being built.
            window.setTimeout(() => setNotice(parts.join(" ")), 0);
          }
          return report.html;
        }
      },
      onCreate: ({ editor: instance }) => {
        lastDocRef.current = fingerprint(readDoc(instance.getJSON()));

        if (process.env.NODE_ENV !== "production") {
          // The parity check from extensions.ts. Development only, because the answer is a change to
          // the code — and in production a warning nobody reads is not worth the bytes.
          const drift = describeSchemaDrift(instance.schema);
          if (drift.unrenderableNodes.length > 0 || drift.unrenderableMarks.length > 0) {
            console.warn(
              "[RichTextEditor] This editor can produce content components/RichText.tsx will not draw, so it would vanish when published. Nodes:",
              drift.unrenderableNodes,
              "Marks:",
              drift.unrenderableMarks
            );
          }
        }
      },
      onUpdate: ({ editor: instance }) => {
        // Normalised through the same reader the renderer uses, so what is stored is exactly what
        // will be drawn — and so the fingerprint on both sides of a save is computed the same way.
        const doc = readDoc(instance.getJSON());
        lastDocRef.current = fingerprint(doc);
        onDirtyRef.current?.();
        onChangeRef.current(doc);
      }
    },
    []
  );

  // `editable` is a prop and the editor is created once, so the two are kept in step here.
  useEffect(() => {
    if (!editor) return;
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editable, editor]);

  /**
   * The one-way door: an INCOMING document that this editor did not produce.
   *
   * A revision restored in another panel, a section swapped, a value reset by the form. It is applied
   * with `emitUpdate: false` so it does not immediately bounce back out through `onChange` as if the
   * author had typed it.
   */
  useEffect(() => {
    if (!editor) return;
    const incoming = readDoc(value);
    const incomingPrint = fingerprint(incoming);
    if (incomingPrint === lastDocRef.current) return;

    // It may also be the document the editor is ALREADY showing, written without the attribute
    // defaults the schema fills in — `{ type: "paragraph" }` against the editor's
    // `{ type: "paragraph", attrs: { textAlign: null } }`. That is the ordinary case at mount, for
    // seeded and imported documents, and re-setting it would put a pointless entry on the undo stack.
    // The second walk only happens when the fingerprints already differ, so typing never pays for it.
    if (incomingPrint === fingerprint(readDoc(editor.getJSON()))) return;

    // Never while the author is typing in it. The change is held; the blur handler applies it.
    if (editor.isFocused) {
      pendingRef.current = incoming;
      return;
    }

    pendingRef.current = null;
    lastDocRef.current = incomingPrint;
    editor.commands.setContent(incoming, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    const onBlur = () => {
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = null;
      lastDocRef.current = fingerprint(pending);
      editor.commands.setContent(pending, { emitUpdate: false });
    };
    editor.on("blur", onBlur);
    return () => {
      editor.off("blur", onBlur);
    };
  }, [editor]);

  /**
   * How many pictures have no description.
   *
   * Counted from the document on every transaction, which is O(document) — acceptable for a studio
   * screen, and the alternative (counting only when a picture is inserted) leaves a warning standing
   * about a picture the author has already removed.
   */
  const [missingAlt, setMissingAlt] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const count = () => {
      let missing = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name !== "image") return;
        const alt = node.attrs.altText;
        if (typeof alt !== "string" || alt.trim().length === 0) missing += 1;
      });
      setMissingAlt(missing);
    };
    count();
    // "transaction" rather than "update", because a document applied with `emitUpdate: false` — a
    // restored revision — changes the pictures without firing an update, and the warning would stand
    // there describing the document that was replaced. Selection-only transactions are skipped: this
    // walks the whole document and moving the caret does not change the answer.
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      count();
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  const openLink = useCallback(() => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const attrs = editor.getAttributes("link");
    const href = typeof attrs.href === "string" && attrs.href.length > 0 ? attrs.href : null;
    // `" "` as the block separator so two paragraphs in the selection do not fuse into one word.
    const text = empty ? null : editor.state.doc.textBetween(from, to, " ");
    setLinkDialog({ open: true, href, text });
  }, [editor]);

  useEffect(() => {
    openLinkRef.current = openLink;
  }, [openLink]);

  const applyLink = useCallback(
    (href: string) => {
      if (!editor) return;
      setLinkDialog({ open: false, href: null, text: null });

      if (editor.state.selection.empty && !editor.isActive("link")) {
        // Nothing selected and no link at the caret: there is no text to attach the mark to, so the
        // address becomes the words. `unsetMark` afterwards clears the stored mark only — without it
        // everything typed next would join the link.
        editor
          .chain()
          .focus()
          .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
          .unsetMark("link")
          .run();
        return;
      }

      // `extendMarkRange` so editing a link from the middle of it changes the whole link rather than
      // splitting it into two.
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    },
    [editor]
  );

  const removeLink = useCallback(() => {
    if (!editor) return;
    setLinkDialog({ open: false, href: null, text: null });
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  }, [editor]);

  /**
   * Insert a picture from the media library AS A FIGURE, with its caption as editable prose.
   *
   * ⚠ THE CAPTION IS MOVED OUT OF THE ATTRIBUTE AND INTO THE CAPTION NODE, and the attribute is
   * cleared. Both would otherwise hold a caption: the renderer ignores the attribute inside a figure,
   * so the studio would show one caption while the stored document carried two — the second frozen at
   * whatever the media library said on the day the picture was placed. One caption, one owner.
   *
   * Bare `image` nodes are still perfectly renderable and every document written before today is full
   * of them; this only changes what a NEW insert produces.
   */
  const insertMedia = useCallback(() => {
    if (!editor || !onRequestMedia) return;
    void (async () => {
      const chosen = await onRequestMedia();
      // Null is "the author closed the picker", which is not a failure and gets no message.
      if (!chosen) return;
      const attrs = imageAttrsFromMedia(chosen);
      editor
        .chain()
        .focus()
        .insertFigure({ ...attrs, caption: null }, chosen.caption ?? null)
        .run();
    })();
  }, [editor, onRequestMedia]);

  return (
    <div
      className={cn(
        // The focus ring lives on the box, because the contenteditable inside it has no border of its
        // own to draw one on. Both halves named: a bare `ring-2` is stock BLUE (contract §3).
        //
        // ⚠ NO `overflow-hidden` HERE, however tempting it is for the corners. An `overflow: hidden`
        // ancestor becomes the scroll port for anything `position: sticky` inside it — and since this
        // box never scrolls, the toolbar would simply never stick. The children round their own
        // corners instead (11px = the 12px `rounded-md` less the 1px border).
        "rounded-md border border-line-200 bg-card focus-within:border-purple-600 focus-within:ring-4 focus-within:ring-purple-600/15",
        className
      )}
    >
      {editable ? (
        <>
          <EditorToolbar
            editor={editor}
            className="rounded-t-[11px]"
            label={`Formatting — ${label}`}
            onRequestLink={openLink}
            onRequestImage={onRequestMedia ? insertMedia : undefined}
            onShowShortcuts={() => setShortcutsOpen(true)}
          />
          <TableControls editor={editor} />
        </>
      ) : null}

      {/* `grid` so the ProseMirror element stretches to the minimum height and a click anywhere in the
          box lands in the document rather than beside it. */}
      <EditorContent editor={editor} className="grid" style={{ minHeight }} />

      {editable ? (
        <SlashCommands
          editor={editor}
          // Same rule as the toolbar: with no picker there is no way to insert a picture, so the entry
          // is absent from the menu rather than present and inert.
          onRequestImage={onRequestMedia ? insertMedia : undefined}
        />
      ) : null}

      {(notice || missingAlt > 0) && (
        <div className="space-y-2 rounded-b-[11px] border-t border-line-200 bg-surface-50 px-3 py-2.5">
          {notice ? (
            // `role="status"` announces it once, politely. Correct here and nowhere else in this
            // component: it appears in answer to a single deliberate action, not on every keystroke.
            <div
              role="status"
              className="flex items-start gap-2 text-xs leading-relaxed text-ink-700"
            >
              <ImageOff aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" />
              <span className="min-w-0 flex-1">{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-500 transition hover:bg-surface-200 hover:text-ink-900"
                aria-label="Dismiss this message"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {missingAlt > 0 ? (
            // Not a live region: it changes as the document changes, and a region that re-announced
            // itself on every keystroke would talk over the typing it describes.
            <p className="flex items-start gap-2 text-xs leading-relaxed text-warn-800">
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {missingAlt === 1
                  ? "One picture here has no description, so a reader using a screen reader will be told nothing about it."
                  : `${missingAlt} pictures here have no description, so a reader using a screen reader will be told nothing about them.`}{" "}
                Add one in the media library.
              </span>
            </p>
          ) : null}
        </div>
      )}

      <LinkDialog
        open={linkDialog.open}
        href={linkDialog.href}
        selectionText={linkDialog.text}
        onClose={() => setLinkDialog({ open: false, href: null, text: null })}
        onSave={applyLink}
        onRemove={linkDialog.href ? removeLink : undefined}
        searchPages={searchPages}
      />

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

/**
 * The list behind the "?" button.
 *
 * The shortcuts are data in extensions.ts, beside the extensions that provide them, so the list
 * cannot drift from what the keyboard actually does.
 */
function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  // Read after mount, never during render: `navigator` does not exist on the server and a value that
  // differs between the two passes is a hydration mismatch.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPad|iPhone|iPod/.test(navigator.userAgent));
  }, []);

  const modifier = isMac ? "Cmd" : "Ctrl";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="These work while the cursor is in the writing area."
      size="lg"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-5">
        {EDITOR_SHORTCUT_GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="field-label">{group.title}</h3>
            <dl className="mt-2 divide-y divide-line-200">
              {group.shortcuts.map((shortcut) => (
                <div
                  key={`${group.title}-${shortcut.keys}`}
                  className="flex items-baseline justify-between gap-4 py-1.5"
                >
                  <dt className="text-sm text-ink-700">{shortcut.action}</dt>
                  <dd className="shrink-0">
                    <kbd className="rounded border border-line-200 bg-surface-100 px-1.5 py-0.5 font-mono text-xs text-ink-900">
                      {shortcut.keys.split("+").join(" + ").replace(/\bMod\b/g, modifier)}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
