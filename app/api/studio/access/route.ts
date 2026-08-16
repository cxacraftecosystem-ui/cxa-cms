import type { NextRequest } from "next/server";
import { z } from "zod";
import type { AccessKind, AuthProvider, Prisma, Role } from "@prisma/client";
import { assertSameOrigin, badRequest, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { parseAccessSubject } from "@/lib/auth/access";
import { requireCapability } from "@/lib/auth/current-user";
import { configuredProviders } from "@/lib/auth/oauth";
import { prisma } from "@/lib/db";
import { ROLE_LABELS, canManageStudioAccess } from "@/lib/permissions";
import {
  buildAuditContext,
  isUniqueViolation,
  parseStudioJson,
  parseStudioQuery
} from "@/lib/studio/crud";

/**
 * The studio access list: who may sign in at all, and adding somebody to it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS THE MOST SECURITY-SENSITIVE TABLE IN THE PRODUCT. `StudioAccess` is the AUTHORISATION gate
 * every sign-in path consults (lib/auth/access.ts): a provider answers "who is this?" and this table
 * answers "should they be here?". Without it, adding "Continue with Google" would mean anybody on earth
 * with a Google account could open the CMS, because an OAuth callback that creates an account for
 * whoever arrives has asked only the first question.
 *
 * FIVE RULES, none of them optional.
 *
 * 1. `canManageStudioAccess` — MASTER ADMIN ONLY, and deliberately not an administrator. An
 *    administrator runs the site; a master admin decides who is allowed near it. The predicate comes
 *    from lib/permissions.ts and is not re-derived here; app/studio/access/page.tsx calls the same one
 *    to decide whether to render the screen at all (contract §1.7).
 *
 * 2. THE SUBJECT IS NORMALISED WITH `parseAccessSubject()` BEFORE EVERY READ AND EVERY WRITE. The column
 *    carries a unique index on the lower-cased form, so "Ada@Example.org" and "ada@example.org" are one
 *    entry rather than two — and two entries on one address would be a coin toss over which one the
 *    sign-in path found, which is to say a coin toss over what role somebody gets.
 *
 *    ⚠ AND ONE BOX ACCEPTS TWO THINGS. A leading "@" means a DOMAIN — "@iitkgp.ac.in" admits everybody
 *    there, present and future — and anything else is one address. That parser is the ONLY writer of the
 *    widest grant in the product, which is why it lives beside `resolveAccess` in lib/auth/access.ts
 *    rather than here: the rules that decide what may be STORED and the rules that decide what a stored
 *    row MATCHES have to be the same rules, and two files apart is how they stop being.
 *
 * 3. A DUPLICATE IS A 409 THAT NAMES THE ENTRY ALREADY HOLDING THE ADDRESS, including whether it has
 *    been revoked. "That address is already on the list" leaves a master admin looking for an entry the
 *    revoked filter was hiding from them, and the right action — restore it — is one they cannot guess.
 *
 * 4. EVERY MUTATION IS AUDITED AS `PERMISSION_CHANGE`, WITH THE EMAIL AS THE `entityLabel`. The audit
 *    screen colours that class as an incident-tone entry on purpose: the trail is the only record of who
 *    opened the door, and filing it as an ordinary UPDATE would bury it among a hundred content saves.
 *    `mutateWithHistory()` writes the row and the entry in one transaction, so neither can exist alone.
 *
 * 5. GRANTING `MASTER_ADMIN` HERE IS PERMITTED, AND IS NOT THE SAME THING AS CREATING A MASTER ADMIN.
 *    `initialRoleFor()` in lib/auth/access.ts CAPS what a brand-new account is created with — a first
 *    sign-in against a master-admin entry produces an ADMINISTRATOR, and the promotion is then a
 *    deliberate act by an existing master admin on an existing account. This route writes the LIST, not
 *    the account. The two are easy to confuse and the consequence of confusing them is either a refusal
 *    nobody can explain or an account that appears already holding the power to widen the list.
 *
 * ⚠ NO SECRET COLUMN IS EVER SELECTED INTO A RESPONSE. This file reads `User` only to answer "does this
 * address have an account, and is anybody signed in on it?", and it names the three columns it wants.
 * `select: undefined` hands back the whole row, which is how a password hash leaves a CMS.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Deep paging over an allow-list is always a sign the search box is the better tool. */
const MAX_PAGE = 200;

const NOTE_MAX = 1000;

/**
 * Every `Role`, as a tuple, so `z.enum` can validate against it.
 *
 * `satisfies` rather than an annotation: adding a tier to the Prisma enum without adding it here becomes
 * a compile error rather than a role the screen offers and this route silently refuses.
 */
const ROLE_VALUES = [
  "VIEWER",
  "AUTHOR",
  "MEDIA_MANAGER",
  "RESEARCHER",
  "EDITOR",
  "ADMINISTRATOR",
  "MASTER_ADMIN"
] as const satisfies readonly Role[];

/** Every `AuthProvider`, same reasoning as `ROLE_VALUES`. */
const AUTH_PROVIDERS = ["PASSWORD", "GOOGLE", "MICROSOFT", "YAHOO"] as const satisfies readonly AuthProvider[];

/**
 * Plain names for the sign-in methods.
 *
 * ⚠ DUPLICATED IN `app/studio/access/AccessManager.tsx`, and it has to be. `providerConfig()` in
 * lib/auth/oauth.ts carries the same labels but that module is `server-only`, so a client component
 * cannot import it. Two short maps that agree are better than making the OIDC layer importable by the
 * browser. If a provider is ever added, change both.
 */
const PROVIDER_LABELS: Record<AuthProvider, string> = {
  PASSWORD: "Password",
  GOOGLE: "Google",
  MICROSOFT: "Microsoft",
  YAHOO: "Yahoo"
};

/** "Google", "Google and Yahoo", "Google, Microsoft and Yahoo". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  return `${head} and ${items[items.length - 1] ?? ""}`;
}

/**
 * Which sign-in methods this installation can actually perform.
 *
 * A password always works. An OAuth provider only works once its client id and secret are set
 * (`configuredProviders()`), and an entry restricted to a provider nobody has configured is an entry
 * that cannot be used by anybody — which looks exactly like a broken sign-in from the other side. This
 * is reported in the response rather than refused: a deployment may well be configuring Google
 * tomorrow, and refusing today would make the list impossible to prepare in advance.
 */
function unusableMethodNote(allowed: readonly AuthProvider[]): string | null {
  if (allowed.length === 0) return null;

  const available = new Set<AuthProvider>(["PASSWORD"]);
  for (const entry of configuredProviders()) available.add(entry.provider);

  const unusable = allowed.filter((provider) => !available.has(provider));
  if (unusable.length === 0) return null;

  const names = andList(unusable.map((provider) => PROVIDER_LABELS[provider]));
  const isAre = unusable.length === 1 ? "is" : "are";
  const itThey = unusable.length === 1 ? "it is" : "they are";

  if (unusable.length === allowed.length) {
    return `${names} ${isAre} not set up on this installation, and ${unusable.length === 1 ? "it is" : "those are"} the only ${unusable.length === 1 ? "method" : "methods"} this entry allows — so nobody can use it until ${itThey} set up.`;
  }
  return `${names} ${isAre} not set up on this installation yet, so that part of the restriction has no effect until ${itThey} set up.`;
}

/** Duplicates are dropped and the order is fixed, so the stored array reads the same for every entry. */
function tidyProviders(values: readonly AuthProvider[]): AuthProvider[] {
  const chosen = new Set(values);
  return AUTH_PROVIDERS.filter((provider) => chosen.has(provider));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The columns an answer may carry. Written out, so a column added to the model later is a deliberate
 * addition here rather than something that starts appearing in a response nobody reviewed.
 */
const grantSelect = {
  id: true,
  email: true,
  /** EMAIL or DOMAIN. The screen cannot show which rows are the wide ones without being told. */
  kind: true,
  name: true,
  grantedRole: true,
  note: true,
  allowedProviders: true,
  createdAt: true,
  updatedAt: true,
  revokedAt: true,
  lastSignInAt: true,
  lastProvider: true,
  signInCount: true,
  addedBy: { select: { id: true, name: true, email: true } },
  revokedBy: { select: { id: true, name: true, email: true } }
} as const;

type GrantRow = Prisma.StudioAccessGetPayload<{ select: typeof grantSelect }>;

interface AccountFacts {
  isActive: boolean;
  activeSessions: number;
}

/**
 * Does each address have an account, and how many devices are signed in on it?
 *
 * ⚠ THIS IS WHAT MAKES THE "REVOKING DOES NOT SIGN THEM OUT" WARNING TRUE RATHER THAN GENERIC. Revoking
 * an entry stops the NEXT sign-in; a session already issued lives until it expires. The screen offers to
 * end those sessions at the same time, and it can only say "two devices are signed in" if somebody
 * counted them.
 *
 * Two queries for the whole page rather than two per row: twenty-five entries would otherwise be fifty
 * round trips for a number in a table cell.
 *
 * ADDRESSES ONLY — the caller filters domain rows out before calling. A domain key ("@iitkgp.ac.in")
 * cannot equal anybody's `User.email`, so including one would be a value in an `IN` list that is
 * guaranteed to match nothing. "How many people from that domain are signed in?" is a real question and
 * a different one; it is answered where it is acted on, by the sign-out path in
 * app/api/studio/access/[id]/route.ts, which matches on the suffix rather than on equality.
 */
async function accountFactsFor(emails: readonly string[]): Promise<Map<string, AccountFacts>> {
  const facts = new Map<string, AccountFacts>();
  if (emails.length === 0) return facts;

  // The entries hold normalised addresses and so does `User.email`, which is what lets this be a plain
  // `in` rather than a case-insensitive scan.
  const accounts = await prisma.user.findMany({
    where: { email: { in: [...emails] }, deletedAt: null },
    select: { id: true, email: true, isActive: true }
  });
  if (accounts.length === 0) return facts;

  const grouped = await prisma.session.groupBy({
    by: ["userId"],
    where: {
      userId: { in: accounts.map((account) => account.id) },
      revokedAt: null,
      expiresAt: { gt: new Date() }
    },
    _count: { _all: true }
  });

  const sessions = new Map<string, number>();
  for (const entry of grouped) sessions.set(entry.userId, entry._count._all);

  for (const account of accounts) {
    facts.set(account.email, {
      isActive: account.isActive,
      activeSessions: sessions.get(account.id) ?? 0
    });
  }
  return facts;
}

/**
 * ⚠ ON A DOMAIN ROW THE THREE ACCOUNT FACTS ARE ALWAYS "no account", AND THAT IS NOT A FINDING. A domain
 * is not a person and has no `User` row; the screen must read `kind` before it says anything about an
 * account, or every domain grant reads as "added, never signed in, no account" — which on an address
 * means "probably a typo" and here would mean nothing at all.
 */
function toRow(row: GrantRow, account: AccountFacts | undefined) {
  return {
    ...row,
    /**
     * Whether anybody has ever actually signed in against this entry — the prunability question. On a
     * DOMAIN row it means "has anybody at this domain ever come through", which is the same question.
     */
    used: row.lastSignInAt !== null,
    hasAccount: account !== undefined,
    accountIsActive: account?.isActive ?? false,
    activeSessions: account?.activeSessions ?? 0
  };
}

const ListQuery = z.object({
  /**
   * Matched against the address AND the name: a reader looking for a colleague types their name. It
   * finds domain grants too without a second clause, because a domain is stored in the same column —
   * "iitkgp" turns up both ada@iitkgp.ac.in and the "@iitkgp.ac.in" grant, which is what somebody
   * checking "how is this person getting in?" needs to see together.
   */
  q: z.string().trim().max(200, "That search is too long. Try fewer words.").default(""),
  /**
   * `unused` means "still allowed in, and has never signed in" — the set worth pruning. A revoked entry
   * that was never used is history rather than a loose end, so it is not counted here.
   */
  filter: z.enum(["all", "active", "revoked", "unused"]).default("all"),
  page: z.coerce
    .number()
    .int("The page must be a whole number.")
    .min(1, "Page numbers start at 1.")
    .max(MAX_PAGE, `This list stops at page ${MAX_PAGE}. Search instead.`)
    .default(1),
  pageSize: z.coerce
    .number()
    .int("The number of rows must be a whole number.")
    .min(1, "Ask for at least one row.")
    .max(MAX_PAGE_SIZE, `Ask for at most ${MAX_PAGE_SIZE} rows at a time.`)
    .default(DEFAULT_PAGE_SIZE)
});

const READ_REFUSAL =
  "The studio access list is only visible to a master administrator. It is the record of who may sign " +
  "in at all, so it is kept apart from the people who manage the site day to day.";

export const GET = route(async (request: NextRequest) => {
  await requireCapability(canManageStudioAccess, READ_REFUSAL);

  const query = parseStudioQuery(request, ListQuery);
  const term = query.q;

  const where: Prisma.StudioAccessWhereInput = {
    ...(query.filter === "active" ? { revokedAt: null } : {}),
    ...(query.filter === "revoked" ? { revokedAt: { not: null } } : {}),
    ...(query.filter === "unused" ? { revokedAt: null, lastSignInAt: null } : {}),
    ...(term.length > 0
      ? {
          OR: [
            { email: { contains: term, mode: "insensitive" } },
            { name: { contains: term, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [rows, total, all, active, revoked, unused, masterAdmins] = await prisma.$transaction([
    prisma.studioAccess.findMany({
      where,
      select: grantSelect,
      // Newest first, with `id` as the tiebreaker. Two entries added in the same millisecond have no
      // defined order otherwise, so page 2 could repeat a row from page 1 and omit another entirely.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize
    }),
    prisma.studioAccess.count({ where }),
    prisma.studioAccess.count(),
    prisma.studioAccess.count({ where: { revokedAt: null } }),
    prisma.studioAccess.count({ where: { revokedAt: { not: null } } }),
    prisma.studioAccess.count({ where: { revokedAt: null, lastSignInAt: null } }),
    /**
     * How many unrevoked master-admin entries exist.
     *
     * The screen needs the same number the write path guards on, so it can explain why the revoke
     * control is absent on the last one instead of appearing broken. ⚠ It is a COURTESY: the guard that
     * actually holds the invariant is taken with those rows locked, inside the transaction that writes —
     * see app/api/studio/access/[id]/route.ts.
     */
    prisma.studioAccess.count({ where: { revokedAt: null, grantedRole: "MASTER_ADMIN" } })
  ]);

  const facts = await accountFactsFor(
    rows.filter((row) => row.kind === "EMAIL").map((row) => row.email)
  );

  return ok({
    items: rows.map((row) => toRow(row, facts.get(row.email))),
    total,
    page: query.page,
    pageSize: query.pageSize,
    /** A list that quietly stops is indistinguishable from a place with no records (contract §1.6). */
    truncated: query.page * query.pageSize < total,
    counts: { all, active, revoked, unused, masterAdmins }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Adding somebody
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The address branch of the one box, kept as Zod's own `.email()`.
 *
 * ⚠ NOT RE-IMPLEMENTED ALONGSIDE THE DOMAIN RULES. `parseAccessSubject()` owns the domain half because
 * the sign-in path has to agree with it; addresses are left to the validator every other route in this
 * codebase uses, because a second hand-rolled address test would differ from it in exactly the corner
 * that lets a typo onto the list.
 */
const ADDRESS = z.string().email();

const ADDRESS_REFUSAL =
  "That does not look like an email address. Check for a missing @ or a typo in the domain. To let " +
  "everybody at an organisation in, write the domain on its own with a leading “@”, as in " +
  "“@iitkgp.ac.in”.";

const CreateBody = z.object({
  /**
   * ONE ADDRESS, OR ONE DOMAIN WITH A LEADING "@". The field keeps the name `email` because it is the
   * column, the audit label and the identity of the row whichever kind it holds — see
   * `StudioAccess.email` in schema.prisma for why one column carries both.
   *
   * The refusals come from `parseAccessSubject()` so that the sentence a master admin reads is written
   * beside the rule that produced it, and so the write side cannot accept a shape the sign-in side will
   * not match. ⚠ `.superRefine` rather than `.refine`: it is what lets the reason be the parser's own
   * sentence ("“@” on its own would let anybody at any domain sign in…") instead of one generic message
   * for six different mistakes.
   */
  email: z
    .string()
    .trim()
    .min(1, "An address or a domain is needed — it is the only thing the sign-in path can match on.")
    .max(254, "That address is too long to be a real one.")
    .superRefine((raw, ctx) => {
      const subject = parseAccessSubject(raw);
      if (!subject.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: subject.message });
        return;
      }
      if (subject.kind === "EMAIL" && !ADDRESS.safeParse(subject.value).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: ADDRESS_REFUSAL });
      }
    }),
  name: z.string().trim().max(200, "Keep the name to 200 characters or fewer.").optional(),
  role: z.enum(ROLE_VALUES, {
    errorMap: () => ({ message: "Choose what this person will be able to do." })
  }),
  note: z
    .string()
    .trim()
    .max(NOTE_MAX, `Keep the reason to ${NOTE_MAX} characters or fewer.`)
    .optional(),
  /** Empty means "any method this installation has set up" — see `StudioAccess.allowedProviders`. */
  allowedProviders: z.array(z.enum(AUTH_PROVIDERS)).max(AUTH_PROVIDERS.length).default([])
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const actor = await requireCapability(
    canManageStudioAccess,
    "Adding somebody to the studio access list needs master administrator access. It is the one action " +
      "that widens who can sign in, so it is kept to the people who are meant to decide that."
  );

  const body = await parseStudioJson(request, CreateBody);

  /**
   * ⚠ NORMALISED BEFORE THE DUPLICATE CHECK AND BEFORE THE WRITE. Checking one form and storing another
   * is how a list ends up with two entries for one person.
   *
   * ⚠ AND PARSED AGAIN HERE RATHER THAN TRUSTED FROM THE SCHEMA. The `superRefine` above has already
   * refused everything this can refuse, so the failure branch is unreachable today — it is kept because
   * this call is what decides `kind`, and a schema edited later that stops validating must not be able to
   * write a DOMAIN row nobody checked. The parser is pure, so the second call costs nothing.
   */
  const subject = parseAccessSubject(body.email);
  if (!subject.ok) throw badRequest(subject.message);

  const email = subject.value;
  const kind: AccessKind = subject.kind;
  const allowedProviders = tidyProviders(body.allowedProviders);

  // One unique index over both kinds, so this single lookup catches "that address is already listed" and
  // "that domain is already listed" alike — a domain key carries its "@" and can never collide with an
  // address. See `StudioAccess.email`.
  const existing = await prisma.studioAccess.findUnique({
    where: { email },
    select: { id: true, kind: true, name: true, grantedRole: true, revokedAt: true, createdAt: true }
  });
  if (existing) throw conflict(describeDuplicate(email, existing));

  const context = buildAuditContext(request, actor);

  let created: GrantRow;
  try {
    created = await mutateWithHistory<GrantRow>(
      context,
      {
        action: "PERMISSION_CHANGE",
        entityType: "StudioAccess",
        // The address — or the "@domain" — because that is what the entry IS, and the leading "@" makes
        // the two impossible to confuse in the log. A cuid in the audit log names nothing.
        entityLabel: email,
        /**
         * NO REVISION. An access entry is not versioned content, and a revision of one would be a second
         * copy of the audit entry. The audit trail holds the before and the after.
         */
        revise: false,
        // ⚠ THE WIDEST ENTRY ON THE LIST SAYS SO IN THE LOG. An incident reader scanning
        // PERMISSION_CHANGE lines must be able to see "everybody at …" without opening the row.
        summary:
          kind === "DOMAIN"
            ? `everybody at ${email} was added to the studio access list`
            : `${email} was added to the studio access list`
      },
      async (tx) =>
        tx.studioAccess.create({
          data: {
            email,
            kind,
            name: body.name && body.name.length > 0 ? body.name : null,
            /**
             * ⚠ ANY ROLE, `MASTER_ADMIN` INCLUDED — see rule 5 in the header. This is the list, not the
             * account: `initialRoleFor()` caps a brand-new account at ADMINISTRATOR whatever this says.
             */
            grantedRole: body.role,
            note: body.note && body.note.length > 0 ? body.note : null,
            allowedProviders,
            addedById: actor.id
          },
          select: grantSelect
        })
    );
  } catch (thrown) {
    /**
     * Two master admins added the same address within the same millisecond and both found nothing. The
     * unique index refused the second insert, which is the point of having one; the honest answer is the
     * same 409 the check above would have given.
     */
    if (isUniqueViolation(thrown)) {
      throw conflict(
        `“${email}” was added to the access list by somebody else a moment ago, so nothing has been changed. Reload the list to see the entry that exists.`
      );
    }
    throw thrown;
  }

  // An empty list for a domain: there is no `User` row to find, and asking for one would be a query
  // guaranteed to match nothing. `accountFactsFor` answers with an empty map, so `facts.get` is undefined
  // and `toRow` reports the "no account" values — which is the truth about a domain.
  const facts = await accountFactsFor(kind === "EMAIL" ? [email] : []);
  const methodNote = unusableMethodNote(allowedProviders);
  const role = ROLE_LABELS[body.role].toLowerCase();

  return ok({
    grant: toRow(created, facts.get(email)),
    message: [
      kind === "DOMAIN"
        ? `Everybody with an address at ${email} can now sign in as ${role}, including people who join later — an account is created the first time each of them signs in.`
        : `${email} can now sign in as ${role}.`,
      allowedProviders.length === 0
        ? "Any sign-in method this installation has set up will work."
        : `Only ${andList(allowedProviders.map((provider) => PROVIDER_LABELS[provider]))} will work for ${kind === "DOMAIN" ? "addresses at this domain" : "this address"}.`,
      /**
       * ⚠ SAID AT THE MOMENT THE WIDEST GRANT IN THE PRODUCT IS CREATED, not left in documentation. The
       * second half is the part nobody guesses: an individual entry BEATS the domain, in both directions,
       * because lib/auth/access.ts consults the exact address first and its answer is final. That is how a
       * single person is kept out of — or given more than — a domain everybody else comes through.
       */
      kind === "DOMAIN"
        ? "Nobody reviews these people one by one, so this entry is only as trustworthy as the organisation that hands out those addresses. To keep one person out, or to give one person a different level of access, add their address on its own — an entry naming somebody always wins over the domain."
        : null,
      body.role === "MASTER_ADMIN"
        ? kind === "DOMAIN"
          ? "Master administrator on a whole domain is the widest entry this list can hold: every account created from it arrives as an administrator — the cap that stops a first sign-in appearing already able to widen this list — and each one would then be a candidate for promotion. Naming the individual addresses is almost always what was meant."
          : "If they have never signed in before, their account is created as an administrator and a master administrator promotes it afterwards, so there is always a person behind that step."
        : null,
      methodNote
    ]
      .filter((sentence): sentence is string => sentence !== null)
      .join(" ")
  });
});

/**
 * The 409 for an address — or a domain — that is already listed, NAMING the entry that holds it.
 *
 * The revoked branch is the one that matters: that entry is hidden by the default filter, so a master
 * admin looking for it would not find it, and the action they want — restore rather than re-add — is not
 * one they can guess from "already on the list".
 *
 * The domain wording is separate rather than clever, because "there can only ever be one entry per
 * person" is a sentence that reads as nonsense about "@iitkgp.ac.in" and would make a master admin
 * wonder whether they had typed somebody's address by mistake.
 */
function describeDuplicate(
  email: string,
  existing: { kind: AccessKind; name: string | null; grantedRole: Role; revokedAt: Date | null }
): string {
  const named = existing.name && existing.name.length > 0;
  const role = ROLE_LABELS[existing.grantedRole].toLowerCase();

  if (existing.kind === "DOMAIN") {
    const what = named ? `${existing.name} (${email})` : `“${email}”`;
    if (existing.revokedAt) {
      return `Everybody at ${what} was already on the access list as ${role}, and that entry has been revoked. Restore it instead of adding a second one — a domain can be listed only once, and restoring keeps the record of who first opened it.`;
    }
    return `Everybody at ${what} is already on the access list as ${role}, and can sign in now. Change that entry rather than adding a second one. To treat one person there differently, add their address on its own — an entry naming somebody wins over the domain.`;
  }

  const who = named ? `${existing.name} (${email})` : `“${email}”`;
  if (existing.revokedAt) {
    return `${who} is already on the access list as ${role}, and that entry has been revoked. Restore it instead of adding a second one — the list is keyed on the address, so there can only ever be one entry per person, and restoring keeps the record of who first let them in.`;
  }
  return `${who} is already on the access list as ${role}, and can sign in now. Change that entry rather than adding a second one.`;
}
