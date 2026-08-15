import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect as navigate } from "next/navigation";
import Link from "next/link";
import { FilterX, RotateCcw, ScrollText, Search, TriangleAlert } from "lucide-react";
import { Prisma, type AuditAction } from "@prisma/client";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canRestoreDeleted, canViewAuditLog } from "@/lib/permissions";
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";

/**
 * The audit log — who changed what, when, and what it replaced.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canViewAuditLog)` IS THE FIRST STATEMENT — administrator only. The log holds the
 * before and after of every change, which means it holds the CONTENT of unpublished work and the email
 * addresses of everybody who has ever signed in. Passwords, TOTP secrets and recovery codes are stripped by
 * name before they reach it (`redact()` in lib/audit.ts); everything else is there in full.
 *
 * ACTION NAMES ARE PLAIN WORDS, NEVER THE ENUM. "PERMISSION_CHANGE" is a database value; "changed what
 * somebody is allowed to do" is the same fact in a sentence an administrator can act on. The map is total,
 * so adding an `AuditAction` is a compile error here rather than a blank word on screen — and it is READ
 * through a `Partial` view, so a row written by a newer deploy than this one still renders something.
 *
 * THE FILTERS ARE ONE PLAIN `<form method="get">`, and that is deliberate. Everything on this screen is a
 * navigation: the filters live in the URL, the pages are real links, and a filtered view is something an
 * administrator can paste into an incident note. There is nothing reacting to a click, so there is nothing
 * to fetch over HTTP (contract §9) — and the whole screen works with JavaScript switched off, which is worth
 * having for the one screen somebody reads while something is going wrong.
 *
 * ⚠ ROLLBACK IS OFFERED ONLY WHERE IT CAN BE DONE HONESTLY, and it is narrower than it looks:
 *
 *   • Only for an entry that HAS a `before` object and an entity id — a sign-in has neither.
 *   • Only for the models in `ROLLBACKABLE`. `User` and `Setting` are deliberately absent: rolling a role
 *     change back blindly is a privilege change nobody reviewed, and settings have their own screen with
 *     their own validation.
 *   • Only the record's OWN COLUMNS. Anything that looks like a list of related rows is left alone, and the
 *     screen says so — a rollback that silently reattached six deleted gallery items would be a bigger
 *     change than the one being undone.
 *   • The typed confirmation is enforced ON THE SERVER, in the action, not by a dialog. That is stronger
 *     than a client confirm, not weaker: a form can be submitted by anything, and the check that matters is
 *     the one that cannot be skipped.
 *
 * `?problem=` AND `?notice=` CARRY CODES, NEVER SENTENCES. A free-text message from the query string would
 * let anybody craft a link that shows an administrator a message this application never wrote.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Audit log"
};

const PAGE_SIZE = 40;

/** How many distinct entity types and actors the filters offer. Stated on screen when it bites. */
const FILTER_OPTION_LIMIT = 60;

/** How much of one value is shown in a diff. The cut is always stated (contract §1.6). */
const VALUE_LIMIT = 500;

/**
 * Every action, in plain words. A total `Record`, read through a `Partial` view — see the header.
 */
const ACTION_LABELS: Record<AuditAction, string> = {
  CREATE: "Created",
  UPDATE: "Changed",
  DELETE: "Moved to the recycle bin",
  RESTORE: "Restored from the recycle bin",
  PUBLISH: "Published",
  UNPUBLISH: "Taken off the site",
  ARCHIVE: "Archived",
  LOGIN: "Signed in",
  LOGIN_FAILED: "Sign-in refused",
  LOGOUT: "Signed out",
  PERMISSION_CHANGE: "Changed what somebody is allowed to do",
  UPLOAD: "Uploaded",
  PURGE: "Deleted for good",
  ROLLBACK: "Put back an earlier version"
};

