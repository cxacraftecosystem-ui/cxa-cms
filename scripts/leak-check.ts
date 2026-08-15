/**
 * The draft-leak check.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT PROVES, AND WHY IT IS WORTH A SCRIPT.
 *
 * The single highest-consequence defect this codebase can have is a DRAFT or SOFT-DELETED record
 * appearing on the public site. Not a crash, not a broken layout — an embargoed publication, an
 * unannounced partnership or a person's unfinished biography becoming readable by anyone, quietly,
 * with every signal green. Nothing about it is visible in a build log or a type error.
 *
 * It cannot be caught by reading code either, at least not reliably: there are ~90 Prisma queries
 * across the public routes, and the defect is an OMISSION — a missing `livePublishableWhere()` or
 * `liveStatusWhere()` in one of them. Omissions are exactly what review misses.
 *
 * So this script does the only thing that actually settles the question. It creates one DRAFT and one
 * SOFT-DELETED record of every content type, with a distinctive marker string in every text field,
 * fetches every public URL, and greps the returned HTML for the marker. If the marker appears
 * anywhere, something leaked and the script says precisely where.
 *
 * It then DELETES the fixtures it made, in a `finally`, so a failed run does not leave test rows in a
 * real database.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SEARCH SURFACES NEED THREE THINGS THE OTHER SURFACES DO NOT, and the history is worth setting
 * down, because for a while this part of the script proved nothing whatsoever.
 *
 *  1. **THE FIXTURES HAVE TO BE IN THE SEARCH INDEX.** Public search reads `search_documents` and
 *     joins back to no source table at all (lib/search/query.ts), and those rows are written only by
 *     lib/search/index.ts from the studio's mutation routes. A fixture created with a direct
 *     `prisma.<model>.create` therefore produces NO index row, and `/search?q=<marker>` came back
 *     empty because the canary had never been indexed — not because the publish filter excluded it.
 *     Three assertions passed for a reason unrelated to what they claimed to test, which is worse than
 *     having no assertion at all: it turns an unknown into a confident wrong answer. `indexFixtures()`
 *     now writes the index row each fixture would have had, with `isPublished` computed by the
 *     product's own `isLive()`, so a regression in EITHER the write-time predicate or the read-time
 *     filter fails the run.
 *
 *     ⚠ It writes those rows itself rather than calling lib/search/index.ts, which is `server-only`
 *     and cannot be imported into a plain Node script. What that leaves untested is the studio save
 *     path's own call into the indexer; `smoke.ts` exercises that, in the published direction.
 *
 *  2. **A POSITIVE CONTROL**, because "nothing came back" only means something once the surface has
 *     been shown to be capable of answering. One index row with a DIFFERENT marker and `isPublished`
 *     true is installed, and all three search surfaces must return it. If one does not, the run fails
 *     with that fact instead of reporting a clean sweep over a search box that was answering nothing.
 *
 *  3. **A LEAK IS RECOGNISED BY THE FIXTURE'S OWN TITLE AND URL, NOT BY THE MARKER.** These surfaces
 *     legitimately echo the query, and the marker IS the query, so it appears in the heading, the
 *     `<title>`, the input's value and the JSON `query` field. The previous attempt replaced every
 *     occurrence of the marker and then asked whether any occurrence had survived — a question that
 *     cannot be answered yes by construction. A leaked record, on the other hand, always arrives with
 *     its own title ("… research area draft") and its own detail URL, and no echo of a query can
 *     produce either.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * USAGE
 *   npx next start -p 3200 &          # or `next dev`
 *   npx tsx scripts/leak-check.ts http://127.0.0.1:3200
 *
 * ⚠ RUN IT AGAINST A DEVELOPMENT DATABASE. It writes rows — including, for the length of the run, one
 * PUBLISHED search index row (the control above) that is genuinely findable on the site. It refuses to
 * run when NODE_ENV is "production" precisely because a marker string appearing on the real site —
 * even for thirty seconds — is the thing it exists to prevent.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { isLive, type PublishableFields } from "../lib/content";

const prisma = new PrismaClient();

/**
 * The marker.
 *
 * Deliberately long, unmistakable and unlike any real content, so a match in a page's HTML cannot be a
 * coincidence and a grep for it cannot hit a substring of something legitimate.
 */
