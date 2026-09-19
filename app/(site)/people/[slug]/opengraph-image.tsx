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
 * THE PERSON'S `kind` IS NOT SHOWN, AND THE REASON IS NOW ONLY THE SECOND OF THE TWO IT USED TO BE.
 * The vocabulary for it (`PERSON_KIND_LABELS`) no longer lives in a component module that would drag
 * the site's card stack into a route which runs cold, once per crawler, to draw eight words — it is in
 * lib/people/groups.ts, which costs nothing to import. What still stands is the editorial reason: the
 * designation an editor typed ("Professor of Industrial Design") is more specific than the enum
 * ("Faculty"), and there is room on this card for one of them.
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
   *
   * ⚠ BOTH ARE HANDED OVER WHOLE, AND THAT IS THE DECISION, NOT AN OVERSIGHT. `Person.department` is
   * free text whose canonical spelling of the Centre's own name runs to 199 characters
   * (components/site/PersonCard.tsx), and every card and credit on the SITE now shortens it — but this
   * surface already has a budget of its own, measured against a frame that cannot grow. `card()` cuts a
   * promoted department to `SUBTITLE_LIMIT` at 30px inside a 900px box, and `footerLine` gives the one
   * beside the institution's name whatever is left of the footer's 86 characters, dropping it entirely
   * rather than printing a stub too short to be a placing (lib/og/card.tsx). Cutting here as well would
   * put a second, shorter and unmeasured limit in front of that one: the 630px card would then be laid
   * out for a string it never receives, and two files would have to agree about a number only one of
   * them can see.
   *
   * ⚠ ONE READING THAT FOLLOWS FROM IT, LEFT AS IT IS: most of the roster's department IS this Centre,
   * so the footer of most of these cards says the institution's name and then most of it again —
   * "Centre of Excellence · Centre of Excellence for Unified AI-Enabled Craft Ecosystem…". It is
   * repetitive rather than wrong, and the alternative — dropping a department that begins with the site
   * name — is a special case that would silently blank the placing of the people whose placing really
   * is the Centre. If it is ever worth solving it belongs in `footerLine`, where the footer is built,
   * and not in one of the five routes that feed it.
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
