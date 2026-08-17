import "server-only";

import { z, type ZodSchema } from "zod";
// `Prisma` is imported as a VALUE, not merely as a type: `Prisma.sql` and `Prisma.join` are the
// tagged-template helpers `rewriteSectionPositions` builds its two statements from.
import { Prisma, type AuditAction, type ContentStatus } from "@prisma/client";

import {
  ApiError,
  clientIp,
  conflict,
  forbidden,
  notFound,
  parseJson,
  parseQuery,
  userAgent
} from "@/lib/api";
import { writeAudit, type AuditContext, type TxClient } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canEditOthersContent, canPublish as mayPublish } from "@/lib/permissions";
import {
  indexDocument,
  removeDocument,
  searchDocFromAlbum,
  searchDocFromCraft,
  searchDocFromEvent,
  searchDocFromFile,
  searchDocFromPage,
  searchDocFromPerson,
  searchDocFromPost,
  searchDocFromProject,
  searchDocFromPublication,
  searchDocFromResearchArea,
  type IndexableAlbum,
  type IndexableCraft,
  type IndexableEvent,
  type IndexableFile,
  type IndexablePage,
  type IndexablePerson,
  type IndexableProject,
  type IndexablePublication,
  type IndexablePost,
  type IndexableResearchArea,
  type SearchDocumentInput,
  type SearchEntityType
} from "@/lib/search/index";
import { slugify } from "@/lib/utils";

/**
 * The studio's write plumbing — the rules every `/api/studio/*` handler shares.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * Twenty-odd studio endpoints do the same eight things: assemble an audit context, read a paged list,
 * decide whether this person may edit this row, check a web address is free, hold an advisory lock,
 * keep the search index in step, validate a change of publication state, and re-order a list without
 * tripping a unique constraint. Written per route, each of those becomes eight nearly-identical
 * implementations, and the failure mode is always the same: ONE of them forgets the soft-delete filter,
 * or caps a page size, or resets a publication date, and nobody notices until an administrator asks why
 * an article's date moved when somebody fixed a typo in it.
 *
 * So the rules live here once. Nothing in this file talks to the network or renders anything; every
 * function either throws an `ApiError` from lib/api.ts (which `route()` turns into the standard body) or
 * returns a value the caller writes.
 *
 * FIVE HOUSE RULES, all of them load-bearing elsewhere:
 *
 *  1. **Every list is capped.** `listQuerySchema` refuses a page size above `MAX_PAGE_SIZE` rather than
 *     quietly clamping it, and `paginated()` reports `truncated` so the screen can print the honest
 *     sentence. A list that silently stops is indistinguishable from a place with no records (contract
 *     §1.6) — the single most repeated bug class in the sibling product.
 *
 *  2. **An unowned row counts as somebody else's.** `assertCanEdit` sends an imported record, or one
 *     whose author has since been deleted, to `canEditOthersContent`. The safe direction: it needs an
 *     editor rather than falling open to whoever happens to be signed in.
 *
 *  3. **A conflict NAMES the thing it collided with.** "That address is taken" leaves an editor
 *     guessing, and the row that took it is often in the recycle bin where they cannot see it at all.
 *
 *  4. **The search index is written inside the same transaction as the row.** A rolled-back save cannot
 *     leave a search result pointing at content that does not exist, and a published article cannot be
 *     missing from search because a second request failed.
 *
 *  5. **A re-publish never rewrites the original publication date.** `publishTransition` sets
 *     `publishedAt` on the FIRST publish only. Without that rule an article's own claim about when it
 *     appeared changes every time somebody corrects a spelling in it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// The audit context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who is making this change, from where.
 *
 * Assembled ONCE per request and handed to `mutateWithHistory()` / `writeAudit()`. The IP and user agent
 * come from lib/api.ts's readers, which document their own limits: `clientIp` reads a header a client
 * can set, so it is evidence for an incident review and never an authorisation input.
 *
 * `user` is nullable so a public route (a registration, a contact form) can share the shape. Inside the
 * studio it is always the result of `requireUser()`.
 */
