import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, assertSameOrigin, badRequest, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { canRestoreDeleted } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";
import {
  indexDocument,
  searchDocFromAlbum,
  searchDocFromCraft,
  searchDocFromEvent,
  searchDocFromFile,
  searchDocFromPage,
  searchDocFromPerson,
  searchDocFromPost,
  searchDocFromProject,
  searchDocFromPublication,
  searchDocFromResearchArea
} from "@/lib/search/index";
// The bin's ONE list of kinds. See ../kinds.ts: four copies of it was four chances for a kind to be
// listable but not restorable, with nothing to say so until somebody hit the missing branch.
import { BIN_TYPES, isBinType, type BinType } from "../kinds";

/**
 * Putting something back from the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A RESTORE CLEARS `deletedAt` AND NOTHING ELSE. It does NOT republish.
 *
 * A page that was published when it was deleted comes back published; one that was a draft comes back a
 * draft. That is the honest answer, and it is the one that surprises nobody twice: this endpoint undoes a
 * DELETION, not an editorial decision. A restore that also published would put content in front of the
 * public that the person pressing the button did not choose to publish.
 *
 * ⚠ AND IT RE-INDEXES, IN THE SAME TRANSACTION.
 *
 * `lib/search/index.ts` never indexes a soft-deleted row and a delete removes its document, so a restored
 * record is invisible to search until something writes its index row again. Without this the record would be
 * back in the studio, back on the site, reachable by its own address — and absent from the search box. That
 * is the worst kind of restore, because it looks complete.
 *
 * The indexing joins the SAME transaction as the `deletedAt` clear, so a rolled-back restore cannot leave a
 * search result pointing at a record that is still in the bin. `isPublished` is recomputed by the extractor
 * from the row's own state, so a draft comes back indexed as a draft and stays out of public results.
 *
 * ⚠ THREE KINDS ARE NOT SEARCHABLE and are reported rather than silently skipped: media files, partners and
 * enquiries have no entry in the search index at all. `reindexed: false` says so, so nobody spends an
 * afternoon wondering why a restored photograph is not in the search box.
 *
 * `canRestoreDeleted` — administrator, and deliberately stricter than editing. A restore can resurrect
 * content an editor deliberately retired, which is why lib/permissions.ts makes it an administrator's act.
 *
 * Its opposite number, `../purge/route.ts`, is stricter AGAIN — master admin only. The asymmetry is the
 * point: a restore that got the wrong record is undone by deleting it again, and there is no such second
 * chance the other way.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** How many records one request may put back. Bounded, and the refusal says the number. */
const MAX_PER_REQUEST = 50;

const RestoreBody = z.object({
  type: z.string().trim().min(1, "Which kind of record?").max(40),
  /** One id, or several. Both shapes are accepted so a client need not special-case a single row. */
  id: z.string().trim().max(64).optional(),
  ids: z.array(z.string().trim().min(1).max(64)).max(MAX_PER_REQUEST).optional()
});

/**
 * Clear `deletedAt`.
 *
 * ⚠ ONE EXPLICIT BRANCH PER MODEL. Indexing the transaction client by a string would type-check nothing at
 * all and would happily write to a table nobody meant to include; this way a kind with no branch simply
 * cannot be restored, and adding one is a compile-time obligation.
 */
async function clearDeletedAt(
  tx: TxClient,
  type: BinType,
  id: string
): Promise<({ id: string } & Record<string, unknown>) | null> {
  const data = { deletedAt: null };
  switch (type) {
    case "Page":
      return tx.page.update({ where: { id }, data });
    case "Post":
      return tx.post.update({ where: { id }, data });
    case "Person":
      return tx.person.update({ where: { id }, data });
    case "Project":
      return tx.project.update({ where: { id }, data });
    case "Publication":
      return tx.publication.update({ where: { id }, data });
    case "ResearchArea":
      return tx.researchArea.update({ where: { id }, data });
    case "CoeEvent":
      return tx.coeEvent.update({ where: { id }, data });
    case "Craft":
      return tx.craft.update({ where: { id }, data });
    case "GalleryAlbum":
      return tx.galleryAlbum.update({ where: { id }, data });
    case "Partner":
      return tx.partner.update({ where: { id }, data });
    case "MediaAsset":
      return tx.mediaAsset.update({ where: { id }, data });
    case "FileAsset":
      return tx.fileAsset.update({ where: { id }, data });
    case "ContactSubmission":
      return tx.contactSubmission.update({ where: { id }, data });
    default:
      return null;
  }
}

/**
 * Write the restored record's search document, inside the same transaction.
 *
 * Each branch re-reads the row with exactly the columns its extractor needs — the extractors are structural
 * and minimal, so a fuller row is acceptable and a missing column is a runtime error. `now` is passed once
 * so every document in a batch resolves publication state against a single instant rather than drifting
 * across the run.
 *
 * Returns false for a kind the index does not carry. That is a FACT to report, not a failure — see the
 * header.
 */
