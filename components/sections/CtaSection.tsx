/**
 * CtaSection — the panel that asks the reader to do one thing.
 *
 * A Server Component. `LinkButton` renders an `<a>`, so nothing here ships JavaScript; `Reveal` is
 * the only client piece.
 *
 * TWO TONES, AND THE QUIET ONE IS NOT A LESSER VERSION. `brand` fills the width with the deep purple
 * panel and carries the weight of a page's single ask. `quiet` sits on the page canvas with no panel
 * at all, for the second call further down — a page with two loud purple panels has, in effect,
 * none, because the eye stops reading either of them as important.
 *
 * ON THE BRAND PANEL THE BUTTONS INVERT. A purple-700 fill on a purple gradient is invisible, so the
 * primary becomes white-on-purple and the secondary a white hairline. The overrides carry `!`
 * because `cn()` is a plain join: one utility cannot beat another on the order it was written in,
 * only on CSS source order (contract §5).
 *
 * A button appears only once it has BOTH a label and a link. A labelled button with no link is a
 * dead control and a linked button with no label is invisible — the schema allows either mid-edit
 * precisely because autosave runs between the two keystrokes.
 */

import { ArrowRight } from "lucide-react";
import type { PageSection } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { PointerGlow } from "@/components/site/PointerGlow";
import { LinkButton } from "@/components/ui/Button";
import type { CtaSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface CtaSectionProps {
  data: CtaSectionData;
  section: PageSection;
}

/** Complete literal class strings (contract §5). */
const ALIGN_CLASS: Record<CtaSectionData["alignment"], string> = {
  left: "items-start text-left",
  center: "items-center text-center",
  right: "items-end text-right"
};

const ACTIONS_ALIGN_CLASS: Record<CtaSectionData["alignment"], string> = {
  left: "justify-start",
  center: "justify-center",
  right: "justify-end"
};

export function CtaSection({ data, section }: CtaSectionProps) {
  const primary = data.primaryCta.label && data.primaryCta.href ? data.primaryCta : null;
  const secondary = data.secondaryCta.label && data.secondaryCta.href ? data.secondaryCta : null;

  // Nothing to say and nothing to press. An empty panel is a hole in the page.
  if (!data.heading && !data.body && !primary && !secondary) return null;

  const brand = data.tone === "brand";

  const body = (
    <div className={cn("flex flex-col", ALIGN_CLASS[data.alignment])}>
      {data.eyebrow ? (
        // Gold is marketing-only and a call to action on the public site is where it is permitted;
        // purple-700 on the purple panel would be two rungs of one hue and read as a smudge.
        <p className={cn("eyebrow", brand && "text-gold-300")}>{data.eyebrow}</p>
      ) : null}

      {data.heading ? (
        <h2
          className={cn(
            "display-title text-balance text-3xl sm:text-4xl",
            brand && "text-white",
            data.eyebrow && "mt-3"
          )}
        >
          {data.heading}
        </h2>
      ) : null}

      {data.body ? (
        <p
          className={cn(
            "prose-measure mt-4 text-base leading-relaxed",
            brand ? "text-white/75" : "text-ink-500"
          )}
        >
          {data.body}
        </p>
      ) : null}

      {primary || secondary ? (
        <div
          className={cn(
            "mt-8 flex w-full flex-wrap items-center gap-3",
            ACTIONS_ALIGN_CLASS[data.alignment]
          )}
        >
          {primary ? (
            <LinkButton
              href={primary.href}
              icon={ArrowRight}
              iconPosition="end"
              className={
                brand ? "!bg-white !text-purple-800 hover:!bg-gold-100 hover:!shadow-none" : undefined
              }
            >
              {primary.label}
            </LinkButton>
          ) : null}

          {secondary ? (
            <LinkButton
              href={secondary.href}
              variant="secondary"
              className={
                brand
                  ? "!border-white/40 !bg-transparent !text-white hover:!border-white hover:!bg-white/10"
                  : undefined
              }
            >
              {secondary.label}
            </LinkButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          {brand ? (
            /*
              `.noise` is a `::after` pinned to `inset: 0`, so the panel has to be positioned, and
              the overflow clip keeps the grain inside the 24px radius.

              `PointerGlow` IS this panel, not a wrapper around it — it takes the panel's classes and
              renders the element itself, so no extra box enters the layout. It is the only client
              JavaScript this section ships: `body` is built on the server and handed through as
              children, so the heading, the copy and both links stay out of the bundle. See its
              header for why that distinction is worth the indirection.
            */
            <PointerGlow className="grad-brand noise overflow-hidden rounded-xl px-6 py-14 shadow-cinema sm:px-10 sm:py-16 lg:px-14">
              <div className="relative">{body}</div>
            </PointerGlow>
          ) : (
            body
          )}
        </Reveal>
      </div>
    </section>
  );
}
