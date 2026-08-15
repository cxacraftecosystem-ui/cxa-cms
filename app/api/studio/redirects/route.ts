import type { NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, badRequest, conflict, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { mutateWithHistory } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/env";
import { canManageStructure } from "@/lib/permissions";
import { buildAuditContext, found, parseStudioJson, parseStudioQuery } from "@/lib/studio/crud";

/**
 * Redirects — "this page has moved", so an address printed in a paper keeps working.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE THINGS ARE REFUSED, AND EVERY ONE OF THEM IS A FAILURE THE BROWSER REPORTS AS SOMETHING ELSE.
 *
 *  1. A SOURCE THAT IS NOT A PATH. `https://example.com/old` in the source column can never match: this
 *     site only answers for its own addresses. A row like that looks saved and does nothing at all, which
 *     is the worst kind of configuration — visibly present, invisibly useless.
 *
 *  2. A REDIRECT TO ITSELF. `/old` → `/old` is an infinite loop, which every browser reports as
 *     ERR_TOO_MANY_REDIRECTS: a page that appears completely broken, for a reason nothing on screen
 *     explains. (`findPageRedirect()` in lib/pages.ts refuses one at READ time as well and logs it. This
 *     stops it being created in the first place.)
 *
 *  3. A CHAIN THAT COMES BACK ROUND. `/a` → `/b` → `/a` is the same infinite loop written across two rows,
 *     and it is the one nobody spots by eye. So every write FOLLOWS THE WHOLE CHAIN before it commits,
 *     using every other row in the table and the destination being proposed. An unchecked chain is a loop
 *     the browser reports as a network failure.
 *
 * A CHAIN THAT DOES NOT LOOP IS ALLOWED, AND REPORTED. `/a` → `/b` → `/c` works, but each hop is another
 * round trip for the reader and search engines follow only a few before giving up on the address
 * altogether — so `chains` in the list response names them and the studio prints them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE NORMALISATION AND THE CHAIN WALK ARE DUPLICATED IN `app/studio/redirects/page.tsx`, which does the
 * same job through Server Actions for a form that needs no JavaScript. The two must agree: a route that
 * accepted a shape the screen refuses (or the reverse) would make "why did that save there and not here"
 * unanswerable. If either changes, both change.
 */

export const dynamic = "force-dynamic";

const SOURCE_MAX = 500;
const DESTINATION_MAX = 500;

/** How far a chain is followed before it is called a loop. Ten hops is far beyond anything useful. */
const MAX_HOPS = 10;

/** How many rows one list answer carries. Reported as `truncated` when it bites (contract §1.6). */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * The stored form of a source: exactly one leading slash, no trailing slash, no doubled slashes.
 *
 * `findPageRedirect()` accepts both `/old-page` and `old-page` for historical reasons, preferring the
 * leading-slash form. Writing only that form means the two shapes never both exist for one address — so a
 * reader can never be looking at a redirect that is plainly saved and plainly not working.
 */
function normaliseSource(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (trimmed.length === 0) return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/** The destination as stored. An external address keeps its scheme; anything else becomes a path. */
function normaliseDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("#") || trimmed.startsWith("?")) return trimmed;
  return normaliseSource(trimmed);
}

/** True when a source is a usable path on this site. */
function isUsableSource(source: string): boolean {
  if (!source.startsWith("/")) return false;
  // `//host` is a protocol-relative address to somebody else's site; `://` means a whole URL was pasted.
  // Neither can ever match a request this site receives.
  if (source.startsWith("//")) return false;
  if (source.includes("://")) return false;
  return source.length <= SOURCE_MAX;
}

/**
 * A destination that will not send a reader somewhere dangerous.
 *
 * A path, an anchor, a query, or a full http(s) address. `javascript:` and `data:` are refused by the
 * positive allow-list rather than by a blacklist — a destination is put into a `Location` header, and a
 * scheme nobody thought about is exactly what a blacklist misses.
 */