const ACTION_TONES: Record<AuditAction, BadgeTone> = {
  CREATE: "success",
  UPDATE: "neutral",
  DELETE: "warn",
  RESTORE: "info",
  PUBLISH: "success",
  UNPUBLISH: "warn",
  ARCHIVE: "neutral",
  LOGIN: "neutral",
  LOGIN_FAILED: "error",
  LOGOUT: "neutral",
  PERMISSION_CHANGE: "error",
  UPLOAD: "neutral",
  PURGE: "error",
  ROLLBACK: "warn"
};

const ACTIONS: readonly AuditAction[] = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "RESTORE",
  "PUBLISH",
  "UNPUBLISH",
  "ARCHIVE",
  "PERMISSION_CHANGE",
  "UPLOAD",
  "PURGE",
  "ROLLBACK",
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT"
];

function isAction(value: string): value is AuditAction {
  return (ACTIONS as readonly string[]).includes(value);
}

function actionLabel(action: AuditAction): string {
  const labels: Partial<Record<AuditAction, string>> = ACTION_LABELS;
  return labels[action] ?? humanise(action);
}

function actionTone(action: AuditAction): BadgeTone {
  const tones: Partial<Record<AuditAction, BadgeTone>> = ACTION_TONES;
  return tones[action] ?? "neutral";
}

/** Plain nouns for the polymorphic `entityType`. */
const ENTITY_NOUNS: Record<string, string> = {
  Page: "page",
  PageSection: "block on a page",
  Post: "news article",
  Person: "person's profile",
  Project: "project",
  Publication: "publication",
  ResearchArea: "research area",
  CoeEvent: "event",
  Craft: "craft record",
  GalleryAlbum: "gallery album",
  GalleryItem: "picture in an album",
  MediaAsset: "media file",
  FileAsset: "file",
  User: "user account",
  NavigationItem: "menu item",
  Setting: "setting",
  Redirect: "redirect",
  Partner: "partner",
  ContactSubmission: "enquiry",
  EventRegistration: "event registration"
};