export function buildAuditContext(request: Request, user: SessionUser | null): AuditContext {
  return {
    actor: user ? { id: user.id, email: user.email } : null,
    ipAddress: clientIp(request),
    userAgent: userAgent(request)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `parseQuery` / `parseJson` from lib/api.ts, typed for a schema that has DEFAULTS.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE CAST. Both helpers are declared as `<T>(request, schema: ZodSchema<T>) => T`, and
 * `ZodSchema<T>` is `ZodType<T, ZodTypeDef, T>` — it pins Zod's INPUT type and its OUTPUT type to the
 * same `T`. That holds for a schema built only from `min`/`max`/`email`, which is why the public routes
 * use them directly.
 *
 * It stops holding the moment a field carries `.default()` or `.transform()`: the input type has the key
 * optional and the output type has it required, so TypeScript cannot satisfy both and silently infers `T`
 * as the INPUT — leaving every defaulted field typed `| undefined` even though Zod has just filled it in.
 * Under `noUncheckedIndexedAccess` that surfaces as "'query.page' is possibly undefined" on a field with
 * a default of 1.
 *
 * These wrappers keep the runtime behaviour exactly as it is — the same validation, the same 422 body,
 * the same field errors — and take the generic over the SCHEMA instead, so `z.output<S>` is the honest
 * answer. Every studio handler reads its input through these two, and nothing else casts.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function parseStudioQuery<S extends z.ZodTypeAny>(request: Request, schema: S): z.output<S> {
  return parseQuery(request, schema as unknown as ZodSchema<z.output<S>>);
}

export function parseStudioJson<S extends z.ZodTypeAny>(
  request: Request,
  schema: S
): Promise<z.output<S>> {
  return parseJson(request, schema as unknown as ZodSchema<z.output<S>>);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prisma's error code, read structurally.
 *
 * `instanceof Prisma.PrismaClientKnownRequestError` would mean importing the client as a VALUE purely to
 * name a class, and it fails silently if two copies of the client are ever resolved. The code string is
 * the stable half of the contract. Same approach as app/api/public/events/[slug]/register/route.ts.
 */
export function prismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** P2002 — a unique index refused the write. */
export function isUniqueViolation(error: unknown): boolean {
  return prismaErrorCode(error) === "P2002";
}

/** P2034 — a write conflict or deadlock. Retryable exactly once; see the registrations route. */
export function isWriteConflict(error: unknown): boolean {
  return prismaErrorCode(error) === "P2034";
}

/**
 * A row, or a 404.
 *
 * `what` is a noun phrase that reads inside `notFound()`'s sentence: `found(row, "That page")` →
 * "That page could not be found. It may have been deleted."
 */
export function found<T>(row: T | null | undefined, what: string): T {
  if (row === null || row === undefined) throw notFound(what);
  return row;
}

/**
 * A 422 attached to ONE named field.
 *
 * The shape matches what Zod produces through `describeZodError`, so `fieldErrors` reaches the same form
 * plumbing whether the rule lives in a schema or in a handler. A cross-field rule ("the end must be after
 * the start") cannot be expressed in a per-field schema, and a banner that does not say which box is
 * wrong sends the reader hunting through a twenty-field form.
 */
export function fieldProblem(field: string, message: string): ApiError {
  return new ApiError(422, message, {
    code: "validation_failed",
    fieldErrors: { [field]: [message] }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared field vocabulary
//
// Studio forms are controlled React state and they AUTOSAVE (contract §10), which changes what a
// validator may do. Two consequences run through everything below:
//
//   • An empty box arrives as `""`, not as an absent key, and an empty PICKER arrives as `null`. Zod's
//     `.default()` fires only for a MISSING key, never for an explicit `null` (contract §14), so a
//     nullable field must say `.nullable()` and not merely carry a default.
//   • `""` is stored as SQL NULL for every optional column, so "has a subtitle" is one honest query
//     rather than "not null AND not the empty string" repeated at every call site.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-screen framing, for the twelve records that carry a picture in a column rather than in a block.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ ONE SCHEMA, GENUINELY ONE — the twelve record columns AND the nine section fields. This is a
 * re-export, and `lib/sections/schema.ts` imports `screenFramingPayload` from that same
 * `lib/media/framing-schema.ts`; there is no second copy anywhere. An earlier note here claimed the two
 * "cannot simply be shared" because this module sits beside `server-only` code — that was the state before
 * the schema was extracted, and it is worth correcting rather than deleting: the reason the shared module
 * exists at all is that it is deliberately free of `server-only` and of `zod`-in-`screens.ts`, so a studio
 * CLIENT component and a route handler can both reach it.
 *
 * The two exports differ only in how an ABSENT key is read, which is the difference between a column and a
 * payload: `screenFramingColumn` is `.nullable().optional()` (see below), while `screenFramingPayload` is
 * `.nullable().default(null)` because a section's `data` blob is written whole. `bucketKeysAgree()` checks
 * the shape against `SCREEN_BUCKET_IDS` and `scripts/screens-check.ts` asserts it, so a bucket added to
 * `SCREEN_BUCKETS` without a key here is a failing assertion rather than a field that silently never saves.
 *
 * "Twelve" counts COLUMNS, not files: fourteen route files carry this field across twenty-two call sites,
 * a collection route and a detail route for each of the seven records that own one.
 *
 * ⚠ `.nullable().optional()`, WHICH IS TWO DIFFERENT STATEMENTS AND BOTH ARE NEEDED. `optional` means "the
 * form did not send this field, leave the column alone" — every PATCH in this studio is partial. `nullable`
 * means "the editor cleared it, write NULL". Collapsing them would make clearing a framing impossible,
 * which is the same distinction the header of this section draws about an empty picker: `""` and absent
 * are different answers and a partial update has to be able to express both.
 *
 * The bounds match `isUsableCrop` in lib/media/crop.ts. Stating them here is not duplication for its own
 * sake — this is the layer that can answer a SENTENCE, and the render side's test is what stops a
 * hand-edited row drawing a broken frame rather than degrading to no crop.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export { screenFramingColumn as screenFramingField } from "@/lib/media/framing-schema";

/** Text that must be there. The message names what is missing, because "Required" does not. */
export function requiredText(max: number, missing: string) {
  return z
    .string({ invalid_type_error: missing })
    .trim()
    .min(1, missing)
    .max(max, `Keep this to ${max} characters or fewer.`);
}

/**
 * Optional text: trimmed, capped, and `""` → `null`.
 *
 * Accepts `null` as well as `""` because a client that has never had a value sends one and a client that
 * cleared the box sends the other, and refusing either would fail a save for a field nobody filled in.
 */
export function optionalText(max: number) {
  return z
    .union([z.string().trim().max(max, `Keep this to ${max} characters or fewer.`), z.null()])
    .default(null)
    .transform((value) => (value !== null && value.length > 0 ? value : null));
}

/**
 * A reference to another row by id, or nothing.
 *
 * The length cap is a shape test, not a foreign key — the database enforces the reference. It exists so a
 * pasted paragraph in a picker's hidden field cannot become a 40 kB query parameter.
 */
export function optionalId() {
  return z
    .union([z.string().trim().max(40, "That does not look like a reference to a record."), z.null()])
    .default(null)
    .transform((value) => (value !== null && value.length > 0 ? value : null));
}

/**
 * An ISO instant, or nothing.
 *
 * The studio sends `Date.prototype.toISOString()` and clears a date with `null`. `""` is accepted for the
 * same reason as in `optionalText`. An unreadable string is a 422 that NAMES THE FIELD in words a
 * non-technical reader can act on, rather than "Invalid date".
 */
export function optionalDateTime(label: string) {
  return z
    .union([z.string().trim(), z.null()])
    .default(null)
    .refine((value) => value === null || value.length === 0 || !Number.isNaN(Date.parse(value)), {
      message: `${label} could not be read as a date and time. Pick it again from the calendar.`
    })
    .transform((value) => (value === null || value.length === 0 ? null : new Date(value)));
}

/** An ISO instant that must be there — an event's start, for instance. */
export function requiredDateTime(label: string, missing: string) {
  return z
    .string({ invalid_type_error: missing })
    .trim()
    .min(1, missing)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: `${label} could not be read as a date and time. Pick it again from the calendar.`
    })
    .transform((value) => new Date(value));
}

/** A whole number from a number input, clamped to a sane range. `z.coerce` because the box sends a string. */
export function boundedInt(options: { min: number; max: number; fallback: number }) {
  return z.coerce
    .number()
    .int("Enter a whole number.")
    .min(options.min, `Enter ${options.min} or more.`)
    .max(options.max, `Enter ${options.max} or fewer.`)
    .default(options.fallback);
}

/**
 * Every `ContentStatus`, as a tuple.
 *
 * `satisfies` rather than an annotation, so adding a status to the Prisma enum without adding it here is
 * a compile error rather than a filter that silently cannot select the new state.
 */
export const CONTENT_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "SCHEDULED",
  "PUBLISHED",
  "ARCHIVED"
] as const satisfies readonly ContentStatus[];

export const statusSchema = z.enum(CONTENT_STATUSES);

/** The same list plus `""` for "any status", which is what an unset filter means. */
export const statusFilterSchema = z.union([z.literal(""), statusSchema]).default("");

/**
 * A web address fragment, as stored.
 *
 * ⚠ LOWER CASE IS ENFORCED ON WRITE, even though `normalisePageSlug()` in lib/pages.ts deliberately
 * leaves case alone on READ. The two are not in conflict: reading must not fold `/Research` onto a row
 * saved as `research` (that would serve one page at two URLs and earn a duplicate-content report), and
 * writing must not create the pair in the first place. `SlugField` in the studio already lower-cases and
 * slugifies each segment, so the steady state of the form always satisfies this — the refusal exists for
 * a pasted address and for anything that does not come from that field.
 *
 * The message shows the transformation rather than describing it, because "kebab-case" is jargon and an
 * administrator who has just pasted "Annual Report 2026" needs to see what to type instead.
 */
export function slugSchema(options: { allowEmpty?: boolean; allowSlashes?: boolean } = {}) {
  const segment = "[a-z0-9]+(?:-[a-z0-9]+)*";
  const shape = options.allowSlashes
    ? new RegExp(`^${segment}(?:/${segment})*$`)
    : new RegExp(`^${segment}$`);

  const advice = options.allowSlashes
    ? "A web address may only contain lower-case letters, numbers and hyphens, with / between its parts. “Annual Report 2026” becomes “annual-report-2026”."
    : "A web address may only contain lower-case letters, numbers and hyphens. “Annual Report 2026” becomes “annual-report-2026”.";

  return z
    .string({ invalid_type_error: advice })
    .trim()
    .max(96, "That web address is too long. Keep it to 96 characters or fewer.")
    .refine((value) => (value.length === 0 ? options.allowEmpty === true : shape.test(value)), {
      message: options.allowEmpty
        ? advice
        : `${advice} It cannot be left empty — it is the last part of the page's address.`
    });
}

/** A suggested address from a title, for a create form that left the field blank. */
export function slugFromTitle(title: string): string {
  return slugify(title);
}

// ─────────────────────────────────────────────────────────────────────────────
// List queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The hard cap on how many rows one request may ask for.
 *
 * A client-supplied unbounded page size is a denial of service with a database bill attached: one request
 * for `pageSize=1000000` reads the whole table, serialises it and holds a connection while it does. 100
 * is above every studio screen's own page size (25) with room for a picker that wants more.
 */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * The furthest page anybody may ask for.
 *
 * `skip` is an OFFSET, and its cost grows linearly with the number of rows stepped over. A person never
 * reaches page 500 of a studio list; a crawler or a runaway loop does.
 */
export const MAX_PAGE = 500;

/**
 * The shared list query.
 *
 * A plain `ZodObject`, deliberately: every route `.extend()`s it with its own filters, and a schema
 * wrapped in a `.transform()` cannot be extended.
 *
 * `limit` is an ALIAS for `pageSize`, and it is not redundant — `LinkDialog` and the entity pickers in
 * components/studio/ already send `?limit=`. Read the effective window with `pageWindow()`, which prefers
 * it; a route that reads `query.pageSize` directly would silently ignore what those screens asked for.
 */
export const listQuerySchema = z.object({
  page: z.coerce
    .number()
    .int("The page number must be a whole number.")
    .min(1, "Page numbers start at 1.")
    .max(MAX_PAGE, `This list stops at page ${MAX_PAGE}. Narrow the search instead.`)
    .default(1),
  pageSize: z.coerce
    .number()
    .int("The number of rows must be a whole number.")
    .min(1, "Ask for at least one row.")
    .max(MAX_PAGE_SIZE, `Ask for at most ${MAX_PAGE_SIZE} rows at a time.`)
    .default(DEFAULT_PAGE_SIZE),
  limit: z.coerce
    .number()
    .int("The number of rows must be a whole number.")
    .min(1, "Ask for at least one row.")
    .max(MAX_PAGE_SIZE, `Ask for at most ${MAX_PAGE_SIZE} rows at a time.`)
    .optional(),
  q: z.string().trim().max(160, "That search is too long. Try fewer words.").default(""),
  /** A key from the route's own allowlist. Resolved by `resolveSort`, never used as a column directly. */
  sort: z.string().trim().max(40).default(""),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: statusFilterSchema,
  /**
   * Whether soft-deleted rows are in scope. `exclude` by default: the recycle bin is its own screen, and
   * a list that quietly mixed deleted rows into live ones would let an editor "fix" a row they had
   * already thrown away.
   */
  bin: z.enum(["exclude", "only", "include"]).default("exclude")
});

export type ListQuery = z.infer<typeof listQuerySchema>;

/** The window one request asks for, with `limit` honoured over `pageSize`. See `listQuerySchema`. */
export function pageWindow(query: { page: number; pageSize: number; limit?: number | undefined }): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const pageSize = query.limit ?? query.pageSize;
  return { page: query.page, pageSize, skip: (query.page - 1) * pageSize, take: pageSize };
}

/**
 * Turn a sort key from the wire into a Prisma `orderBy`.
 *
 * TWO things this does that a hand-rolled `orderBy` in a route forgets:
 *
 *  1. **It only ever emits a column from the allowlist.** A column name taken straight from the query
 *     string is either a Prisma runtime error or, worse, a way to sort by a column the screen does not
 *     show and infer its values.
 *  2. **It appends `id` as a tiebreaker.** Two rows with the same `updatedAt` have no defined order, so
 *     page 2 can repeat a row from page 1 and omit another entirely. A total ordering is the only kind
 *     that can be paged.
 *
 * An UNKNOWN key falls back silently rather than failing: a bookmarked list from a release where "author"
 * was sortable should still render, and a 422 about a sort key nobody typed is not actionable.
 */
export function resolveSort(
  query: { sort: string; order: "asc" | "desc" },
  allowed: Readonly<Record<string, string>>,
  fallbackKey: string
): Record<string, "asc" | "desc">[] {
  const column = allowed[query.sort] ?? allowed[fallbackKey] ?? "id";
  const orderBy: Record<string, "asc" | "desc">[] = [{ [column]: query.order }];
  if (column !== "id") orderBy.push({ id: query.order });
  return orderBy;
}

/**
 * A case-insensitive "contains" across several columns.
 *
 * ⚠ RETURNS AN `OR`, so it must never be spread into an object that already has one — the second wins
 * and the first vanishes. Where a query already carries an `OR` (anything from `livePublishableWhere()`),
 * nest both under `AND: [...]`.
 */
export function textSearchWhere(q: string, fields: readonly string[]): Record<string, unknown> {
  const term = q.trim();
  if (term.length === 0 || fields.length === 0) return {};
  return {
    OR: fields.map((field) => ({ [field]: { contains: term, mode: "insensitive" } }))
  };
}

/** The soft-delete half of a list's `where`, from `bin`. */
export function binWhere(bin: "exclude" | "only" | "include"): Record<string, unknown> {
  if (bin === "only") return { deletedAt: { not: null } };
  if (bin === "include") return {};
  return { deletedAt: null };
}

/**
 * One page of a list, with everything a screen needs to describe it honestly.
 *
 * `items` and `rows` are THE SAME ARRAY under two names. The studio's list screens were written against
 * `items` (see `InquiryListResponse`, `MediaListResponse`, `StudioFileRow[]`) and this contract names
 * `rows`; publishing one and not the other would leave half the product reading an empty list from a
 * successful response. The duplication costs bytes bounded by `MAX_PAGE_SIZE` and removes a class of
 * integration failure that is invisible until a screen is opened.
 *
 * `truncated` is REQUIRED rather than derived by each caller: it is true whenever this response does not
 * carry every matching record, whether because of paging or because of a cap, and it is what the "showing
 * 25 of 312" sentence is built from.
 */
export interface PaginatedResult<T> {
  items: T[];
  /** The same array as `items`. See above. */
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  /** At least 1, so a screen never prints "page 1 of 0" for an empty list. */
  pageCount: number;
  truncated: boolean;
}

export function paginated<T>(
  rows: readonly T[],
  total: number,
  page: number,
  pageSize: number
): PaginatedResult<T> {
  const list = [...rows];
  const size = Math.max(1, pageSize);
  return {
    items: list,
    rows: list,
    total,
    page,
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
    truncated: total > list.length
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership
// ─────────────────────────────────────────────────────────────────────────────

/** The columns that can record who owns a row. Whichever one the model has. */
export interface OwnedRow {
  authorId?: string | null;
  uploaderId?: string | null;
}

export function ownerOf(row: OwnedRow): string | null {
  return row.authorId ?? row.uploaderId ?? null;
}

/**
 * May this person edit this row?
 *
 * Own content always; anyone else's needs `canEditOthersContent` (EDITOR and above — a RESEARCHER
 * deliberately does not qualify, see lib/permissions.ts). An UNOWNED row — imported content, or a row
 * whose author has since been deleted — counts as SOMEBODY ELSE'S, which is the safe direction.
 *
 * The two refusals say different things because the reader's next action differs: one is "ask the person
 * who wrote it", the other is "there is nobody to ask, so ask an editor".
 */
export function assertCanEdit(user: SessionUser, row: OwnedRow, what = "this item"): void {
  const owner = ownerOf(row);
  if (owner !== null && owner === user.id) return;
  if (canEditOthersContent(user)) return;

  throw forbidden(
    owner === null
      ? `${capitalise(what)} has no author recorded, so it is treated as somebody else's work. An editor can change it, or an administrator can raise your access.`
      : `${capitalise(what)} was written by somebody else. An editor can change it — ask them, or ask an administrator to raise your access.`
  );
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Web addresses
// ─────────────────────────────────────────────────────────────────────────────

interface SlugLookup {
  /** What an administrator calls this sort of record, lower case, for the refusal sentence. */
  noun: string;
  find: (
    client: TxClient,
    slug: string
  ) => Promise<{ id: string; label: string; deletedAt: Date | null } | null>;
}

/**
 * Every model with a unique `slug`, and how to describe the row that already has one.
 *
 * Written out rather than generated: a Prisma delegate cannot be indexed by a string without erasing the
 * type of everything it returns, and the label column differs per model (`title` here, `name` there). A
 * model missing from this table is a compile error at the call site, not a silent skip.
 *
 * The models WITHOUT a `deletedAt` column report `null` for it — they are hard-deleted, so a conflicting
 * row is always one an editor can see.
 */
const SLUG_LOOKUPS = {
  page: {
    noun: "page",
    find: async (client, slug) => {
      const row = await client.page.findUnique({
        where: { slug },
        select: { id: true, title: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.title, deletedAt: row.deletedAt } : null;
    }
  },
  post: {
    noun: "news article",
    find: async (client, slug) => {
      const row = await client.post.findUnique({
        where: { slug },
        select: { id: true, title: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.title, deletedAt: row.deletedAt } : null;
    }
  },
  event: {
    noun: "event",
    find: async (client, slug) => {
      const row = await client.coeEvent.findUnique({
        where: { slug },
        select: { id: true, title: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.title, deletedAt: row.deletedAt } : null;
    }
  },
  album: {
    noun: "gallery album",
    find: async (client, slug) => {
      const row = await client.galleryAlbum.findUnique({
        where: { slug },
        select: { id: true, title: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.title, deletedAt: row.deletedAt } : null;
    }
  },
  person: {
    noun: "person",
    find: async (client, slug) => {
      const row = await client.person.findUnique({
        where: { slug },
        select: { id: true, name: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.name, deletedAt: row.deletedAt } : null;
    }
  },
  project: {
    noun: "project",
    find: async (client, slug) => {
      const row = await client.project.findUnique({
        where: { slug },
        select: { id: true, title: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.title, deletedAt: row.deletedAt } : null;
    }
  },
  publication: {
    noun: "publication",
    find: async (client, slug) => {
      const row = await client.publication.findUnique({
        where: { slug },
        select: { id: true, title: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.title, deletedAt: row.deletedAt } : null;
    }
  },
  researchArea: {
    noun: "research area",
    find: async (client, slug) => {
      const row = await client.researchArea.findUnique({
        where: { slug },
        select: { id: true, title: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.title, deletedAt: row.deletedAt } : null;
    }
  },
  craft: {
    noun: "craft",
    find: async (client, slug) => {
      const row = await client.craft.findUnique({
        where: { slug },
        select: { id: true, name: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.name, deletedAt: row.deletedAt } : null;
    }
  },
  file: {
    noun: "file",
    find: async (client, slug) => {
      const row = await client.fileAsset.findUnique({
        where: { slug },
        select: { id: true, title: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.title, deletedAt: row.deletedAt } : null;
    }
  },
  partner: {
    noun: "partner",
    find: async (client, slug) => {
      const row = await client.partner.findUnique({
        where: { slug },
        select: { id: true, name: true, deletedAt: true }
      });
      return row ? { id: row.id, label: row.name, deletedAt: row.deletedAt } : null;
    }
  },
  category: {
    noun: "news category",
    find: async (client, slug) => {
      const row = await client.category.findUnique({
        where: { slug },
        select: { id: true, name: true }
      });
      return row ? { id: row.id, label: row.name, deletedAt: null } : null;
    }
  },
  tag: {
    noun: "tag",
    find: async (client, slug) => {
      const row = await client.tag.findUnique({ where: { slug }, select: { id: true, name: true } });
      return row ? { id: row.id, label: row.name, deletedAt: null } : null;
    }
  },
  craftRegion: {
    noun: "place",
    find: async (client, slug) => {
      const row = await client.craftRegion.findUnique({
        where: { slug },
        select: { id: true, name: true }
      });
      return row ? { id: row.id, label: row.name, deletedAt: null } : null;
    }
  },
  craftSchool: {
    noun: "tradition",
    find: async (client, slug) => {
      const row = await client.craftSchool.findUnique({
        where: { slug },
        select: { id: true, name: true }
      });
      return row ? { id: row.id, label: row.name, deletedAt: null } : null;
    }
  },
  mediaCollection: {
    noun: "media collection",
    find: async (client, slug) => {
      const row = await client.mediaCollection.findUnique({
        where: { slug },
        select: { id: true, name: true }
      });
      return row ? { id: row.id, label: row.name, deletedAt: null } : null;
    }
  }
} satisfies Record<string, SlugLookup>;

export type SluggedModel = keyof typeof SLUG_LOOKUPS;

/**
 * Refuse a web address that is already in use, and SAY WHAT HAS IT.
 *
 * "That address is taken" leaves an editor guessing, and the row holding it is very often in the recycle
 * bin — invisible from every list they can reach, so no amount of looking would have found it. Both
 * branches therefore name the record, and the deleted branch says what to do about it.
 *
 * `excludeId` is the row being edited: saving a page without changing its address must not collide with
 * itself.
 *
 * Pass `client` to run inside a transaction. Even then this is a CHECK and not a guarantee — two
 * simultaneous creates can both pass it — which is why every slug column carries a unique index. Catch
 * P2002 and answer the same 409.
 */
export async function assertSlugAvailable(
  model: SluggedModel,
  slug: string,
  excludeId?: string | null,
  client: TxClient = prisma
): Promise<void> {
  const lookup: SlugLookup = SLUG_LOOKUPS[model];
  const existing = await lookup.find(client, slug);
  if (!existing) return;
  if (excludeId && existing.id === excludeId) return;

  const address = slug.length === 0 ? "the site's front page address" : `“${slug}”`;

  throw conflict(
    existing.deletedAt
      ? `${capitalise(address)} is already used by the ${lookup.noun} “${existing.label}”, which is in the recycle bin. Restore it and give it a different address, or empty the bin, before using this one.`
      : `${capitalise(address)} is already used by the ${lookup.noun} “${existing.label}”. Choose a different address.`
  );
}

/**
 * Refuse a picture that is not in the library any more.
 *
 * Every media reference is `onDelete: SetNull` at the referring side (prisma/schema.prisma), so writing a
 * stale id would not fail — it would succeed and leave the column pointing at a row in the recycle bin,
 * and the picture would simply stop appearing with nothing on screen to say why. Checking here turns that
 * into a message attached to the field the reader just used.
 *
 * A `null` id is "no picture chosen", which is always allowed.
 */
export async function assertMediaAvailable(
  client: TxClient,
  id: string | null | undefined,
  options: { field: string; what: string }
): Promise<void> {
  if (!id) return;
  const row = await client.mediaAsset.findFirst({
    where: { id, deletedAt: null },
    select: { id: true }
  });
  if (row) return;

  const message = `The ${options.what} you chose is no longer in the media library. Choose another.`;
  throw new ApiError(422, message, {
    code: "validation_failed",
    fieldErrors: { [options.field]: [message] }
  });
}

/**
 * Turn tag NAMES into tag ids, creating the ones that do not exist yet.
 *
 * The studio's tag fields are free text with suggestions, not a closed list — an editor typing "handloom"
 * for the first time must not have to go and create a tag first. `Tag.slug` is the identity, so "Handloom",
 * "handloom" and " Handloom " are one tag rather than three, and the first spelling anybody used is the name
 * that is kept (`update: {}` leaves an existing name alone: renaming a tag from a post editor would rename
 * it everywhere it is used, silently).
 *
 * A name that slugifies to nothing — punctuation or an emoji alone — is dropped rather than stored under an
 * empty slug, which the unique index would collapse onto whichever tag got there first.
 *
 * Shared by the newsroom and by events, which both hang off `Tag`. Each caller writes its own join table.
 */
export async function resolveTagIds(tx: TxClient, names: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const slug = slugify(name);
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);

    const row = await tx.tag.upsert({
      where: { slug },
      create: { slug, name },
      update: {},
      select: { id: true }
    });
    ids.push(row.id);
  }

  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Advisory locks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a lock survives without a heartbeat.
 *
 * ⚠ THE EXPIRY IS NOT OPTIONAL. A lock that outlives the tab that took it strands the content forever:
 * the editor closed a laptop, the row still says they are editing, and nobody else can be told it is
 * free. Five minutes is five missed heartbeats at the studio's 60-second interval (`LOCK_HEARTBEAT_MS` in
 * PageEditor), which is long enough to survive a sleeping laptop's network gap and short enough that a
 * colleague waiting for a page does not go and find somebody.
 */
export const LOCK_TTL_MS = 5 * 60_000;

export interface LockHolder {
  userId: string;
  userName: string;
  userEmail: string;
  /** When they opened it — NOT when the lock was last refreshed. See `acquireLock`. */
  acquiredAt: Date;
  expiresAt: Date;
}

/** What every lock call answers: who holds it, and whether that is you. */
export interface LockState {
  holder: LockHolder | null;
  mine: boolean;
}

const lockUserSelect = { select: { id: true, name: true, email: true } } as const;

interface LockRow {
  userId: string;
  acquiredAt: Date;
  expiresAt: Date;
  user: { id: string; name: string; email: string };
}

function toHolder(row: LockRow): LockHolder {
  return {
    userId: row.user.id,
    userName: row.user.name,
    userEmail: row.user.email,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt
  };
}

/** An expired lock is reported as no lock at all — the row is merely rubbish nobody has cleared yet. */
function liveLock(row: LockRow | null, now: Date): LockRow | null {
  if (!row) return null;
  return row.expiresAt.getTime() > now.getTime() ? row : null;
}

/** Who holds this lock right now, without touching it. For a GET, and for the loser of a race. */
export async function readLock(
  entityType: string,
  entityId: string,
  user: SessionUser,
  client: TxClient = prisma
): Promise<LockState> {
  const row = await client.contentLock.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { userId: true, acquiredAt: true, expiresAt: true, user: lockUserSelect }
  });
  const live = liveLock(row, new Date());
  if (!live) return { holder: null, mine: false };
  return { holder: toHolder(live), mine: live.userId === user.id };
}

/**
 * Take the lock if it is free, refresh it if it is already yours, and REPORT rather than refuse if
 * somebody else has it.
 *
 * This never throws for a held lock, because `ContentLock` is advisory by design (prisma/schema.prisma):
 * it says "somebody else has this open", names them and offers a take-over. A lock that actually locked
 * would strand content the moment somebody shut a laptop, and it is what makes editors work outside the
 * CMS to hit a deadline.
 *
 * `acquiredAt` is preserved when the lock is refreshed and RESET when it is claimed from an expired
 * holder. The studio prints "has had this page open since 14:32", and a heartbeat that pushed that
 * forward would make the sentence say "since a moment ago" for somebody who has been in it all morning.
 */
export async function acquireLock(
  user: SessionUser,
  entityType: string,
  entityId: string
): Promise<LockState> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.contentLock.findUnique({
        where: { entityType_entityId: { entityType, entityId } },
        select: { userId: true, acquiredAt: true, expiresAt: true, user: lockUserSelect }
      });
      const live = liveLock(existing, now);

      if (live && live.userId !== user.id) return { holder: toHolder(live), mine: false };

      const row = await tx.contentLock.upsert({
        where: { entityType_entityId: { entityType, entityId } },
        create: { entityType, entityId, userId: user.id, expiresAt },
        // A lock inherited from an EXPIRED holder is a new hold and gets a new `acquiredAt`; refreshing
        // your own keeps the original.
        update: live ? { expiresAt } : { userId: user.id, acquiredAt: now, expiresAt },
        select: { userId: true, acquiredAt: true, expiresAt: true, user: lockUserSelect }
      });

      return { holder: toHolder(row), mine: true };
    });
  } catch (error) {
    // Two editors opened the same row within the same millisecond and both found no lock. The unique
    // index on (entityType, entityId) refused the second insert, which is the point of having one; the
    // honest answer for the loser is who actually won.
    if (isUniqueViolation(error)) return readLock(entityType, entityId, user);
    throw error;
  }
}

/**
 * Push your own lock's expiry forward.
 *
 * `userId` AND an unexpired `expiresAt` are both in the `where`, so a heartbeat can never resurrect a
 * hold that lapsed and was taken by somebody else in the meantime — it reports the new holder instead.
 */
export async function refreshLock(
  user: SessionUser,
  entityType: string,
  entityId: string
): Promise<LockState> {
  const now = new Date();
  await prisma.contentLock.updateMany({
    where: { entityType, entityId, userId: user.id, expiresAt: { gt: now } },
    data: { expiresAt: new Date(now.getTime() + LOCK_TTL_MS) }
  });

  // Read back either way, rather than answering from what was just written. A heartbeat that updated nothing
  // is the ONE case that matters — the lock lapsed and somebody else took it — and the caller needs to be
  // told who has it now, not merely that the refresh did nothing.
  return readLock(entityType, entityId, user);
}

/**
 * Give up your own lock. Somebody else's is left alone — that is what a take-over is for.
 *
 * `deleteMany`, so releasing a lock that has already expired and been cleared is a no-op rather than a
 * P2025. A release is best-effort by nature: the studio fires it from a cleanup function it cannot await.
 */
export async function releaseLock(
  user: SessionUser,
  entityType: string,
  entityId: string
): Promise<void> {
  await prisma.contentLock.deleteMany({ where: { entityType, entityId, userId: user.id } });
}

/**
 * Take a lock somebody else holds — and RECORD IT.
 *
 * A take-over is recorded rather than blocked (prisma/schema.prisma). The audit entry is filed against
 * the CONTENT, not against the lock row, which is why this does not use `mutateWithHistory()`: that
 * helper takes the entity id from the row it wrote, so the entry would be filed against a `ContentLock`
 * id nobody will ever search for. An editor reading an article's history needs to see "editing was taken
 * over by X" beside the saves it explains.
 *
 * No revision is written: nothing about the content changed.
 */
export async function takeOverLock(
  context: AuditContext,
  user: SessionUser,
  entityType: string,
  entityId: string,
  entityLabel?: string | null
): Promise<LockState> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  return prisma.$transaction(async (tx) => {
    const previous = await tx.contentLock.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
      select: { userId: true, acquiredAt: true, expiresAt: true, user: lockUserSelect }
    });

    const row = await tx.contentLock.upsert({
      where: { entityType_entityId: { entityType, entityId } },
      create: { entityType, entityId, userId: user.id, expiresAt },
      update: { userId: user.id, acquiredAt: now, expiresAt },
      select: { userId: true, acquiredAt: true, expiresAt: true, user: lockUserSelect }
    });

    if (previous && previous.userId !== user.id) {
      await writeAudit(tx, context, {
        action: "UPDATE",
        entityType,
        entityId,
        entityLabel: entityLabel ?? null,
        before: {
          editingHeldBy: previous.user.email,
          editingHeldSince: previous.acquiredAt,
          lockHadExpired: previous.expiresAt.getTime() <= now.getTime()
        },
        after: { editingHeldBy: user.email, takenOver: true }
      });
    }

    return { holder: toHolder(row), mine: true };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The search index
// ─────────────────────────────────────────────────────────────────────────────

/** The row shape each indexed entity type needs. Keeps a call site from indexing a page as a person. */
export interface SearchRowByType {
  page: IndexablePage;
  person: IndexablePerson;
  "research-area": IndexableResearchArea;
  project: IndexableProject;
  publication: IndexablePublication;
  post: IndexablePost;
  event: IndexableEvent;
  craft: IndexableCraft;
  album: IndexableAlbum;
  file: IndexableFile;
}

function documentFor(entityType: SearchEntityType, row: unknown, now: Date): SearchDocumentInput {
  // The generic signature below keeps every call site honest; inside the switch the indexed type cannot
  // be narrowed by TypeScript, so each branch restates what the key already proved.
  switch (entityType) {
    case "page":
      return searchDocFromPage(row as IndexablePage, now);
    case "person":
      return searchDocFromPerson(row as IndexablePerson, now);
    case "research-area":
      return searchDocFromResearchArea(row as IndexableResearchArea, now);
    case "project":
      return searchDocFromProject(row as IndexableProject, now);
    case "publication":
      return searchDocFromPublication(row as IndexablePublication, now);
    case "post":
      return searchDocFromPost(row as IndexablePost, now);
    case "event":
      return searchDocFromEvent(row as IndexableEvent, now);
    case "craft":
      return searchDocFromCraft(row as IndexableCraft, now);
    case "album":
      return searchDocFromAlbum(row as IndexableAlbum, now);
    case "file":
      return searchDocFromFile(row as IndexableFile, now);
  }
}

/**
 * Write — or withdraw — one row's search document, INSIDE the caller's transaction.
 *
 * `tx` is not optional by accident. Indexing in a second request, or after the transaction commits,
 * gives the index two ways to disagree with the data: a rolled-back save that left a result pointing at
 * content that never existed, and a successful save whose index write failed silently. Both were real in
 * the sibling product; joining the transaction removes the possibility rather than the likelihood.
 *
 * A SOFT-DELETED ROW IS REMOVED FROM THE INDEX, not merely marked unpublished. The recycle bin is reached
 * from the studio, never from search (lib/search/index.ts), and `reindexAll()` skips deleted rows — so
 * leaving a row behind here would make a full rebuild change the search results.
 */
export async function syncSearchDocument<T extends SearchEntityType>(
  tx: TxClient,
  entityType: T,
  row: SearchRowByType[T],
  now: Date = new Date()
): Promise<void> {
  // Every indexable shape carries `id`, and every one that can be soft-deleted carries `deletedAt`; the
  // generic index type does not resolve to a single object type, hence the read through a narrow view.
  const view = row as unknown as { id: string; deletedAt?: Date | null };

  if (view.deletedAt) {
    await removeDocument(tx, entityType, view.id);
    return;
  }

  await indexDocument(tx, documentFor(entityType, row, now));
}

/** Withdraw a row from the index. For a delete route that has no row shape to hand. */
export async function dropSearchDocument(
  tx: TxClient,
  entityType: SearchEntityType,
  entityId: string
): Promise<void> {
  await removeDocument(tx, entityType, entityId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Publication state
// ─────────────────────────────────────────────────────────────────────────────

/** The publication columns this decision reads. A model without `publishAt` simply omits it. */
export interface PublishableRow {
  status: ContentStatus;
  publishedAt?: Date | null;
  publishAt?: Date | null;
}

/** What the request asked for. `undefined` means "not mentioned", which is not the same as `null`. */
export interface PublishIntent {
  status?: ContentStatus | undefined;
  publishAt?: Date | null | undefined;
}

/**
 * What to write, and what to call it in the log.
 *
 * Only the keys that must CHANGE are present. An omitted key in a Prisma `update` means "leave this
 * column alone", which is exactly the guarantee `publishedAt` needs.
 */
export interface PublishDecision {
  status: ContentStatus;
  /** Present only on a first publish. Absent means: do not touch the column. */
  publishedAt?: Date;
  /** Present only when it must be cleared, and only for a model that has the column. */
  publishAt?: null;
  /** PUBLISH / UNPUBLISH / ARCHIVE / UPDATE — for `mutateWithHistory`'s `action`. */
  action: AuditAction;
}

function isLiveStatus(status: ContentStatus): boolean {
  return status === "PUBLISHED" || status === "SCHEDULED";
}

/**
 * Validate a change of publication state, and work out what it does to the dates.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FOUR RULES, and the bug each one prevents:
 *
 *  1. **Going live, or coming off the site, needs `canPublish`.** Editing an already-published row does
 *     NOT: an author fixing a typo on their own live article must not be told they need publishing
 *     rights. So the permission is checked only when the status actually crosses the line.
 *
 *  2. **A SCHEDULED row needs a date, and a NEW schedule needs a FUTURE one.** The "future" half applies
 *     only when the schedule is being introduced or its date changed. A row scheduled for yesterday is
 *     already live (publication is resolved at read time, lib/content.ts) — refusing to save it would
 *     leave an editor unable to correct a page that is in front of readers, which is the worst possible
 *     moment to refuse a save.
 *
 *  3. **`publishedAt` is set on the FIRST publish only.** A re-publish must not rewrite it, or the
 *     article's own claim about when it appeared changes every time somebody fixes a typo. It is never
 *     CLEARED either: unpublishing keeps the original date so that re-publishing restores the truth
 *     rather than inventing a new one.
 *
 *  4. **A model with no `publishAt` column cannot be SCHEDULED.** `liveStatusWhere()` treats only
 *     PUBLISHED as live for those models, so a scheduled event would sit there looking imminent and
 *     never appear. Pass `schedulable: true` for `Page` and `Post`, which have the columns, and leave it
 *     alone for everything else — the default is the safe direction.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The sentences for rules 2 and 4 are word-for-word the ones `statusProblems()` in
 * components/studio/StatusControl.tsx shows in the form. Duplicated rather than imported because that
 * module is a client component; if one changes, change both, or the studio will refuse a save for one
 * reason and explain a different one.
 */
export function publishTransition(
  row: PublishableRow,
  next: PublishIntent,
  user: SessionUser,
  options: { schedulable?: boolean; now?: Date } = {}
): PublishDecision {
  const now = options.now ?? new Date();
  const schedulable = options.schedulable === true;

  const status = next.status ?? row.status;
  const publishAtChanged = next.publishAt !== undefined;
  const publishAt = publishAtChanged ? (next.publishAt ?? null) : (row.publishAt ?? null);

  const wasLive = isLiveStatus(row.status);
  const willBeLive = isLiveStatus(status);
  const changed = status !== row.status;

  // ── Rule 4 ────────────────────────────────────────────────────────────────
  if (status === "SCHEDULED" && !schedulable) {
    throw fieldProblem(
      "status",
      "This kind of record cannot be scheduled. Choose Draft or Published instead."
    );
  }

  // ── Rule 1 ────────────────────────────────────────────────────────────────
  if (changed && (willBeLive || wasLive) && !mayPublish(user)) {
    throw forbidden(
      willBeLive
        ? "Publishing needs publishing rights. Save it as a draft or send it for review, and an editor will put it out."
        : "Taking something off the site needs publishing rights. Ask an editor to do it."
    );
  }

  // ── Rule 2 ────────────────────────────────────────────────────────────────
  if (status === "SCHEDULED") {
    if (publishAt === null) {
      throw fieldProblem(
        "publishAt",
        "A scheduled item needs a date and time to go public, or it never will."
      );
    }
    const introducing = changed || publishAtChanged;
    if (introducing && publishAt.getTime() <= now.getTime()) {
      throw fieldProblem(
        "publishAt",
        "The date this is scheduled for has already gone. Pick a time in the future, or publish it now."
      );
    }
  }

  const decision: PublishDecision = { status, action: describeTransition(row.status, status) };

  // ── Rule 3 ────────────────────────────────────────────────────────────────
  // PUBLISHED, and never published before. A SCHEDULED row deliberately does NOT get a `publishedAt`:
  // it has not appeared yet, and app/api/cron/publish stamps it with the SCHEDULED time when it does, so
  // the recorded date is the one the schedule promised rather than whenever the job happened to run.
  if (status === "PUBLISHED" && !row.publishedAt) {
    decision.publishedAt = now;
  }

  // Publishing now, over the top of a schedule that has not fired. The row is live the moment the status
  // says PUBLISHED (livePublishableWhere ignores `publishAt` for a published row), so leaving a future
  // date behind would make the studio's own "Scheduled for 4 June" sentence a lie about a live page.
  if (schedulable && status === "PUBLISHED" && publishAt && publishAt.getTime() > now.getTime()) {
    decision.publishAt = null;
  }

  return decision;
}

/**
 * The audit verb for a status change.
 *
 * ARCHIVE beats UNPUBLISH when the destination is ARCHIVED — both took it off the site, but only one
 * says the row was retired deliberately rather than sent back for more work.
 */
function describeTransition(from: ContentStatus, to: ContentStatus): AuditAction {
  if (from === to) return "UPDATE";
  if (isLiveStatus(to)) return "PUBLISH";
  if (to === "ARCHIVED") return "ARCHIVE";
  if (isLiveStatus(from)) return "UNPUBLISH";
  return "UPDATE";
}

// ─────────────────────────────────────────────────────────────────────────────
// Dense ordering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rewrite `PageSection.position` for a whole page, in the order given.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS IS TWO PASSES ON PURPOSE, AND THE REASON IS THE MOST LIKELY PLACE IN THE STUDIO FOR A
 * "REORDERING SOMETIMES FAILS" BUG.
 *
 * `PageSection` carries `@@unique([pageId, position])`, which Prisma creates as a plain unique INDEX.
 * Postgres checks one of those PER ROW, the instant that row is written — not at the end of the
 * statement, and not at the end of the transaction. So the obvious loop is wrong:
 *
 *     A(0) B(1) C(2)   →   move C to the front
 *     UPDATE C SET position = 0    ← A is still at 0. The index refuses. Transaction dead.
 *
 * ⚠ AND FOR THE SAME REASON, COLLAPSING THIS INTO ONE `UPDATE … FROM (VALUES …)` DOES NOT WORK, however
 * much it looks as though it should. Verified against Postgres 17 on a table carrying exactly this
 * index: a single statement that permutes the column fails with 23505 `Key ("pageId", "position")
 * already exists`, because the rows are still checked one at a time as the statement walks them. An
 * earlier version of this comment claimed the check happened at the end of the statement; it does not,
 * and that claim is what makes the one-statement version look safe. Deferring is not available either —
 * a unique INDEX cannot be deferred at all in Postgres, only a unique CONSTRAINT can, and swapping one
 * for the other would put Prisma permanently in drift.
 *
 * So the negatives stay: every row is first parked in a range nothing can occupy, then brought to its
 * final position. `-1 - rank` is unique per row and can never collide with a final value, which is
 * always `>= 0`.
 *
 * WHAT DID CHANGE IS THE STATEMENT COUNT: two, not two per block. Each pass used to be a loop of
 * `updateMany` calls, so a page of twenty blocks spent forty network round trips inside one interactive
 * transaction — and Prisma closes a transaction that outlives its timeout, raising `P2028`, which
 * reaches an editor as "Something went wrong on our side". That is exactly how the people board came to
 * be unable to save an order at all (app/api/studio/people/reorder/route.ts). Two statements cost the
 * same whether a page holds three blocks or three hundred.
 *
 * The `pageId` is in both `WHERE` clauses, so an id belonging to ANOTHER page cannot silently move that
 * page's block into this one. The first pass's row count is the membership check: short of the whole
 * list means an id is not on this page, and that is a refusal rather than a quiet no-op.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * Re-index a page after its BLOCKS changed.
 *
 * A page's searchable text is built from the words inside its blocks (`plainTextFromSections`), so adding,
 * editing, hiding, re-ordering or deleting one changes what the page matches. Every one of those lives in
 * a different handler, and each of them calling this is what stops four of them drifting into three
 * different ideas of what a page's search document contains.
 *
 * A page that has vanished between the write and this call is skipped rather than treated as an error: the
 * only way that happens is a concurrent delete, and that delete has already withdrawn the document.
 */
export async function reindexPage(tx: TxClient, pageId: string): Promise<void> {
  const page = await tx.page.findUnique({
    where: { id: pageId },
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
      deletedAt: true
    }
  });
  if (!page) return;

  const sections = await tx.pageSection.findMany({
    where: { pageId },
    select: { isVisible: true, data: true }
  });

  await syncSearchDocument(tx, "page", { ...page, sections });
}

export async function rewriteSectionPositions(
  tx: TxClient,
  pageId: string,
  orderedIds: readonly string[]
): Promise<void> {
  // An empty page has nothing to renumber, and `VALUES ()` is not a statement Postgres will parse.
  if (orderedIds.length === 0) return;

  /**
   * Rebuilt per call rather than held in a variable and used twice. A `Prisma.Sql` carries its own
   * parameter list, and reusing one across two templates makes the placeholder numbering depend on an
   * implementation detail of how they are flattened — cheap to avoid, expensive to debug.
   */
  const ranks = () =>
    Prisma.join(orderedIds.map((id, rank) => Prisma.sql`(${id}::text, ${rank}::int)`));

  const parked = await tx.$executeRaw(Prisma.sql`
    UPDATE "page_sections" AS s
       SET "position" = -1 - v."rank"
      FROM (VALUES ${ranks()}) AS v("id", "rank")
     WHERE s."id" = v."id" AND s."pageId" = ${pageId}::text
  `);

  if (parked !== orderedIds.length) {
    throw conflict(
      "One of the blocks in that order is not on this page any more. Reload the page and try again."
    );
  }

  await tx.$executeRaw(Prisma.sql`
    UPDATE "page_sections" AS s
       SET "position" = v."rank"
      FROM (VALUES ${ranks()}) AS v("id", "rank")
     WHERE s."id" = v."id" AND s."pageId" = ${pageId}::text
  `);
}