const MARKER = "ZZLEAKCANARY7QX";

/**
 * The positive control.
 *
 * A SECOND, DIFFERENT marker on purpose: this record is published and is meant to be found, so sharing
 * the canary's string would make the emptiness assertions fail on the control itself. Its index row
 * belongs to no content table — nothing else on the site can render it — so it exercises the search
 * path and nothing but the search path.
 */
const CONTROL_MARKER = "ZZLEAKCONTROL3VB";
const CONTROL_TITLE = `${CONTROL_MARKER} published control record`;
const CONTROL_ENTITY_ID = `${CONTROL_MARKER.toLowerCase()}-control`;

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");

/**
 * Surfaces that legitimately ECHO the reader's query back.
 *
 * A search page prints "Search: <what you typed>" in its heading and its `<title>`, and the search
 * API returns `query` in its response — both correct, and both of which contain the marker when the
 * marker IS the query. So on these three paths the marker alone proves nothing, and the check asks a
 * sharper question instead: does any FIXTURE appear? See point 3 of the header for why that is the
 * question that can actually be answered, and `leakSignatures()` for what it looks for.
 */
const ECHOES_THE_QUERY = new Set([
  `/search?q=${MARKER}`,
  `/api/public/search?q=${MARKER}`,
  `/api/public/suggest?q=${MARKER}`
]);

/** Every public surface a leak could surface on. Listing pages, search, feeds and the sitemap. */
const PUBLIC_PATHS = [
  "/",
  "/about",
  "/contact",
  "/research",
  "/projects",
  "/publications",
  "/people",
  "/craft-explorer",
  "/gallery",
  "/news",
  "/events",
  "/search",
  `/search?q=${MARKER}`,
  "/sitemap.xml",
  `/api/public/search?q=${MARKER}`,
  `/api/public/suggest?q=${MARKER}`,
  "/api/public/stats"
];

/** The search index row a fixture would have had, had it been saved through the studio. */
interface IndexRow {
  entityType: string;
  entityId: string;
  title: string;
  url: string;
  isPublished: boolean;
}

interface Fixture {
  label: string;
  /** The public detail URL this record would have if it WERE published. */
  detailPath: string;
  /** The record's own title — what a leaked result card or JSON result prints. */
  title: string;
  indexRow: IndexRow;
  cleanup: () => Promise<void>;
}

/**
 * The strings whose presence on a search surface means a fixture actually leaked.
 *
 * The title and the detail URL, because a search result carries both and a query echo can carry
 * neither: the query is the bare marker, and nothing on the site turns it into "…-draft-area" or into
 * "ZZLEAKCANARY7QX research area draft" on its own.
 */
function leakSignatures(fixture: Fixture): string[] {
  return [fixture.detailPath, fixture.title];
}

