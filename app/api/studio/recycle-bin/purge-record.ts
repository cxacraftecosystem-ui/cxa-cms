import "server-only";
// `ListObjectsV2Command` is the ONE S3 command constructed outside lib/storage/client.ts, and the reason
// is spelled out at `sweepDerivatives` below. It runs on that module's shared client via its exported
// `s3()` / `bucket()`, so it still uses one connection pool and one credential resolver.
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { removeDocument, type SearchEntityType } from "@/lib/search/index";
import { deleteObjects, listObjectKeys, storageAvailable } from "@/lib/storage/client";
import { variantPrefix } from "@/lib/storage/keys";

import { metaFor, type BinType } from "./kinds";

/**
 * PERMANENT DELETION — the one operation in this product that cannot be undone.
 *
 * Shared by `purge/route.ts` (the API) and by the Server Action on `app/studio/recycle-bin/page.tsx`, so
 * the two cannot drift into two different ideas of what "delete for good" destroys. Everything here
 * REPORTS rather than throws: a route turns a refusal into an HTTP status and the screen turns the same
 * refusal into a sentence, and neither has to reverse-engineer the other's error class.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FOUR RULES, AND EACH ONE IS A DIFFERENT WAY THIS GOES WRONG.
 *
 * 1. MASTER ADMIN ONLY — enforced by the CALLERS, because both of them have their own way of refusing
 *    (`requireCapability` throws an `ApiError`; `requireStudioCapability` renders the forbidden screen).
 *    See the note on `canPurge` at the bottom of this comment.
 *
 * 2. ⚠ THE BYTES GO BEFORE THE ROW, AND THE ORDER IS THE WHOLE DESIGN. It is the same ordering
 *    `app/api/cron/purge/route.ts` argues at length, for the same three outcomes:
 *
 *      • bytes gone, row gone         → correct.
 *      • bytes gone, row still here   → an orphan ROW pointing at nothing. Visible, reported, fixable.
 *      • row gone, bytes still there  → an orphan OBJECT nothing references. Invisible, unbilled to any
 *        feature, publicly readable at its URL for ever, and it accumulates. Nobody ever finds it,
 *        because the row was the only thing that knew it existed.
 *
 *    So a failure to remove the bytes ABORTS the row deletion and the record stays in the bin for a
 *    later attempt. The refusal says exactly that, because the natural reading of a failed delete is
 *    "it deleted half of it".
 *
 * 3. ⚠ NOTHING ELSE MAY SILENTLY CHANGE. Read `referencesTo` below before touching any of this: several
 *    of these models are pointed at by OTHER records, and the foreign keys do not fail — they succeed.
 *    `onDelete: SetNull` on nine cover columns means destroying a photograph blanks the picture on a
 *    PUBLISHED page and nothing anywhere says why; `onDelete: Cascade` on six join tables means it
 *    quietly removes itself from albums and galleries, captions and all. A 500 from a foreign key would
 *    at least be visible. This is worse, so it is REFUSED, with the referring records named.
 *
 * 4. AUDIT IT, AND CAPTURE WHAT IT WAS. There is no row left to reference afterwards, so the audit entry
 *    is the only surviving record that this ever existed. It therefore carries the whole row as `before`,
 *    plus every storage key that went with it. `revise: false` — a revision pointing at an entity id that
 *    no longer exists is a dangling reference that confuses the next person to read the history.
 *
 * ⚠ WHY NOT `canPurge`. `lib/permissions.ts` puts `canPurge` at ADMINISTRATOR, alongside `canManageUsers`,
 * and that is right for the automatic window-based purge the cron performs. It is NOT right for this: the
 * same file argues that `canManageStudioAccess` is master-admin because "an administrator runs the site; a
 * master admin decides who is allowed near it", and irreversible destruction of the archive sits on that
 * side of the line for the same reason. An administrator account is the one used every day and therefore
 * the one most likely to be phished; the difference here is between "somebody defaced a page" and
 * "somebody destroyed the only copy". Both callers gate on `isMasterAdmin` directly, which is the named
 * predicate lib/permissions.ts asks call sites to use rather than comparing the role string themselves.
 *
 * ⚠ THERE IS NO "EMPTY THE BIN" HERE, ON PURPOSE. A bulk destroy would run the reference census thirteen
 * times over an unbounded set and then decide, per row, whether to skip or to stop — and the one answer
 * an administrator could not act on is "41 of 260 were kept, for four different reasons". Single-record
 * deletion, each with its own typed confirmation, is the requirement. If a bulk action is ever wanted it
 * belongs in its OWN route with a stronger ceremony than this one, not as a flag on this path.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** How many referring records are named in a refusal before it stops listing them. */
