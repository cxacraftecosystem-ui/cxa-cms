import "server-only";
import type { AuthProvider, Role, StudioAccess, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ROLE_RANK } from "@/lib/permissions";

/**
 * The studio allow-list — who may sign in at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS THE GATE EVERY SIGN-IN PATH GOES THROUGH, AND IT EXISTS BECAUSE OF OAUTH.
 *
 * A password login is self-limiting: an account has to be created before anybody can use one. An OAuth
 * login is not. "Continue with Google" means every Google account on earth can reach the callback, and
 * a naive implementation creates a user for whoever arrives — so the CMS of a research institution
 * becomes open to the public the moment the button is added.
 *
 * So the two questions are kept apart, and answered in this order:
 *
 *   1. AUTHENTICATION — "who is this?" — answered by a password or by a provider's signed token.
 *   2. AUTHORISATION  — "should they be here?" — answered HERE, by an address a master admin added.
 *
 * Nothing creates an account before step 2 passes. `resolveAccess` is called by the password login and
 * by the OAuth callback alike, and both refuse identically.
 *
 * ⚠ THE BOOTSTRAP PROBLEM, AND HOW IT IS SOLVED WITHOUT A BACK DOOR. An allow-list that is empty on the
 * day it ships locks everybody out, including the person who would add the first entry. Three things
 * prevent that, none of which is an exemption at sign-in time:
 *
 *   • the seed writes a grant for the administrator it creates;
 *   • the migration backfills a grant for every user that already existed;
 *   • the grace path below admits an already-active account, but ONLY while the list is completely
 *     empty — see `resolveAccess` for why that condition is what makes it safe rather than a bypass.
 *
 * That last one is the only soft edge. It closes itself: the moment a single grant exists the list is
 * authoritative, so an address without one is refused whether it was revoked or deleted. Before that it
 * cannot be used to GAIN access either — the account must already exist and already be active.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Addresses are compared lower-cased and trimmed. Stored the same way, so the index does the work. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type AccessDecision =
  | { ok: true; grant: StudioAccess | null; viaGrace: boolean }
  | { ok: false; reason: "not-listed" | "revoked" | "provider-not-allowed" };

/**
 * May this address sign in, by this method?
 *
 * Returns a DECISION rather than throwing, because the caller has to answer carefully: the message a
 * refused visitor sees must not reveal whether an address is on the list. See `ACCESS_REFUSED_MESSAGE`.
 */
export async function resolveAccess(input: {
  email: string;
  provider: AuthProvider;
  /** The existing account, when one has already been found. Enables the grace path below. */
  existingUser?: Pick<User, "id" | "isActive" | "deletedAt"> | null;
}): Promise<AccessDecision> {
  const email = normaliseEmail(input.email);
  const grant = await prisma.studioAccess.findUnique({ where: { email } });

  if (!grant) {
    /**
     * THE GRACE PATH, AND THE CONDITION THAT MAKES IT SAFE.
     *
     * ⚠ AN EARLIER VERSION ADMITTED ANY ALREADY-ACTIVE ACCOUNT WHOSE GRANT WAS MISSING, AND THAT WAS
     * WRONG. It made the list mean two different things depending on how somebody was taken off it:
     * REVOKING a grant refused them (the row is found and `revokedAt` is set), while DELETING the grant
     * outright admitted them again — because the row was gone and the grace path caught it. A master
     * admin who removes a person from the list and watches them sign in has been handed a control that
     * does not control anything. Found by testing, not by reading.
     *
     * So grace is now conditional on the list NOT BEING IN USE YET. If there is not a single grant in
     * the table, nobody has configured the allow-list — this is an installation mid-upgrade, before the
     * seed's backfill has run — and refusing every existing account would lock an institution out of its
     * own CMS at the worst possible moment. The instant ONE grant exists, the list is authoritative and a
     * missing row means refused, which is what "remove them from the list" has to mean.
     *
     * `count` rather than a flag or an environment variable: the state is derived from the data, so it
     * cannot drift out of step with reality, and it stops being permissive by itself the moment somebody
     * adds the first person.
     */
    const grantsInUse = await prisma.studioAccess.count();

    if (
      grantsInUse === 0 &&
      input.existingUser &&
      input.existingUser.isActive &&
      !input.existingUser.deletedAt
    ) {
      console.warn(
        `[access] ${email} signed in and the studio access list is EMPTY, so the account was admitted ` +
          "because it already existed. Run the seed (or add grants in Studio → Studio access) — as soon " +
          "as one grant exists, an address without one is refused."
      );
      return { ok: true, grant: null, viaGrace: true };
    }

    return { ok: false, reason: "not-listed" };
  }

  if (grant.revokedAt) return { ok: false, reason: "revoked" };

  // An empty list means "any configured method". A populated one is an explicit narrowing — an
  // administrator who wrote "Google only" meant it, and a password must not be an unnoticed second door.
  if (grant.allowedProviders.length > 0 && !grant.allowedProviders.includes(input.provider)) {
    return { ok: false, reason: "provider-not-allowed" };
  }

  return { ok: true, grant, viaGrace: false };
}