async function createFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  const draftSlug = `${MARKER.toLowerCase()}-draft`;
  const deletedSlug = `${MARKER.toLowerCase()}-deleted`;

  // Each content type gets BOTH states, because they are guarded by different columns: a draft is
  // excluded by `status`, a soft delete by `deletedAt`, and a filter can easily cover one and miss the
  // other. Several bugs of exactly that shape are only visible when both are tested.
  for (const [state, slugBase] of [
    ["DRAFT", draftSlug],
    ["DELETED", deletedSlug]
  ] as const) {
    const status = state === "DRAFT" ? ("DRAFT" as const) : ("PUBLISHED" as const);
    const publishedAt = state === "DRAFT" ? null : new Date();
    // Written explicitly on the DRAFT rows too, as `null`, so the create calls below have one shape.
    const deletedAt = state === "DELETED" ? new Date() : null;
    const suffix = state.toLowerCase();

    /**
     * What the studio would have written to `SearchDocument.isPublished` for a row in this state.
     *
     * Computed with the product's own `isLive()` rather than hard-coded to `false`, so the emptiness
     * assertions also fail when the PREDICATE regresses: delete its `case "DRAFT": return false` arm
     * and every draft here is indexed as published, which is exactly the shape of defect the search
     * surfaces are checked for.
     */
    const publishState: PublishableFields = { status, publishedAt, deletedAt };
    const isPublished = isLive(publishState);

    /** One fixture, plus the index row it would have had. Keeps the nine blocks below to their data. */
    const record = (input: {
      label: string;
      entityType: string;
      id: string;
      title: string;
      detailPath: string;
      remove: () => Promise<unknown>;
    }): void => {
      fixtures.push({
        label: input.label,
        detailPath: input.detailPath,
        title: input.title,
        indexRow: {
          entityType: input.entityType,
          entityId: input.id,
          title: input.title,
          url: input.detailPath,
          isPublished
        },
        cleanup: () => input.remove().then(() => undefined)
      });
    };

    const area = await prisma.researchArea.create({
      data: {
        slug: `${slugBase}-area`,
        title: `${MARKER} research area ${suffix}`,
        summary: `${MARKER} summary`,
        status,
        publishedAt,
        deletedAt
      }
    });
    record({
      label: `ResearchArea (${state})`,
      entityType: "research-area",
      id: area.id,
      title: area.title,
      detailPath: `/research/${area.slug}`,
      remove: () => prisma.researchArea.delete({ where: { id: area.id } })
    });

    const project = await prisma.project.create({
      data: {
        slug: `${slugBase}-project`,
        title: `${MARKER} project ${suffix}`,
        tagline: `${MARKER} tagline`,
        summary: `${MARKER} summary`,
        status,
        publishedAt,
        isFeatured: true,
        deletedAt
      }
    });
    record({
      label: `Project (${state})`,
      entityType: "project",
      id: project.id,
      title: project.title,
      detailPath: `/projects/${project.slug}`,
      remove: () => prisma.project.delete({ where: { id: project.id } })
    });

    const publication = await prisma.publication.create({
      data: {
        slug: `${slugBase}-publication`,
        kind: "JOURNAL_ARTICLE",
        title: `${MARKER} publication ${suffix}`,
        abstract: `${MARKER} abstract`,
        authorLine: `${MARKER} Author`,
        year: 2026,
        status,
        publishedAt,
        isFeatured: true,
        deletedAt
      }
    });
    record({
      label: `Publication (${state})`,
      entityType: "publication",
      id: publication.id,
      title: publication.title,
      detailPath: `/publications/${publication.slug}`,
      remove: () => prisma.publication.delete({ where: { id: publication.id } })
    });

    const person = await prisma.person.create({
      data: {
        slug: `${slugBase}-person`,
        name: `${MARKER} Person ${suffix}`,
        kind: "FACULTY",
        designation: `${MARKER} designation`,
        bio: `${MARKER} biography`,
        status,
        publishedAt,
        deletedAt
      }
    });
    record({
      label: `Person (${state})`,
      entityType: "person",
      id: person.id,
      title: person.name,
      detailPath: `/people/${person.slug}`,
      remove: () => prisma.person.delete({ where: { id: person.id } })
    });

    const post = await prisma.post.create({
      data: {
        slug: `${slugBase}-post`,
        title: `${MARKER} article ${suffix}`,
        subtitle: `${MARKER} subtitle`,
        excerpt: `${MARKER} excerpt`,
        status,
        publishedAt,
        isFeatured: true,
        deletedAt
      }
    });
    record({
      label: `Post (${state})`,
      entityType: "post",
      id: post.id,
      title: post.title,
      detailPath: `/news/${post.slug}`,
      remove: () => prisma.post.delete({ where: { id: post.id } })
    });

    const event = await prisma.coeEvent.create({
      data: {
        slug: `${slugBase}-event`,
        title: `${MARKER} event ${suffix}`,
        summary: `${MARKER} summary`,
        // Comfortably in the future, so a listing that shows only upcoming events still has to exclude
        // it on status rather than being saved by the date.
        startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status,
        publishedAt,
        isFeatured: true,
        deletedAt
      }
    });
    record({
      label: `CoeEvent (${state})`,
      entityType: "event",
      id: event.id,
      title: event.title,
      detailPath: `/events/${event.slug}`,
      remove: () => prisma.coeEvent.delete({ where: { id: event.id } })
    });

    const craft = await prisma.craft.create({
      data: {
        slug: `${slugBase}-craft`,
        name: `${MARKER} craft ${suffix}`,
        summary: `${MARKER} summary`,
        status,
        publishedAt,
        isFeatured: true,
        deletedAt
      }
    });
    record({
      label: `Craft (${state})`,
      entityType: "craft",
      id: craft.id,
      title: craft.name,
      detailPath: `/craft-explorer/${craft.slug}`,
      remove: () => prisma.craft.delete({ where: { id: craft.id } })
    });

    const album = await prisma.galleryAlbum.create({
      data: {
        slug: `${slugBase}-album`,
        title: `${MARKER} album ${suffix}`,
        description: `${MARKER} description`,
        status,
        publishedAt,
        deletedAt
      }
    });
    record({
      label: `GalleryAlbum (${state})`,
      entityType: "album",
      id: album.id,
      title: album.title,
      detailPath: `/gallery/${album.slug}`,
      remove: () => prisma.galleryAlbum.delete({ where: { id: album.id } })
    });

    const page = await prisma.page.create({
      data: {
        slug: `${slugBase}-page`,
        title: `${MARKER} page ${suffix}`,
        seoDescription: `${MARKER} description`,
        status,
        publishedAt,
        deletedAt
      }
    });
    record({
      label: `Page (${state})`,
      entityType: "page",
      id: page.id,
      title: page.title,
      detailPath: `/${page.slug}`,
      remove: () => prisma.page.delete({ where: { id: page.id } })
    });
  }

  return fixtures;
}