const NAMED_REFERENCES = 6;

// The sweep's own cap now lives with the sweep, in lib/storage/client.ts — see `listObjectKeys`.

export type PurgeCode =
  | "unknown_type"
  | "not_found"
  | "name_mismatch"
  | "in_use"
  | "protected"
  | "storage_unavailable"
  | "storage_failed"
  | "failed";

export interface PurgeRefusal {
  ok: false;
  code: PurgeCode;
  /** The HTTP status an API caller should answer with. Kept here so both callers agree on it. */
  status: number;
  /** A complete sentence a non-technical reader can act on. Every one of them says nothing was changed. */
  message: string;
}

export interface PurgeSuccess {
  ok: true;
  label: string;
  /** Objects actually removed from storage — the original, its derivatives, or a file's versions. */
  storedFilesRemoved: number;
  /** Owned child records destroyed alongside, already phrased. Empty when there were none. */
  alsoRemoved: string[];
  message: string;
}

export type PurgeOutcome = PurgeSuccess | PurgeRefusal;

function refuse(code: PurgeCode, status: number, message: string): PurgeRefusal {
  return { ok: false, code, status, message };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading the row
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface BinRowSnapshot {
  /** What it is called. Never empty — it is the string the confirmation has to echo. */
  label: string;
  /**
   * The whole row, for the audit entry.
   *
   * NOT a select of a few columns. In a moment this row is the only thing that will have known what the
   * record contained, and "we kept the title and the id" is not a record of anything. `redact()` in
   * lib/audit.ts strips the key names that must never be logged before it is written.
   */
  row: Record<string, unknown>;
  /**
   * True only for a `Page` locked against deletion; false for everything else.
   *
   * Read HERE rather than by poking at `row` afterwards, so the switch below stays the single place that
   * knows which model has which column. `row.isSystem` at a call site would type-check for all thirteen
   * kinds, including the twelve that have no such column.
   */
  isSystem: boolean;
}

const binWhere = (id: string) => ({ id, deletedAt: { not: null } });

/**
 * Read the row, and confirm it really is in the bin.
 *
 * ⚠ ONE EXPLICIT BRANCH PER MODEL, the same discipline as `restore/route.ts`. Indexing a Prisma client by
 * a string would type-check nothing at all and would happily read — and later destroy — from a table
 * nobody meant to include. This way a kind with no branch simply cannot be destroyed.
 */
async function readBinRow(type: BinType, id: string): Promise<BinRowSnapshot | null> {
  const where = binWhere(id);
  switch (type) {
    case "Page": {
      const row = await prisma.page.findFirst({ where });
      return row ? { label: row.title, row, isSystem: row.isSystem } : null;
    }
    case "Post": {
      const row = await prisma.post.findFirst({ where });
      return row ? { label: row.title, row, isSystem: false } : null;
    }
    case "Person": {
      const row = await prisma.person.findFirst({ where });
      return row ? { label: row.name, row, isSystem: false } : null;
    }
    case "Project": {
      const row = await prisma.project.findFirst({ where });
      return row ? { label: row.title, row, isSystem: false } : null;
    }
    case "Publication": {
      const row = await prisma.publication.findFirst({ where });
      return row ? { label: row.title, row, isSystem: false } : null;
    }
    case "ResearchArea": {
      const row = await prisma.researchArea.findFirst({ where });
      return row ? { label: row.title, row, isSystem: false } : null;
    }
    case "CoeEvent": {
      const row = await prisma.coeEvent.findFirst({ where });
      return row ? { label: row.title, row, isSystem: false } : null;
    }
    case "Craft": {
      const row = await prisma.craft.findFirst({ where });
      return row ? { label: row.name, row, isSystem: false } : null;
    }
    case "GalleryAlbum": {
      const row = await prisma.galleryAlbum.findFirst({ where });
      return row ? { label: row.title, row, isSystem: false } : null;
    }
    case "Partner": {
      const row = await prisma.partner.findFirst({ where });
      return row ? { label: row.name, row, isSystem: false } : null;
    }
    case "MediaAsset": {
      const row = await prisma.mediaAsset.findFirst({ where });
      return row ? { label: row.fileName, row, isSystem: false } : null;
    }
    case "FileAsset": {
      const row = await prisma.fileAsset.findFirst({ where });
      return row ? { label: row.title, row, isSystem: false } : null;
    }
    case "ContactSubmission": {
      const row = await prisma.contactSubmission.findFirst({ where });
      return row ? { label: row.name, row, isSystem: false } : null;
    }
    default:
      return null;
  }
}

/** A real DELETE. Same discipline as `readBinRow`. */
async function deleteRow(
  tx: TxClient,
  type: BinType,
  id: string
): Promise<({ id: string } & Record<string, unknown>) | null> {
  switch (type) {
    case "Page":
      return tx.page.delete({ where: { id } });
    case "Post":
      return tx.post.delete({ where: { id } });
    case "Person":
      return tx.person.delete({ where: { id } });
    case "Project":
      return tx.project.delete({ where: { id } });
    case "Publication":
      return tx.publication.delete({ where: { id } });
    case "ResearchArea":
      return tx.researchArea.delete({ where: { id } });
    case "CoeEvent":
      return tx.coeEvent.delete({ where: { id } });
    case "Craft":
      return tx.craft.delete({ where: { id } });
    case "GalleryAlbum":
      return tx.galleryAlbum.delete({ where: { id } });
    case "Partner":
      return tx.partner.delete({ where: { id } });
    case "MediaAsset":
      return tx.mediaAsset.delete({ where: { id } });
    case "FileAsset":
      return tx.fileAsset.delete({ where: { id } });
    case "ContactSubmission":
      return tx.contactSubmission.delete({ where: { id } });
    default:
      return null;
  }
}

/**
 * The kind's entry in the search index, or null for the three that have none.
 *
 * The same three exceptions `restore/route.ts` lists and for the same reasons: a media file and a partner
 * are referenced BY content rather than being content, and an enquiry is private correspondence that must
 * never be findable from a search box.
 *
 * A soft delete already withdrew the document (`syncSearchDocument` in lib/studio/crud.ts removes rather
 * than unpublishes when `deletedAt` is set), so the removal below should always be a no-op. It is done
 * anyway because this is the last moment at which anybody could: after the row is gone there is no id to
 * look the stale document up by, and `SearchDocument` has no foreign key to cascade from — it addresses
 * its subject by `(entityType, entityId)` strings.
 */
function searchTypeFor(type: BinType): SearchEntityType | null {
  switch (type) {
    case "Page":
      return "page";
    case "Post":
      return "post";
    case "Person":
      return "person";
    case "Project":
      return "project";
    case "Publication":
      return "publication";
    case "ResearchArea":
      return "research-area";
    case "CoeEvent":
      return "event";
    case "Craft":
      return "craft";
    case "GalleryAlbum":
      return "album";
    case "FileAsset":
      return "file";
    case "MediaAsset":
    case "Partner":
    case "ContactSubmission":
      return null;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ Referential integrity — what ELSE points at this row
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One record that still points at the row somebody is trying to destroy. */
interface Reference {
  /** The referring record's own name, so the refusal is actionable rather than a number. */
  label: string;
  /** What the reference IS, in an editor's words: "album cover", "speaker at an event". */
  role: string;
}

/** `findMany` results reduced to `Reference`s. A referring row whose own name is missing still counts. */
function refs(role: string, rows: readonly (string | null | undefined)[]): Reference[] {
  return rows.map((label) => ({ role, label: label && label.length > 0 ? label : "(untitled)" }));
}

/**
 * Everything that would be changed or destroyed BY somebody else's row if this one went.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE FOREIGN KEYS DO NOT THROW. THAT IS THE PROBLEM.
 *
 * Every incoming relation in prisma/schema.prisma is declared `SetNull` or `Cascade`; not one is
 * `Restrict`. So a hard delete NEVER fails with a foreign-key error — it succeeds, and takes something
 * with it. The two shapes, and what each one actually does:
 *
 *   • `SetNull` on the referring column. Nine cover/photo columns point at `MediaAsset` this way
 *     (`Page.seoImageId`, `Person.photoId`, `Project.coverId`, `Post.coverId`, `CoeEvent.coverId`,
 *     `Craft.coverId`, `GalleryAlbum.coverId`, `ResearchArea.coverId`, `Partner.logoId`), plus
 *     `User.avatarId`; and `ResearchArea` is pointed at the same way by `Project.researchAreaId` and
 *     `Publication.researchAreaId`. Destroying the target BLANKS THOSE COLUMNS on rows that may be
 *     published this minute. The page still renders; the picture is simply gone, and nothing anywhere
 *     records why. The schema's own note on those back-relations says the direction is deliberate —
 *     "removing a photograph must never cascade into deleting the article that used it" — which is
 *     right, and is exactly why the check has to live here instead.
 *
 *   • `Cascade` on a JOIN table. `GalleryItem`, `ProjectMedia`, `EventMedia`, `CraftMedia` and
 *     `MediaCollectionItem` all cascade from `MediaAsset`; `ProjectFile` from `FileAsset`;
 *     `ProjectMember`, `PublicationAuthor` and `EventSpeaker` from `Person`; `ProjectPartner` from
 *     `Partner`. Destroying the target silently removes it from every album, gallery, team list and
 *     author list it was in — and `GalleryItem` carries a CAPTION, which is editorial content that has
 *     no other copy.
 *
 * So: this is REFUSED, and the refusal names the records. "This image is still used by 3 records" with
 * the three named is something an editor can act on in a minute; a blank cover discovered a fortnight
 * later is not.
 *
 * A referring record that is ITSELF in the recycle bin does not count — it is already invisible
 * everywhere, and blocking on it would make two deleted records unable to be destroyed except in an
 * order nobody could work out. `deletedAt: null` on every query below is that rule.
 *
 * ⚠ THE REMAINING KINDS RETURN NOTHING, AND THAT IS A FINDING RATHER THAN AN OMISSION. `Page`, `Post`,
 * `Project`, `Publication`, `CoeEvent`, `Craft`, `GalleryAlbum` and `ContactSubmission` are pointed at
 * ONLY by rows they own — a page's blocks, an event's agenda, an album's items — which are part of the
 * record and are supposed to go with it. `alsoRemoved` counts those out loud instead.
 *
 * This census is taken once, immediately before the deletion, so a reference added in the milliseconds
 * afterwards would not be seen. That window is not closed by re-reading inside the transaction either
 * (Prisma's default isolation would still not see an uncommitted write), and closing it properly would
 * mean locking eleven tables against a deliberate, master-admin-only, once-a-quarter operation. The
 * honest mitigation is the audit entry, which records the census that was taken — so "why did this cover
 * go blank" has an answer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function referencesTo(type: BinType, id: string): Promise<Reference[]> {
  const take = NAMED_REFERENCES + 1;
  const live = { deletedAt: null };

  switch (type) {
    case "MediaAsset": {
      const [
        pages,
        people,
        projects,
        posts,
        events,
        crafts,
        albums,
        areas,
        partners,
        users,
        albumItems,
        projectGallery,
        eventGallery,
        craftGallery,
        collections
      ] = await Promise.all([
        prisma.page.findMany({ where: { seoImageId: id, ...live }, take, select: { title: true } }),
        prisma.person.findMany({ where: { photoId: id, ...live }, take, select: { name: true } }),
        prisma.project.findMany({ where: { coverId: id, ...live }, take, select: { title: true } }),
        prisma.post.findMany({ where: { coverId: id, ...live }, take, select: { title: true } }),
        prisma.coeEvent.findMany({ where: { coverId: id, ...live }, take, select: { title: true } }),
        prisma.craft.findMany({ where: { coverId: id, ...live }, take, select: { name: true } }),
        prisma.galleryAlbum.findMany({ where: { coverId: id, ...live }, take, select: { title: true } }),
        prisma.researchArea.findMany({ where: { coverId: id, ...live }, take, select: { title: true } }),
        prisma.partner.findMany({ where: { logoId: id, ...live }, take, select: { name: true } }),
        prisma.user.findMany({ where: { avatarId: id, ...live }, take, select: { email: true } }),
        prisma.galleryItem.findMany({
          where: { assetId: id, album: live },
          take,
          select: { album: { select: { title: true } } }
        }),
        prisma.projectMedia.findMany({
          where: { assetId: id, project: live },
          take,
          select: { project: { select: { title: true } } }
        }),
        prisma.eventMedia.findMany({
          where: { assetId: id, event: live },
          take,
          select: { event: { select: { title: true } } }
        }),
        prisma.craftMedia.findMany({
          where: { assetId: id, craft: live },
          take,
          select: { craft: { select: { name: true } } }
        }),
        // `MediaCollection` has no `deletedAt` — a collection cannot be soft-deleted, so every membership
        // row counts.
        prisma.mediaCollectionItem.findMany({
          where: { assetId: id },
          take,
          select: { collection: { select: { name: true } } }
        })
      ]);

      return [
        ...refs("social preview image of a page", pages.map((row) => row.title)),
        ...refs("profile photograph", people.map((row) => row.name)),
        ...refs("cover of a project", projects.map((row) => row.title)),
        ...refs("cover of a news article", posts.map((row) => row.title)),
        ...refs("cover of an event", events.map((row) => row.title)),
        ...refs("cover of a craft record", crafts.map((row) => row.name)),
        ...refs("cover of an album", albums.map((row) => row.title)),
        ...refs("cover of a research area", areas.map((row) => row.title)),
        ...refs("logo of a partner", partners.map((row) => row.name)),
        ...refs("somebody's profile picture", users.map((row) => row.email)),
        ...refs("picture in an album", albumItems.map((row) => row.album.title)),
        ...refs("picture in a project's gallery", projectGallery.map((row) => row.project.title)),
        ...refs("picture in an event's gallery", eventGallery.map((row) => row.event.title)),
        ...refs("picture in a craft record's gallery", craftGallery.map((row) => row.craft.name)),
        ...refs("member of a media collection", collections.map((row) => row.collection.name))
      ];
    }

    case "FileAsset": {
      // `ProjectFile` cascades, so destroying the file would quietly take the download off a project
      // page. `FileVersion` also cascades but is OWNED by the file — it is counted in `alsoRemoved`.
      const projectFiles = await prisma.projectFile.findMany({
        where: { fileId: id, project: live },
        take,
        select: { project: { select: { title: true } } }
      });
      return refs("download listed on a project", projectFiles.map((row) => row.project.title));
    }

    case "Person": {
      const [members, authors, speakers] = await Promise.all([
        prisma.projectMember.findMany({
          where: { personId: id, project: live },
          take,
          select: { project: { select: { title: true } } }
        }),
        prisma.publicationAuthor.findMany({
          where: { personId: id, publication: live },
          take,
          select: { publication: { select: { title: true } } }
        }),
        prisma.eventSpeaker.findMany({
          where: { personId: id, event: live },
          take,
          select: { event: { select: { title: true } } }
        })
      ]);
      return [
        ...refs("member of a project team", members.map((row) => row.project.title)),
        // The publication's `authorLine` is a stored string and survives, so the CITATION would still
        // read correctly — but the link from the publication to this person would be gone, and with it
        // every "publications by" list.
        ...refs("linked author of a publication", authors.map((row) => row.publication.title)),
        ...refs("speaker at an event", speakers.map((row) => row.event.title))
      ];
    }

    case "ResearchArea": {
      // Both of these are `SetNull`: the project or publication survives, un-filed, with nothing on
      // screen to say which area it used to belong to.
      const [projects, publications] = await Promise.all([
        prisma.project.findMany({ where: { researchAreaId: id, ...live }, take, select: { title: true } }),
        prisma.publication.findMany({
          where: { researchAreaId: id, ...live },
          take,
          select: { title: true }
        })
      ]);
      return [
        ...refs("project filed under it", projects.map((row) => row.title)),
        ...refs("publication filed under it", publications.map((row) => row.title))
      ];
    }

    case "Partner": {
      const partnerships = await prisma.projectPartner.findMany({
        where: { partnerId: id, project: live },
        take,
        select: { project: { select: { title: true } } }
      });
      return refs("partner credited on a project", partnerships.map((row) => row.project.title));
    }

    /**
     * NOTHING OUTSIDE THESE RECORDS POINTS AT THEM, and this is the complete list rather than a default
     * branch that swallowed a model somebody added later. Each is referenced only by rows it owns, which
     * `alsoRemoved` reports:
     *
     *   • Page        → `PageSection` (its blocks).
     *   • Post        → `PostTag`, and the implicit `RelatedPosts` join.
     *   • Project     → members, milestones, gallery links, file links, partner links, FAQs, and the
     *                   implicit join to publications. Every one is a LINK; the person, file, partner
     *                   and publication on the far side all survive.
     *   • Publication → `PublicationAuthor` links.
     *   • CoeEvent    → agenda, speakers, gallery links, tags — and `EventRegistration`, which is not a
     *                   link but real personal data. Named out loud in `alsoRemoved` for that reason.
     *   • Craft       → `CraftMedia` links.
     *   • GalleryAlbum→ `GalleryItem` rows, which carry captions.
     *   • ContactSubmission → nothing at all.
     */
    case "Page":
    case "Post":
    case "Project":
    case "Publication":
    case "CoeEvent":
    case "Craft":
    case "GalleryAlbum":
    case "ContactSubmission":
      return [];
    default:
      return [];
  }
}

/** "3 records: “About” (cover of a page), …" — the middle of the refusal sentence. */
function describeReferences(references: readonly Reference[]): string {
  const named = references.slice(0, NAMED_REFERENCES);
  const listed = named.map((entry) => `“${entry.label}” (${entry.role})`).join(", ");
  const count = references.length;
  const total =
    count > NAMED_REFERENCES
      ? `more than ${NAMED_REFERENCES} records`
      : count === 1
        ? "1 record"
        : `${count} records`;
  return `${total}: ${listed}${count > NAMED_REFERENCES ? ", and others" : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What goes with it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * The rows this record OWNS, which the cascade will take with it.
 *
 * Not a refusal — these are part of the record. They are counted so that the confirmation says what is
 * actually being destroyed: "and its 240 registrations" is a materially different decision from "and its
 * 3 blocks", and an album's captions are editorial writing that exists nowhere else.
 */
async function ownedChildren(type: BinType, id: string): Promise<string[]> {
  switch (type) {
    case "Page": {
      const blocks = await prisma.pageSection.count({ where: { pageId: id } });
      return blocks > 0 ? [plural(blocks, "block", "blocks")] : [];
    }
    case "Project": {
      const [members, milestones, faqs] = await Promise.all([
        prisma.projectMember.count({ where: { projectId: id } }),
        prisma.projectMilestone.count({ where: { projectId: id } }),
        prisma.projectFaq.count({ where: { projectId: id } })
      ]);
      const parts: string[] = [];
      // The people, files, partners and publications on the far side of a project's links all survive —
      // only the links go. Milestones and FAQs are written on the project itself and have no other copy.
      if (members > 0) parts.push(`${plural(members, "team link", "team links")} (the people stay)`);
      if (milestones > 0) parts.push(plural(milestones, "milestone", "milestones"));
      if (faqs > 0) parts.push(plural(faqs, "question and answer", "questions and answers"));
      return parts;
    }
    case "Publication": {
      const authors = await prisma.publicationAuthor.count({ where: { publicationId: id } });
      return authors > 0
        ? [`${plural(authors, "linked author", "linked authors")} (the people stay)`]
        : [];
    }
    case "CoeEvent": {
      const [registrations, agenda, speakers] = await Promise.all([
        prisma.eventRegistration.count({ where: { eventId: id } }),
        prisma.eventAgendaItem.count({ where: { eventId: id } }),
        prisma.eventSpeaker.count({ where: { eventId: id } })
      ]);
      const parts: string[] = [];
      // ⚠ NAMED FIRST AND IN FULL. Registrations are people's names, email addresses and issued
      // certificate codes. Destroying an event destroys the only record that anybody attended it.
      if (registrations > 0) {
        parts.push(
          `${plural(registrations, "registration", "registrations")} — the attendees' names, email ` +
            "addresses and any certificates issued to them"
        );
      }
      if (agenda > 0) parts.push(plural(agenda, "agenda item", "agenda items"));
      if (speakers > 0) parts.push(`${plural(speakers, "speaker link", "speaker links")} (the people stay)`);
      return parts;
    }
    case "GalleryAlbum": {
      const items = await prisma.galleryItem.count({ where: { albumId: id } });
      return items > 0
        ? [
            `${plural(items, "item", "items")} and their captions (the pictures themselves stay in the ` +
              "media library)"
          ]
        : [];
    }
    case "Craft": {
      const images = await prisma.craftMedia.count({ where: { craftId: id } });
      return images > 0
        ? [`${plural(images, "gallery link", "gallery links")} (the pictures stay in the media library)`]
        : [];
    }
    case "FileAsset": {
      const versions = await prisma.fileVersion.count({ where: { fileId: id } });
      return versions > 0 ? [plural(versions, "stored version", "stored versions")] : [];
    }
    case "MediaAsset": {
      // Derivatives are counted as storage rather than as records — see `storageKeysFor`.
      return [];
    }
    case "Post":
    case "Person":
    case "ResearchArea":
    case "Partner":
    case "ContactSubmission":
      return [];
    default:
      return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ The bytes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every derivative under an asset's variant prefix, whether or not a row remembers it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHY THE `MediaVariant` ROWS ARE NOT ENOUGH.
 *
 * `buildVariantKey` in lib/storage/keys.ts puts every derivative under `variantPrefix(originalKey)`
 * precisely so that "delete every derivative of this asset" is a prefix operation. The rows are the
 * normal way to find them — but they are written AFTER the objects are uploaded, and lib/storage/
 * derivatives.ts is explicit that a run can partly fail. A derivative whose row was never written, or
 * was lost to a rolled-back transaction, is invisible to the database and stays in the bucket for ever
 * at a publicly readable URL, with the row that would have named it now deleted. That is the exact
 * failure this whole ordering exists to prevent, and the row list cannot see it.
 *
 * So the prefix is swept as well and the two sets are unioned. `deleteObjects` treats an already-absent
 * key as a success, so a key in both lists costs nothing.
 *
 * ⚠ A FAILED SWEEP IS A FAILED DELETE, not an empty one. If storage cannot be listed, the derivative set
 * is unknown; deleting what we happen to know about and then removing the row would leave exactly the
 * orphans this exists to prevent. It throws, and the caller keeps the row.
 *
 * (The listing itself is `listObjectKeys` in lib/storage/client.ts, where it belongs — this file
 * briefly built its own S3 command because no listing helper existed. The nightly cron purge in
 * app/api/cron/purge/route.ts had the same blind spot and did not sweep at all; both now call the one
 * implementation, so neither can drift from the other's idea of what a complete delete is.)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function sweepDerivatives(originalKey: string): Promise<string[]> {
  // The listing now lives in lib/storage/client.ts as `listObjectKeys`, so this and the nightly cron
  // in app/api/cron/purge/route.ts share ONE implementation. They had grown separate answers to the
  // same problem and only one of them was right — the cron did not sweep at all. Its throw-rather-
  // than-truncate behaviour and its cap are documented there.
  return listObjectKeys(variantPrefix(originalKey));
}

