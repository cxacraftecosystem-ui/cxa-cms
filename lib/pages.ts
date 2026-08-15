import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import type { Metadata } from "next";
import type { Page, PageSection, Prisma, SectionType } from "@prisma/client";

import { livePublishableWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { authEnv } from "@/lib/env";
import { sectionLabel } from "@/lib/sections/registry";
import { placeholderPromptsIn } from "@/lib/sections/schema";
import { pageMetadata } from "@/lib/seo";

/**
 * Resolving a CMS `Page` — the ONE definition of what "published" means for a page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * Three routes read `Page` rows: the homepage (`app/(site)/page.tsx`, the row whose slug is `""`),
 * the catch-all (`app/(site)/[...slug]/page.tsx`, every other CMS page) and the studio's preview.
 * Each of them needs the row, its sections IN ORDER, and its SEO fields. If each fetched for itself,
 * the three would drift: one would forget the soft-delete filter, another would forget that an
 * `unpublishAt` in the past retires a row whatever the status column says, and the homepage would
 * quietly disagree with the sitemap about whether a page is live. So the filter is written once here,
 * on top of `livePublishableWhere()` from lib/content.ts, and nothing else hand-rolls it.
 *
 * SECTIONS ARE ORDERED IN SQL, not by the caller. `PageSection` has a `@@unique([pageId, position])`
 * and a dense 0-based ordering maintained by the builder, so `orderBy: { position: "asc" }` is total.
 * `SectionRenderer` sorts again defensively; that is belt and braces, not the mechanism.
 *
 * HIDDEN SECTIONS ARE RETURNED. `isVisible: false` is an editor turning a block OFF, not deleting it,
 * and the studio's preview legitimately wants to see one. `SectionRenderer` is what drops them from a
 * public render — filtering here would make a preview of a hidden block impossible.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
//
// ⚠ NOT ONE OF THE FIVE TYPES THIS FILE EXPORTS IS NAMED BY ANY OTHER FILE, AND THAT IS NOT THE DEFECT IT
// LOOKS LIKE. Grepped, so the claim is checkable: `PageSeoImage`, `PageWithSections`, `PageMetadataSource`,
// `PublishableSection` and `PagePublishBlocker` appear in no `.ts`/`.tsx` outside this module.
//
// This repository has a real and recurring defect of that shape — something fully built, correct, and
// reached by NOTHING — and it is worth being precise about why these are not instances of it. That defect
// is about EXECUTION: a function no path calls, a route nothing links to. A type in a signature is reached
// by inference instead of by import, and every one of these is in a signature that IS reached:
//
//   • `PageWithSections` is the declared return of `getPublishedPage()` and `getPageForPreview()`, so all
//     three page routes that call them (`app/(site)/page.tsx`, `app/(site)/[...slug]/page.tsx`,
//     `app/(site)/preview/[[...slug]]/page.tsx`) hold one — under that name, in every hover and every
//     error message — without writing an import for it. `PageSeoImage` arrives with it.
//   • `PageMetadataSource`, `PublishableSection` and `PagePublishBlocker` are STRUCTURAL parameter types,
//     which is the point their own headers argue: a caller that selected four columns satisfies them by
//     shape, so needing to import the name would defeat the reason they are interfaces rather than
//     `Pick<Page, …>`. `pagePublishBlockers()` is handed a Prisma `findMany` result by `pages/[id]`'s PATCH
//     and a locally built `PlannedSection[]` by the restore route; both satisfy `PublishableSection` by
//     shape and neither imports it, which is the type doing exactly the job it was written for.
//   • `PagePublishBlocker` is the return of one exported function and the parameter of the next, so
//     `describePublishBlockers(pagePublishBlockers(blocks))` at both call sites is it being used.
//
// So they stay exported. The alternative — dropping `export` — would compile (nothing here emits
// declarations) and would take away the only way a future caller could annotate one of these values, in
// exchange for a grep that comes back empty either way. What WOULD be worth acting on is an exported type
// that annotates nothing; there is none in this file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The share-card image for a page.
 *
 * Structurally identical to `MediaLike` in lib/media/url.ts, which is what `pageMetadata()` wants.
 * `ogImageUrl()` reads only `objectKey` and the `og` variant, but the full shape is selected anyway so
 * the same value can be handed to `<MediaImage>` without a second query — a narrower select would
 * silently cost the blur placeholder and the intrinsic size the moment somebody rendered it.
 *
 * Written out rather than imported: the equivalent select in lib/sections/resolve.ts is private to that
 * module and shaped for cards. Two small literals that each say what they are beat one shared one that
 * has to serve both.
 */
const seoImageSelect = {
  objectKey: true,
  width: true,
  height: true,
  altText: true,
  blurDataUrl: true,
  variants: { select: { label: true, format: true, objectKey: true, width: true } }
} satisfies Prisma.MediaAssetSelect;

export type PageSeoImage = Prisma.MediaAssetGetPayload<{ select: typeof seoImageSelect }>;

/** A `Page` row with everything a route needs to render and describe it. */
export interface PageWithSections extends Page {
  /** Ascending `position`. Includes hidden blocks — see the header. */
  sections: PageSection[];
  seoImage: PageSeoImage | null;
}

const pageInclude = {
  sections: { orderBy: { position: "asc" } },
  seoImage: { select: seoImageSelect }
} satisfies Prisma.PageInclude;

// ─────────────────────────────────────────────────────────────────────────────
// Slugs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stored form of a path.
 *
 * `Page.slug` is documented in prisma/schema.prisma as the full path WITHOUT a leading slash — `""` is
 * the homepage, `"about"`, `"research/roadmap"`. Callers arrive with the path in every other shape: the
 * catch-all hands over an array of segments, a redirect row may have been typed with a leading slash,
 * and a hand-written link may have a trailing one. Normalising on the way IN means a page is never
 * unreachable because of a slash somebody could not see.
 *
 * Case is left alone deliberately. Lowercasing here would make `/Research` resolve to a row saved as
 * `research`, which sounds helpful until two URLs serve one page and a crawler reports the duplicate.
 */
export function normalisePageSlug(slug: string): string {
  return slug
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

/** The public path for a stored slug: `""` → `/`, `"about"` → `/about`. */
export function pagePath(slug: string): string {
  const normalised = normalisePageSlug(slug);
  return normalised ? `/${normalised}` : "/";
}

// ─────────────────────────────────────────────────────────────────────────────
// Slugs the router cannot serve
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route segments under `app/(site)` that own a DYNAMIC CHILD.
 *
 * A `Page` row nested under one of these is unreachable: `/research/handbook` matches
 * `app/(site)/research/[slug]`, which looks for a research area called "handbook", finds none and
 * answers 404. The catch-all that would have served the page is never consulted, because a static
 * segment beats it.
 *
 * ⚠ THE SEGMENT ITSELF IS NOT LISTED AS FORBIDDEN, only the ground beneath it. A row whose slug is
 * exactly `research` is a different question — see `CODE_OWNED_PATHS`.
 */
const DYNAMIC_CHILD_SEGMENTS = [
  "craft-explorer",
  "events",
  "gallery",
  "news",
  "people",
  "preview",
  "projects",
  "publications",
  "research"
] as const;

/**
 * Paths served entirely by code, where a `Page` row of the same slug would never be rendered.
 *
 * ⚠ `about` AND `contact` ARE DELIBERATELY ABSENT, and getting that wrong would break the seed.
 * Both of those routes READ their own `Page` row and render its sections when it has any — that is
 * the whole design of `app/(site)/about/page.tsx`, and `prisma/seed.ts` creates both rows as
 * `isSystem`. Refusing them would make the seeded site invalid on its own terms.
 *
 * Everything below has no such reader: the code page wins and the row is invisible for ever.
 */
const CODE_OWNED_PATHS = [
  "a-z",
  "accessibility",
  "credits",
  "search",
  // The listing routes. Each renders its own records and never looks for a page of the same name.
  "craft-explorer",
  "events",
  "gallery",
  "news",
  "people",
  "preview",
  "projects",
  "publications",
  "research"
] as const;

/**
 * Why the router could never serve this slug — or `null` when it can.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS EXISTS SO THE ROW CANNOT BE CREATED, RATHER THAN SO SOMETHING DOWNSTREAM CAN HIDE IT.
 *
 * An earlier attempt at this problem was a filter on the A–Z index: drop any row whose first segment
 * looks like a listing route. That is guesswork at the wrong end — it means dropping rows on an
 * assumption about every route's shape, and it risks hiding reachable records in order to hide
 * unreachable ones. Meanwhile the row still exists, still appears in the studio's page list, still
 * says PUBLISHED, and still 404s for the editor who made it.
 *
 * Refusing it at the point of validation is the honest fix: the editor is told immediately, in the
 * one place they can act, and every surface downstream — the A–Z, the sitemap, the search index —
 * needs no rule of its own.
 *
 * ⚠ THE MESSAGE MUST NAME THE COLLISION. "That address cannot be used" sends somebody to the
 * developers; "the news section already answers for /news/…" tells them what to type instead.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function pageSlugConflict(slug: string): string | null {
  const normalised = normalisePageSlug(slug);
  // The homepage. `""` is a legitimate, seeded slug and is not a path collision with anything.
  if (normalised.length === 0) return null;

  const segments = normalised.split("/");
  const first = segments[0] ?? "";

  if (segments.length > 1 && (DYNAMIC_CHILD_SEGMENTS as readonly string[]).includes(first)) {
    return `Addresses beginning with “${first}/” already belong to the ${first} section, which answers for everything beneath it — so a page saved here would never be shown. Choose an address that does not start with “${first}/”.`;
  }

  if (segments.length === 1 && (CODE_OWNED_PATHS as readonly string[]).includes(first)) {
    return `“${first}” is a section this site builds for itself, so a page saved at that address would never be shown. Choose a different address.`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Content the router CAN serve and a reader must never be shown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The columns this check reads. A structural interface, like `PageMetadataSource` above, so a caller
 * who selected four columns rather than a whole `PageSection` can still use it.
 */
export interface PublishableSection {
  type: SectionType;
  /** The raw JSON payload, exactly as stored. See `placeholderPromptsIn` for why it is not parsed. */
  data: unknown;
  isVisible: boolean;
  /** The builder's own name for the block, where somebody set one. */
  label?: string | null;
}

/** One block standing between this page and the publish button. */
export interface PagePublishBlocker {
  /** "The corpus, in numbers (Key figures)" — named, because a count sends somebody hunting. */
  where: string;
  /** The prompt strings the block is still carrying, longest first. */
  prompts: string[];
}

/**
 * Blocks on this page that still carry the words the studio put there as a prompt.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS EXISTS SO A PLACEHOLDER CANNOT BE PUBLISHED, RATHER THAN SO SOMETHING DOWNSTREAM CAN HIDE ONE.
 *
 * The homepage shipped with a literal "Add a heading" as its `<h2>`, above four figures reading 0.
 * Every mechanism in the building saw it and none of them stopped it: the schema was satisfied (a
 * heading is optional and "Add a heading" is a valid string), the seed validated, the renderer drew
 * exactly what it was given, and `lib/health.ts` — which finds this correctly and says so plainly —
 * is a REPORT that somebody has to open. Nothing was wrong; nothing was refused; it went live.
 *
 * So the refusal goes at the point of publication, which is the same argument `pageSlugConflict`
 * above makes for addresses and for the same reason: the editor is told immediately, in the one place
 * they can act, and no surface downstream needs a rule of its own.
 *
 * ⚠ WHY NOT SIMPLY EMPTY THE PLACEHOLDERS INSTEAD. It was the obvious fix and it is the wrong one,
 * twice over. An empty heading is INVISIBLE in the builder, so an editor never learns the field
 * exists — the prompts are doing a real job and doing it well, which is why the seed map argues for
 * them at length. And `lib/health.ts` DERIVES its entire "nobody filled this in" check from those
 * strings: emptying them would silently switch that check off for every block type it currently
 * covers, trading a loud wrong thing for a quiet missing one. The string was never the defect. The
 * absence of a gate was. (One placeholder WAS changed — the stats `value` of `"0"`, which read as a
 * finished statistic rather than as an instruction and so was invisible to every check including this
 * one. See the note in lib/sections/schema.ts.)
 *
 * ⚠ HIDDEN BLOCKS ARE SKIPPED. `isVisible: false` renders nothing, so it cannot mislead a visitor,
 * and refusing to publish a page because of a block that is switched off would be a refusal an editor
 * cannot understand and can only escape by deleting work. Same predicate `lib/health.ts` uses.
 *
 * ⚠ THE MATCH IS EXACT, NEVER A PATTERN, and `placeholderPromptsIn` explains why at length: the
 * seeded homepage carries a button reading "Write to the Centre", and a gate testing for a leading
 * verb would refuse to publish the site's own front page for ever. Measured against the live database and
 * RE-MEASURED after the seed's two repair passes ran, since the example this note used to give has been
 * mended: that button still produces no blocker; the homepage's STATS block no longer produces one either
 * (`repairPlaceholderStats()` rewrote its heading), and nor does /about (`repairPlaceholderProse()`). The
 * one page this function names today is /contact — "Add a line about how long a reply usually takes." on
 * its CONTACT_FORM block and "Add the postal address" on its MAP block.
 *
 * ⚠ WHO CALLS THIS, AND EXACTLY WHAT IS THEREFORE REFUSED. **ONE handler can refuse anything today.**
 * The boundary each call draws is the load-bearing part — a reader who assumes "the gate is on" will be
 * wrong in both directions:
 *
 *   • `app/api/studio/pages/[id]/route.ts` (PATCH) refuses the CROSSING into publication —
 *     DRAFT/IN_REVIEW/ARCHIVED → PUBLISHED or SCHEDULED. **This is the live one.** It does NOT check an
 *     ordinary save of a page that is already live, so a page published with a placeholder before the
 *     gate existed STAYS published with it, and its editor is not locked out of a form that cannot fix
 *     it. Grandfathering is the only rule every existing row can satisfy; `lib/health.ts`'s report is
 *     what finds those.
 *   • `app/api/studio/pages/[id]/revisions/[version]/restore/route.ts` refuses restoring BLOCKS that
 *     carry a prompt into a page that is already published, because a restore keeps the publication
 *     state and would otherwise put content the editor never saw straight in front of readers.
 *     ⚠ **LATENT BY CONSTRUCTION, NOT MERELY UNTRIGGERED SO FAR.** Its guard needs a `sections` array
 *     inside a stored Page revision, and no writer of one can produce it: `mutateWithHistory()` in
 *     lib/audit.ts versions the mutation's RETURN value, every writer of a Page revision returns a
 *     column-only `select` (`PAGE_EDITABLE_SELECT` in the PATCH, `PAGE_SELECT` in the restore route, a
 *     column list in `app/studio/templates/page.tsx`), the three block handlers version
 *     `entityType: "PageSection"` instead, and `sections/order` and the soft DELETE both pass
 *     `revise: false`. So the branch is a guard held for the day a snapshot carries blocks — an import, a
 *     future revision shape — and counting it as a second live consumer overstates what is enforced. It
 *     is kept rather than deleted for the reason its own ⚠ note gives at length.
 *
 * ⚠ AND HERE IS EVERYTHING ELSE THAT PUTS A PAGE'S BLOCKS IN FRONT OF A READER. This paragraph used to
 * say "Nothing else calls it" and name two of them; it had missed three, one of which is a genuine
 * crossing. A survey that claims to be exhaustive and is not is worse than no survey, because the next
 * reader stops looking. Measured by grepping every writer of `Page.status` and `Page.deletedAt`:
 *
 *   • `app/api/studio/pages/route.ts` (create) makes a page with NO BLOCKS AT ALL, so there is nothing
 *     to refuse. Vacuous, and it says so where the call would have gone.
 *   • `app/api/studio/pages/[id]/duplicate/route.ts` always produces a DRAFT. Vacuous for exactly as
 *     long as that holds, which is why that file carries its own ⚠ IF PROMISE 1 IS EVER RELAXED note.
 *   • `app/studio/templates/page.tsx` — a Server Action that creates a page WITH BLOCKS, copied from a
 *     `PageTemplate`, i.e. blocks that are the studio's own prompt text almost by definition. It is
 *     vacuous ONLY because it hard-codes `status: "DRAFT"`; its file header states that invariant
 *     ("⚠ THE NEW PAGE IS ALWAYS A DRAFT, whatever else happens") and the create call points back at it.
 *     ⚠ It writes through Prisma directly and never touches the PATCH, so relaxing that one literal
 *     would need the same `LIVE_STATUSES` check written HERE-style at that call site — a note would not
 *     be enough.
 *   • `app/api/cron/publish/route.ts` flips SCHEDULED → PUBLISHED unattended. Deliberately not gated:
 *     the PATCH treats SCHEDULED as the moment of commitment for exactly this reason — nobody is in the
 *     room when the scheduler runs, and a job that silently declined to publish what a person had
 *     already approved would be a worse failure than the one being prevented.
 *   • `app/api/studio/recycle-bin/restore/route.ts` clears `deletedAt` and nothing else. ⚠ THAT IS A
 *     REAL CROSSING and this survey used not to admit it: `isLive()` is false while `deletedAt` is set,
 *     so restoring a PUBLISHED row puts its blocks back in front of readers. Not gated, and the reason
 *     is grandfathering rather than an oversight — those blocks were already public before the page was
 *     binned, and no NEW placeholder can arrive while it sits there, because both block editors refuse a
 *     page with `deletedAt` set (`sections/route.ts` selects `deletedAt: null` and 404s;
 *     `sections/[sectionId]` answers 409 "This page is in the recycle bin"). A gate there would refuse
 *     to give an editor back the only page from which they could fix it.
 *   • `prisma/seed.ts` creates the three structural pages PUBLISHED, outside every route. It does not call
 *     this function — ⚠ NOT because it cannot: the seed already imports two `server-only` modules and they
 *     resolve, which that file documents at length, so "a script cannot import this" would be the same
 *     falsehood that file has had to retract twice. The reasons are that importing this module would pull a
 *     SECOND `PrismaClient` into the seed process through `@/lib/db`, and that the per-block question is not
 *     the one the seed needed: its page literals are fixed in source and proved publishable by harness,
 *     while the surface nobody was watching was the flattened text on its way into the search index. So
 *     `seedSearchIndex()` there reports any prompt in a seeded page's flattened text through
 *     `allPlaceholderPrompts()` on every run, before the corpus is written. ⚠ That report is a SUBSET of
 *     what this function sees — it can only read the keys `SECTION_TEXT_KEYS` collects — and its own header
 *     says so with a measured example.
 *
 * Nothing else should grow its own copy of this check. A second, weaker copy somewhere the editor cannot
 * see it is precisely how the vocabulary in lib/sections/schema.ts DRIFTED from the one lib/health.ts used
 * to derive for itself — a divergence of exactly one string, since closed by making the report import the
 * export (below), and documented at length in both files because it is the failure this rule prevents.
 *
 * ⚠ THE BLOCK EDITORS ARE NOT GATED, and cannot be. `pages/[id]/sections/[sectionId]` saves one block
 * on a page that may be live, and refusing that save would stop an editor REPLACING the placeholder —
 * the very act the gate wants. Publication is the boundary; a block save is not one.
 *
 * ⚠ THE HEALTH REPORT NOW SHARES THIS VOCABULARY — AND IT IS STILL NOT WHERE A REFUSED EDITOR FINDS THEIR
 * ANSWER. Both halves matter, and this note used to state only the first half's opposite.
 *
 * `lib/health.ts:20` imports `sectionPlaceholderPrompts` from lib/sections/schema.ts and matches those exact
 * strings. It used to re-derive its own list with `/^(add|write)\b/i`, which omitted `replace` and so missed
 * STORY_SCROLL's "Replace this photograph with one of your own." — one string, in the dangerous direction.
 * That divergence is CLOSED; the two can no longer disagree about which words count.
 *
 * ⚠ But do not tell a refused editor to go and read the report, because their block will not be on it. That
 * finding reads `visibleBlocksOnLivePages` — `livePublishableWhere()`, i.e. PUBLISHED or a SCHEDULED page
 * whose moment has come — and its title says so out loud ("blocks on published pages have not been filled
 * in"). A page the PATCH refuses did NOT cross, so it is still DRAFT, IN_REVIEW or ARCHIVED and no query in
 * that report can see it. The report covers the OTHER population: pages already live, grandfathered past
 * this gate (the paragraph above lists how each of them got there). What diagnoses a refusal is the refusal
 * itself — `describePublishBlockers` below QUOTES the offending words for exactly this reason, because it
 * is the only surface the editor is looking at.
 *
 * ⚠ Two smaller differences survive the shared import and are recorded on `judgementFor()` in lib/health.ts:
 * this gate walks the RAW payload with an uncapped walker while the report walks the PARSED payload with one
 * capped at depth 12, and the report applies a second test this gate does not (a payload identical to the
 * all-defaults `bare` document). Neither check is simply the stricter one. See the header on
 * `PLACEHOLDER_PROMPT_PATTERN` in lib/sections/schema.ts.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function pagePublishBlockers(
  sections: readonly PublishableSection[]
): PagePublishBlocker[] {
  const blockers: PagePublishBlocker[] = [];

  for (const section of sections) {
    if (!section.isVisible) continue;

    const prompts = placeholderPromptsIn(section.type, section.data);
    if (prompts.length === 0) continue;

    // The builder's label first — it is what the editor named the block and what they will look for
    // in the list — with the block type in brackets so an unlabelled block is still findable.
    const named = section.label?.trim();
    const kind = sectionLabel(section.type);
    blockers.push({
      where: named ? `${named} (${kind})` : kind,
      prompts: [...prompts].sort((a, b) => b.length - a.length || a.localeCompare(b))
    });
  }

  return blockers;
}

/**
 * How many blocks a refusal names before it stops.
 *
 * Three fits in a sentence an editor reads rather than skims. ⚠ When it bites the message SAYS SO —
 * a refusal that listed three of nine would send somebody back to the publish button five more times
 * (contract §1.6).
 */
const NAMED_BLOCKERS = 3;

/**
 * The refusal, as one sentence ready to render verbatim.
 *
 * `null` when there is nothing to refuse, so a caller reads as `if (message) throw badRequest(message)`
 * and cannot accidentally refuse an empty list.
 *
 * IT QUOTES THE WORDS RATHER THAN DESCRIBING THEM. "One block still has placeholder text" sends an
 * editor through a forty-block page hunting for something they cannot picture; "still says “Add a
 * heading”" is a phrase they can find with the browser's own search. This is the same rule
 * `pageSlugConflict` follows and the same one contract §9 sets for every `ApiError` message.
 */
export function describePublishBlockers(blockers: readonly PagePublishBlocker[]): string | null {
  if (blockers.length === 0) return null;

  const named = blockers.slice(0, NAMED_BLOCKERS).map((blocker) => {
    // One example per block. A block holding six prompts is a block nobody has started, and printing
    // all six would bury the block's NAME, which is the part the editor navigates by.
    const example = blocker.prompts[0];
    return example ? `${blocker.where}, which still says “${example}”` : blocker.where;
  });

  const remaining = blockers.length - named.length;
  const tail =
    remaining > 0
      ? ` and ${remaining} other block${remaining === 1 ? "" : "s"} on the same page`
      : "";

  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join("; ")}; and ${named[named.length - 1]}`;

  return (
    `This page cannot be published while a block still holds the words the studio put there as a ` +
    `prompt: ${list}${tail}. Replace that text with the page's own words, or turn the block off, and ` +
    `publish again.`
  );
}

