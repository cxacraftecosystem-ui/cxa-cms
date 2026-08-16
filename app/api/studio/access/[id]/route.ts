import type { NextRequest } from "next/server";
import { z } from "zod";
// `Prisma` is imported as a VALUE, not merely as a type: `Prisma.sql` is the tagged template
// `$queryRaw` needs for the master-admin lock. See `lockMasterAdminGrants`.
import { Prisma, type AccessKind, type AuthProvider, type Role } from "@prisma/client";
import { assertSameOrigin, badRequest, conflict, forbidden, ok, route } from "@/lib/api";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { normaliseEmail } from "@/lib/auth/access";
import { requireCapability } from "@/lib/auth/current-user";
import { revokeAllSessionsForUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { ROLE_LABELS, canManageStudioAccess } from "@/lib/permissions";
import { buildAuditContext, found, parseStudioJson, parseStudioQuery } from "@/lib/studio/crud";

/**
 * One entry on the studio access list: changing it, revoking it, restoring it, destroying it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO RULES EXIST TO STOP THIS INSTALLATION LOCKING EVERYBODY OUT, AND BOTH ARE CHECKED INSIDE THE
 * TRANSACTION THAT WRITES.
 *
 * 1. A MASTER ADMIN CANNOT REVOKE OR DELETE THEIR OWN ENTRY. Somebody has to be able to undo a mistake
 *    on this list, and an account that has just removed its own permission to sign in cannot.
 *
 * 2. THE LAST UNREVOKED MASTER-ADMIN ENTRY CANNOT BE REMOVED FROM THAT SET. Revoking it, deleting it,
 *    or lowering its role all take it out of the set — and the third one matters as much as the first
 *    two, because a role change that was not guarded would be a two-step way round the guard: lower the
 *    last master-admin entry to administrator, and revoking it is no longer "the last one".
 *
 * ⚠ AND THE COUNT THAT ENFORCES RULE 2 IS TAKEN WITH THOSE ROWS LOCKED, INSIDE THE TRANSACTION. A count
 * taken beforehand is a reading of the past: two master admins revoking two different entries at the
 * same moment each see two, each pass the guard, and the installation ends with nobody who can add
 * anybody — including the person who would have to undo it. There is no way back through the
 * application. `lockMasterAdminGrants` is what makes the two requests take their turns; the count
 * outside the transaction is kept as well, because it refuses the ordinary case earlier and with a
 * better sentence than the race can be given.
 *
 * ⚠ REVOKING DOES NOT SIGN ANYBODY OUT. `StudioAccess` is consulted at SIGN-IN; a session already
 * issued lives until it expires. So `revokeSessions` is offered alongside a revocation and the response
 * says which happened in words the screen prints verbatim. A control that implies an immediate effect it
 * does not have is worse than one that explains itself.
 *
 * ⚠ THE ADDRESS IS NOT EDITABLE HERE, AND NEITHER IS `kind`. Changing either would move a standing grant
 * — with its record of who added it and when it was last used — onto a different person, and the audit
 * entry would read as "an entry was changed" rather than "somebody new was let in". Turning one person's
 * entry into a whole domain would be the same sleight of hand at the widest possible scale. Deleting the
 * entry and adding the new one is the honest pair, and it is two audit entries because it is two
 * decisions.
 *
 * ⚠ AN ENTRY MAY BE THE ACTOR'S OWN WITHOUT NAMING THEM. Rule 1 used to be a comparison of two addresses,
 * which stopped being the whole question the moment a grant could be "@iitkgp.ac.in": a master admin
 * whose own access comes through that domain, and who revokes it, has locked themselves out just as
 * surely as if they had deleted a row with their name on it — and there is no way back in through the
 * site. `coversActor()` therefore asks the question `resolveAccess` asks, and a domain entry is refused
 * when it is the thing letting the actor in. It is not refused when they have an entry of their own,
 * because then the domain is not what admits them.
 *
 * Every mutation is audited as `PERMISSION_CHANGE` with the address as the `entityLabel`, through
 * `mutateWithHistory()`, so the row and the entry cannot exist without each other.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const NOTE_MAX = 1000;

/** See app/api/studio/access/route.ts — `satisfies` makes a new tier a compile error, not a silent gap. */
const ROLE_VALUES = [
  "VIEWER",
  "AUTHOR",
  "MEDIA_MANAGER",
  "RESEARCHER",
  "EDITOR",
  "ADMINISTRATOR",
  "MASTER_ADMIN"
] as const satisfies readonly Role[];

const AUTH_PROVIDERS = ["PASSWORD", "GOOGLE", "MICROSOFT", "YAHOO"] as const satisfies readonly AuthProvider[];

/** Duplicated from the collection route and from the screen; lib/auth/oauth.ts is `server-only`. */
const PROVIDER_LABELS: Record<AuthProvider, string> = {
  PASSWORD: "Password",
  GOOGLE: "Google",
  MICROSOFT: "Microsoft",
  YAHOO: "Yahoo"
};

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  return `${head} and ${items[items.length - 1] ?? ""}`;
}