/**
 * Every storage object this row owns.
 *
 * A kind with no bytes returns an empty list and never touches storage at all — a deployment with no
 * object store must still be able to destroy a deleted page.
 */
async function storageKeysFor(type: BinType, id: string): Promise<string[]> {
  if (type === "MediaAsset") {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id },
      select: { objectKey: true, variants: { select: { objectKey: true } } }
    });
    if (!asset) return [];
    const known = [asset.objectKey, ...asset.variants.map((variant) => variant.objectKey)];
    const swept = await sweepDerivatives(asset.objectKey);
    return [...new Set([...known, ...swept])];
  }

  if (type === "FileAsset") {
    // Each `FileVersion` is an independent upload with its own random key, so there is no shared prefix
    // to sweep here — the version rows are the only record of them, which is precisely why the row is
    // never deleted before its objects are.
    const file = await prisma.fileAsset.findUnique({
      where: { id },
      select: { versions: { select: { objectKey: true } } }
    });
    if (!file) return [];
    return [...new Set(file.versions.map((version) => version.objectKey))];
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The operation
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface PurgeRequest {
  type: BinType;
  id: string;
  /** The record's own name, typed or echoed back. See the ceremony note below. */
  confirm: string;
}

/**
 * Destroy one record from the recycle bin, for good.
 *
 * The caller has already checked that the person is a master admin. Everything else is here.
 */
export async function purgeRecord(
  context: AuditContext,
  request: PurgeRequest
): Promise<PurgeOutcome> {
  const { type, id } = request;
  const meta = metaFor(type);
  const noun = meta?.singular ?? "record";

  const found = await readBinRow(type, id);
  if (!found) {
    // Deliberately not lib/api.ts's `notFound()`: its sentence ends "it may have been deleted", which on
    // this screen is exactly what the reader was trying to do and reads as a contradiction.
    return refuse(
      "not_found",
      404,
      "That item is not in the recycle bin. Somebody may have restored it or removed it for good while " +
        "your screen was open. Nothing has been changed."
    );
  }

  const label = found.label.trim().length > 0 ? found.label.trim() : `${type} ${id}`;

  /**
   * THE CONFIRMATION.
   *
   * The record's own name, sent back. This is the only irreversible operation in the studio, and it is
   * the one guard between a mis-scripted loop — or a mis-aimed click — and a fortnight of work. Echoing
   * the name proves the caller was looking at the record it is asking to destroy.
   *
   * Case and surrounding space are forgiven: the ceremony is what makes this a decision rather than a
   * reflex, and somebody who typed the right name with a capital letter has already made it.
   */
  if (request.confirm.trim().toLowerCase() !== label.toLowerCase()) {
    return refuse(
      "name_mismatch",
      400,
      `Nothing has been deleted. To delete this ${noun} for good, type its name back exactly as it is ` +
        `stored: “${label}”.`
    );
  }

  /**
   * ⚠ A `Page` MARKED `isSystem` IS NEVER DESTROYED.
   *
   * The schema's own note: "Locks a page against deletion in the CMS. Set on structural pages (home,
   * about, contact) whose route is referenced by the code." Such a page should never have reached the bin
   * at all — but if one has, destroying it removes a page the site itself links to, and no restore can
   * bring it back. Restoring it is the answer, and the refusal says so.
   */
  if (found.isSystem) {
    return refuse(
      "protected",
      409,
      `“${label}” is a structural page that the site itself links to, so it cannot be deleted for good. ` +
        "Restore it instead — a link somewhere on the site points at its address, and nothing could put " +
        "it back. Nothing has been changed."
    );
  }

  // ── ⚠ REFERENTIAL INTEGRITY. See `referencesTo`: none of these foreign keys throws. ──────────────
  const references = await referencesTo(type, id);
  if (references.length > 0) {
    return refuse(
      "in_use",
      409,
      `“${label}” is still used by ${describeReferences(references)}. Deleting it would not fail — it ` +
        "would quietly blank those, on pages that may be live right now, with nothing to say why. So " +
        "nothing has been changed. Take it out of those records first, or leave it in the recycle bin, " +
        "where it does no harm."
    );
  }

  const alsoRemoved = await ownedChildren(type, id);

  // ── ⚠ BYTES FIRST. See the header for why the order is not negotiable. ───────────────────────────
  let keys: string[] = [];
  if (type === "MediaAsset" || type === "FileAsset") {
    if (!storageAvailable()) {
      return refuse(
        "storage_unavailable",
        503,
        `The file store is not set up on this installation, so this ${noun}'s stored files cannot be ` +
          "removed — and removing the record on its own would leave files that nothing points at and " +
          "nobody could ever find. Nothing has been changed, and restoring still works."
      );
    }

    try {
      keys = await storageKeysFor(type, id);
    } catch (thrown) {
      // Almost always the derivative sweep. The set of objects is unknown, so the row must stay.
      console.error("[recycle-bin] could not list stored objects for", type, id, thrown);
      return refuse(
        "storage_failed",
        409,
        "The file store could not be read, so there is no way to be sure which stored files belong to " +
          `“${label}”. The record has been KEPT rather than risk leaving files behind that nothing ` +
          "points at. Nothing has been lost — try again, or ask whoever looks after storage."
      );
    }

    if (keys.length > 0) {
      const outcome = await deleteObjects(keys);
      if (outcome.failed.length > 0) {
        console.error("[recycle-bin] could not delete stored objects for", type, id, outcome.failed);
        return refuse(
          "storage_failed",
          409,
          `${outcome.failed.length} of this ${noun}'s ${keys.length} stored ` +
            `${keys.length === 1 ? "file" : "files"} could not be removed, so the record was KEPT rather ` +
            "than leaving files behind that nothing points at. Nothing has been lost — try again, or ask " +
            "whoever looks after storage."
        );
      }
    }
  }

  // ── The row, the search document and the audit entry, in one transaction ─────────────────────────
  const searchType = searchTypeFor(type);
  try {
    await mutateWithHistory<{ id: string }>(
      context,
      {
        action: "PURGE",
        entityType: type,
        entityLabel: label,
        /**
         * NO REVISION. There is nothing left to be a revision OF, and a revision row pointing at an
         * entity id that no longer exists is a dangling reference that will mislead the next person who
         * reads the history.
         */
        revise: false,
        /**
         * WHAT IT WAS. This entry is now the only surviving record that this record ever existed, so it
         * carries the whole row, every storage key that went with it, and the reference census that was
         * taken (empty, by definition — it is why the deletion was allowed) so that a later question
         * about a blank cover has an answer.
         */
        before: {
          record: found.row,
          storedObjects: keys,
          storedFiles: keys.length,
          alsoRemoved,
          referencesAtDeletion: 0
        }
      },
      async (tx) => {
        const deleted = await deleteRow(tx, type, id);
        // Throwing inside the transaction rolls the audit entry back too, which is the property
        // lib/audit.ts exists to provide.
        if (!deleted) throw new Error(`No permanent delete is defined for ${type}.`);
        // Should already be a no-op — the soft delete withdrew it. See `searchTypeFor`.
        if (searchType) await removeDocument(tx, searchType, id);
        return deleted;
      }
    );
  } catch (thrown) {
    /**
     * ⚠ THE BYTES ARE ALREADY GONE. This is the recoverable direction — a row that points at nothing is
     * visible in the studio and can be dealt with — but it must be reported loudly rather than as a
     * generic failure, because the record now renders as a broken image and the reason is not obvious.
     */
    console.error("[recycle-bin] a permanent delete failed after its bytes were removed", type, id, thrown);
    return refuse(
      "failed",
      500,
      keys.length > 0
        ? `The stored files for “${label}” were removed, but the record itself could not be deleted, so ` +
            "it is still in the recycle bin and now points at files that no longer exist. Nothing else " +
            "has been changed. Try again; if it fails a second time, this needs somebody with database " +
            "access."
        : `“${label}” could not be deleted for good and nothing has been changed. This usually means ` +
            "something it refers to changed while the deletion was running. Try again."
    );
  }

  return {
    ok: true,
    label,
    storedFilesRemoved: keys.length,
    alsoRemoved,
    message:
      `“${label}” has been deleted for good` +
      (keys.length > 0
        ? `, along with ${keys.length === 1 ? "its stored file" : `all ${keys.length} of its stored files`}`
        : "") +
      (alsoRemoved.length > 0 ? `, and with it ${alsoRemoved.join(", ")}` : "") +
      ". It cannot be restored, nothing can bring it back, and any address that pointed at it will stop " +
      "working."
  };
}