/** The stored slug for a catch-all's segments. Empty when there is nothing usable. */
export function slugFromSegments(segments: readonly string[] | undefined): string {
  if (!segments) return "";
  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The published page at `slug`, or null.
 *
 * `cache()`-wrapped, and that is load-bearing rather than an optimisation: `generateMetadata` and the
 * page component are two separate passes over the same request, and both need the row. Without the
 * memo every CMS page would issue the identical query twice — once to build a `<title>` and once to
 * render the body.
 *
 * `findFirst`, not `findUnique`, because the publication filter is part of the question. `slug` is
 * unique, so at most one row can match either way; asking `findUnique` and then testing `isLive()` in
 * JavaScript would work and is precisely the hand-rolled filter this module exists to prevent.
 */
export const getPublishedPage = cache(async (slug: string): Promise<PageWithSections | null> => {
  /**
   * An unreachable database answers `null` — the same answer as "no such page".
   *
   * Every caller already handles `null`: the homepage renders its dignified fallback, `/about` and
   * `/contact` compose their default page, and the catch-all checks the redirect table and then 404s.
   * So the failure degrades into a path that is already written and already correct.
   *
   * It matters because `next build` renders these pages, and a throw there fails the entire deploy for
   * a reason unrelated to the change being shipped — the same argument lib/prerender.ts makes at length.
   * Each of those pages carries a `revalidate` window, so a degraded prerender repairs itself.
   */
  return prisma.page
    .findFirst({
      where: { ...livePublishableWhere(), slug: normalisePageSlug(slug) },
      include: pageInclude
    })
    .catch((error: unknown) => {
      console.error(
        `[pages] "${slug}" could not be read, so it is being treated as absent. ` +
          `Reason: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    });
});

/**
 * Every published page's slug, for `generateStaticParams`.
 *
 * `isSystem: false` is the filter the catch-all asked for: a system page is one whose route the CODE
 * owns (the homepage, and any structural page a bespoke route renders), and prerendering it from the
 * catch-all would put two builders in charge of one URL.
 *
 * The homepage's empty slug is dropped — a catch-all cannot match `/`, and emitting `{ slug: [] }`
 * produces a build-time route conflict with `app/(site)/page.tsx`.
 *
 * ⚠ The publication filter is evaluated AT BUILD TIME here, so a page scheduled for next Tuesday is
 * not in this list. It is not lost: `dynamicParams` is on, so the route renders it on demand the
 * moment its `publishAt` passes, and `revalidate` refreshes it thereafter. The prerender list is a
 * head start, never the set of pages that exist.
 */
export async function listPublishedPageSlugs(): Promise<string[]> {
  const rows = await prisma.page.findMany({
    where: { ...livePublishableWhere(), isSystem: false },
    select: { slug: true },
    // A total ordering, so two builds of the same commit prerender in the same order and a diff of
    // the build output is about the change under test.
    orderBy: [{ sortOrder: "asc" }, { slug: "asc" }]
  });

  return rows.map((row) => row.slug).filter((slug) => normalisePageSlug(slug).length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Redirects
// ─────────────────────────────────────────────────────────────────────────────

export interface PageRedirect {
  /** A site path, or an absolute URL for a destination genuinely off this origin. */
  destination: string;
  permanent: boolean;
}

/**
 * Tidy an editor-typed destination, or reject it.
 *
 * Three cases, and each rejection is a loop or a surprise avoided rather than a preference:
 *
 *   • A bare word (`about`) becomes `/about`. Handed to `redirect()` as typed it would be resolved
 *     relative to the current URL, so `/research/old` → `about` would land on `/research/about`.
 *   • A protocol-relative `//example.com` is collapsed to `/example.com`. It is almost always a typo
 *     for one slash, and honouring it would send a reader off this origin from a field that looks like
 *     a path.
 *   • Empty is null. A redirect row with no destination is a row that must be ignored, not one that
 *     sends every reader to the homepage.
 */
function normaliseRedirectDestination(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("#") || trimmed.startsWith("?")) return trimmed;
  if (trimmed.startsWith("/")) return `/${trimmed.replace(/^\/+/, "")}`;
  return `/${trimmed}`;
}

/**
 * "This page moved" — the `Redirect` row for a slug, or null.
 *
 * THIS IS WHAT MAKES AN EDITOR'S "I MOVED THIS PAGE" NOT BREAK EVERY EXISTING CITATION. An
 * institutional URL is quoted in papers, syllabi and emails that outlive the page they point at, so a
 * moved page must keep answering its old address rather than 404.
 *
 * `Redirect.source` HAS NO ENFORCED SHAPE, so both are accepted: `/old-page` and `old-page`. The
 * leading-slash form wins when somehow both exist, because that is the form a URL is written in and
 * therefore the one an editor pasting an address will have produced. Accepting one shape only would
 * leave an editor staring at a redirect that is plainly saved and plainly not working.
 *
 * `hits` IS NOT INCREMENTED HERE, deliberately. This runs inside a render — including a build-time
 * prerender — and a counter incremented there counts deployments rather than readers, in a function
 * React is free to re-invoke. Counting belongs in a request-scoped writer, not in a page body.
 */
export async function findPageRedirect(slug: string): Promise<PageRedirect | null> {
  const normalised = normalisePageSlug(slug);
  const withSlash = `/${normalised}`;
  const candidates = normalised ? [withSlash, normalised] : ["/"];

  const rows = await prisma.redirect.findMany({ where: { source: { in: candidates } } });
  if (rows.length === 0) return null;

  const row = rows.find((candidate) => candidate.source === candidates[0]) ?? rows[0];
  if (!row) return null;

  const destination = normaliseRedirectDestination(row.destination);
  if (!destination) {
    console.error(
      `[pages] the redirect from "${row.source}" has no usable destination, so it was ignored.`
    );
    return null;
  }

  // A row pointing at its own source is an infinite redirect the browser reports as
  // ERR_TOO_MANY_REDIRECTS — a page that appears completely broken for a reason nothing on screen
  // explains. Refusing it here means the reader gets an honest 404 instead, and the operator gets a
  // log line naming the row.
  if (destination === withSlash || (!normalised && destination === "/")) {
    console.error(
      `[pages] the redirect from "${row.source}" points at itself, so it was ignored. Fix or delete it.`
    );
    return null;
  }

  return { destination, permanent: row.permanent };
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The query parameter a preview link carries. Exported so the studio's link builder and whatever route
 * reads it cannot disagree about the name.
 */
export const PAGE_PREVIEW_QUERY_KEY = "preview";

/** 128 bits, as 32 hex characters. Long enough that guessing is not a strategy, short enough to paste. */
const PREVIEW_TOKEN_HEX_LENGTH = 32;

/**
 * The preview token for a page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * DERIVED, NOT STORED. The token is an HMAC of the slug under the server's signing secret, so there is
 * no table to write, nothing to expire and no state that can disagree with the page. Three properties
 * follow, and all three are the ones a preview link needs:
 *
 *   • **It is scoped to ONE page.** A link forwarded to somebody who should not have seen it exposes
 *     that page's draft and nothing else — not the rest of the unpublished site.
 *   • **It is stable.** An editor who pastes a preview link into an email keeps a working link after
 *     the next save. A token that changed per revision would be a link that breaks by being useful.
 *   • **It is unguessable without the secret**, and rotating `JWT_SECRET` invalidates every
 *     outstanding preview link at once — which is the answer when one has leaked.
 *
 * The cost of stability is that a link does not expire on its own. Renaming the page invalidates its
 * link (the slug is the signed message), and rotating the secret invalidates all of them; there is no
 * third mechanism, and that is worth knowing before a draft under embargo is previewed to a mailing
 * list.
 *
 * ⚠ A PREVIEW RENDER MUST NEVER BE INDEXED. Whatever route calls `getPageForPreview` must build its
 * metadata with `pageMetadataFor(page, { forceNoIndex: true })` — an unpublished draft reachable on a
 * stable URL is exactly the sort of thing a crawler that found the link once will keep.
 *
 * ⚠ THE PUBLIC ROUTES DO NOT CALL THIS, and that is a deliberate architectural decision rather than an
 * omission. Reading a search parameter or a cookie inside `app/(site)/[...slug]/page.tsx` would opt
 * every CMS page into per-request rendering, which is the opposite of what `generateStaticParams` and
 * `revalidate` are there for. Preview belongs on its own route, where being dynamic costs nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function pagePreviewToken(slug: string): string {
  const normalised = normalisePageSlug(slug);
  // `authEnv()` REFUSES a missing or weak secret by throwing (lib/auth/config.ts). That is another
  // reason preview stays off the public path: a deployment misconfigured this way must fail at the
  // studio door, not while a visitor is reading a published page.
  return createHmac("sha256", authEnv().secret)
    // The `v1` and the purpose string are domain separation: the same secret signs session tokens, and
    // a bare slug as the message would let one construction's output be replayed as another's.
    .update(`page-preview:v1:${normalised}`)
    .digest("hex")
    .slice(0, PREVIEW_TOKEN_HEX_LENGTH);
}

/**
 * Compare in constant time.
 *
 * `timingSafeEqual` THROWS on a length mismatch rather than returning false, so the lengths are
 * checked first — an offered token of the wrong length is simply wrong, and a thrown error inside a
 * page render would be a 500 where a 404 was meant.
 */
function previewTokenMatches(normalisedSlug: string, offered: string): boolean {
  const expected = Buffer.from(pagePreviewToken(normalisedSlug), "utf8");
  const actual = Buffer.from(offered.trim(), "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * A page for the studio's preview link, whatever its publication state — or null.
 *
 * NOT `cache()`-wrapped, unlike the public reader: a preview is one render of one page for one person,
 * so there is no second pass to save, and keeping the token out of a memo key is one less place it is
 * held.
 *
 * SOFT-DELETED PAGES ARE STILL EXCLUDED. A row in the recycle bin is not a draft; previewing one
 * would show content an editor believes they have removed, on a URL that survives the removal.
 */
export async function getPageForPreview(
  slug: string,
  token: string | null | undefined
): Promise<PageWithSections | null> {
  if (!token) return null;

  const normalised = normalisePageSlug(slug);
  if (!previewTokenMatches(normalised, token)) return null;

  return prisma.page.findFirst({
    where: { slug: normalised, deletedAt: null },
    include: pageInclude
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The columns `pageMetadataFor` reads.
 *
 * A structural interface rather than `PageWithSections`, so a caller who selected only the SEO columns
 * — a metadata-only path with no need for the sections — can still use it.
 */
export interface PageMetadataSource {
  slug: string;
  title: string;
  seoTitle: string | null;
  seoDescription: string | null;
  seoNoIndex: boolean;
  canonicalUrl: string | null;
  seoImage?: PageSeoImage | null;
}

export interface PageMetadataOptions {
  /**
   * Force `noindex` regardless of the row. A preview route MUST pass this — see `pagePreviewToken`.
   * It only ever ADDS the directive; it can never turn one off.
   */
  forceNoIndex?: boolean;
  /**
   * Escape the root layout's `%s · <site name>` title template.
   *
   * For the HOMEPAGE only, whose title is usually the institution's own name — the template would
   * render it twice.
   */
  absoluteTitle?: boolean;
}

/**
 * A page row's `Metadata`, built through `pageMetadata()` from lib/seo.ts.
 *
 * Every rule that file enforces — the absolute canonical, the 160-character word-boundary
 * description, `noindex` on BOTH `robots` and `googleBot`, an Open Graph image that always exists —
 * is therefore inherited rather than restated. The only page-specific decisions are here:
 *
 *   • `seoTitle` wins over `title`, but an EMPTY `seoTitle` does not. The studio's SEO panel starts
 *     blank, and `""` there means "use the page's title", not "publish an untitled page".
 *   • `canonicalUrl` is an OVERRIDE, used only when the content genuinely lives elsewhere. Empty
 *     falls back to this page's own absolute URL, which is what almost every page wants.
 */
export function pageMetadataFor(
  page: PageMetadataSource,
  options: PageMetadataOptions = {}
): Metadata {
  const title = page.seoTitle?.trim() || page.title;

  const metadata = pageMetadata({
    title,
    description: page.seoDescription,
    path: pagePath(page.slug),
    image: page.seoImage ?? null,
    noIndex: page.seoNoIndex || options.forceNoIndex === true,
    canonicalOverride: page.canonicalUrl?.trim() || undefined
  });

  if (!options.absoluteTitle) return metadata;
  return { ...metadata, title: { absolute: title } };
}