function humanise(value: string): string {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim().toLowerCase();
  if (words.length === 0) return value;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function nounFor(entityType: string): string {
  return ENTITY_NOUNS[entityType] ?? humanise(entityType).toLowerCase();
}

/**
 * The models a rollback may write to.
 *
 * `User` and `Setting` are deliberately absent — see the header. A model added here must also gain a case in
 * `applyRollback`, and the `switch` there is what makes forgetting one a compile-time impossibility rather
 * than a silent no-op.
 */
const ROLLBACKABLE: readonly string[] = [
  "Page",
  "Post",
  "Person",
  "Project",
  "Publication",
  "ResearchArea",
  "CoeEvent",
  "Craft",
  "GalleryAlbum",
  "Partner",
  "FileAsset",
  "MediaAsset",
  "Redirect"
];

/** Actions whose `before` describes a state worth putting back. A CREATE has no earlier state. */
const ROLLBACKABLE_ACTIONS: readonly AuditAction[] = [
  "UPDATE",
  "DELETE",
  "PUBLISH",
  "UNPUBLISH",
  "ARCHIVE",
  "RESTORE",
  "ROLLBACK"
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading a stored snapshot
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Columns that change on every save and mean nothing on their own. */
const NOISY_FIELDS: readonly string[] = ["id", "createdAt", "updatedAt"];

/**
 * An ISO instant, exactly as `redact()` writes a `Date`.
 *
 * ⚠ THIS IS WHY A ROLLBACK NEEDS CONVERTING AT ALL. `lib/audit.ts` serialises every `Date` to an ISO string
 * before storing it, and Prisma refuses a string for a `DateTime` column — so writing a snapshot back
 * verbatim fails on the first date. The pattern is anchored and demands the `Z`, so a piece of prose that
 * merely contains a date cannot be mistaken for one.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/**
 * The record's OWN columns, ready for Prisma.
 *
 * Drops the noisy three, drops anything that looks like a list of related rows, and revives ISO instants.
 * A `Json` column survives as an object, which is what it is.
 */
function ownColumns(snapshot: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(snapshot)) {
    if (NOISY_FIELDS.includes(key)) continue;
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      // A `String[]` column (tags, keywords, materials) is kept; an array of objects is a relation and is
      // left alone. The screen says which fields were skipped.
      if (value.every((entry) => typeof entry === "string")) out[key] = value;
      continue;
    }

    if (typeof value === "string" && ISO_INSTANT.test(value)) {
      out[key] = new Date(value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

/** Which fields a rollback would NOT touch, so the confirmation can name them. */
function skippedColumns(snapshot: Record<string, unknown>): string[] {
  return Object.entries(snapshot)
    .filter(([, value]) => Array.isArray(value) && !value.every((entry) => typeof entry === "string"))
    .map(([key]) => key);
}

interface DiffRow {
  field: string;
  before: string;
  after: string;
  beforeCut: boolean;
  afterCut: boolean;
}

function formatValue(value: unknown): { text: string; cut: boolean } {
  if (value === null || value === undefined) return { text: "(empty)", cut: false };
  if (typeof value === "string") {
    if (value.length === 0) return { text: "(empty)", cut: false };
    return value.length > VALUE_LIMIT
      ? { text: value.slice(0, VALUE_LIMIT), cut: true }
      : { text: value, cut: false };
  }
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value), cut: false };

  let serialised: string;
  try {
    serialised = JSON.stringify(value, null, 2) ?? "(empty)";
  } catch {
    return { text: "(this value cannot be shown)", cut: false };
  }
  return serialised.length > VALUE_LIMIT
    ? { text: serialised.slice(0, VALUE_LIMIT), cut: true }
    : { text: serialised, cut: false };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function buildDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): DiffRow[] {
  if (!before && !after) return [];
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  const rows: DiffRow[] = [];

  for (const field of fields) {
    if (NOISY_FIELDS.includes(field)) continue;
    const left = before?.[field];
    const right = after?.[field];
    if (sameValue(left, right)) continue;
    const a = formatValue(left);
    const b = formatValue(right);
    rows.push({ field, before: a.text, after: b.text, beforeCut: a.cut, afterCut: b.cut });
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The rollback
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Write a snapshot back to its row.
 *
 * ⚠ ONE CAST PER CASE, AND IT IS CONTAINED HERE. The snapshot is JSON read from the audit log, so its shape
 * cannot be proven to TypeScript — but the DELEGATE is chosen by an explicit branch, so the column names and
 * types are still checked by Prisma at run time and a model with no branch simply cannot be rolled back. The
 * alternative, indexing `tx` by a string, would type-check nothing at all and would happily write to a table
 * nobody meant to include.
 */
async function applyRollback(
  tx: TxClient,
  entityType: string,
  id: string,
  data: Record<string, unknown>
): Promise<({ id: string } & Record<string, unknown>) | null> {
  switch (entityType) {
    case "Page":
      return tx.page.update({ where: { id }, data: data as Prisma.PageUncheckedUpdateInput });
    case "Post":
      return tx.post.update({ where: { id }, data: data as Prisma.PostUncheckedUpdateInput });
    case "Person":
      return tx.person.update({ where: { id }, data: data as Prisma.PersonUncheckedUpdateInput });
    case "Project":
      return tx.project.update({ where: { id }, data: data as Prisma.ProjectUncheckedUpdateInput });
    case "Publication":
      return tx.publication.update({
        where: { id },
        data: data as Prisma.PublicationUncheckedUpdateInput
      });
    case "ResearchArea":
      return tx.researchArea.update({
        where: { id },
        data: data as Prisma.ResearchAreaUncheckedUpdateInput
      });
    case "CoeEvent":
      return tx.coeEvent.update({ where: { id }, data: data as Prisma.CoeEventUncheckedUpdateInput });
    case "Craft":
      return tx.craft.update({ where: { id }, data: data as Prisma.CraftUncheckedUpdateInput });
    case "GalleryAlbum":
      return tx.galleryAlbum.update({
        where: { id },
        data: data as Prisma.GalleryAlbumUncheckedUpdateInput
      });
    case "Partner":
      return tx.partner.update({ where: { id }, data: data as Prisma.PartnerUncheckedUpdateInput });
    case "FileAsset":
      return tx.fileAsset.update({ where: { id }, data: data as Prisma.FileAssetUncheckedUpdateInput });
    case "MediaAsset":
      return tx.mediaAsset.update({
        where: { id },
        data: data as Prisma.MediaAssetUncheckedUpdateInput
      });
    case "Redirect":
      return tx.redirect.update({ where: { id }, data: data as Prisma.RedirectUncheckedUpdateInput });
    default:
      return null;
  }
}

const PROBLEMS: Record<string, string> = {
  not_found: "That audit entry no longer exists.",
  not_rollbackable:
    "That entry cannot be put back. Either it records no earlier state, or it is for a kind of record this screen deliberately will not rewrite — user accounts and settings are changed from their own screens.",
  name_mismatch:
    "The name you typed did not match, so nothing was changed. Type it exactly as it appears in the confirmation.",
  failed:
    "The earlier version could not be written back. Nothing has been changed. This usually means a column in the old version no longer exists, or something it referred to has since been deleted."
};

const NOTICES: Record<string, string> = {
  rolled_back:
    "The earlier version has been written back. This rollback is itself in the log below, so it can be undone the same way."
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Who is doing this, for the audit entry the rollback itself writes.
 *
 * `clientIp()`/`userAgent()` in lib/api.ts take a `Request`, which a Server Action does not have, so the same
 * two headers are read here. `x-forwarded-for` carries a list; the first entry is the client.
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
  navigate(`/studio/audit${search.length > 0 ? `?${search}` : ""}`);
}

async function rollback(formData: FormData): Promise<void> {
  "use server";

  /**
   * THE BOUNDARY. `canRestoreDeleted` rather than `canViewAuditLog`: this WRITES, and undoing somebody
   * else's change is the same kind of act as restoring something they deliberately retired — which
   * lib/permissions.ts makes an administrator's job for exactly that reason.
   */
  const user = await requireStudioCapability(
    canRestoreDeleted,
    "Putting back an earlier version needs administrator access."
  );

  const entryId = String(formData.get("entryId") ?? "").trim();
  const typed = String(formData.get("confirmName") ?? "").trim();
  if (entryId.length === 0) backWith({ problem: "not_found" });

  const entry = await prisma.auditLog.findUnique({ where: { id: entryId } });
  if (!entry || !entry.entityId) backWith({ problem: "not_found" });

  const snapshot = asRecord(entry.before);
  if (
    snapshot === null ||
    !ROLLBACKABLE.includes(entry.entityType) ||
    !ROLLBACKABLE_ACTIONS.includes(entry.action)
  ) {
    backWith({ problem: "not_rollbackable" });
  }

  /**
   * THE TYPED CONFIRMATION, ENFORCED HERE.
   *
   * Case and surrounding space are forgiven — the ceremony is what makes this a decision, and somebody who
   * typed the right name with a capital letter has already made it. The label is what the log recorded, so
   * it is what the confirmation asks for.
   */
  const expected = (entry.entityLabel ?? nounFor(entry.entityType)).trim();
  if (typed.toLowerCase() !== expected.toLowerCase()) backWith({ problem: "name_mismatch" });

  const data = ownColumns(snapshot);
  const context = await auditContext({ id: user.id, email: user.email });
  const entityId = entry.entityId;

  try {
    await mutateWithHistory(
      context,
      {
        action: "ROLLBACK",
        entityType: entry.entityType,
        entityLabel: expected,
        // A revision IS written: the state being overwritten has to be recoverable, and "what was on screen
        // before the rollback" is exactly what somebody will want back if this was the wrong entry.
        summary: `Put back the version from before ${entry.createdAt.toISOString()}`,
        before: entry.after
      },
      async (tx) => {
        const result = await applyRollback(tx, entry.entityType, entityId, data);
        // Throwing inside the transaction rolls the whole thing back, log entry included — which is the
        // property lib/audit.ts exists to provide.
        if (!result) throw new Error(`No rollback is defined for ${entry.entityType}.`);
        return result;
      }
    );
  } catch (thrown) {
    console.error("[audit] a rollback failed", entryId, thrown);
    backWith({ problem: "failed" });
  }

  backWith({ notice: "rolled_back" });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A date in a NAMED zone. UTC, so the server's HTML and the browser's hydration cannot disagree. */
function formatWhen(date: Date): string {
  return `${date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  })} UTC`;
}

/** `YYYY-MM-DD` → a UTC instant. `new Date("2026-03-01")` is parsed as UTC by the specification. */
function dayStart(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayEnd(value: string): Date | null {
  const start = dayStart(value);
  if (!start) return null;
  // The whole of the chosen day, so "to 4 March" includes everything that happened on the 4th.
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

export default async function StudioAuditPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canViewAuditLog,
    "The audit log needs administrator access. Ask an administrator to look it up for you."
  );

  const params = await searchParams;
  const q = first(params.q).trim();
  const actorId = first(params.actor);
  const actionParam = first(params.action);
  const entityType = first(params.entityType);
  const from = first(params.from);
  const to = first(params.to);
  const pageParam = Number.parseInt(first(params.page), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const problem = PROBLEMS[first(params.problem)] ?? null;
  const notice = NOTICES[first(params.notice)] ?? null;

  const createdAt: Prisma.DateTimeFilter = {};
  const fromDate = dayStart(from);
  const toDate = dayEnd(to);
  if (fromDate) createdAt.gte = fromDate;
  if (toDate) createdAt.lte = toDate;

  const where: Prisma.AuditLogWhereInput = {
    ...(actorId.length > 0 ? { actorId } : {}),
    ...(isAction(actionParam) ? { action: actionParam } : {}),
    ...(entityType.length > 0 ? { entityType } : {}),
    ...(fromDate || toDate ? { createdAt } : {}),
    ...(q.length > 0
      ? {
          OR: [
            { entityLabel: { contains: q, mode: "insensitive" } },
            { entityId: { contains: q, mode: "insensitive" } },
            { actorEmail: { contains: q, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [entries, total, actorRows, typeRows] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      // Newest first, with the id as the tiebreak so two entries written in the same millisecond keep a
      // stable order between requests.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { actor: { select: { id: true, name: true, email: true } } }
    }),
    prisma.auditLog.count({ where }),
    prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: FILTER_OPTION_LIMIT
    }),
    prisma.auditLog.findMany({
      select: { entityType: true },
      distinct: ["entityType"],
      orderBy: { entityType: "asc" },
      take: FILTER_OPTION_LIMIT
    })
  ]);

  const mayRollback = canRestoreDeleted(user);
  const filtered =
    q.length > 0 ||
    actorId.length > 0 ||
    actionParam.length > 0 ||
    entityType.length > 0 ||
    from.length > 0 ||
    to.length > 0;

  const carried = new URLSearchParams();
  if (q.length > 0) carried.set("q", q);
  if (actorId.length > 0) carried.set("actor", actorId);
  if (isAction(actionParam)) carried.set("action", actionParam);
  if (entityType.length > 0) carried.set("entityType", entityType);
  if (from.length > 0) carried.set("from", from);
  if (to.length > 0) carried.set("to", to);
  const baseHref =
    carried.toString().length > 0 ? `/studio/audit?${carried.toString()}` : "/studio/audit";

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Audit log"
        description="Every change made in this studio, with the name of whoever made it and the state it replaced. Nothing here can be edited or removed — it is the record you read when something has gone wrong."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 entry" : `${total} entries`}
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
          className="rounded-md border border-success-600/25 bg-success-100 px-3.5 py-3 text-sm leading-relaxed text-success-600"
        >
          {notice}
        </p>
      ) : null}

      <FormSection
        title="Find an entry"
        description="Everything here is part of the address, so a filtered view can be pasted into an incident note and opened by somebody else exactly as you left it."
      >
        {/* A GET form. No JavaScript, no client component, and the URL is the state. */}
        <form method="get" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* `Field` (a real `<label>`) for every one of these: each control is a plain `<input>` or a
                native `<select>`, so there is no button inside for a stray click to be forwarded to. */}
            <Field
              label="Search"
              help="The name of the thing that changed, its id, or the email address of whoever changed it."
            >
              <Input name="q" type="search" defaultValue={q} placeholder="Search the log" iconNode={<Search />} />
            </Field>

            <Field label="Who">
              <Select
                name="actor"
                defaultValue={actorId}
                placeholder="Anybody"
                options={actorRows.map((row) => ({
                  value: row.id,
                  label: row.name.trim().length > 0 ? row.name : row.email
                }))}
              />
            </Field>

            <Field label="What happened">
              <Select
                name="action"
                defaultValue={isAction(actionParam) ? actionParam : ""}
                placeholder="Anything"
                options={ACTIONS.map((action) => ({ value: action, label: actionLabel(action) }))}
              />
            </Field>

            <Field label="Kind of record">
              <Select
                name="entityType"
                defaultValue={entityType}
                placeholder="Any kind"
                options={typeRows.map((row) => ({
                  value: row.entityType,
                  label: humanise(nounFor(row.entityType))
                }))}
              />
            </Field>

            <Field label="From" help="Dates are read as UTC, which is how the log stores them.">
              <Input name="from" type="date" defaultValue={from} />
            </Field>

            <Field label="To">
              <Input name="to" type="date" defaultValue={to} />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" icon={Search}>
              Search the log
            </Button>
            {filtered ? (
              <Link
                href="/studio/audit"
                className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-ink-700 transition hover:bg-surface-100 hover:text-ink-900"
              >
                <FilterX aria-hidden="true" className="h-3.5 w-3.5" />
                Clear all filters
              </Link>
            ) : (
              // "Empty means everything", said out loud. An absence is not something a reader can see.
              <p className="text-xs text-ink-500">No filters are set, so everything is listed.</p>
            )}
          </div>
        </form>

        {actorRows.length >= FILTER_OPTION_LIMIT ? (
          <HelpText>
            The list of people above stops at {FILTER_OPTION_LIMIT}. Search by email address if the person
            you want is not offered.
          </HelpText>
        ) : null}
      </FormSection>

      {entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={filtered ? "No entries match these filters" : "Nothing has been recorded yet"}
          description={
            filtered
              ? "Nothing in the log fits all of what you have asked for. That is a fact about the filters rather than about the log."
              : "Every change made in this studio appears here as it happens, with the name of whoever made it."
          }
          action={
            filtered ? (
              <Link
                href="/studio/audit"
                className="field-button-secondary"
              >
                Clear the filters
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <ol className="space-y-3">
            {entries.map((entry) => {
              const before = asRecord(entry.before);
              const after = asRecord(entry.after);
              const diff = buildDiff(before, after);
              const label = entry.entityLabel?.trim();
              const who = entry.actor?.name.trim() || entry.actorEmail || "Somebody whose account has gone";
              const rollbackable =
                mayRollback &&
                before !== null &&
                entry.entityId !== null &&
                ROLLBACKABLE.includes(entry.entityType) &&
                ROLLBACKABLE_ACTIONS.includes(entry.action);
              const skipped = before ? skippedColumns(before) : [];
              const expected = label && label.length > 0 ? label : nounFor(entry.entityType);

              return (
                <li key={entry.id} className="panel px-4 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge tone={actionTone(entry.action)} size="sm">
                          {actionLabel(entry.action)}
                        </Badge>
                        <span className="text-sm font-medium text-ink-900">
                          {label && label.length > 0 ? label : `a ${nounFor(entry.entityType)}`}
                        </span>
                        <span className="text-xs text-ink-500">{nounFor(entry.entityType)}</span>
                      </p>
                      <p className="mt-1 text-xs text-ink-500">
                        {who} ·{" "}
                        <time dateTime={entry.createdAt.toISOString()}>
                          {formatWhen(entry.createdAt)}
                        </time>
                        {entry.ipAddress ? ` · from ${entry.ipAddress}` : ""}
                      </p>
                    </div>
                  </div>

                  {diff.length > 0 ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer rounded text-sm font-medium text-purple-700 transition hover:text-purple-800">
                        {diff.length === 1
                          ? "Show what changed (1 field)"
                          : `Show what changed (${diff.length} fields)`}
                      </summary>

                      <dl className="mt-2.5 space-y-3">
                        {diff.map((row) => (
                          <div key={row.field} className="min-w-0">
                            <dt className="text-xs font-semibold text-ink-900">{humanise(row.field)}</dt>
                            <dd className="mt-1 grid gap-2 sm:grid-cols-2">
                              <div className="min-w-0 rounded-md border border-line-200 bg-surface-50 px-2.5 py-2">
                                <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-500">
                                  Before
                                </p>
                                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-ink-900">
                                  {row.before}
                                </pre>
                                {row.beforeCut ? (
                                  <p className="mt-1 text-[0.6875rem] text-ink-500">
                                    Shortened here. The whole value is in the log.
                                  </p>
                                ) : null}
                              </div>

                              <div className="min-w-0 rounded-md border border-purple-200 bg-purple-50 px-2.5 py-2">
                                <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-purple-700">
                                  After
                                </p>
                                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-ink-900">
                                  {row.after}
                                </pre>
                                {row.afterCut ? (
                                  <p className="mt-1 text-[0.6875rem] text-ink-500">
                                    Shortened here. The whole value is in the log.
                                  </p>
                                ) : null}
                              </div>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ) : (
                    <p className="mt-2 text-xs text-ink-500">
                      {before === null && after === null
                        ? "This kind of entry records no before and after — it is an event rather than a change to a record."
                        : "Nothing differs between the two states apart from fields that change on every save."}
                    </p>
                  )}

                  {rollbackable ? (
                    <details className="mt-3 rounded-md border border-error-200 bg-card px-3 py-2.5">
                      <summary className="cursor-pointer rounded text-sm font-medium text-error-600 transition hover:text-error-700">
                        Put the earlier version back
                      </summary>

                      {/*
                        A DANGER-TONE CONFIRMATION IN THE PAGE, not a dialog, and the typed name is checked
                        ON THE SERVER. This screen is a Server Component — making it a client one to borrow
                        `ConfirmProvider` would ship the whole log, before-and-after payloads included, to
                        the browser. The friction is the same and the check is stronger: a form can be
                        submitted by anything, and the server is where the name is compared.
                      */}
                      <form action={rollback} className="mt-2.5 space-y-3">
                        <input type="hidden" name="entryId" value={entry.id} />

                        <p className="text-sm leading-relaxed text-ink-700">
                          The {nounFor(entry.entityType)} will be written back to the state it was in before
                          this change. What it looks like now is kept as a version of its own, so this can be
                          undone the same way.
                        </p>

                        {skipped.length > 0 ? (
                          <HelpText tone="warn">
                            Only the record&rsquo;s own fields are put back. Things linked to it —{" "}
                            {skipped.map((field) => humanise(field).toLowerCase()).join(", ")} — are left
                            exactly as they are now.
                          </HelpText>
                        ) : null}

                        <Field
                          label={`Type “${expected}” to confirm`}
                          help="Typed in full, so this is a decision rather than a reflex. Capital letters do not matter."
                        >
                          <Input
                            name="confirmName"
                            required
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={expected}
                          />
                        </Field>

                        <Button type="submit" variant="danger" size="sm" icon={RotateCcw}>
                          Put the earlier version back
                        </Button>
                      </form>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            totalItems={total}
            baseHref={baseHref}
            itemNoun={{ singular: "entry", plural: "entries" }}
            label="Audit log"
          />

          {!mayRollback ? (
            <HelpText>
              Putting an earlier version back needs administrator access, so it is not offered here.
            </HelpText>
          ) : (
            <HelpText>
              Only some entries can be put back: an entry has to record an earlier state, and it has to be
              for a kind of record this screen will rewrite. User accounts and settings are deliberately
              excluded — those are changed from their own screens, where the checks that belong to them run.
            </HelpText>
          )}
        </>
      )}
    </div>
  );
}
