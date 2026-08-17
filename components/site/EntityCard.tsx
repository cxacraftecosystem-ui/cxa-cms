/**
 * EntityCard — THE card. Projects, people, publications, news, events, crafts and albums all render
 * through this one component, driven by props.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE WHOLE CARD IS ONE LINK, AND IT IS A LINK OVERLAY — NOT A WRAPPER.
 *
 * The two obvious shapes are both wrong:
 *
 *   • `<a>` wrapped around the card. It cannot then contain a tag chip, a "cite" button or a second
 *     link, because HTML forbids nesting interactive content and the browser silently restructures
 *     the DOM when you try. It also folds every word in the card into one accessible name.
 *   • Two links (one on the image, one on the title). A screen reader announces the same
 *     destination twice, and a keyboard user tabs through the list at double length.
 *
 * So: an `<a className="absolute inset-0">` covering the card, named by the title through
 * `aria-labelledby`. One link, one tab stop, the title as its name, and the card is free to hold
 * whatever else it needs.
 *
 * ⚠ THE DOM ORDER OF THE THREE BLOCKS IS LOAD-BEARING — media, THEN the overlay, THEN the content.
 * Positioned elements paint in DOM order and none of this carries a z-index (contract §6). MediaImage
 * renders a `position: relative` frame, so an overlay declared BEFORE it would be painted over by the
 * photograph and a click on the image would hit nothing. Content is static flow, so it paints below
 * the overlay wherever it sits. Do not "tidy" this ordering.
 *
 * Anything inside `meta` or `footer` that must stay clickable — a tag chip, a DOI link — is lifted
 * above the overlay by the `[&_a]:relative [&_button]:relative` on those two wrappers. That is what
 * makes a second, deliberate link possible without making the whole card two links.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * HOVER IS PURE CSS. `transition hover:-translate-y-0.5 … active:translate-y-0`, with no framer and
 * no JS branch — the globals.css reduced-motion rules collapse the transition for both sources at
 * once (contract §1.3). A framer version would need a hook, would make this a Client Component, and
 * would ship JavaScript to every listing page on the site for a 2px lift.
 *
 * FOCUS COMES FOR FREE. The overlay is the size of the card, so the global `a:focus-visible` outline
 * traces the card itself — no ring utility, no `ring-2` (which would be stock BLUE, contract §3).
 */

import type { ReactNode } from "react";
import Link from "next/link";

import { MediaImage } from "@/components/ui/MediaImage";
import type { Picture } from "@/lib/media/screens";
import type { MediaLike } from "@/lib/media/url";
import { cn, stableHash } from "@/lib/utils";
import { Heading } from "@/components/ui/Heading";

export type EntityCardVariant = "cover" | "portrait" | "compact" | "text";
export type EntityCardHeadingLevel = 2 | 3 | 4 | 5 | 6;

export interface EntityCardProps {
  /** Where the card goes. One destination per card — that is the whole design. */
  href: string;
  media?: MediaLike | null;
  /**
   * `media`'s per-screen framing, already resolved by the caller that fetched it.
   *
   * Handed straight to `MediaImage`, which ignores a single-band picture — so a card whose record
   * nobody has framed renders exactly as it did before. It is resolved by the CALLER because the
   * alternate photographs a framing names are ids in a JSONB column no relation joins, and only the
   * query that fetched the row can fetch them (lib/media/framing.ts).
   */
  picture?: Picture | null;
  /**
   * Drawn in the media slot INSTEAD of the "no image" placeholder when `media` is null.
   *
   * ⚠ IT IS FOR A KNOWN, PERMANENT ABSENCE — not for a picture that has merely not been uploaded yet.
   * `MediaImage`'s placeholder is a diagnostic: it says "this asset has no variants" or "no CDN is
   * configured", which is exactly what an editor needs to see when a photograph is MISSING. Replacing
   * it everywhere would hide a real fault.
   *
   * The case it exists for is a card whose subject will never have a photograph and where the
   * absence is not a problem to report — a person with no portrait, where an initials plate is both
   * better looking and more informative than a grey box saying "No image" twenty-four times down a
   * directory.
   */
  mediaFallback?: ReactNode;
  /** A category line above the title — "Journal article", "Seminar", "Bagru, Rajasthan". */
  eyebrow?: ReactNode;
  /** The card's heading, and the overlay link's accessible name. Plain text reads best here. */
  title: ReactNode;
  /** Two or three lines. Truncate on the SERVER with `truncateWords` — a CSS line clamp hides text
   *  from sighted readers while leaving it in the accessibility tree, so the two disagree. */
  description?: ReactNode;
  /** Dates, authors, counts. Rendered in a wrapping row under the description. */
  meta?: ReactNode;
  /** The bottom rail — a TagList, a status badge, a file size. */
  footer?: ReactNode;
  /** Overrides the variant's media ratio. Any CSS `aspect-ratio`, or a number (width/height). */
  aspect?: number | string;
  variant?: EntityCardVariant;
  /** Only for a card ABOVE THE FOLD. More than one or two per page and none of them is a priority. */
  priority?: boolean;
  /** The rank of the card's heading. Default 3 — a card under a section's `<h2>`. */
  headingLevel?: EntityCardHeadingLevel;
  /** `sizes` for the image. The variant defaults are right for a CardGrid; override for a wide slot. */
  sizes?: string;
  className?: string;
}