function tidyProviders(values: readonly AuthProvider[]): AuthProvider[] {
  const chosen = new Set(values);
  return AUTH_PROVIDERS.filter((provider) => chosen.has(provider));
}

function sameProviders(a: readonly AuthProvider[], b: readonly AuthProvider[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** ⚠ Written out, and it must stay identical to the one in the collection route: one screen reads both. */
const grantSelect = {
  id: true,
  email: true,
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

/** The subset the guards read. Kept narrow so the in-transaction re-read is cheap. */
interface GuardState {
  email: string;
  kind: AccessKind;
  grantedRole: Role;
  revokedAt: Date | null;
}

/** The columns `GuardState` needs, as a Prisma `select`, so the two re-reads cannot drift from it. */
const guardSelect = { email: true, kind: true, grantedRole: true, revokedAt: true } as const;

/** What the request is trying to do to this entry, as far as the guards are concerned. */
interface Intent {
  nextRole?: Role | undefined;
  revoking?: boolean;
  deleting?: boolean;
}

/**
 * Does this change take the entry OUT of the set of unrevoked master-admin entries?
 *
 * One function, called before the transaction for the early refusal and again inside it for the real
 * one, so the two cannot drift into disagreeing about what "removing a master admin" means.
 */
function leavesMasterAdminSet(row: GuardState, intent: Intent): boolean {
  if (row.grantedRole !== "MASTER_ADMIN" || row.revokedAt !== null) return false;
  if (intent.deleting === true || intent.revoking === true) return true;
  return intent.nextRole !== undefined && intent.nextRole !== "MASTER_ADMIN";
}

/**
 * Both kinds are counted. A DOMAIN entry granting master administrator is a way in for a master admin
 * exactly as a named one is, so removing it takes something out of the same set. The stronger invariant —
 * that an installation always has a live master-admin ACCOUNT — is held where accounts are written, by
 * `countActiveByRole()` in app/api/studio/users/[id]/route.ts; this guard is about the list.
 */
async function countMasterAdminGrants(): Promise<number> {
  return prisma.studioAccess.count({ where: { revokedAt: null, grantedRole: "MASTER_ADMIN" } });
}

/**
 * Is THIS entry the thing that lets the ACTOR in?
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT ASKS THE QUESTION `resolveAccess()` ASKS, AND IT HAS TO. Rule 1 — "you cannot take your own access
 * away" — was a comparison of two addresses while an entry could only be an address. A domain entry is
 * somebody's own access without carrying their name anywhere in it, and a master admin who revokes the
 * domain they themselves arrive through is locked out on their next sign-in with no way back through the
 * site. The refusal has to cover that, or the rule protects only the people who happen to be named.
 *
 * ⚠ AND IT IS NOT A BARE SUFFIX TEST. An actor who has an EMAIL entry of their own is admitted by THAT
 * entry — lib/auth/access.ts consults the exact address first and its answer is final — so the domain is
 * not what lets them in and they must be able to revoke it. Refusing there would mean the person best
 * placed to close a domain that has been left too wide is the one person forbidden from doing it. The
 * lookup deliberately does not care whether their own entry is revoked: if it is, they are already
 * refused at sign-in and this entry is not what changes that.
 *
 * The suffix match is exact because the stored key carries its "@" — `ada@iitkgp.ac.in`.endsWith(
 * `@iitkgp.ac.in`) is true and `ada@evil-iitkgp.ac.in` is not, which a bare `iitkgp.ac.in` would have
 * swallowed. Both sides are normalised, so the comparison cannot fail on capitalisation.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function coversActor(
  client: TxClient,
  row: Pick<GuardState, "email" | "kind">,
  actorEmail: string
): Promise<boolean> {
  if (row.kind === "EMAIL") return row.email === actorEmail;

  if (!actorEmail.endsWith(row.email)) return false;

  const own = await client.studioAccess.findUnique({
    where: { email: actorEmail },
    select: { kind: true }
  });
  // No entry of their own — or one that is somehow not an address, which cannot be theirs — means this
  // domain is what admits them.
  return own === null || own.kind !== "EMAIL";
}

/**
 * The same count, taken INSIDE a transaction with every master-admin entry held until it commits.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS THE GUARD. Moving the ordinary count inside the transaction would not have been one: at
 * Postgres's default READ COMMITTED a transaction cannot see another's uncommitted work, so two
 * requests revoking two different master-admin entries would both count two and both write.
 *
 * `FOR UPDATE` closes it. The second request blocks here until the first commits, and when it is
 * released Postgres re-tests the row it was waiting on against this `WHERE`: the entry the first
 * request revoked no longer matches, so it is not returned. The second therefore counts one and
 * refuses. That re-test is why the answer is the NUMBER OF ROWS RETURNED rather than a separate
 * `count()` — the locked rows are the ones the answer has to be built from.
 *
 * `ORDER BY "id"` is not cosmetic: two of these lock the same rows, and taking them in a fixed order is
 * what stops the pair deadlocking each other.
 *
 * Called ONLY on a write that can remove a master-admin entry. Renaming somebody must not queue behind
 * rows it is not touching.
 *
 * `"studio_access"` is `StudioAccess`'s table (`@@map`), and `grantedRole` is declared with the `Role`
 * enum, which is why the literal needs no cast.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function lockMasterAdminGrants(tx: TxClient): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "studio_access"
               WHERE "grantedRole" = 'MASTER_ADMIN' AND "revokedAt" IS NULL
               ORDER BY "id"
               FOR UPDATE`
  );
  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The refusals
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const WRITE_REFUSAL =
  "Changing the studio access list needs master administrator access. It is the one list that decides " +
  "who can sign in at all, so it is kept apart from the people who manage the site day to day.";

const SELF_REMOVAL =
  "You cannot take your own address off the access list. Somebody has to be able to undo a mistake here, " +
  "and an account that has just removed its own permission to sign in cannot — there is no way back in " +
  "through the site itself. Ask another master administrator to remove your access.";

/**
 * The same rule, when the entry is the DOMAIN the actor themselves arrives through.
 *
 * A separate sentence because "your own address" is not what happened and would send somebody looking for
 * a row with their name on it, which does not exist. It also names the way out, which is specific to this
 * case and is not obvious: add your own address to the list first, and the domain stops being the thing
 * that admits you (`coversActor`), so you may then close it.
 */
const SELF_REMOVAL_BY_DOMAIN =
  "Your own access comes through this domain, so revoking or deleting it would lock you out on your next " +
  "sign-in — and there is no way back in through the site itself. Add your own address to the list as its " +
  "own entry first: an entry naming somebody is what the sign-in path matches on before it looks at the " +
  "domain, so once yours exists you can close this one.";

/** Which rule stopped it, in words that say what to do next. */
function lastMasterAdminRefusal(intent: Intent): string {
  const action = intent.deleting === true
    ? "deleted"
    : intent.revoking === true
      ? "revoked"
      : "changed to a lower level of access";

  return (
    `This is the only entry on the access list that grants master administrator access, so it cannot be ${action}. ` +
    "If it were, nobody could add anybody to this list again, and nobody could undo it — the studio would be " +
    "closed to everyone whose address is not already on the list. Add a second master administrator to the " +
    "list first, and let them sign in, before changing this one."
  );
}

const LAST_MASTER_ADMIN_RACE =
  "Somebody else changed a master administrator's entry at the same moment, and this is now the only " +
  "entry left that grants master administrator access. Nothing has been changed — if it had, nobody " +
  "could add anybody to this list again. Add a second master administrator, then try again.";

/**
 * The sentence every revocation carries when the sessions were left alone.
 *
 * Honest about the gap rather than implying the person is out this instant: the access list is consulted
 * when somebody signs IN, so a browser that is already signed in stays signed in until its session runs
 * out. This is the whole reason the screen offers to end those sessions in the same action.
 */
const REVOCATION_GAP =
  "Revoking takes effect the next time they try to sign in. A browser they are already signed in on " +
  "keeps working until its session expires, which can be days. Use the sign-out option beside the " +
  "action if they need to be out now.";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Ending the sessions this entry admits
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sign everybody this entry admits out of every device.
 *
 * Run AFTER the entry has been written and outside its transaction. The order is deliberate: if the
 * revocation failed and the write had not happened, somebody would have been signed out of a change that
 * was never made, which reads as though the revocation had taken effect. This way the worst case is a
 * revoked entry whose sessions live out their own expiry, and the response says so.
 *
 * An address with no account is not an error — most new entries have none — so the count is 0 and the
 * message says nothing was signed out rather than claiming a device was.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ A DOMAIN ENTRY SIGNS OUT EVERY ACCOUNT AT THAT DOMAIN, AND IT HAS TO. The whole point of the option
 * is "they need to be out now"; on a domain grant, "they" is everybody it let in. A version that looked
 * up one `User` by the entry's key would find nothing — no account has "@iitkgp.ac.in" for an address —
 * report zero and leave every one of those sessions live, which is the worst kind of control: one that
 * reports success and does nothing, at the moment somebody is trying to close a breach.
 *
 * The suffix match is exact because the stored key carries its "@": `endsWith("@iitkgp.ac.in")` cannot
 * reach `ada@evil-iitkgp.ac.in`, which a bare `iitkgp.ac.in` would have swept in. Prisma's `endsWith` is
 * case-sensitive and both sides are stored lower-cased.
 *
 * ⚠ IT SIGNS OUT PEOPLE THIS ENTRY MAY NOT BE THE ONLY WAY IN FOR. Somebody at the domain who also has an
 * entry of their own is still admitted at their next sign-in — `resolveAccess` matches the address first
 * — so for them this is a sign-out rather than a removal. That is the right way round: signing somebody
 * out costs them a login, and leaving a session live during a domain-wide revocation could cost the
 * institution the CMS. The response counts what was ended so the sentence on screen is the truth.
 *
 * DELETED ACCOUNTS ARE NOT FILTERED OUT. A soft-deleted user with a live session is precisely somebody
 * who should not be holding one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function endSessionsFor(row: { email: string; kind: AccessKind }): Promise<number> {
  const key = normaliseEmail(row.email);

  const accounts =
    row.kind === "DOMAIN"
      ? await prisma.user.findMany({ where: { email: { endsWith: key } }, select: { id: true } })
      : await prisma.user.findMany({ where: { email: key }, select: { id: true } });

  if (accounts.length === 0) return 0;

  const ids = accounts.map((account) => account.id);
  const live = await prisma.session.count({
    where: { userId: { in: ids }, revokedAt: null, expiresAt: { gt: new Date() } }
  });

  // One at a time, because `revokeAllSessionsForUser` is what also clears whatever else hangs off a
  // sign-out (lib/auth/session.ts). A hand-rolled `updateMany` here would be a second implementation of
  // "sign somebody out", and the day the first one gains a step this one would silently skip it. The loop
  // is bounded by the number of ACCOUNTS at the domain — people who have actually signed in through it,
  // not everybody it would admit — which is tens in the installation this was written for.
  for (const id of ids) await revokeAllSessionsForUser(id);

  return live;
}

/**
 * What the sign-out actually did, in a sentence.
 *
 * The domain wording counts DEVICES rather than naming a person, because there is no one person to name
 * and "signed in as everybody at @iitkgp.ac.in" is not English.
 */
function describeSignOut(row: { name: string | null; email: string; kind: AccessKind }, ended: number): string {
  if (row.kind === "DOMAIN") {
    if (ended === 0) {
      return `No device was signed in with an address at ${row.email}. Any that was is now signed out.`;
    }
    return `${ended === 1 ? "1 device" : `${ended} devices`} signed in with an address at ${row.email} ${ended === 1 ? "has" : "have"} been signed out.`;
  }

  const name = label(row);
  if (ended === 0) {
    return `No device appeared to be signed in as ${name}. Any that was is now signed out.`;
  }
  return `${ended === 1 ? "1 device" : `${ended} devices`} signed in as ${name} ${ended === 1 ? "has" : "have"} been signed out.`;
}

/**
 * What to call the entry in a sentence: its name if it has one, otherwise the key.
 *
 * On a DOMAIN entry that reads as "everybody at …", because the sentences it appears in are about who can
 * and cannot sign in, and "@iitkgp.ac.in can no longer sign in" describes a mailbox rather than the
 * hundreds of people the entry actually governs.
 */
function label(row: { name: string | null; email: string; kind: AccessKind }): string {
  const named = row.name && row.name.length > 0 ? row.name : row.email;
  return row.kind === "DOMAIN" ? `everybody at ${named}` : named;
}

/**
 * The same idea for the AUDIT LOG, and deliberately not `label()`: the trail names the KEY and never the
 * display name, because a name can be edited afterwards and an audit line that says "IIT Kharagpur was
 * revoked" cannot be matched back to a row six months later. The scope still goes in front of it, so the
 * widest changes on the list read as wide at a glance.
 */
function auditSubject(row: { email: string; kind: AccessKind }): string {
  return row.kind === "DOMAIN" ? `everybody at ${row.email}` : row.email;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — change the entry, revoke it, or restore it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PatchBody = z.object({
  /** `""` and `null` both mean "no name recorded" — a cleared box sends one, a client that never had a value sends the other. */
  name: z
    .union([z.string().trim().max(200, "Keep the name to 200 characters or fewer."), z.null()])
    .optional(),
  role: z.enum(ROLE_VALUES, {
    errorMap: () => ({ message: "Choose what this person will be able to do." })
  }).optional(),
  note: z
    .union([z.string().trim().max(NOTE_MAX, `Keep the reason to ${NOTE_MAX} characters or fewer.`), z.null()])
    .optional(),
  /** Empty means "any method this installation has set up". */
  allowedProviders: z.array(z.enum(AUTH_PROVIDERS)).max(AUTH_PROVIDERS.length).optional(),
  /** `true` revokes, `false` restores. A soft flag either way — the row is never deleted by this. */
  revoked: z.boolean().optional(),
  /**
   * End the person's sessions as part of revoking. Only meaningful WITH `revoked: true` — see the
   * refusal below, and `POST /api/studio/users/{id}` for signing somebody out on its own.
   */
  revokeSessions: z.boolean().optional()
});

export const PATCH = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(canManageStudioAccess, WRITE_REFUSAL);

    const { id } = await params;
    const body = await parseStudioJson(request, PatchBody);

    const grant = found(
      await prisma.studioAccess.findUnique({ where: { id }, select: grantSelect }),
      "That access list entry"
    );

    // The actor's own address, normalised on both sides so the comparison cannot fail on capitalisation.
    // `coversActor` — not an equality — because a DOMAIN entry can be the actor's own access without
    // naming them anywhere. See its comment; the answer is used for the early refusal only, and the one
    // that holds the rule is taken again inside the transaction.
    const actorEmail = normaliseEmail(actor.email);
    const isOwnEntry = await coversActor(prisma, grant, actorEmail);

    const changes: Prisma.StudioAccessUpdateInput = {};
    const reasons: string[] = [];

    let nextRole: Role | undefined;
    let revoking = false;
    let restoring = false;

    // ── What they will be able to do ────────────────────────────────────────────────────────────
    if (body.role !== undefined && body.role !== grant.grantedRole) {
      nextRole = body.role;
      changes.grantedRole = body.role;
      /**
       * ⚠ THIS ONLY AFFECTS AN ACCOUNT THAT DOES NOT EXIST YET. `StudioAccess.grantedRole` is the role a
       * FIRST sign-in creates the account with; it deliberately does not follow later changes, or
       * re-reading it would silently undo an administrator's promotion or demotion on the person's next
       * visit. Somebody who has already signed in keeps whatever their account says, and the sentence
       * below says so rather than implying an access change that has not happened.
       */
      reasons.push(
        grant.kind === "DOMAIN"
          ? // Never "their own account": a domain entry has no one holder, and the people already through
            // it may be dozens. The sentence has to send the reader to the Users screen either way.
            `Accounts created through this domain from now on will be ${ROLE_LABELS[body.role].toLowerCase()}. Anybody who has already signed in keeps the level of access their account has now — change those on the Users screen.`
          : grant.lastSignInAt === null
            ? `If they sign in for the first time, their account will be created as ${ROLE_LABELS[body.role].toLowerCase()}.`
            : `New accounts made from this entry will be ${ROLE_LABELS[body.role].toLowerCase()}. They have already signed in, so their own account keeps the level of access it has now — change that on the Users screen.`
      );
    }

    // ── The name and the reason ─────────────────────────────────────────────────────────────────
    if (body.name !== undefined) {
      const name = body.name === null || body.name.length === 0 ? null : body.name;
      if (name !== grant.name) changes.name = name;
    }
    if (body.note !== undefined) {
      const note = body.note === null || body.note.length === 0 ? null : body.note;
      if (note !== grant.note) {
        changes.note = note;
        if (note === null) {
          reasons.push("The reason for their access has been cleared, so nothing on this list now explains it.");
        }
      }
    }

    // ── Which sign-in methods are permitted ─────────────────────────────────────────────────────
    if (body.allowedProviders !== undefined) {
      const allowed = tidyProviders(body.allowedProviders);
      if (!sameProviders(allowed, grant.allowedProviders)) {
        changes.allowedProviders = allowed;
        const subject = grant.kind === "DOMAIN" ? "addresses at this domain" : "this address";
        reasons.push(
          allowed.length === 0
            ? `Any sign-in method this installation has set up will now work for ${subject}.`
            : `Only ${andList(allowed.map((provider) => PROVIDER_LABELS[provider]))} will now work for ${subject}; every other method is refused.`
        );
      }
    }

    // ── Revoking, and restoring ─────────────────────────────────────────────────────────────────
    if (body.revoked === true && grant.revokedAt === null) {
      revoking = true;
      changes.revokedAt = new Date();
      changes.revokedBy = { connect: { id: actor.id } };
      /**
       * A SOFT FLAG, never a delete. The record of who was once allowed in — and who let them in — is
       * what makes this list auditable at all, and a revocation that erased it would remove the only
       * evidence of a decision at the moment somebody is most likely to be asking about it.
       */
      reasons.push(`${label(grant)} can no longer sign in. The entry stays on the list, marked revoked, so the record of who let them in survives.`);
    } else if (body.revoked === false && grant.revokedAt !== null) {
      restoring = true;
      changes.revokedAt = null;
      changes.revokedBy = { disconnect: true };
      reasons.push(`${label(grant)} can sign in again.`);
    }

    /**
     * ⚠ THE CHECK IS ON WHAT THE REQUEST ASKED FOR, NOT ON WHETHER THE STATE CHANGED.
     *
     * Testing `!revoking` instead would produce this refusal for a screen that was a moment out of date —
     * somebody else revoked the entry first — and "signing out is offered as part of revoking" is then a
     * misleading explanation of a race. That case falls through to `alreadyRevokedNote` below, which says
     * what actually happened.
     */
    const wantsSignOut = body.revokeSessions === true;
    if (wantsSignOut && body.revoked !== true) {
      throw badRequest(
        "Signing somebody out is offered as part of revoking their access. To sign somebody out without " +
          "changing the access list, use their account on the Users screen."
      );
    }

    /** Asked for with a revocation that turned out to be unnecessary, because it had already happened. */
    const alreadyRevokedNote =
      "This entry was already revoked, so nobody has been signed out. Their sessions can be ended from " +
      "their account on the Users screen.";

    const intent: Intent = { nextRole, revoking };

    // ── The early refusals ──────────────────────────────────────────────────────────────────────
    // Better sentences than the race can be given, and they answer before any row is locked. The
    // refusals that actually hold the invariants are inside the transaction below.
    if (revoking && isOwnEntry) {
      throw forbidden(grant.kind === "DOMAIN" ? SELF_REMOVAL_BY_DOMAIN : SELF_REMOVAL);
    }
    if (leavesMasterAdminSet(grant, intent) && (await countMasterAdminGrants()) <= 1) {
      throw conflict(lastMasterAdminRefusal(intent));
    }

    if (Object.keys(changes).length === 0) {
      // Not an error. A picker set back to the value it already had produces this, and a 422 would put an
      // error banner on a screen where nothing is wrong.
      return ok({
        grant,
        changed: false,
        sessionsEnded: null,
        masterAdminGrants: await countMasterAdminGrants(),
        message: wantsSignOut
          ? `Nothing was different, so nothing has been changed. ${alreadyRevokedNote}`
          : "Nothing was different, so nothing has been changed."
      });
    }

    const updated = await mutateWithHistory<GrantRow>(
      buildAuditContext(request, actor),
      {
        action: "PERMISSION_CHANGE",
        entityType: "StudioAccess",
        entityLabel: grant.email,
        // No revision: an access entry is not versioned content. The audit entry holds before and after.
        revise: false,
        before: grant,
        // "everybody at @iitkgp.ac.in was revoked…" on a domain entry: an incident reader scanning
        // PERMISSION_CHANGE lines must see the scope of what moved without opening the row.
        summary: revoking
          ? `${auditSubject(grant)} was revoked from the studio access list`
          : restoring
            ? `${auditSubject(grant)} was restored to the studio access list`
            : `the access list entry for ${auditSubject(grant)} was changed`
      },
      async (tx) => {
        /**
         * ⚠ RE-READ AND RE-CHECKED INSIDE THE TRANSACTION. The state the refusals above were computed
         * from was read before any row was locked, so by the time the write lands it may be two
         * revocations old.
         */
        const current = found(
          await tx.studioAccess.findUnique({ where: { id }, select: guardSelect }),
          "That access list entry"
        );

        if (revoking && (await coversActor(tx, current, actorEmail))) {
          throw forbidden(current.kind === "DOMAIN" ? SELF_REMOVAL_BY_DOMAIN : SELF_REMOVAL);
        }
        if (revoking && current.revokedAt !== null) {
          throw conflict(
            "Somebody else revoked this entry a moment ago, so nothing has been changed. Reload the list to see who did it and when."
          );
        }
        if (restoring && current.revokedAt === null) {
          throw conflict(
            "Somebody else restored this entry a moment ago, so nothing has been changed. Reload the list."
          );
        }
        if (leavesMasterAdminSet(current, intent) && (await lockMasterAdminGrants(tx)) <= 1) {
          throw conflict(LAST_MASTER_ADMIN_RACE);
        }

        return tx.studioAccess.update({ where: { id }, data: changes, select: grantSelect });
      }
    );

    let sessionsEnded: number | null = null;
    if (revoking && wantsSignOut) {
      sessionsEnded = await endSessionsFor(updated);
      reasons.push(describeSignOut(updated, sessionsEnded));
    } else if (revoking) {
      reasons.push(REVOCATION_GAP);
    } else if (wantsSignOut) {
      reasons.push(alreadyRevokedNote);
    }

    return ok({
      grant: updated,
      changed: true,
      sessionsEnded,
      masterAdminGrants: await countMasterAdminGrants(),
      message: reasons.join(" ") || "The entry has been saved."
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — a real delete, which is why the screen asks for the address to be typed
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ THIS DESTROYS HISTORY, AND THAT IS WHY IT IS A SEPARATE ACTION FROM REVOKING.
 *
 * A revoked entry still says who was allowed in, who allowed them, and when they last used it. Deleting
 * removes that. It exists because a list nobody can prune is a list that only ever grows — an address
 * added for a three-month visitor in 2019 is noise that makes the real entries harder to read — but the
 * screen asks for the address to be typed first (`requireTyping`), because the difference between this
 * and revoking is not recoverable.
 *
 * The audit entry remains: it is the only record left, which is exactly why it is written in the same
 * transaction as the delete.
 */
const DeleteQuery = z.object({
  /** `true` also signs the holder out. Deleting an entry no more ends a session than revoking does. */
  revokeSessions: z.enum(["true", "false"]).default("false")
});

export const DELETE = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(canManageStudioAccess, WRITE_REFUSAL);

    const { id } = await params;
    const query = parseStudioQuery(request, DeleteQuery);

    const grant = found(
      await prisma.studioAccess.findUnique({ where: { id }, select: grantSelect }),
      "That access list entry"
    );

    const actorEmail = normaliseEmail(actor.email);
    if (await coversActor(prisma, grant, actorEmail)) {
      throw forbidden(grant.kind === "DOMAIN" ? SELF_REMOVAL_BY_DOMAIN : SELF_REMOVAL);
    }

    const intent: Intent = { deleting: true };
    if (leavesMasterAdminSet(grant, intent) && (await countMasterAdminGrants()) <= 1) {
      throw conflict(lastMasterAdminRefusal(intent));
    }

    await mutateWithHistory<{ id: string }>(
      buildAuditContext(request, actor),
      {
        action: "PERMISSION_CHANGE",
        entityType: "StudioAccess",
        entityLabel: grant.email,
        revise: false,
        before: grant,
        summary: `${auditSubject(grant)} was deleted from the studio access list`
      },
      async (tx) => {
        // ⚠ THE REAL GUARDS, for the same reason as in PATCH: a delete and a revocation running together
        // would otherwise each see two master-admin entries and leave none.
        const current = found(
          await tx.studioAccess.findUnique({ where: { id }, select: guardSelect }),
          "That access list entry"
        );

        if (await coversActor(tx, current, actorEmail)) {
          throw forbidden(current.kind === "DOMAIN" ? SELF_REMOVAL_BY_DOMAIN : SELF_REMOVAL);
        }
        if (leavesMasterAdminSet(current, intent) && (await lockMasterAdminGrants(tx)) <= 1) {
          throw conflict(LAST_MASTER_ADMIN_RACE);
        }

        await tx.studioAccess.delete({ where: { id } });
        /**
         * The audit entry's `after` is built from what this returns, and the row is gone — so it says so
         * rather than echoing the deleted values back as though they were still there. `before` above
         * holds the whole entry, which is now the only copy of it anywhere.
         */
        return { id, deleted: true, email: current.email };
      }
    );

    let sessionsEnded: number | null = null;
    if (query.revokeSessions === "true") {
      sessionsEnded = await endSessionsFor(grant);
    }

    return ok({
      deleted: true,
      sessionsEnded,
      masterAdminGrants: await countMasterAdminGrants(),
      message: [
        grant.kind === "DOMAIN"
          ? `${grant.email} has been removed from the access list, and the record of who opened it is gone with it. Nobody at that domain can sign in from now on unless their own address is listed.`
          : `${grant.email} has been removed from the access list, and the record of who added them is gone with it.`,
        grant.lastSignInAt !== null
          ? grant.kind === "DOMAIN"
            ? "The accounts made through it are untouched — switch one off on the Users screen if it should no longer exist. Anything those people wrote in the studio keeps their names on it."
            : "Anything they wrote in the studio keeps their name on it, and their account is untouched — switch it off on the Users screen if they should no longer have one."
          : grant.kind === "DOMAIN"
            ? "Nobody ever signed in through that domain, so no account or content is affected."
            : "Nobody ever signed in with that address, so no account or content is affected.",
        sessionsEnded === null ? REVOCATION_GAP : describeSignOut(grant, sessionsEnded),
        "This deletion is in the audit log with your name on it."
      ].join(" ")
    });
  }
);
