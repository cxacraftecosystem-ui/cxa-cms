/**
 * The social card for one profile.
 *
 * A researcher's page is shared by the researcher, into places where the reader has never heard of the
 * Centre — a hiring thread, a conference chat, a supervisor's mail. The name and the designation are the
 * whole message. The design lives in `lib/og/card.tsx`; this file is the query.
 *
 * ⚠ `isVisible` IS PART OF THE FILTER, NOT AN AFTERTHOUGHT. `page.tsx` loads a person with
 * `{ ...liveStatusWhere(), isVisible: true, slug }`, and this card must match it clause for clause: a
 * profile an editor has hidden is hidden from the roster, from its own URL — and from its card. Dropping
 * one clause here would publish the name of somebody who asked not to be listed, in an image no HTML
 * grep can see (`npm run leak-check` cannot read a PNG — see lib/og/card.tsx).
 *
 * `liveStatusWhere()`, not `livePublishableWhere()`: `Person` carries only `status`, and naming a
 * `publishAt` column it does not have is a Prisma runtime error rather than a type error.
 *
 * NO PHOTOGRAPH ON THE CARD. `next/og` would have to fetch, decode and re-encode the portrait on every
 * crawler request, and a card that half-loads a face is worse than one that never promised it. When an
 * editor HAS uploaded a portrait, the page's own metadata should keep preferring it (see
 * `generatedCardUrl` in lib/og/card.tsx) — this card is what replaces the card that says nothing.
 *
 * THE PERSON'S `kind` IS NOT SHOWN. "Faculty" or "Alumnus" would be useful, but the vocabulary for it
 * (`PERSON_KIND_LABELS`) lives in a component module that drags a good part of the site's card stack
 * into a route which runs cold, once per crawler, to draw eight words. The designation an editor typed
 * is more specific than the enum anyway.
 */

import { ImageResponse } from "next/og";

import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteName } from "@/lib/env";
import { OG_CONTENT_TYPE, OG_SIZE, fallbackCard, loadCardRecord, recordCard } from "@/lib/og/card";

/**
 * Five minutes, the same window as the page beside it (and re-exported into the generated route by
 * Next's metadata loader, exactly as `runtime` is). It caps two things at once: how much of a busy
 * channel's preview traffic reaches the database, and how long a card can outlive the record it names.
 */
export const revalidate = 300;

export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt =
  "A Centre of Excellence share card naming one member of the Centre, their role and their department.";

/**
 * ⚠ `params` ARRIVES ALREADY RESOLVED HERE, unlike a page's — Next's metadata-image route awaits the
 * segment params before calling this handler. Typed as the union and awaited so it is right either way.
 */
interface CardProps {
  params: Promise<{ slug: string }> | { slug: string };
}

export default async function PersonSocialCard({ params }: CardProps) {
  const { slug } = await params;

  const person = await loadCardRecord("person", () =>
    prisma.person.findFirst({
      // The page's filter, clause for clause. See the header.
      where: { ...liveStatusWhere(), isVisible: true, slug },
      select: { name: true, designation: true, department: true }
    })
  );

  /**
   * The designation is what a reader looks for immediately after the name, so it takes the subtitle and
   * the department follows it below. When there is no designation the department is promoted rather than
   * printed twice — a card reading "Physics" on both lines looks like a rendering fault.
   */
  const designation = person?.designation?.trim() || null;
  const department = person?.department?.trim() || null;

  return new ImageResponse(
    person
      ? recordCard({
          kind: "Person",
          title: person.name,
          subtitle: designation ?? department,
          meta: designation ? department : null,
          siteName: siteName()
        })
      : fallbackCard(),
    OG_SIZE
  );
}