interface Failure {
  path: string;
  detail: string;
}

async function fetchText(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}${path}`, {
    headers: { "Cache-Control": "no-cache" },
    redirect: "manual"
  });
  return { status: response.status, body: await response.text() };
}

/**
 * The same request, kept as BYTES.
 *
 * A generated social card is a PNG, so `fetchText()` would hand back mojibake and `String.includes`
 * would decide nothing. See `probeSocialCards()` for what is done with the bytes instead.
 */
async function fetchBytes(path: string): Promise<{ status: number; bytes: Buffer }> {
  const response = await fetch(`${base}${path}`, {
    headers: { "Cache-Control": "no-cache" },
    redirect: "manual"
  });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

/**
 * Every generated social-card route, keyed by the listing prefix it belongs to.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE CARD ROUTES ARE NOT AT THE PATH THEY LOOK LIKE, AND CONSTRUCTING IT BY HAND DOES NOT WORK.
 *
 * Next serves a metadata-image route only at a CACHE-BUSTED path — `/research/x/opengraph-image-hlwcbc`
 * — never at `/research/x/opengraph-image`, and the suffix is a build-time hash no source file can
 * know. The first version of this probe built the plain path, got a 404 for every fixture, and skipped
 * them all: it PASSED without asserting anything, which is the exact failure this script's own header
 * warns about ("it turns an unknown into a confident wrong answer").
 *
 * ⚠ AND THE HASH CANNOT BE LEARNED FROM A PUBLISHED PAGE EITHER, which was the second attempt. A page
 * only advertises its generated card when it has no uploaded image of its own, and in this corpus every
 * research area has a cover — so there was no published record of that type to read the hash from.
 *
 * So it is read from the BUILD MANIFEST, which is the one place that actually knows. That is legitimate
 * here and nowhere else: this script is pointed at a server, and `.next/app-path-routes-manifest.json`
 * is that same build's own index of its routes.
 *
 * ⚠ IF THE MANIFEST CANNOT BE READ, THE PROBE SAYS SO AND FAILS THE RUN. It must never fall back to
 * silence — a card check that quietly does nothing is worse than no card check, because the summary
 * line then claims the cards were covered.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function socialCardRoutes(): Map<string, string> | null {
  try {
    const manifestPath = path.join(process.cwd(), ".next", "app-path-routes-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>;

    const routes = new Map<string, string>();
    for (const value of Object.values(manifest)) {
      // `/research/[slug]/opengraph-image-hlwcbc` → prefix "research", segment "opengraph-image-hlwcbc".
      const match = /^\/([^/]+)\/\[slug\]\/(opengraph-image-[a-z0-9]+)$/.exec(value);
      if (match?.[1] && match[2]) routes.set(match[1], match[2]);
    }
    return routes.size > 0 ? routes : null;
  } catch {
    return null;
  }
}

/**
 * The generated social cards must not draw an unpublished record.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS THE ONE SURFACE THE REST OF THIS SCRIPT CANNOT SEE, AND IT WAS STATED AS A GAP RATHER THAN
 * CLOSED.
 *
 * `app/(site)/<type>/[slug]/opengraph-image.tsx` renders a 1200×630 PNG carrying the record's title,
 * and each of the seven queries the database with its OWN copy of the page's publication filter. Seven
 * copies is seven chances to reach for `liveStatusWhere()` where `livePublishableWhere()` was needed,
 * or to drop the filter in an edit — and a draft's headline rasterised into an image is a leak that
 * survives the record being deleted, because the platform that fetched it has cached the picture.
 *
 * Everything else here works by grepping HTML for a marker. **A marker cannot be grepped out of a
 * PNG**: the text is drawn as glyph outlines and then compressed. So the check asks a different
 * question, which the format can answer.
 *
 * ⚠ THE TECHNIQUE: EVERY REFUSAL DRAWS THE SAME PICTURE, SO THE BYTES ARE COMPARABLE.
 *
 * When a card route's query finds nothing it renders `fallbackCard()`, whose only input is the
 * institution's name. So a card for a slug that has never existed and a card for a slug that is merely
 * unpublished must be BYTE-IDENTICAL. If they differ, the second drew something the first did not, and
 * the only thing it could have drawn is the record.
 *
 * That needs no OCR, no image library and no golden file. **Its soundness was verified rather than
 * assumed**: two different nonexistent slugs return identical bytes (so a difference is meaningful),
 * and a published record's card differs from that (so the comparison can discriminate at all).
 *
 * ⚠ IT CANNOT PROVE A CARD IS CORRECT, only that a refusal is a refusal. A card drawing the WRONG
 * published record would pass this, and is not what this script is for.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function probeSocialCards(fixtures: Fixture[], failures: Failure[]): Promise<void> {
  const routes = socialCardRoutes();
  if (!routes) {
    failures.push({
      path: ".next/app-path-routes-manifest.json",
      detail:
        "could not read the build manifest, so the generated social cards were NOT checked — run this " +
        "against a built server (`npm run build` then `npx next start`), or the summary below overstates " +
        "what was covered"
    });
    return;
  }

  /* A slug nothing can ever match, to establish what a refusal looks like for each type. */
  const controlSlug = `${MARKER.toLowerCase()}-no-such-record`;
  let checked = 0;

  for (const fixture of fixtures) {
    // "/research/zzz-draft" → prefix "research", which is how the route is keyed.
    const prefix = fixture.detailPath.split("/")[1] ?? "";
    const segment = routes.get(prefix);
    // A type with no generated card. Correct and not a leak: it inherits the institutional card.
    if (!segment) continue;

    const slug = fixture.detailPath.split("/").slice(2).join("/");
    if (!slug) continue;

    const control = await fetchBytes(`/${prefix}/${controlSlug}/${segment}`);
    const offered = await fetchBytes(`/${prefix}/${slug}/${segment}`);

    if (control.status !== 200 || offered.status !== 200) {
      failures.push({
        path: `/${prefix}/${slug}/${segment}`,
        detail:
          `expected both the card and its control to render (got ${offered.status} and ` +
          `${control.status}), so the comparison could not be made and the card is UNVERIFIED`
      });
      continue;
    }

    checked += 1;

    if (!offered.bytes.equals(control.bytes)) {
      failures.push({
        path: `/${prefix}/${slug}/${segment}`,
        detail:
          `${fixture.label} is unpublished, but its social card differs from the card for a ` +
          `nonexistent record (${offered.bytes.length} bytes vs ${control.bytes.length}) — the card ` +
          `is drawing something out of the record`
      });
    }
  }

  // ⚠ Stated, not assumed. If the fixtures and the routes stopped overlapping — a type renamed, a card
  // deleted — this loop would run zero comparisons and report nothing, which is the vacuous pass the
  // first version of this function actually shipped.
  if (checked === 0) {
    failures.push({
      path: "(social cards)",
      detail:
        `${routes.size} card route(s) exist and ${fixtures.length} fixtures were created, but no ` +
        `fixture matched a card route — nothing was compared, so the cards are UNVERIFIED`
    });
  }
}

/**
 * Put the fixtures in the search index, as a studio save would have.
 *
 * Written straight to `search_documents` because lib/search/index.ts is `server-only` and cannot be
 * imported here — see point 1 of the header, which also states what that leaves untested. Only the
 * columns the two search predicates read are set: they match on `title`, and they return `url`, so a
 * leak arrives carrying both of the strings `leakSignatures()` looks for.
 */
async function indexFixtures(fixtures: Fixture[]): Promise<void> {
  for (const fixture of fixtures) {
    const row = fixture.indexRow;
    await prisma.searchDocument.upsert({
      where: { entityType_entityId: { entityType: row.entityType, entityId: row.entityId } },
      create: row,
      update: row
    });
  }
}

/**
 * Install the published control row, and confirm all three search surfaces return it.
 *
 * WITHOUT THIS THE EMPTINESS ASSERTIONS ARE UNFALSIFIABLE. A search box that is answering nothing at
 * all — a broken index, a query the tokeniser drops, a route that 500s — reports exactly the same
 * empty result as one whose publish filter is working perfectly, and the run would print PASS either
 * way. So a record that MUST be found is planted first, and a surface that cannot find it is reported
 * as a surface whose emptiness proves nothing.
 */
async function probeSearchSurfaces(failures: Failure[]): Promise<void> {
  await prisma.searchDocument.upsert({
    where: { entityType_entityId: { entityType: "page", entityId: CONTROL_ENTITY_ID } },
    create: {
      entityType: "page",
      entityId: CONTROL_ENTITY_ID,
      title: CONTROL_TITLE,
      url: `/${CONTROL_ENTITY_ID}`,
      isPublished: true
    },
    update: { title: CONTROL_TITLE, url: `/${CONTROL_ENTITY_ID}`, isPublished: true }
  });

  const dead = (path: string, what: string) =>
    failures.push({
      path,
      detail:
        `${what}, so this surface is not answering from the search index at all — every "nothing ` +
        'unpublished was found" result for it below would be true whatever the publish filter did'
    });

  const htmlPath = `/search?q=${CONTROL_MARKER}`;
  const html = await fetchText(htmlPath);
  if (!html.body.includes(CONTROL_TITLE)) {
    dead(htmlPath, `the published control record is missing from the page (status ${html.status})`);
  }

  for (const apiPath of [
    `/api/public/search?q=${CONTROL_MARKER}`,
    `/api/public/suggest?q=${CONTROL_MARKER}`
  ]) {
    const response = await fetchText(apiPath);
    const hits = countHits(response.body);
    if (hits === null) {
      dead(apiPath, `the response (status ${response.status}) carried no countable result field`);
    } else if (hits === 0) {
      dead(apiPath, `the published control record was not returned (status ${response.status})`);
    }
  }
}

