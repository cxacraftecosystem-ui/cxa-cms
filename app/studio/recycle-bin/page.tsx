import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect as navigate } from "next/navigation";
import { CircleCheck, Trash2, TriangleAlert, Undo2 } from "lucide-react";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canPurge, canRestoreDeleted } from "@/lib/permissions";
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { mediaPurgeAfterDays } from "@/lib/env";
import { deleteObjects, storageAvailable } from "@/lib/storage/client";
import { formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";

/**
 * The recycle bin — everything soft-deleted, and the two things that can be done with it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canRestoreDeleted)` IS THE FIRST STATEMENT — administrator only, and deliberately
 * stricter than editing. A restore can resurrect content an editor deliberately retired, which is why
 * lib/permissions.ts makes it an administrator's act; permanent deletion is `canPurge`, the same tier, but
 * it is checked separately so the two can diverge without either becoming the other by accident.
 *
 * THE RECYCLE BIN IS `deletedAt IS NOT NULL`. There is no separate table and no flag to forget: every read
 * path on the public site and in the studio filters it out, so a row in here is already invisible
 * everywhere else (schema header).
 *
 * ⚠ TWO RETENTION RULES, AND THEY ARE NOT THE SAME. `app/api/cron/purge` removes MEDIA FILES and STORED
 * FILES for good once they have been in here longer than the purge window, because those hold bytes that
 * cost money and cannot be left forever. Nothing else is ever removed automatically — a deleted page,
 * article or album stays in here until an administrator removes it. Both facts are stated on screen,
 * because "the recycle bin empties itself" and "the recycle bin never empties" are both wrong and lead to
 * opposite mistakes.
 *
 * ⚠ PERMANENT DELETION OF A FILE DELETES ITS BYTES FIRST, AND THE ORDER IS THE WHOLE DESIGN. Bytes then
 * row:
 *
 *   • bytes gone, row gone         → correct.
 *   • bytes gone, row still here   → a visible orphan, reported and fixable. Recoverable.
 *   • row gone, bytes still there  → an object nothing references, invisible, unbilled to any feature, and
 *     it accumulates forever. Nobody ever finds it.
 *
 * So a failure to delete the bytes ABORTS the row deletion, exactly as the cron does.
 *
 * THE TYPED CONFIRMATION IS ENFORCED IN THE SERVER ACTION, not by a dialog. This screen is a Server
 * Component — making it a client one to borrow `ConfirmProvider`'s `requireTyping` would ship every deleted
 * record's title to the browser and gain nothing, because a form can be submitted by anything. The friction
 * is the same and the check is in the one place that cannot be skipped.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recycle bin"
};

/**
 * How many rows of each kind are listed.
 *
 * Stated on screen when it bites — a list that quietly stops is indistinguishable from a place with only
 * that many records (contract §1.6). One more than the cap is read, so "there are more" is a fact.
 */
const PER_TYPE_LIMIT = 25;

/** The kinds this screen can restore and purge. Each one has a case in both switches below. */
type BinType =
  | "Page"
  | "Post"
  | "Person"
  | "Project"
  | "Publication"
  | "ResearchArea"
  | "CoeEvent"
  | "Craft"
  | "GalleryAlbum"
  | "Partner"
  | "MediaAsset"
  | "FileAsset"
  | "ContactSubmission";

interface BinGroupMeta {
  type: BinType;
  /** Plural, in the words an administrator uses. */
  label: string;
  singular: string;
  /** True where the purge job will eventually remove these on its own. */
  autoPurged: boolean;
}

const GROUPS: readonly BinGroupMeta[] = [
  { type: "Page", label: "Pages", singular: "page", autoPurged: false },
  { type: "Post", label: "News articles", singular: "news article", autoPurged: false },
  { type: "Person", label: "People", singular: "person's profile", autoPurged: false },
  { type: "Project", label: "Projects", singular: "project", autoPurged: false },
  { type: "Publication", label: "Publications", singular: "publication", autoPurged: false },
  { type: "ResearchArea", label: "Research areas", singular: "research area", autoPurged: false },
  { type: "CoeEvent", label: "Events", singular: "event", autoPurged: false },
  { type: "Craft", label: "Craft records", singular: "craft record", autoPurged: false },
  { type: "GalleryAlbum", label: "Gallery albums", singular: "album", autoPurged: false },
  { type: "Partner", label: "Partners", singular: "partner", autoPurged: false },
  { type: "MediaAsset", label: "Media files", singular: "media file", autoPurged: true },
  { type: "FileAsset", label: "Files", singular: "file", autoPurged: true },
  { type: "ContactSubmission", label: "Enquiries", singular: "enquiry", autoPurged: false }
];

function metaFor(type: string): BinGroupMeta | null {
  return GROUPS.find((group) => group.type === type) ?? null;
}

interface BinRow {
  type: BinType;
  id: string;
  /** What the thing is called. Never empty — it is what the typed confirmation asks for. */
  label: string;
  /** A second line: an address, a file size, an email. */
  detail: string;
  deletedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Restoring and purging
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Clear `deletedAt`.
 *
 * ⚠ ONE EXPLICIT BRANCH PER MODEL. Indexing the transaction client by a string would type-check nothing at
 * all and would happily write to a table nobody meant to include; this way a kind with no branch simply
 * cannot be restored, and adding one is a compile-time obligation.
 *
 * ⚠ RESTORING DOES NOT REPUBLISH. Only `deletedAt` is cleared, so a page that was published when it was
 * deleted comes back published and one that was a draft comes back a draft. That is the honest answer:
 * this screen undoes a deletion, not an editorial decision.
 */
async function restoreRow(
  tx: TxClient,
  type: string,
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

/** A real DELETE. Same discipline as `restoreRow`. */
async function purgeRow(
  tx: TxClient,
  type: string,
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

/** Every stored object a row owns, so a purge can remove the bytes before the row. */
async function objectKeysFor(type: string, id: string): Promise<string[]> {
  if (type === "MediaAsset") {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id },
      select: { objectKey: true, variants: { select: { objectKey: true } } }
    });
    if (!asset) return [];
    return [asset.objectKey, ...asset.variants.map((variant) => variant.objectKey)];
  }
  if (type === "FileAsset") {
    const file = await prisma.fileAsset.findUnique({
      where: { id },
      select: { versions: { select: { objectKey: true } } }
    });
    if (!file) return [];
    return file.versions.map((version) => version.objectKey);
  }
  return [];
}

const PROBLEMS: Record<string, string> = {
  not_found: "That item is no longer in the recycle bin. Somebody may have dealt with it while this page was open.",
  unknown_type: "This screen does not know how to handle that kind of record, so nothing was changed.",
  name_mismatch:
    "The name you typed did not match, so nothing was deleted. Type it exactly as it appears above the box.",
  storage_failed:
    "The stored files could not be removed, so the record was KEPT rather than leaving files behind that nothing points at. Try again, or ask whoever looks after storage. Nothing has been lost.",
  purge_failed: "That could not be deleted for good. Nothing has been changed.",
  restore_failed:
    "That could not be restored. Nothing has been changed — this usually means something it referred to has since been deleted too."
};

const NOTICES: Record<string, string> = {
  restored: "It is back where it was, in the state it was in when it was deleted. If it was published before, it is published again.",
  purged: "It has been deleted for good, along with any files stored with it. Nothing can bring it back."
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Who is doing this, for the audit entry.
 *
 * `clientIp()`/`userAgent()` in lib/api.ts take a `Request`, which a Server Action does not have, so the
 * same two headers are read here. `x-forwarded-for` carries a list; the first entry is the client.
 */
async function auditContext(actor: { id: string; email: string }): Promise<AuditContext> {
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for");
  return {
    actor,
    ipAddress: forwarded?.split(",")[0]?.trim() ?? incoming.get("x-real-ip") ?? null,
    userAgent: incoming.get("user-agent")
  };
}

function backWith(params: Record<string, string>): never {
  const search = new URLSearchParams(params).toString();
  navigate(`/studio/recycle-bin${search.length > 0 ? `?${search}` : ""}`);
}

async function restore(formData: FormData): Promise<void> {
  "use server";

  // THE BOUNDARY. Not the render — a form can be submitted by anything that can make a POST.
  const user = await requireStudioCapability(
    canRestoreDeleted,
    "Restoring something needs administrator access."
  );

  const type = String(formData.get("type") ?? "").trim();
  const id = String(formData.get("id") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  if (!metaFor(type)) backWith({ problem: "unknown_type" });
  if (id.length === 0) backWith({ problem: "not_found" });

  const context = await auditContext({ id: user.id, email: user.email });

  try {
    await mutateWithHistory(
      context,
      {
        action: "RESTORE",
        entityType: type,
        entityLabel: label.length > 0 ? label : id,
        // No revision: nothing about the record's own content changed, only whether it is deleted. A
        // revision here would be an identical second copy of the state it already had.
        revise: false,
        before: { deletedAt: "set" }
      },
      async (tx) => {
        const result = await restoreRow(tx, type, id);
        // Throwing inside the transaction rolls back the log entry too, which is the property lib/audit.ts
        // exists to provide.
        if (!result) throw new Error(`No restore is defined for ${type}.`);
        return result;
      }
    );
  } catch (thrown) {
    console.error("[recycle-bin] a restore failed", type, id, thrown);
    backWith({ problem: "restore_failed" });
  }

  backWith({ notice: "restored" });
}

async function purge(formData: FormData): Promise<void> {
  "use server";

  const user = await requireStudioCapability(
    canPurge,
    "Deleting something for good needs administrator access."
  );

  const type = String(formData.get("type") ?? "").trim();
  const id = String(formData.get("id") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const typed = String(formData.get("confirmName") ?? "").trim();

  if (!metaFor(type)) backWith({ problem: "unknown_type" });
  if (id.length === 0) backWith({ problem: "not_found" });

  /**
   * THE TYPED CONFIRMATION, ENFORCED HERE.
   *
   * Case and surrounding space are forgiven — the ceremony is what makes this a decision rather than a
   * reflex, and somebody who typed the right name with a capital letter has already made it.
   */
  if (typed.toLowerCase() !== label.toLowerCase()) backWith({ problem: "name_mismatch" });

  // ⚠ BYTES FIRST. See the file header for why the order is not negotiable.
  const keys = await objectKeysFor(type, id);
  if (keys.length > 0) {
    if (!storageAvailable()) {
      backWith({ problem: "storage_failed" });
    }
    const outcome = await deleteObjects(keys);
    if (outcome.failed.length > 0) {
      console.error("[recycle-bin] could not delete stored objects for", type, id, outcome.failed);
      backWith({ problem: "storage_failed" });
    }
  }

  const context = await auditContext({ id: user.id, email: user.email });

  try {
    await mutateWithHistory(
      context,
      {
        action: "PURGE",
        entityType: type,
        entityLabel: label.length > 0 ? label : id,
        revise: false,
        // The audit entry is now the ONLY record that this ever existed, which is why it carries the count
        // of files that went with it.
        before: { storedFiles: keys.length }
      },
      async (tx) => {
        const result = await purgeRow(tx, type, id);
        if (!result) throw new Error(`No permanent delete is defined for ${type}.`);
        return result;
      }
    );
  } catch (thrown) {
    console.error("[recycle-bin] a purge failed", type, id, thrown);
    backWith({ problem: "purge_failed" });
  }

  backWith({ notice: "purged" });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The recycle bin IS this filter. There is no separate table and no second flag to forget. */
const deletedWhere = { deletedAt: { not: null } };

function formatWhen(date: Date): string {
  return `${date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  })} UTC`;
}

/** Whole days between now and the purge deadline, floored at 0. */
function daysLeft(deletedAt: Date, windowDays: number, now: number): number {
  const deadline = deletedAt.getTime() + windowDays * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((deadline - now) / (24 * 60 * 60 * 1000)));
}

export default async function StudioRecycleBinPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canRestoreDeleted,
    "The recycle bin needs administrator access. Ask an administrator to restore something for you."
  );

  const params = await searchParams;
  const problem = PROBLEMS[first(params.problem)] ?? null;
  const notice = NOTICES[first(params.notice)] ?? null;

  const take = PER_TYPE_LIMIT + 1;
  const order = { deletedAt: "desc" as const };

  /**
   * Thirteen narrow reads in ONE batch.
   *
   * Sequentially each would pay a full round trip, and on a pooled connection that is several seconds of
   * blank screen for thirteen short lists. Each select is written out rather than generated, because the
   * column that NAMES a record differs per model and getting that wrong would show an administrator a list
   * of ids.
   */
  const [
    pages,
    posts,
    people,
    projects,
    publications,
    areas,
    events,
    crafts,
    albums,
    partners,
    media,
    files,
    enquiries
  ] = await prisma.$transaction([
    prisma.page.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.post.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.person.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, name: true, designation: true, deletedAt: true } }),
    prisma.project.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.publication.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, title: true, year: true, deletedAt: true } }),
    prisma.researchArea.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.coeEvent.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, title: true, startsAt: true, deletedAt: true } }),
    prisma.craft.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, name: true, slug: true, deletedAt: true } }),
    prisma.galleryAlbum.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.partner.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, name: true, category: true, deletedAt: true } }),
    prisma.mediaAsset.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, fileName: true, byteSize: true, deletedAt: true } }),
    prisma.fileAsset.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, title: true, slug: true, deletedAt: true } }),
    prisma.contactSubmission.findMany({ where: deletedWhere, orderBy: order, take, select: { id: true, name: true, email: true, deletedAt: true } })
  ]);

  /** `deletedAt` is nullable in the type but never null in these results — the filter guarantees it. */
  function rowsFrom<T extends { id: string; deletedAt: Date | null }>(
    type: BinType,
    source: readonly T[],
    label: (row: T) => string,
    detail: (row: T) => string
  ): BinRow[] {
    return source
      .filter((row): row is T & { deletedAt: Date } => row.deletedAt !== null)
      .map((row) => ({
        type,
        id: row.id,
        // Never empty: the typed confirmation asks for this string, and a blank one could be "confirmed" by
        // pressing the button with an empty box.
        label: label(row).trim().length > 0 ? label(row).trim() : `${type} ${row.id}`,
        detail: detail(row),
        deletedAt: row.deletedAt
      }));
  }

  const collected: { type: BinType; rows: BinRow[] }[] = [
    { type: "Page", rows: rowsFrom("Page", pages, (row) => row.title, (row) => `/${row.slug}`) },
    { type: "Post", rows: rowsFrom("Post", posts, (row) => row.title, (row) => `/news/${row.slug}`) },
    { type: "Person", rows: rowsFrom("Person", people, (row) => row.name, (row) => row.designation ?? "") },
    { type: "Project", rows: rowsFrom("Project", projects, (row) => row.title, (row) => `/projects/${row.slug}`) },
    { type: "Publication", rows: rowsFrom("Publication", publications, (row) => row.title, (row) => String(row.year)) },
    { type: "ResearchArea", rows: rowsFrom("ResearchArea", areas, (row) => row.title, (row) => `/research/${row.slug}`) },
    { type: "CoeEvent", rows: rowsFrom("CoeEvent", events, (row) => row.title, (row) => formatWhen(row.startsAt)) },
    { type: "Craft", rows: rowsFrom("Craft", crafts, (row) => row.name, (row) => `/craft-explorer/${row.slug}`) },
    { type: "GalleryAlbum", rows: rowsFrom("GalleryAlbum", albums, (row) => row.title, (row) => `/gallery/${row.slug}`) },
    { type: "Partner", rows: rowsFrom("Partner", partners, (row) => row.name, (row) => row.category ?? "") },
    { type: "MediaAsset", rows: rowsFrom("MediaAsset", media, (row) => row.fileName, (row) => formatBytes(row.byteSize)) },
    { type: "FileAsset", rows: rowsFrom("FileAsset", files, (row) => row.title, (row) => row.slug) },
    { type: "ContactSubmission", rows: rowsFrom("ContactSubmission", enquiries, (row) => row.name, (row) => row.email) }
  ];

  // `flatMap` with a lookup rather than an index into `GROUPS`: with `noUncheckedIndexedAccess` an index
  // would be `BinGroupMeta | undefined` and need a non-null assertion at every one of thirteen call sites.
  const groups: { meta: BinGroupMeta; rows: BinRow[]; truncated: boolean }[] = collected.flatMap((entry) => {
    const meta = metaFor(entry.type);
    if (!meta) return [];
    return [
      {
        meta,
        rows: entry.rows.slice(0, PER_TYPE_LIMIT),
        truncated: entry.rows.length > PER_TYPE_LIMIT
      }
    ];
  });

  const nonEmpty = groups.filter((group) => group.rows.length > 0);
  const totalShown = nonEmpty.reduce((sum, group) => sum + group.rows.length, 0);
  const mayPurge = canPurge(user);
  const windowDays = mediaPurgeAfterDays();
  const now = Date.now();

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Recycle bin"
        description="Everything that has been deleted recently, grouped by what it is. Restoring puts something back exactly as it was; deleting it for good cannot be undone by anybody."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {totalShown === 1 ? "1 item shown" : `${totalShown} items shown`}
          </span>
        }
      />

      {problem ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{problem}</span>
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-success-600/25 bg-success-100 px-3.5 py-3 text-sm leading-relaxed text-success-600"
        >
          <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </p>
      ) : null}

      {/*
        THE TWO RETENTION RULES, SAID PLAINLY AND SEPARATELY. Getting either one wrong leads to an opposite
        mistake: waiting for the bin to empty itself, or assuming a photograph will still be here next month.
      */}
      <div className="panel px-4 py-3.5">
        <p className="text-sm font-semibold text-ink-900">How long things stay here</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-700">
          <li>
            <span className="font-medium">Media files and stored files</span> are removed for good{" "}
            {windowDays} days after they were deleted, by a job that runs on its own. Their stored bytes go
            with them, and nothing can bring either back.
          </li>
          <li>
            <span className="font-medium">Everything else</span> — pages, articles, profiles, projects,
            publications, events, albums, enquiries — stays here until somebody removes it. It is not
            cleared automatically, so this list only ever grows.
          </li>
        </ul>
        {!storageAvailable() ? (
          <p className="mt-2 text-xs leading-relaxed text-amber-800">
            The file store is not set up on this installation, so a media file or stored file cannot be
            removed for good from here: its bytes could not be deleted, and removing the record alone would
            leave files nothing points at. Restoring still works.
          </p>
        ) : null}
      </div>

      {nonEmpty.length === 0 ? (
        <EmptyState
          icon={Trash2}
          title="The recycle bin is empty"
          description="Nothing has been deleted, or everything that was has already been removed for good. Anything deleted in the studio appears here first."
        />
      ) : (
        nonEmpty.map((group) => (
          <FormSection
            key={group.meta.type}
            title={group.meta.label}
            description={
              group.meta.autoPurged
                ? `Removed for good ${windowDays} days after being deleted, automatically.`
                : "Kept here until somebody removes it. Nothing removes these on its own."
            }
          >
            <ul className="space-y-3">
              {group.rows.map((row) => {
                const left = group.meta.autoPurged
                  ? daysLeft(row.deletedAt, windowDays, now)
                  : null;

                return (
                  <li key={`${row.type}-${row.id}`} className="rounded-md border border-line-200 bg-surface-50 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink-900">{row.label}</p>
                        <p className="mt-0.5 truncate text-xs text-ink-500">
                          {row.detail.length > 0 ? `${row.detail} · ` : ""}
                          deleted <time dateTime={row.deletedAt.toISOString()}>{formatWhen(row.deletedAt)}</time>
                        </p>
                        {left !== null ? (
                          <p
                            className={
                              left <= 3
                                ? "mt-1 text-xs font-medium text-error-600"
                                : "mt-1 text-xs text-amber-800"
                            }
                          >
                            {left === 0
                              ? "Past the window — the next run of the clean-up job will remove this for good."
                              : left === 1
                                ? "1 day left before it is removed for good."
                                : `${left} days left before it is removed for good.`}
                          </p>
                        ) : null}
                      </div>

                      <form action={restore} className="shrink-0">
                        <input type="hidden" name="type" value={row.type} />
                        <input type="hidden" name="id" value={row.id} />
                        <input type="hidden" name="label" value={row.label} />
                        <Button type="submit" variant="secondary" size="sm" icon={Undo2}>
                          Restore
                        </Button>
                      </form>
                    </div>

                    {mayPurge ? (
                      <details className="mt-3 rounded-md border border-error-200 bg-card px-3 py-2.5">
                        <summary className="cursor-pointer rounded text-sm font-medium text-error-600 transition hover:text-error-700">
                          Delete this {group.meta.singular} for good
                        </summary>

                        {/*
                          A SEPARATE form from Restore, so pressing Enter in the confirmation box cannot
                          reach the other button — and so the safe action is never one keystroke from the
                          irreversible one.
                        */}
                        <form action={purge} className="mt-2.5 space-y-3">
                          <input type="hidden" name="type" value={row.type} />
                          <input type="hidden" name="id" value={row.id} />
                          <input type="hidden" name="label" value={row.label} />

                          <p className="text-sm leading-relaxed text-ink-700">
                            This removes “{row.label}” and anything stored with it for good. Nothing can
                            bring it back, and any address that pointed at it will stop working.
                          </p>

                          <Field
                            label={`Type “${row.label}” to confirm`}
                            help="Typed in full, so this is a decision rather than a reflex. Capital letters do not matter."
                          >
                            <Input
                              name="confirmName"
                              required
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={row.label}
                            />
                          </Field>

                          <Button type="submit" variant="danger" size="sm" icon={Trash2}>
                            Delete for good
                          </Button>
                        </form>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {group.truncated ? (
              <HelpText>
                Only the {PER_TYPE_LIMIT} most recently deleted {group.meta.label.toLowerCase()} are shown.
                There are more — deal with these and the rest will appear.
              </HelpText>
            ) : null}
          </FormSection>
        ))
      )}

      {!mayPurge ? (
        <HelpText>
          Deleting something for good needs administrator access, so it is not offered here. Restoring is.
        </HelpText>
      ) : null}

      <HelpText>
        User accounts are not in this list. An account is switched off rather than deleted, from the Users
        screen, so that everything the person wrote keeps its author and the audit log keeps its trail.
      </HelpText>
    </div>
  );
}
