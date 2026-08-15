import { ApiError, ok, route } from "@/lib/api";
import { getRevision } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageStructure } from "@/lib/permissions";
import { found } from "@/lib/studio/crud";

/**
 * ONE saved version of a page, with its stored snapshot — the payload the diff is built from.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE SNAPSHOT MUST BE AT THE TOP LEVEL OF THE RESPONSE, UNDER THE KEY `data`.
 *
 * `PageEditor.loadRevision` accepts two shapes — a body that IS the snapshot, or one that wraps it as
 * `{ data: … }` — and it decides between them by looking for a top-level `data` property that is an
 * object. Wrapping this answer as `{ revision: { … } }` would satisfy neither test: the whole envelope
 * would be treated as the snapshot, and `RevisionHistory` would then diff the page against a record whose
 * only field is called "revision". So the revision's columns are spread at the top level and `data` is
 * left exactly where the client looks for it. This is the one thing in this file that is not free to
 * change.
 *
 * THE AUTHOR IS INCLUDED, and separately from `authorId`. The panel names who saved a version
 * ("Version 7 … by Anita Sharma"), and the id alone would send the screen to a second request per row.
 * `Revision.author` is `onDelete: SetNull`, so a version saved by somebody whose account has since been
 * removed answers `null` here and the panel says "author unknown" rather than breaking.
 *
 * A VERSION THAT DOES NOT EXIST IS A 404 WITH A SENTENCE. An empty object would be indistinguishable from
 * a version that stored nothing, and the panel would render a diff claiming every field had been emptied.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; version: string }>;
}

/**
 * The version number from the address.
 *
 * A segment that is not a whole number is refused with a 400 rather than a 404: "there is no version 7"
 * and "“latest” is not a version number" are different problems with different fixes, and a route that
 * answered both the same way would have somebody hunting for a deleted revision that never existed.
 */
function versionFrom(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new ApiError(
      400,
      `A version is a whole number, like 7. “${raw.slice(0, 40)}” could not be read as one.`,
      { code: "bad_request" }
    );
  }
  return Number.parseInt(raw, 10);
}

export const GET = route(async (_request: Request, context: RouteContext) => {
  await requireCapability(
    canManageStructure,
    "A page's version history needs editor access. An administrator can raise yours."
  );

  const { id, version: rawVersion } = await context.params;
  const version = versionFrom(rawVersion);

  // The page is looked up first so a mistyped page id says "that page could not be found" rather than
  // "that version could not be found", which would send a reader looking through a history that is not the
  // one they are on. A page in the recycle bin is readable here, as it is everywhere else in the studio.
  const page = found(
    await prisma.page.findUnique({ where: { id }, select: { id: true, title: true } }),
    "That page"
  );

  const revision = await getRevision("Page", page.id, version);
  if (!revision) {
    throw new ApiError(
      404,
      `There is no version ${version} of “${page.title}”. It may have been removed, or the history may have been opened from a screen that has since gone stale — reload the page to see the versions that do exist.`,
      { code: "not_found" }
    );
  }

  const author = revision.authorId
    ? await prisma.user.findUnique({
        where: { id: revision.authorId },
        // Explicit columns, never the whole row: a user row carries `passwordHash`, `twoFactorSecret` and
        // the recovery codes, and a spread of it here would put all three into a studio response.
        select: { id: true, name: true, email: true }
      })
    : null;

  return ok({
    id: revision.id,
    version: revision.version,
    summary: revision.summary,
    createdAt: revision.createdAt,
    author,
    /** The stored snapshot. Top level, under this key — see the header. */
    data: revision.data
  });
});