interface VariantSpec {
  /** Null means the variant renders no media at all. */
  aspect: number | string | null;
  row: boolean;
  sizes: string;
  titleClass: string;
}

/** Complete literal class strings — a name assembled by concatenation is purged (contract §5). */
const VARIANTS: Record<EntityCardVariant, VariantSpec> = {
  cover: {
    aspect: "16 / 10",
    row: false,
    sizes: "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
    titleClass: "text-lg"
  },
  portrait: {
    aspect: "3 / 4",
    row: false,
    sizes: "(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw",
    titleClass: "text-lg"
  },
  compact: {
    aspect: "1 / 1",
    row: true,
    // A fixed thumbnail width, so the optimiser is not asked for a 1600px file for a 96px box.
    sizes: "96px",
    titleClass: "text-base"
  },
  text: { aspect: null, row: false, sizes: "100vw", titleClass: "text-lg" }
};

const CARD_BASE =
  "group relative flex h-full overflow-hidden rounded-lg border border-line-200 bg-card transition duration-200 ease-out hover:-translate-y-0.5 hover:border-purple-200 hover:shadow-md active:translate-y-0 active:shadow-sm";

/**
 * Interactive descendants of `meta`/`footer` are positioned so they paint ABOVE the overlay and stay
 * clickable. Only the descendants, never the wrapper — a positioned wrapper would lift its whitespace
 * too and the card would stop being clickable along that whole row.
 */
const LIFT_INTERACTIVE = "[&_a]:relative [&_button]:relative";

export function EntityCard({
  href,
  media,
  picture,
  eyebrow,
  title,
  description,
  meta,
  footer,
  aspect,
  variant = "cover",
  mediaFallback,
  priority = false,
  headingLevel = 3,
  sizes,
  className
}: EntityCardProps) {
  const spec = VARIANTS[variant];

  // A deterministic id, because a Server Component has no `useId`. Two cards pointing at the same
  // href on one page would collide — and would also carry the same title, so `aria-labelledby`
  // resolves to identical text either way.
  const titleId = `entity-card-${stableHash(href).toString(36)}`;

  const showMedia = spec.aspect !== null || aspect !== undefined;
  // The fallback stands in only when there is genuinely nothing to render — never over a resolved
  // asset, and never over the placeholder's diagnostic when a caller has not supplied one.
  const mediaNode = showMedia && !media && mediaFallback ? (
    <div
      style={{ aspectRatio: String(aspect ?? spec.aspect ?? "16 / 10") }}
      className={cn(
        "relative flex items-center justify-center overflow-hidden bg-surface-100",
        spec.row ? "w-20 shrink-0 self-start rounded-sm sm:w-24" : "w-full"
      )}
    >
      {mediaFallback}
    </div>
  ) : showMedia ? (
    <MediaImage
      media={media}
      picture={picture}
      aspect={aspect ?? spec.aspect ?? "16 / 10"}
      rounded={spec.row ? "sm" : "none"}
      priority={priority}
      sizes={sizes ?? spec.sizes}
      className={cn(
        spec.row ? "w-20 shrink-0 sm:w-24" : "w-full",
        // The card already clips to its 16px radius, so a stacked image needs no radius of its own.
        spec.row ? "self-start" : undefined
      )}
      imageClassName="transition-transform duration-500 ease-out group-hover:scale-[1.03]"
    />
  ) : null;

  return (
    <article className={cn(CARD_BASE, spec.row ? "flex-row gap-4 p-4" : "flex-col", className)}>
      {mediaNode}

      {/* THE ONE LINK. Declared after the media and before the content — see the header. */}
      <Link href={href} aria-labelledby={titleId} className="absolute inset-0 rounded-lg" />

      <div className={cn("flex min-w-0 flex-1 flex-col", spec.row ? undefined : "p-5")}>
        {eyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-wide text-purple-700">{eyebrow}</p>
        ) : null}

        <Heading
          level={headingLevel}
          id={titleId}
          className={cn(
            "display-title text-balance leading-snug transition-colors group-hover:text-purple-700",
            spec.titleClass,
            eyebrow ? "mt-2" : undefined
          )}
        >
          {title}
        </Heading>

        {description ? (
          <p className="mt-2 text-sm leading-relaxed text-ink-500">{description}</p>
        ) : null}

        {meta ? (
          <div
            className={cn(
              "mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-500",
              LIFT_INTERACTIVE
            )}
          >
            {meta}
          </div>
        ) : null}

        {footer ? (
          // `mt-auto` pins the rail to the bottom so every card in a row lines up, which is why the
          // card is `h-full` and a column flex box.
          <div
            className={cn(
              "mt-auto flex flex-wrap items-center gap-2 pt-4",
              LIFT_INTERACTIVE
            )}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </article>
  );
}