/**
 * ONE message for every refusal, whatever the reason.
 *
 * A refused visitor must not be able to tell "there is no such address here" from "that address is
 * revoked" from "you used the wrong button". The first two turn the sign-in page into a directory of
 * who works at the Centre, which is precisely what an attacker wants before a phishing attempt. The
 * real reason is written to the audit log, where the people who can act on it will see it.
 */
export const ACCESS_REFUSED_MESSAGE =
  "This account cannot sign in to the studio. If you should have access, ask an administrator to add " +
  "your email address to the studio's access list.";

/** A sentence for the AUDIT LOG — specific, because the reader is entitled to the detail. */
export function describeRefusal(reason: Exclude<AccessDecision, { ok: true }>["reason"]): string {
  switch (reason) {
    case "not-listed":
      return "the address is not on the studio access list";
    case "revoked":
      return "the address is on the access list but its grant has been revoked";
    case "provider-not-allowed":
      return "the address is on the access list but not for this sign-in method";
  }
}

/**
 * Record that a grant was used.
 *
 * Never throws: a session that has been issued must not be reported as failed because a bookkeeping
 * write lost a race. The worst consequence of a missed stamp is one stale "last used" figure, and the
 * audit log holds the authoritative record either way.
 */
export async function markGrantUsed(grantId: string, provider: AuthProvider): Promise<void> {
  try {
    await prisma.studioAccess.update({
      where: { id: grantId },
      data: { lastSignInAt: new Date(), lastProvider: provider, signInCount: { increment: 1 } }
    });
  } catch (error) {
    console.error("[access] could not record grant usage", grantId, error);
  }
}

/**
 * The role a NEW account is created with.
 *
 * ⚠ CAPPED BELOW MASTER ADMIN, ALWAYS. A grant may name any role, but an account that has never been
 * seen before must not appear already holding the power to widen the allow-list. Promotion to master
 * admin is a deliberate act performed on an existing account by an existing master admin, so that there
 * is always a person and a timestamp behind it rather than an email address somebody typed.
 */
export function initialRoleFor(grant: StudioAccess | null): Role {
  const requested: Role = grant?.grantedRole ?? "VIEWER";
  return ROLE_RANK[requested] >= ROLE_RANK.MASTER_ADMIN ? "ADMINISTRATOR" : requested;
}

/**
 * Would removing or demoting this account leave nobody able to administer the studio?
 *
 * Counted inside the caller's transaction — see app/api/studio/users/[id]/route.ts for why an outer
 * check races. Master admins are counted separately from administrators because they are the only tier
 * that can restore the other: an installation with administrators but no master admin can still publish,
 * but nobody can ever add a colleague again.
 */
export async function countActiveByRole(
  client: { user: { count: (args: unknown) => Promise<number> } },
  role: Role
): Promise<number> {
  return client.user.count({ where: { deletedAt: null, isActive: true, role } } as never);
}