function isUsableDestination(destination: string): boolean {
  if (destination.length === 0 || destination.length > DESTINATION_MAX) return false;
  if (/^https?:\/\//i.test(destination)) return true;
  if (destination.startsWith("//")) return false;
  return destination.startsWith("/") || destination.startsWith("#") || destination.startsWith("?");
}

/**
 * Follow the chain from `destination` using every OTHER redirect, and say whether it comes back to
 * `source`.
 *
 * `others` excludes the row being saved and `destination` is that row's NEW destination, so the walk asks
 * exactly the question that matters: "if I commit this, can a reader end up back where they started?"
 */
function chainReturnsTo(
  others: ReadonlyMap<string, string>,
  source: string,
  destination: string
): boolean {
  let current = destination;
  const seen = new Set<string>([source]);

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (current === source) return true;
    // A loop that does not involve this row is somebody else's problem and is reported in `chains`, not
    // refused here — refusing it would make an unrelated row impossible to fix.
    if (seen.has(current)) return false;
    seen.add(current);
    const next = others.get(current);
    if (next === undefined) return false;
    current = next;
  }
  // Ten hops without settling is a loop for every practical purpose.
  return true;
}

/** Every chain in the table, with a flag for the ones that come back round. */
function describeChains(rows: readonly { source: string; destination: string }[]) {
  const destinations = new Map<string, string>();
  for (const row of rows) destinations.set(normaliseSource(row.source), normaliseDestination(row.destination));

  const chains: { source: string; hops: string[]; loops: boolean }[] = [];
  for (const row of rows) {
    const source = normaliseSource(row.source);
    const hops: string[] = [];
    let current = normaliseDestination(row.destination);
    const seen = new Set<string>([source]);
    let loops = false;

    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const next = destinations.get(current);
      if (next === undefined) break;
      if (seen.has(current)) {
        loops = true;
        break;
      }
      seen.add(current);
      hops.push(current);
      current = next;
      if (current === source) {
        loops = true;
        break;
      }
    }

    if (hops.length > 0) chains.push({ source, hops: [...hops, current], loops });
  }
  return chains;
}

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, "The number of rows must be a whole number.")
    .optional()
});

const WriteBody = z.object({
  /** Absent for a new redirect, present to change an existing one. */
  id: z.string().trim().max(64).optional(),
  source: z
    .string()
    .min(1, "The old address is needed — it is the path people already have.")
    .max(SOURCE_MAX + 32),
  destination: z
    .string()
    .min(1, "A redirect needs somewhere to go, or it would send readers to a blank page.")
    .max(DESTINATION_MAX + 32),
  /**
   * Defaulted TRUE, matching the form on the redirects screen. A permanent redirect is what tells a search
   * engine to forget the old address, which is the usual intent when a page moves.
   */
  permanent: z.boolean().default(true)
});

const DeleteQuery = z.object({ id: z.string().trim().min(1, "Which redirect?").max(64) });

export const GET = route(async (request: NextRequest) => {
  await requireCapability(
    canManageStructure,
    "Redirects need editor access or higher. An administrator can raise yours."
  );

  const query = parseStudioQuery(request, ListQuery);
  const q = query.q ?? "";
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, query.limit ? Number.parseInt(query.limit, 10) : DEFAULT_LIMIT)
  );

  const where =
    q.length > 0
      ? {
          OR: [
            { source: { contains: q, mode: "insensitive" as const } },
            { destination: { contains: q, mode: "insensitive" as const } }
          ]
        }
      : {};

  const [rows, total, all] = await prisma.$transaction([
    prisma.redirect.findMany({
      where,
      // Most-followed first: the rows that matter are the ones people are actually hitting.
      orderBy: [{ hits: "desc" }, { source: "asc" }],
      take: limit
    }),
    prisma.redirect.count({ where }),
    // The whole table, narrowly, for the chain walk. Two short strings per row; a table big enough for
    // this to matter is a table with a different problem.
    prisma.redirect.findMany({ select: { source: true, destination: true } })
  ]);

  return ok({
    items: rows,
    total,
    /** REQUIRED READING for the client: a list that quietly stops is indistinguishable from a short table. */
    truncated: total > rows.length,
    limit,
    chains: describeChains(all),
    /** So a client can show the full address a reader would type. */
    origin: siteUrl()
  });
});

