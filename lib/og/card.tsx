/**
 * lib/og/card.tsx — the ONE social card, drawn five ways.
 *
 * A shared link should preview the RECORD, not the institution. Until this file existed, every page
 * whose editor had not uploaded a cover fell through to `app/opengraph-image.tsx`, so a craft, a
 * researcher, an article, a project and a research area all previewed as the same purple rectangle
 * carrying only the Centre's name — a link pasted into Slack or WhatsApp that told the reader nothing
 * whatsoever about what was behind it.
 *
 * ONE BUILDER, FIVE ROUTES. Each `app/(site)/<segment>/[slug]/opengraph-image.tsx` loads its row and calls
 * `recordCard()`; not one of them writes a style of its own. Five hand-drawn cards would drift into
 * five designs the first time one of them was tweaked, and this is a surface with NO reader inside the
 * building — nobody on the team ever sees their own site's share cards — so the drift would be
 * permanent and unnoticed. That is exactly why the design lives in one place instead of five.
 *
 * The visual language extends `app/opengraph-image.tsx` on purpose: the same gradient, the same mark,
 * the same gold rule, the same 72px frame and the same type sizes. `fallbackCard()` reproduces that
 * card exactly, so a route with nothing to show degrades to the institutional card the rest of the
 * site already uses rather than to some third design.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ SATORI RENDERS A SUBSET OF CSS, AND IT FAILS SILENTLY. A declaration it does not understand is
 * dropped, so a mistake here is a badly laid-out PNG on somebody else's website, not an error anyone
 * in this repository sees.
 *
 *   • No `oklch()`, no CSS variables, no themed neutral. Every colour below is the sRGB equivalent of
 *     the brand ramp, written out. A card has one theme, not two — there is no `[data-theme]` here to
 *     invert against.
 *   • Tailwind classes do NOTHING. An `ImageResponse` has no stylesheet; `className` is ignored and
 *     only inline `style` is read. Do not import a class name into this file.
 *   • Every element with more than one child needs an explicit `display: flex`, and `gap` works only
 *     inside a flex container.
 *   • ⚠ AN INTERPOLATED TEXT LINE IS SEVERAL CHILDREN. `{name} · {meta}` inside one `<div>` is three
 *     children, which Satori lays out as three flex items with no space between them. Every line below
 *     is therefore ONE string, joined in JavaScript before it reaches the JSX.
 *   • ⚠ THE BUNDLED FALLBACK FONT COVERS LATIN ONLY. `next/og` ships a Noto Sans subset and nothing
 *     else, and a glyph it has no coverage for is drawn as nothing at all. That is why a craft's
 *     `localName` is NOT on these cards even though it is the second line of every craft heading on
 *     the site: Devanagari, Gurmukhi or Bengali would come out as a row of blanks, which reads as a
 *     broken image rather than as a name. The `lang`-switched local name stays on the page, where a
 *     real font stack and a screen reader can both do it justice.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ `npm run leak-check` CANNOT SEE THESE ROUTES. It fetches public URLs and greps the returned HTML
 * for its canary string; these five return a PNG, and no grep will ever find a draft title that has
 * been rasterised into pixels. So the publication filter in each route is held by review alone — which
 * is why every one of them spreads the SAME `liveStatusWhere()` / `livePublishableWhere()` the page
 * beside it uses, including the `isVisible` clause on a person, and never a hand-rolled `status`
 * comparison.
 */

import type { ReactElement } from "react";

import { siteName } from "@/lib/env";
import { absoluteUrl } from "@/lib/seo";
import { truncateWords } from "@/lib/utils";

/** 1200×630 — the size every platform crops from. Exported so five routes cannot disagree. */
export const OG_SIZE = { width: 1200, height: 630 };

export const OG_CONTENT_TYPE = "image/png";

/**
 * ⚠ LONG TITLES: A SIZE BAND FIRST, THEN A WORD-BOUNDARY CUT — and the order matters.
 *
 * The corpus holds names like "Thatheras of Jandiala Guru" and publication titles three times that
 * length. One font size that fits the longest of them leaves every short title looking lost in the
 * frame, and a title that runs off the edge is worse than one that was shortened: a reader cannot tell
 * a clipped card from a broken renderer, but everybody understands an ellipsis.
 *
 * So the title is cut to `TITLE_LIMIT` characters on a WORD boundary with an ellipsis — through
 * `truncateWords`, the same helper `pageMetadata()` uses on every description, because one truncation
 * rule for the whole site is one rule to get right — and the size band is then chosen from the length
 * of what SURVIVED the cut. Banding on the raw string would pick a size for 300 characters and then
 * draw 118 of them at it.
 *
 * The ellipsis is the on-screen statement that something was dropped (contract §1.6). A 1200×630 card
 * has no room for the sentence a page would write, and the untruncated title is one tap away inside
 * the link itself.
 *
 * The bands assume 1056px of usable width (1200 less two 72px margins) and at most three lines:
 * ~25 characters per line at 82px, ~30 at 68px, ~38 at 54px, ~44 at 46px.
 */