async function reindexRestored(
  tx: TxClient,
  type: BinType,
  id: string,
  now: Date
): Promise<boolean> {
  switch (type) {
    case "Page": {
      const row = await tx.page.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          navLabel: true,
          seoDescription: true,
          seoNoIndex: true,
          status: true,
          publishedAt: true,
          publishAt: true,
          unpublishAt: true,
          deletedAt: true,
          sections: { select: { isVisible: true, data: true } }
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromPage(row, now));
      return true;
    }
    case "Post": {
      const row = await tx.post.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          subtitle: true,
          excerpt: true,
          body: true,
          mdx: true,
          status: true,
          publishedAt: true,
          publishAt: true,
          unpublishAt: true,
          deletedAt: true,
          category: { select: { name: true } },
          tags: { select: { tag: { select: { name: true } } } }
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromPost(row, now));
      return true;
    }
    case "Person": {
      const row = await tx.person.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          name: true,
          kind: true,
          designation: true,
          department: true,
          bio: true,
          bioRich: true,
          researchInterests: true,
          isVisible: true,
          status: true,
          publishedAt: true,
          deletedAt: true
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromPerson(row, now));
      return true;
    }
    case "Project": {
      const row = await tx.project.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          tagline: true,
          summary: true,
          body: true,
          state: true,
          fundingBody: true,
          status: true,
          publishedAt: true,
          deletedAt: true,
          researchArea: { select: { title: true } }
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromProject(row, now));
      return true;
    }
    case "Publication": {
      const row = await tx.publication.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          kind: true,
          abstract: true,
          authorLine: true,
          venue: true,
          publisher: true,
          year: true,
          doi: true,
          arxivId: true,
          keywords: true,
          status: true,
          publishedAt: true,
          deletedAt: true,
          researchArea: { select: { title: true } }
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromPublication(row, now));
      return true;
    }
    case "ResearchArea": {
      const row = await tx.researchArea.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          summary: true,
          body: true,
          status: true,
          publishedAt: true,
          deletedAt: true
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromResearchArea(row, now));
      return true;
    }
    case "CoeEvent": {
      const row = await tx.coeEvent.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          subtitle: true,
          summary: true,
          body: true,
          mode: true,
          venue: true,
          address: true,
          status: true,
          publishedAt: true,
          deletedAt: true,
          tags: { select: { tag: { select: { name: true } } } }
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromEvent(row, now));
      return true;
    }
    case "Craft": {
      const row = await tx.craft.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          name: true,
          localName: true,
          summary: true,
          body: true,
          originNote: true,
          materials: true,
          techniques: true,
          status: true,
          publishedAt: true,
          deletedAt: true,
          region: { select: { name: true } },
          school: { select: { name: true } }
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromCraft(row, now));
      return true;
    }
    case "GalleryAlbum": {
      const row = await tx.galleryAlbum.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          category: true,
          location: true,
          credit: true,
          tags: true,
          status: true,
          publishedAt: true,
          deletedAt: true,
          items: { select: { caption: true } }
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromAlbum(row, now));
      return true;
    }
    case "FileAsset": {
      const row = await tx.fileAsset.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          category: true,
          isPublic: true,
          expiresAt: true,
          deletedAt: true
        }
      });
      if (!row) return false;
      await indexDocument(tx, searchDocFromFile(row, now));
      return true;
    }
    /**
     * NOT INDEXED, and this is the complete list. A media file, a partner and an enquiry have no document in
     * `SearchDocument`: the first two are referenced by content rather than being content, and an enquiry is
     * private correspondence that must never be findable from a search box.
     */
    case "MediaAsset":
    case "Partner":
    case "ContactSubmission":
      return false;
    default:
      return false;
  }
}