const handleWrite = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageStructure,
    "Changing redirects needs editor access or higher. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, WriteBody);
  const id = body.id ?? "";
  const source = normaliseSource(body.source);
  const destination = normaliseDestination(body.destination);

  if (source.length === 0) throw badRequest("The old address was empty, so nothing has been saved.");
  if (!isUsableSource(source)) {
    throw badRequest(
      "The old address has to be a path on this site, beginning with a slash — “/old-page”, not a whole web address. Nothing has been saved."
    );
  }
  if (!isUsableDestination(destination)) {
    throw badRequest(
      "The new address has to be a path on this site beginning with a slash, or a full address beginning with https://. Nothing has been saved."
    );
  }
  if (destination === source) {
    throw badRequest(
      "The old and the new address are the same. That is an endless loop, which a browser reports as “too many redirects” — the page looks completely broken. Nothing has been saved."
    );
  }

  const existing = await prisma.redirect.findMany({
    select: { id: true, source: true, destination: true }
  });

  const others = new Map<string, string>();
  for (const row of existing) {
    // The row being saved is excluded: its OLD destination must not be what the walk follows.
    if (id.length > 0 && row.id === id) continue;
    others.set(normaliseSource(row.source), normaliseDestination(row.destination));
  }

  if (chainReturnsTo(others, source, destination)) {
    throw badRequest(
      "Saving that would make a chain that comes back to where it started, which a browser reports as “too many redirects”. Follow the chain from the new address and point it somewhere that settles. Nothing has been saved."
    );
  }

  const clash = existing.find(
    (row) => normaliseSource(row.source) === source && (id.length === 0 || row.id !== id)
  );
  if (clash) {
    throw conflict(
      "There is already a redirect for that old address. Change the existing one rather than adding a second — two rows for one address is a coin toss over which one wins."
    );
  }

  const context = buildAuditContext(request, user);

  if (id.length === 0) {
    const created = await mutateWithHistory<{ id: string; source: string; destination: string }>(
      context,
      {
        action: "CREATE",
        entityType: "Redirect",
        entityLabel: `${source} → ${destination}`,
        /**
         * NO REVISION. A redirect is routing configuration, not versioned content: the whole row is two
         * addresses and a flag, and the audit entry this write creates already holds all three. A revision
         * would be a second copy of it.
         */
        revise: false
      },
      async (tx) => tx.redirect.create({ data: { source, destination, permanent: body.permanent } })
    );
    return ok({
      redirect: created,
      created: true,
      message: `Anyone following ${source} is sent to ${destination} from now on.`
    });
  }

  const before = found(await prisma.redirect.findUnique({ where: { id } }), "That redirect");

  const saved = await mutateWithHistory<{ id: string; source: string; destination: string }>(
    context,
    {
      action: "UPDATE",
      entityType: "Redirect",
      entityLabel: `${source} → ${destination}`,
      revise: false,
      before
    },
    async (tx) =>
      tx.redirect.update({ where: { id }, data: { source, destination, permanent: body.permanent } })
  );

  return ok({ redirect: saved, created: false, message: "The redirect has been changed." });
});

export const POST = handleWrite;
export const PATCH = handleWrite;
export const PUT = handleWrite;

export const DELETE = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageStructure,
    "Changing redirects needs editor access or higher. An administrator can raise yours."
  );

  const { id } = parseStudioQuery(request, DeleteQuery);

  const before = found(await prisma.redirect.findUnique({ where: { id } }), "That redirect");

  /**
   * A HARD DELETE, and it is the right one here.
   *
   * `Redirect` carries no `deletedAt`: it is routing configuration rather than content, and there is
   * nothing to recover — the whole row is in the audit entry this write creates. The consequence is worth
   * saying in the response, because it is immediate: the old address answers "page not found" again.
   */
  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "DELETE",
      entityType: "Redirect",
      entityLabel: `${before.source} → ${before.destination}`,
      revise: false,
      before
    },
    async (tx) => tx.redirect.delete({ where: { id } })
  );

  return ok({
    deleted: true,
    message: `${before.source} answers “page not found” again straight away. The addresses are kept in the audit log if you need to put it back.`
  });
});