const TITLE_LIMIT = 118;
const SUBTITLE_LIMIT = 130;

function titleFontSize(length: number): string {
  if (length <= 34) return "82px";
  if (length <= 60) return "68px";
  if (length <= 92) return "54px";
  return "46px";
}

/**
 * The footer's budget, and why it needs one at all.
 *
 * ⚠ THE FOOTER CANNOT GROW WITHOUT BOUND. It sits in a `space-between` column inside a FIXED 630px, so
 * extra lines there do not make the card taller — they squeeze the title block above. `NEXT_PUBLIC_SITE_NAME`
 * has no length limit at all and `branding.siteName` allows 120 characters, which is already more than
 * one 24px line holds (~86 characters across 1056px, fewer in capitals).
 *
 * 86 is therefore a CEILING OF TWO LINES, not a promise of one, and two lines was measured to fit
 * beneath the tallest possible title and subtitle with room to spare. Within it the institution's name
 * has FIRST CLAIM and the fact after the dot takes what is left; a remainder too small to say anything
 * useful drops the fact entirely rather than printing two letters and an ellipsis — a region cut to
 * "Pun…" is not a placing, it is a puzzle, and the page behind the link says it in full.
 */
const FOOTER_LIMIT = 86;
/** Below this many characters of remainder, the fact is dropped instead of shortened. */
const META_MINIMUM = 12;

function footerLine(name: string, meta: string | null): string {
  const institution = truncateWords(name, FOOTER_LIMIT);
  if (!meta) return institution;

  // 3 for the " · " that joins them.
  const room = FOOTER_LIMIT - institution.length - 3;
  if (room < META_MINIMUM) return institution;

  // Joined here, in JavaScript, never interpolated in the JSX — see the Satori note in the header.
  return `${institution} · ${truncateWords(meta, room)}`;
}

/** Collapse the whitespace an editor's paste brings with it; a card is one flowed paragraph. */
function oneLine(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim() ?? "";
  return cleaned.length > 0 ? cleaned : null;
}

interface CardCopy {
  /** The eyebrow. The site's own word for this kind of record — never the enum's. */
  kind: string;
  title: string;
  subtitle: string | null;
  /** The single line beside the gold rule, already joined. */
  footer: string;
}

/**
 * The layout. Private: the two exported wrappers below are the only ways in, so "which card is this?"
 * is always answered by a function name rather than by a combination of arguments.
 */
function card({ kind, title, subtitle, footer }: CardCopy): ReactElement {
  // A whitespace-only title is a data fault, but a blank card is indistinguishable from a broken one,
  // so it degrades to a word rather than to nothing.
  const heading = oneLine(title) ?? "Untitled record";
  const cutHeading = truncateWords(heading, TITLE_LIMIT);
  const strap = subtitle ? truncateWords(subtitle, SUBTITLE_LIMIT) : null;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px",
        background: "linear-gradient(135deg, #5B21B6 0%, #3B1878 55%, #2A1155 100%)",
        color: "#FFFFFF",
        fontFamily: "sans-serif"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
        {/* The Centre's mark, identical to app/opengraph-image.tsx — including the one gold spoke. */}
        <svg width="64" height="64" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="15" fill="none" stroke="#FAF9F5" strokeWidth="3" opacity="0.92" />
          <circle cx="32" cy="32" r="5.5" fill="#FAF9F5" />
          <g stroke="#FAF9F5" strokeWidth="3" strokeLinecap="round" opacity="0.92">
            <line x1="32" y1="7" x2="32" y2="13" />
            <line x1="32" y1="51" x2="32" y2="57" />
            <line x1="7" y1="32" x2="13" y2="32" />
          </g>
          <line x1="51" y1="32" x2="57" y2="32" stroke="#E8B23A" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div
          style={{
            display: "flex",
            fontSize: "22px",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#E9D5FF"
          }}
        >
          {kind}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            // Banded on the CUT length, not the original. See TITLE_LIMIT above.
            fontSize: titleFontSize(cutHeading.length),
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: "-0.02em"
          }}
        >
          {cutHeading}
        </div>
        {/*
          Omitted entirely rather than rendered empty: an empty flex child still carries its
          `marginTop`, which would push the title off its optical centre for no visible reason.
        */}
        {strap ? (
          <div
            style={{
              display: "flex",
              marginTop: "24px",
              fontSize: "30px",
              lineHeight: 1.4,
              color: "#D8C7F5",
              maxWidth: "900px"
            }}
          >
            {strap}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
          fontSize: "24px",
          color: "#C4B0EA"
        }}
      >
        <div style={{ display: "flex", width: "48px", height: "3px", background: "#E8B23A" }} />
        <div style={{ display: "flex" }}>{footer}</div>
      </div>
    </div>
  );
}

