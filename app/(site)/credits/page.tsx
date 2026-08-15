import type { Metadata } from "next";
import { Camera, Scale } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { ImageCredit } from "@/components/site/ImageCredit";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { CRAFT_IMAGES, type CraftImage } from "@/lib/media/craft-imagery";
import { pageMetadata } from "@/lib/seo";

/**
 * /credits — every photograph the site ships with, and the terms it is used under.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS PAGE IS A LICENCE OBLIGATION WEARING THE CLOTHES OF AN EDITORIAL ONE.
 *
 * The craft photography in `public/craft/` is openly licensed material from Wikimedia Commons, and
 * most of it is Creative Commons BY or BY-SA. Those licences grant the right to publish on one
 * condition: retain the creator's name, the licence, and a link to the material.
 *
 * `ImageCredit` already satisfies that beside each photograph. This page is the second half of doing
 * it properly, and it earns its place three times over:
 *
 *   1. **The credit beside a picture can be missed.** It is small, it is grey, and a reader scrolling
 *      a story passes it in half a second. A single page that lists every photograph with its author,
 *      its licence and a link to the original is what somebody checking provenance actually needs.
 *   2. **It is the honest answer to "may we reuse this?"** A CC BY-SA photograph carries a
 *      share-alike obligation onto derivative works; a public-domain one carries none. An
 *      institution's communications officer needs to be able to tell those apart without reading
 *      source code, and this page groups them so they can.
 *   3. **It makes an unattributed picture visible.** The list is generated from the manifest, so a
 *      photograph added without its metadata cannot quietly appear on the site while being absent
 *      from its own credits page.
 *
 * ⚠ IT IS GENERATED FROM `lib/media/craft-imagery.ts` AND NOTHING IS RESTATED HERE. A second,
 * hand-maintained list of photographs is a list that disagrees with the first one within a month, and
 * the disagreement would be a licence breach rather than a typo. The manifest is written by
 * `scripts/fetch-craft-imagery.ts` at the moment each file is downloaded, which is the only moment
 * the attribution is known for certain.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ NO `revalidate` AND THAT IS CORRECT HERE, unlike the four detail routes the audit caught. This
 * page reads no database and no settings: it is derived entirely from a compiled-in constant, so its
 * output can only change when the bundle changes, and a deployment is exactly when that happens.
 * A revalidation window would re-render it on a timer to produce identical bytes.
 *
 * A Server Component throughout; `Reveal` is the only client piece.
 */

export const metadata: Metadata = pageMetadata({
  title: "Photography credits",
  description:
    "Every photograph used on this site, with its photographer, the licence it is published under and a link to the original.",
  path: "/credits"
});

const BREADCRUMBS = [
  { name: "Home", href: "/" },
  { name: "Credits", href: "/credits" }
] as const;

/**
 * Licences that grant rights without conditions.
 *
 * ⚠ THE SAME SET AS `ImageCredit`'s `UNCONDITIONAL`, and the duplication is deliberate rather than
 * careless: that component uses it to choose between "Photograph by" and "Photograph ©", and this
 * page uses it to decide which of two groups a photograph belongs in. Sharing one constant would
 * couple a rendering decision to an editorial one, and the next licence added would have to be
 * correct for both purposes at once. Both lists are short and both are checked against the fetcher's
 * `ACCEPTABLE_LICENCES` allowlist, which is the actual source of truth for what may be published.
 */
const UNCONDITIONAL = new Set(["Public domain", "CC0", "CC PDM 1.0", "PD-USGov"]);

function isUnconditional(image: CraftImage): boolean {
  return UNCONDITIONAL.has(image.licence);
}

