import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect as navigate } from "next/navigation";
import { CircleCheck, Trash2, TriangleAlert, Undo2 } from "lucide-react";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canRestoreDeleted, isMasterAdmin } from "@/lib/permissions";
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { mediaPurgeAfterDays } from "@/lib/env";
import { storageAvailable } from "@/lib/storage/client";
import { formatBytes } from "@/lib/utils";
// The bin's ONE list of kinds, and the ONE implementation of permanent deletion. The API route
// (app/api/studio/recycle-bin/purge/route.ts) calls the same function with the same arguments, so this
// screen and that endpoint cannot drift into two different ideas of what "delete for good" destroys.
import {
  deletedWhere,
  metaFor,
  type BinType,
  type BinTypeMeta
} from "@/app/api/studio/recycle-bin/kinds";
import { purgeRecord } from "@/app/api/studio/recycle-bin/purge-record";
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
 * lib/permissions.ts makes it an administrator's act.
 *
 * ⚠ PERMANENT DELETION IS A HIGHER TIER AGAIN: `isMasterAdmin`, checked separately, in the Server Action
 * as well as in the render. lib/permissions.ts puts `canPurge` at ADMINISTRATOR, which is right for the
 * automatic window-based purge the cron performs and wrong for a person destroying the only copy of
 * something. That file argues `canManageStudioAccess` is master-admin because "an administrator runs the
 * site; a master admin decides who is allowed near it" — irreversible destruction of the archive belongs
 * on the same side of that line, for the same reason: the everyday administrator account is the one most
 * likely to be phished. Hiding the control is NOT the guard; the Server Action and
 * `app/api/studio/recycle-bin/purge/route.ts` both refuse independently.
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
 * ⚠ WHAT A PERMANENT DELETE ACTUALLY DOES — the bytes before the row, and a refusal rather than silent
 * damage to anything that still points at the record — lives in ONE place,
 * `app/api/studio/recycle-bin/purge-record.ts`, and is argued in full at the top of that file. This screen
 * calls it; it does not reimplement it. The version that did reimplement it deleted rows whose covers were
 * still on live pages, because a second copy of a rule is a second chance to get it wrong.
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

/**
 * `BinType`, `BinTypeMeta` and `metaFor` come from `app/api/studio/recycle-bin/kinds.ts`.
 *
 * They used to be restated here, and in the listing route, and in the restore route. Four copies of one
 * list is four chances for a kind to be listed on this screen and then have no branch in the route that
 * has to act on it — with nothing to say so until an administrator pressed the button. `BinType` is what
 * makes a missing branch a compile error rather than a `default:` somebody's row quietly falls into.
 */

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

/**
 * There is no `purgeRow` here.
 *
 * Permanent deletion is `purgeRecord` in `app/api/studio/recycle-bin/purge-record.ts`, which this screen
 * and the API route both call. It is not merely a `delete` per model: it refuses a record something else
 * still points at, removes an asset's original AND every derivative under its storage prefix before the
 * row, and writes the audit entry that becomes the only surviving record of what was destroyed. A copy of
 * that here would be a copy that drifts.
 */

/**
 * The fixed refusals.
 *
 * ⚠ `in_use`, `protected` and `storage_failed` do NOT appear here, because their whole value is the
 * detail: which records still use the picture, which structural page this is, how many objects could not
 * be removed. Those arrive as `reason` — see `backWith` and the banner that renders it.
 */
const PROBLEMS: Record<string, string> = {
  not_found: "That item is no longer in the recycle bin. Somebody may have dealt with it while this page was open.",
  unknown_type: "This screen does not know how to handle that kind of record, so nothing was changed.",
  name_mismatch:
    "The name you typed did not match, so nothing was deleted. Type it exactly as it appears above the box.",
  // There is no entry for "you are not a master administrator": `requireStudioCapability` renders the
  // forbidden screen rather than returning here, which is the right answer — a refused person should not
  // be handed the list back with a note about it.
  purge_failed: "That could not be deleted for good. Nothing has been changed.",
  restore_failed:
    "That could not be restored. Nothing has been changed — this usually means something it referred to has since been deleted too."
};

const NOTICES: Record<string, string> = {
  restored: "It is back where it was, in the state it was in when it was deleted. If it was published before, it is published again.",
  /** A fallback only. A successful deletion normally reports exactly what went with it, through `reason`. */
  purged: "It has been deleted for good, along with anything stored with it. Nothing can bring it back."
};

/**
 * How much of a server-written sentence travels back in the address bar.
 *
 * ⚠ `reason` IS RENDERED, so it is CAPPED and it is rendered as TEXT — a string child of a React element,
 * never markup, never a link, never `dangerouslySetInnerHTML`. So a crafted address can put a misleading
 * sentence in the banner of somebody who follows it, and can do nothing else; there is no injection and
 * nothing clickable. That is an accepted trade for a refusal that names the four records still using a
 * picture, which is the difference between a message an administrator can act on and a message they cannot.
 *
 * The alternative — returning the sentence from the Server Action instead of redirecting with it — needs
 * `useActionState`, which needs a Client Component, which this screen deliberately is not (see the header).
 */
const MAX_REASON = 500;

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

