/**
 * QuoteSection — one quotation, set large across the column.
 *
 * A Server Component; `Reveal` is the only client piece.
 *
 * `<figure>` + `<blockquote>` + `<figcaption>` rather than a styled paragraph: the attribution has
 * to be tied to the words for anything reading the document structure, and a `<cite>` on its own
 * inside a `<blockquote>` is read as part of the quotation, which is exactly what it is not.
 *
 * THE QUOTATION MARK IS THE ORNAMENT AND NOTHING ELSE. The schema tells the editor to type the words
 * WITHOUT quotation marks because the design supplies them, so this draws one large mark and does not
 * also wrap the text in typographic quotes — two sets of marks around one sentence reads as a
 * mistake, and the second set would be inside the text a reader copies.
 *
 * A missing portrait, attribution or role each simply does not render. A quotation with no
 * attribution is still a quotation; an empty circle where a face should be is not.
 */

import { Quote } from "lucide-react";
import type { PageSection } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { MediaImage } from "@/components/ui/MediaImage";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { QuoteSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface QuoteSectionProps {
  data: QuoteSectionData;
  section: PageSection;
  /** The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id. */
  resolved?: ResolvedSectionData;
}

/** Complete literal class strings (contract §5). */
const ALIGN_CLASS: Record<QuoteSectionData["alignment"], string> = {
  left: "items-start text-left",
  center: "items-center text-center",
  right: "items-end text-right"
};

export function QuoteSection({ data, section, resolved }: QuoteSectionProps) {
  if (!data.quote) return null;

  const portrait = data.portraitMediaId ? resolved?.media[data.portraitMediaId] : undefined;
  const hasCaption = Boolean(portrait) || data.attribution.length > 0 || data.role.length > 0;

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          <figure className={cn("mx-auto flex max-w-3xl flex-col", ALIGN_CLASS[data.alignment])}>
            <Quote aria-hidden="true" className="h-10 w-10 text-purple-200" />

            <blockquote className="display-title mt-6 text-balance text-2xl leading-snug sm:text-3xl lg:text-4xl">
              {data.quote}
            </blockquote>

            {hasCaption ? (
              <figcaption
                className={cn(
                  "mt-8 flex items-center gap-4",
                  // On a right-aligned quotation the portrait leads from the right, so the face and
                  // the words it belongs to stay on the same edge of the column.
                  data.alignment === "right" && "flex-row-reverse text-right"
                )}
              >
                {portrait ? (
                  <MediaImage
                    media={portrait}
                    aspect={1}
                    rounded="full"
                    sizes="56px"
                    className="h-14 w-14 shrink-0 border border-line-200"
                  />
                ) : null}

                <span>
                  {data.attribution ? (
                    <span className="block text-sm font-semibold text-ink-900">
                      {data.attribution}
                    </span>
                  ) : null}
                  {data.role ? (
                    <span className="mt-0.5 block text-sm text-ink-500">{data.role}</span>
                  ) : null}
                </span>
              </figcaption>
            ) : null}
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