/**
 * How many hits a search API response reports, or null when the shape says nothing either way.
 *
 * The two endpoints report differently — `/api/public/search` returns a `total`, `/api/public/suggest`
 * returns a `suggestions` array and no total — so the shape is read per endpoint rather than with one
 * pattern. `null` is deliberately distinct from `0`: a response that could not be parsed is an
 * unanswered question, and calling it emptiness is how a check comes to pass for the wrong reason.
 */
function countHits(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const payload = parsed as { total?: unknown; results?: unknown[]; suggestions?: unknown[] };
  if (typeof payload.total === "number") return payload.total;
  return payload.results?.length ?? payload.suggestions?.length ?? null;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run against a production build's database: this script writes draft rows " +
        "containing a marker string, and a marker on the real site is the exact thing it checks for."
    );
  }

  console.log(`\nDraft-leak check against ${base}\n`);

  let fixtures: Fixture[] = [];
  const failures: Failure[] = [];

  try {
    fixtures = await createFixtures();
    await indexFixtures(fixtures);
    console.log(
      `  Created ${fixtures.length} unpublished fixtures and indexed all of them for search.\n`
    );

    // 0. The search surfaces must be shown to work before their emptiness is allowed to mean anything.
    await probeSearchSurfaces(failures);

    // 1. No listing, feed, search result or sitemap entry may contain the marker.
    for (const path of PUBLIC_PATHS) {
      const { status, body } = await fetchText(path);

      // A search surface echoes what was typed, and the marker IS what was typed, so the marker alone
      // decides nothing here. A LEAKED RECORD is what is looked for instead — see ECHOES_THE_QUERY and
      // point 3 of the header.
      if (ECHOES_THE_QUERY.has(path)) {
        for (const fixture of fixtures) {
          const found = leakSignatures(fixture).find((signature) => body.includes(signature));
          if (found !== undefined) {
            failures.push({
              path,
              detail: `${fixture.label} appears among the results (status ${status}) as “${found}”`
            });
          }
        }
        // And, on the two JSON surfaces, the count itself. A result with neither title nor URL is not
        // something a reader could read, but it is still a publish filter that has stopped filtering.
        if (path.startsWith("/api/")) {
          const hits = countHits(body);
          if (hits === null) {
            failures.push({
              path,
              detail: "could not find a total, results or suggestions field — the check cannot verify emptiness"
            });
          } else if (hits !== 0) {
            failures.push({ path, detail: `returned ${hits} hit(s) for unpublished content` });
          }
        }
        continue;
      }

      if (body.includes(MARKER)) {
        // Report a little context so the leaking field is identifiable without re-running.
        const at = body.indexOf(MARKER);
        failures.push({
          path,
          detail: `marker found in the response (status ${status}) near: …${body
            .slice(Math.max(0, at - 60), at + 60)
            .replace(/\s+/g, " ")}…`
        });
      }
    }

    // 1b. No generated social card may draw an unpublished record. See `probeSocialCards` — the
    //     assertion is a byte comparison, because a marker cannot be grepped out of a PNG.
    await probeSocialCards(fixtures, failures);

    // 2. Every detail URL must 404. A 200 here is the leak in its purest form.
    for (const fixture of fixtures) {
      const { status, body } = await fetchText(fixture.detailPath);
      if (status === 200) {
        failures.push({
          path: fixture.detailPath,
          detail: `${fixture.label} is unpublished but its page returned 200`
        });
      } else if (status !== 404 && status !== 307 && status !== 308) {
        // A 500 is not a leak, but it is not a correct refusal either: it means the guard threw rather
        // than declining, and the reader is told the site is broken.
        failures.push({
          path: fixture.detailPath,
          detail: `${fixture.label} returned ${status} rather than 404 — the guard is failing, not refusing`
        });
      } else if (body.includes(MARKER)) {
        failures.push({
          path: fixture.detailPath,
          detail: `${fixture.label} correctly returned ${status}, but the marker still appears in the body`
        });
      }
    }
  } finally {
    // Always, even on a throw. Leaving marker rows behind would make the NEXT run report false leaks
    // and would put fictional content in a database somebody may then publish from.
    let removed = 0;
    for (const fixture of fixtures.reverse()) {
      try {
        await fixture.cleanup();
        removed += 1;
      } catch (error) {
        console.error(
          `  Could not remove fixture ${fixture.label}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    // The index rows this script wrote itself — the fixtures' AND the published control row, which is
    // the one piece of marker-bearing content that really was reachable on the site while the run
    // lasted. Matched by marker rather than by id so a run that died half way still leaves none.
    await prisma.searchDocument.deleteMany({
      where: { OR: [{ title: { contains: MARKER } }, { title: { contains: CONTROL_MARKER } }] }
    });
    // The search API logs what it was asked, so the probes above put two nonsense phrases in the
    // studio's "most searched" list. Case-insensitive because `logSearch` normalises before storing.
    await prisma.searchQueryLog.deleteMany({
      where: {
        OR: [
          { query: { contains: MARKER, mode: "insensitive" } },
          { query: { contains: CONTROL_MARKER, mode: "insensitive" } }
        ]
      }
    });
    console.log(`\n  Removed ${removed} of ${fixtures.length} fixtures.`);
    await prisma.$disconnect();
  }

  if (failures.length === 0) {
    console.log(
      `\n  PASS — the search surfaces returned the published control record, and nothing unpublished ` +
        `appeared on any of ${PUBLIC_PATHS.length} public surfaces, ${fixtures.length} detail URLs or ` +
        `their generated social cards.\n`
    );
    return;
  }

  console.error(`\n  FAIL — ${failures.length} leak(s):\n`);
  for (const failure of failures) {
    console.error(`    ${failure.path}\n      ${failure.detail}\n`);
  }
  process.exitCode = 1;
}

main().catch(async (error) => {
  console.error("\nLeak check could not complete:\n", error, "\n");
  await prisma.$disconnect();
  process.exitCode = 1;
});