export interface RecordCardInput {
  /** "Craft", "Person", "Article", "Project", "Research area" — the site's word, not the schema's. */
  kind: string;
  title: string;
  /** The record's own one-liner: a summary, a tagline, a designation. */
  subtitle?: string | null;
  /** One short fact after the institution's name — a region, a category, a research area. */
  meta?: string | null;
  /**
   * The institution's name, for the footer.
   *
   * Every route passes `lib/env`'s `siteName()` rather than the editable `branding.siteName`, because
   * `pageMetadata()` already sends `og:site_name` from that same source: a preview whose card and whose
   * `og:site_name` named the institution differently would read as two organisations, one of them
   * misspelled. `app/opengraph-image.tsx` reads it from there too. ⚠ If the share-card name ever moves
   * to the branding document, it has to move in all three places in the same change.
   */
  siteName: string;
}

export function recordCard(input: RecordCardInput): ReactElement {
  return card({
    kind: input.kind,
    title: input.title,
    subtitle: oneLine(input.subtitle),
    footer: footerLine(oneLine(input.siteName) ?? siteName(), oneLine(input.meta))
  });
}

/**
 * The card for a route with no record to draw.
 *
 * ⚠ EVERY ROUTE NEEDS THIS PATH. A social crawler will ask for the card of a URL that has just been
 * unpublished, retired by its `unpublishAt`, moved to the recycle bin or simply mistyped — that is
 * normal traffic for this surface, not an edge case. Falling through to a crash hands the platform a
 * 500, and a platform that gets a 500 CACHES the failure: the link previews as a dead grey rectangle
 * for days after the record comes back. Rendering the institutional card instead costs nothing and
 * degrades to exactly what the rest of the site already shows.
 *
 * It is a copy of `app/opengraph-image.tsx`, deliberately, down to the strapline: a reader who gets
 * this card should not be able to tell which of the two routes served it.
 */
export function fallbackCard(name: string = siteName()): ReactElement {
  return card({
    kind: "Centre of Excellence",
    title: name,
    subtitle: "Research, people, publications and a living archive.",
    footer: "Documenting craft, at scale"
  });
}

/**
 * Read the row a card needs, or `null` — and never throw.
 *
 * ⚠ THE SAME REASONING AS `fallbackCard()`, FOR THE OTHER FAILURE. A page that 500s during a database
 * blip is retried by the next reader; a CARD that 500s is remembered by the platform's cache long
 * after the blip is over, so thirty seconds of trouble can spoil a month of shared links. Every route
 * therefore loads through this, logs what happened for whoever is reading the server output, and sends
 * the institutional card.
 *
 * It keeps a BUILD safe for the same money: if Next renders one of these cards while the database is
 * unreachable, the card degrades to the institutional one instead of failing the deploy — the same
 * decision, and the same reasoning, as `prerenderParams` in lib/prerender.ts.
 *
 * `label` names the route in that log line. Without it the message is one of five identical ones.
 */
export async function loadCardRecord<T>(
  label: string,
  load: () => Promise<T | null>
): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    console.error(
      `[og] the ${label} social card could not read its record, so the institutional card was sent ` +
        `instead. The card is a public surface and must not answer a crawler with a 500.`,
      error
    );
    return null;
  }
}

/**
 * The absolute URL of a record's generated card.
 *
 * ⚠ THIS IS THE WIRING, AND NOTHING CALLS IT YET. A file-based `opengraph-image` is applied by Next
 * ONLY when the segment's own metadata does not already carry `openGraph.images`
 * (`mergeStaticMetadata` in next/dist/lib/metadata/resolve-metadata) — and `pageMetadata()` always
 * emits an image, falling back to the institutional `/opengraph-image`. So these five routes are
 * reachable and correct, and the five pages beside them still advertise the generic card until each
 * `generateMetadata` passes this URL as `imageUrl` for the case where the record has no uploaded
 * cover:
 *
 *   image: craft.cover,
 *   imageUrl: craft.cover ? undefined : generatedCardUrl(`/craft-explorer/${craft.slug}`),
 *
 * An uploaded cover must keep winning: a photograph of the craft is a better preview than any
 * typographic card, and this exists to replace the card that says nothing, not the one that says
 * something. Built here rather than as five string literals so a renamed segment cannot leave four
 * pages pointing at cards that 404.
 */
export function generatedCardUrl(pagePath: string): string {
  return absoluteUrl(`${pagePath}/opengraph-image`);
}