/**
 * Delete one record for good.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ `isMasterAdmin` IS THE FIRST STATEMENT, AND IT IS THE REAL GUARD. The control below is drawn only
 * for a master admin, but a Server Action is a POST endpoint like any other: it can be invoked by
 * anything that has the action id, whatever the page chose to render. An administrator — who can open
 * this screen, and should be able to — is refused here.
 *
 * Everything after the boundary is `purgeRecord`, shared with `app/api/studio/recycle-bin/purge/route.ts`.
 * This function's whole remaining job is to turn a `FormData` into that call and its answer into a
 * sentence in the address bar.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function purge(formData: FormData): Promise<void> {
  "use server";

  const user = await requireStudioCapability(
    isMasterAdmin,
    "Deleting something for good needs master administrator access. An administrator can restore it or " +
      "leave it in the recycle bin, but only a master administrator can destroy it."
  );

  const type = String(formData.get("type") ?? "").trim();
  const id = String(formData.get("id") ?? "").trim();
  const typed = String(formData.get("confirmName") ?? "").trim();

  const meta = metaFor(type);
  if (!meta) backWith({ problem: "unknown_type" });
  if (id.length === 0) backWith({ problem: "not_found" });

  /**
   * ⚠ THE TYPED NAME IS CHECKED AGAINST THE STORED ROW, NOT AGAINST THE HIDDEN FIELD.
   *
   * `purgeRecord` re-reads the record and compares what was typed with what is actually in the database.
   * Comparing against a `label` posted by the same form would let anything that can submit the form
   * satisfy the confirmation by sending the same string twice — which is no confirmation at all. The
   * label is still rendered above the box, because the person has to be able to read what to type.
   */
  const outcome = await purgeRecord(await auditContext({ id: user.id, email: user.email }), {
    type: meta.type,
    id,
    confirm: typed
  });

  if (!outcome.ok) {
    // `name_mismatch` and `not_found` have their own settled sentences on this screen; everything else —
    // above all "something still uses this, and here is what" — is worth nothing without its detail.
    if (outcome.code === "name_mismatch" || outcome.code === "not_found") {
      backWith({ problem: outcome.code });
    }
    backWith({ problem: "purge_failed", reason: outcome.message.slice(0, MAX_REASON) });
  }

  backWith({ notice: "purged", reason: outcome.message.slice(0, MAX_REASON) });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

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
  /**
   * The sentence the Server Action wrote, if it wrote one.
   *
   * A refusal from `purgeRecord` is worth reading BECAUSE of its detail — which records still use the
   * picture, how many stored files could not be removed — so it is preferred over the fixed text. It is
   * clipped and it is framed at the point of rendering; see `MAX_REASON`.
   */
  const reason = first(params.reason).slice(0, MAX_REASON).trim();
  const problem = reason.length > 0 && first(params.problem).length > 0
    ? reason
    : (PROBLEMS[first(params.problem)] ?? null);
  const notice = reason.length > 0 && first(params.notice).length > 0
    ? reason
    : (NOTICES[first(params.notice)] ?? null);

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

  // `flatMap` with a lookup rather than an index into `BIN_META`: with `noUncheckedIndexedAccess` an index
  // would be `BinTypeMeta | undefined` and need a non-null assertion at every one of thirteen call sites.
  const groups: { meta: BinTypeMeta; rows: BinRow[]; truncated: boolean }[] = collected.flatMap((entry) => {
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
  /**
   * ⚠ MASTER ADMIN, NOT ADMINISTRATOR. See the header. This decides whether the control is DRAWN; the
   * Server Action decides whether it WORKS, and it checks the same predicate itself. A failing check
   * renders NOTHING rather than a disabled button (contract §7.5) — an ungated control that lands on a
   * refusal invites every tier to press it, and this is the one control where pressing it matters.
   */
  const mayPurge = isMasterAdmin(user);
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

                          ⚠ NO HIDDEN `label`. The name typed below is compared with the row as it is
                          STORED, read fresh by `purgeRecord`. Posting the expected name alongside the
                          typed one would let anything that can submit this form satisfy the confirmation
                          by sending the same string twice, which is no confirmation at all.
                        */}
                        <form action={purge} className="mt-2.5 space-y-3">
                          <input type="hidden" name="type" value={row.type} />
                          <input type="hidden" name="id" value={row.id} />

                          {/*
                            SAID PLAINLY, AND SAID TWICE — once as what happens and once as what stops
                            being possible. "Permanent" is a word people read past; "Restore will no
                            longer be offered" is a sentence about a button they can see.
                          */}
                          <p className="text-sm font-medium leading-relaxed text-error-700">
                            This cannot be undone. “{row.label}” will be destroyed, not moved — the
                            Restore button above will no longer be offered for it, and nobody, at any
                            level of access, will be able to bring it back.
                          </p>

                          <p className="text-sm leading-relaxed text-ink-700">
                            {group.meta.type === "MediaAsset" ? (
                              <>
                                The original file and every resized copy of it are removed from storage,
                                so every address it was ever served at will stop working — including on
                                pages that are live now.
                              </>
                            ) : group.meta.type === "FileAsset" ? (
                              <>
                                Every stored version of this file is removed from storage, so every
                                download link to any version of it will stop working.
                              </>
                            ) : (
                              <>
                                Everything kept inside this {group.meta.singular} goes with it, and any
                                address that pointed at it will stop working.
                              </>
                            )}{" "}
                            If something else still uses it, this will be refused rather than quietly
                            changing that other record — and the refusal will name what is using it.
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
                            Delete “{row.label}” for good
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
          Deleting something for good is the one action here that cannot be undone by anybody, so it needs
          master administrator access and is not offered on this screen. Restoring is. Anything left in
          this list is doing no harm — it is invisible on the site and in every other studio screen.
        </HelpText>
      ) : null}

      <HelpText>
        User accounts are not in this list. An account is switched off rather than deleted, from the Users
        screen, so that everything the person wrote keeps its author and the audit log keeps its trail.
      </HelpText>
    </div>
  );
}