export default function CreditsPage() {
  // Sorted by what a reader looking for a particular picture would search by — the subject, not the
  // filename and not the order they happen to sit in the manifest.
  const images = [...CRAFT_IMAGES].sort((a, b) => a.title.localeCompare(b.title));
  const attributed = images.filter((image) => !isUnconditional(image));
  const free = images.filter(isUnconditional);

  return (
    <>
      <PageHero
        eyebrow="Provenance"
        title="Photography credits"
        description="Every photograph on this site is openly licensed. This page names each one's photographer, the terms it is published under, and where the original lives."
        breadcrumbs={BREADCRUMBS}
      />

      <section className="shell pb-24">
        <Reveal className="shell-narrow px-0">
          <div className="panel p-6 sm:p-8">
            <h2 className="display-title text-xl">How to reuse these photographs</h2>
            <p className="mt-4 text-base leading-relaxed text-ink-700">
              None of this photography belongs to the Centre. It is published here under licences its
              photographers chose, and those licences travel with the pictures — a photograph taken
              from this page carries the same obligations it carries here, not the Centre&rsquo;s
              permission.
            </p>

            <dl className="mt-6 space-y-4">
              <div>
                <dt className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <Scale aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
                  Attribution required
                </dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-ink-700">
                  The {attributed.length} photographs in the first list are under a Creative Commons
                  licence in the BY family. Reusing one means naming the photographer, naming the
                  licence and linking to it. A licence marked <strong>BY-SA</strong> adds a further
                  condition: anything you make from it must be shared under the same licence.
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                  <Camera aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
                  No conditions
                </dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-ink-700">
                  The {free.length} photographs in the second list are in the public domain or
                  released under CC0. Nothing is required of you. They are credited anyway, because
                  somebody wanting the original still needs to be able to find it.
                </dd>
              </div>
            </dl>
          </div>
        </Reveal>

        {attributed.length > 0 ? (
          <CreditList
            heading="Photographs requiring attribution"
            description="Creative Commons BY and BY-SA. Naming the photographer and the licence is a condition of use."
            images={attributed}
          />
        ) : null}

        {free.length > 0 ? (
          <CreditList
            heading="Public domain and CC0"
            description="Free of conditions. Credited as a courtesy, and so the original can be found."
            images={free}
          />
        ) : null}

        {/*
          The whole manifest being empty is not a real state — the pictures are committed to the
          repository — but a page whose only content is two headings and no list would read as broken
          rather than as empty, and "a block that quietly renders nothing is indistinguishable from a
          bug" is the rule this codebase repeats most often.
        */}
        {images.length === 0 ? (
          <Reveal className="mt-10">
            <p className="panel p-6 text-sm text-ink-700">
              No photographs are registered. The picture manifest at{" "}
              <code className="rounded bg-surface-100 px-1.5 py-0.5 text-xs">
                lib/media/craft-imagery.ts
              </code>{" "}
              is empty, which means <code className="rounded bg-surface-100 px-1.5 py-0.5 text-xs">
                scripts/fetch-craft-imagery.ts
              </code>{" "}
              has not been run for this deployment.
            </p>
          </Reveal>
        ) : null}
      </section>
    </>
  );
}

interface CreditListProps {
  heading: string;
  description: string;
  images: CraftImage[];
}

/**
 * One group of credits.
 *
 * A `<ul>` of rows rather than a table: a table would be the honest shape of this data, and it is
 * also the shape that stops being readable at 390px — a credit line is naturally three or four
 * wrapping phrases, and four of those in a row cannot be given useful column widths. The rows carry
 * the same information in a stacking layout.
 *
 * ⚠ NO THUMBNAILS. Twenty-six photographs at any useful size is several megabytes of images on a
 * page whose entire purpose is textual, and the reader who came here came for the words. The
 * photograph's title and region identify it, and the link goes to the original in full.
 */
function CreditList({ heading, description, images }: CreditListProps) {
  return (
    <Reveal as="section" className="mt-14">
      {/* Level 2: `PageHero` above owns the page's one `<h1>` (contract §11). */}
      <SectionHeading level={2} title={heading} description={description} />

      <ul className="mt-6 divide-y divide-line-200 border-y border-line-200">
        {images.map((image) => (
          <li key={image.slug} className="py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-display text-base font-semibold text-ink-900">{image.title}</h3>
              <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {image.region}
              </span>
            </div>

            {/* The same component that renders beside the photograph itself, so the wording on this
                page and the wording under a picture can never drift apart. */}
            <ImageCredit image={image} className="mt-1.5" />

            <p className="mt-1.5 text-[0.6875rem] text-ink-300">
              <code>{image.src}</code>
              <span aria-hidden="true"> · </span>
              {image.width} × {image.height}
            </p>
          </li>
        ))}
      </ul>
    </Reveal>
  );
}

/**
 * A note for whoever adds the next picture set.
 *
 * If photography ever starts coming from the media library instead of the bundle, this page has to
 * grow a second source — `MediaAsset` carries a `credit` column that nothing currently renders in one
 * place. Do not replace this list with that one: the two have different obligations, and a page that
 * showed only uploaded assets would silently stop crediting the bundled photographs that are still
 * on every craft page.
 */
export const dynamic = "force-static";