/** The label a restore records, read per kind so the audit entry is not a list of ids. */
async function labelFor(type: BinType, id: string): Promise<string | null> {
  const where = { id, deletedAt: { not: null } };
  switch (type) {
    case "Page": {
      const row = await prisma.page.findFirst({ where, select: { title: true } });
      return row?.title ?? null;
    }
    case "Post": {
      const row = await prisma.post.findFirst({ where, select: { title: true } });
      return row?.title ?? null;
    }
    case "Person": {
      const row = await prisma.person.findFirst({ where, select: { name: true } });
      return row?.name ?? null;
    }
    case "Project": {
      const row = await prisma.project.findFirst({ where, select: { title: true } });
      return row?.title ?? null;
    }
    case "Publication": {
      const row = await prisma.publication.findFirst({ where, select: { title: true } });
      return row?.title ?? null;
    }
    case "ResearchArea": {
      const row = await prisma.researchArea.findFirst({ where, select: { title: true } });
      return row?.title ?? null;
    }
    case "CoeEvent": {
      const row = await prisma.coeEvent.findFirst({ where, select: { title: true } });
      return row?.title ?? null;
    }
    case "Craft": {
      const row = await prisma.craft.findFirst({ where, select: { name: true } });
      return row?.name ?? null;
    }
    case "GalleryAlbum": {
      const row = await prisma.galleryAlbum.findFirst({ where, select: { title: true } });
      return row?.title ?? null;
    }
    case "Partner": {
      const row = await prisma.partner.findFirst({ where, select: { name: true } });
      return row?.name ?? null;
    }
    case "MediaAsset": {
      const row = await prisma.mediaAsset.findFirst({ where, select: { fileName: true } });
      return row?.fileName ?? null;
    }
    case "FileAsset": {
      const row = await prisma.fileAsset.findFirst({ where, select: { title: true } });
      return row?.title ?? null;
    }
    case "ContactSubmission": {
      const row = await prisma.contactSubmission.findFirst({ where, select: { name: true } });
      return row?.name ?? null;
    }
    default:
      return null;
  }
}

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canRestoreDeleted,
    "Restoring something needs administrator access."
  );

  const body = await parseStudioJson(request, RestoreBody);
  if (!isBinType(body.type)) {
    throw badRequest(
      `This does not know how to restore a “${body.type}”, so nothing has been changed. The kinds it handles are: ${BIN_TYPES.join(", ")}.`
    );
  }
  const type: BinType = body.type;

  const ids = [...new Set([...(body.ids ?? []), ...(body.id ? [body.id] : [])])];
  if (ids.length === 0) {
    throw badRequest("No record was named, so nothing has been restored.");
  }
  if (ids.length > MAX_PER_REQUEST) {
    throw badRequest(
      `At most ${MAX_PER_REQUEST} records can be restored in one request, and ${ids.length} were sent. Nothing has been restored.`
    );
  }

  const context = buildAuditContext(request, user);

  const now = new Date();
  const restored: { id: string; label: string; reindexed: boolean }[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const id of ids) {
    const label = await labelFor(type, id);
    if (label === null) {
      /**
       * REPORTED, NOT THROWN. One id that has already been dealt with must not abandon the other
       * forty-nine — and a caller that got a 404 for a batch would have no way to tell which row caused it.
       */
      skipped.push({
        id,
        reason:
          "It is not in the recycle bin. Somebody may have restored it or removed it for good while your screen was open."
      });
      continue;
    }

    try {
      const outcome = await mutateWithHistory<{ id: string; reindexed: boolean }>(
        context,
        {
          action: "RESTORE",
          entityType: type,
          entityLabel: label.trim().length > 0 ? label.trim() : id,
          /**
           * NO REVISION. Nothing about the record's own content changed — only whether it is deleted — so a
           * revision here would be an identical second copy of the state it already had.
           */
          revise: false,
          before: { deletedAt: "set" }
        },
        async (tx) => {
          const row = await clearDeletedAt(tx, type, id);
          // Throwing inside the transaction rolls the audit entry back too, which is the property
          // lib/audit.ts exists to provide.
          if (!row) throw new Error(`No restore is defined for ${type}.`);
          // ⚠ IN THE SAME TRANSACTION. See the header: a rolled-back restore must not leave a search result
          // pointing at a record that is still in the bin.
          const reindexed = await reindexRestored(tx, type, id, now);
          return { ...row, id: row.id, reindexed };
        }
      );
      restored.push({ id, label, reindexed: outcome.reindexed });
    } catch (thrown) {
      console.error("[recycle-bin] a restore failed", type, id, thrown);
      skipped.push({
        id,
        reason:
          "It could not be restored and nothing about it has been changed. This usually means something it referred to has since been deleted too."
      });
    }
  }

  if (restored.length === 0) {
    // Nothing happened, so this answers as a failure rather than a 200 a client would report as success.
    throw new ApiError(
      409,
      skipped[0]?.reason ?? "Nothing was restored.",
      { code: "conflict" }
    );
  }

  const notIndexed = restored.filter((entry) => !entry.reindexed).length;

  return ok({
    restored,
    skipped,
    message:
      `${restored.length === 1 ? "1 record is" : `${restored.length} records are`} back where they were, in the ` +
      "state they were in when they were deleted — if something was published before, it is published again. " +
      (notIndexed > 0
        ? `${notIndexed === restored.length ? "This kind of record is" : `${notIndexed} of them are`} not carried ` +
          "in the site's search index at all, so nothing about them will appear in the search box. That is by " +
          "design rather than a fault. "
        : "They are searchable again. ") +
      (skipped.length > 0
        ? `${skipped.length === 1 ? "1 was" : `${skipped.length} were`} skipped — each one is listed with the reason.`
        : "")
  });
});
