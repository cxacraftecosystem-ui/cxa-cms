/**
 * FaqSection — questions that open to reveal their answers, plus the structured data that lets a
 * search engine show them without the reader ever arriving here.
 *
 * A Server Component. The disclosure state lives in `./faq/FaqList`, which is the client half; this
 * file stays on the server because `serializeJsonLd` comes from `lib/seo.ts`, and that module is
 * `server-only`. `Reveal` is the only other client piece.
 *
 * IT ENTERS ON THE HOUSE REVEAL, like every other content block. A page built as call to action →
 * questions → text where only the middle block snaps into place fully formed reads as a rendering
 * fault rather than as restraint, and there is no reason for this one to be the exception.
 *
 * ⚠ IT ASKS FOR `amount="some"` RATHER THAN THE DEFAULT, and that is the one thing to preserve if this
 * ever moves. How tall the block is belongs to the editor — a Centre's FAQ can easily run to thirty
 * questions — and framer hands `amount` to an IntersectionObserver as a threshold: an element more
 * than about three viewports tall can NEVER reach the default 0.3, because it can never have that
 * much of itself on screen at once. The reveal would then never fire and the whole set of questions
 * would sit at `opacity: 0` for ever, present in the DOM and invisible on the page.
 *
 * ⚠ THE JSON-LD GOES THROUGH `serializeJsonLd`, NEVER `JSON.stringify`. An answer containing
 * `</script>` — and an answer about writing HTML very well might — would otherwise close the element
 * early, and everything after it would be parsed as page markup. The helper escapes `<`, `>` and `&`
 * for exactly that (contract §9 / lib/seo.ts).
 *
 * ONLY COMPLETE PAIRS ARE DESCRIBED TO A CRAWLER. A `Question` with an empty `acceptedAnswer` is
 * invalid structured data and gets the whole block ignored, so a half-written entry is drawn on the
 * page and left out of the graph rather than taking the rest of the questions down with it.
 *
 * ⚠ THE HEADING IS STRUCTURALLY REQUIRED HERE AND IS THEREFORE ALWAYS RENDERED. `Accordion` wraps every
 * question's trigger in an `<h3>` (components/ui/Accordion.tsx), so a block with no `<h2>` of its own
 * takes the page from `<h1>` straight to `<h3>`: a level missing from the outline a screen-reader user
 * navigates by (contract §11). The heading is also the only thing that NAMES the set of questions —
 * without it the accordion is a run of unrelated triggers with nothing saying what they have in common.
 * A heading an editor cleared is taken OFF SCREEN rather than invented; see the comment on it below.
 */

import type { PageSection } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { FaqList } from "@/components/sections/faq/FaqList";
import { SectionHeading } from "@/components/site/SectionHeading";
import { sectionLabel } from "@/lib/sections/registry";
import type { FaqSectionData } from "@/lib/sections/schema";
import { serializeJsonLd } from "@/lib/seo";

export interface FaqSectionProps {
  data: FaqSectionData;
  section: PageSection;
}

export function FaqSection({ data, section }: FaqSectionProps) {
  // A question with no wording cannot be a trigger — there would be nothing to press or announce.
  const items = data.items.filter((item) => item.question.length > 0);
  if (items.length === 0) return null;

  const answered = items.filter((item) => item.answer.length > 0);

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  /** Is any of the header visible? Only then does it take space above the questions. */
  const showsHeader = Boolean(heading || eyebrow || body);

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      {answered.length > 0 ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd({
              "@context": "https://schema.org",
              "@type": "FAQPage",
              mainEntity: answered.map((item) => ({
                "@type": "Question",
                name: item.question,
                acceptedAnswer: { "@type": "Answer", text: item.answer }
              }))
            })
          }}
        />
      ) : null}

      <div className="shell-narrow">
        {/*
          The heading and the questions rise together, as one block: they are one thought, and the
          JSON-LD above stays outside so a crawler is never asked to read a `<script>` out of an
          animated box. See the header for why the threshold is `some`.
        */}
        <Reveal amount="some">
          {/*
            `sectionLabel` is the block's own name from `SECTION_REGISTRY` — "Questions and answers" —
            so the fallback comes from the one place that names a block and follows it if it is ever
            renamed. `sr-only` is what honours the editor's decision: they wanted no heading ON THE
            PAGE, and putting visible copy there that nobody wrote is the worse of the two failures.

            The margin is gated on there being something to see, so a header that exists only for the
            outline does not leave 40px of empty space above the first question.
          */}
          <SectionHeading
            eyebrow={eyebrow || undefined}
            title={heading || sectionLabel(section.type)}
            titleClassName={heading ? undefined : "sr-only"}
            description={body || undefined}
            className={showsHeader ? "mb-10" : undefined}
          />

          <FaqList items={items} allowMultipleOpen={data.allowMultipleOpen} />
        </Reveal>
      </div>
    </section>
  );
}
