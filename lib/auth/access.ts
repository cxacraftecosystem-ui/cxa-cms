import "server-only";
import type { AccessKind, AuthProvider, Role, StudioAccess, User } from "@prisma/client";
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
 * A grant is EITHER ONE ADDRESS OR A WHOLE DOMAIN. "@iitkgp.ac.in" admits every present and future
 * holder of an address there, which is what an institution actually wants when adding colleagues one at
 * a time means the list is out of date the week somebody joins. It is also the widest thing anybody can
 * write here, so the two are not interchangeable: an exact address is consulted FIRST and its answer is
 * FINAL, which is what makes "revoke this one person" work while their colleagues keep signing in. See
 * `resolveAccess` for the ordering and why each step returns rather than falling through.
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

/**
 * The key a DOMAIN grant is stored under, derived from a full address. `Ada@IITKGP.ac.in` → `@iitkgp.ac.in`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LEADING "@" IS PART OF THE STORED KEY, NOT DECORATION. It is what lets one unique index carry both
 * kinds of grant without either being able to shadow the other: a real address always has a local part
 * in front of its "@", so `@iitkgp.ac.in` can never collide with anybody's address. It is also what makes
 * the sign-out lookup in app/api/studio/access/[id]/route.ts an exact suffix match — `endsWith` on the
 * stored key cannot accidentally sweep in `evil-iitkgp.ac.in`, which a bare `iitkgp.ac.in` would.
 *
 * ⚠ RETURNS null RATHER THAN GUESSING. An input with no "@", nothing before it, more than one of them, or
 * whitespace or a slash in the domain produces NO LOOKUP AT ALL. The alternative — taking the text after
 * the last "@" whatever it is — turns a malformed address into a query, and a query is a chance to match
 * a row. Nothing that reaches here has been through Zod: the OAuth callback passes whatever the provider
 * asserted in its token.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function domainKeyOf(email: string): string | null {
  const normalised = normaliseEmail(email);

  const at = normalised.indexOf("@");
  // `at === 0` is "@example.org" — that is a domain, not a person, so it is nobody's address and gets no
  // domain lookup either. `at === -1` is not an address at all.
  if (at <= 0) return null;
  // Exactly one "@". Two of them is not an address this code is entitled to have an opinion about.
  if (normalised.lastIndexOf("@") !== at) return null;

  const domain = normalised.slice(at + 1);
  // The same shapes the add-grant route refuses to store, refused again on the read side, so the two
  // halves cannot drift into disagreeing about what a domain is.
  if (domain.length === 0 || /[\s/]/.test(domain)) return null;

  return `@${domain}`;
}

/**
 * The reading of what somebody typed: the key to store and its kind, or the sentence refusing it.
 *
 * A refusal carries its OWN message rather than a code the caller turns into words, because each of the
 * six refusals below has a different thing to say about what to type instead, and a caller mapping codes
 * to sentences is a second place for those rules to be described slightly differently.
 */
export type AccessSubject =
  | { ok: true; kind: AccessKind; value: string }
  | { ok: false; message: string };

/** Two or more labels; each starts and ends alphanumeric; the last starts with a letter (so "xn--p1ai"
 *  passes and ".123" does not). Anchored, ASCII only, lower-case only — the input is normalised first. */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]([a-z0-9-]*[a-z0-9])?$/;

/** The RFC 1035 ceiling. Longer than this cannot be a real domain, and is a paste of something else. */
const DOMAIN_MAX = 253;

/**
 * Domains that are NOT an organisation, and are therefore refused as domain grants outright.
 *
 * ⚠ THIS IS A REFUSAL AND NOT A WARNING, WHICH IS UNUSUAL FOR THIS CODEBASE. Everywhere else a risky
 * choice is explained and then permitted, because the person doing it may know something the code does
 * not. Not here: "@gmail.com" cannot mean anything except "every one of the roughly two billion people
 * who can create a Google account may open this CMS at `grantedRole`", and it is one keystroke away from
 * the address a colleague at gmail was going to be added under. A warning is read after the entry exists.
 *
 * An institution that genuinely corresponds from such addresses adds those people individually, which is
 * the honest description of what it is doing anyway.
 *
 * The list is deliberately SHORT and only holds providers where anybody may self-register. It cannot be
 * exhaustive and is not trying to be — it catches the mistake somebody actually makes at 6pm, and the
 * general danger is stated on screen for the ones it does not know about.
 */
const OPEN_REGISTRATION_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.co.uk",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "rediffmail.com",
  "yahoo.co.in",
  "yahoo.com",
  "yandex.com",
  "ymail.com",
  "zoho.com"
]);

/**
 * What a master admin typed into the one box, read as either an address or a domain.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A LEADING "@" IS THE SPELLING FOR "EVERYBODY HERE", because it is how people already write it —
 * "we're all @iitkgp.ac.in" — and because it makes the two kinds impossible to confuse in every place
 * the value is later printed: the audit log's `entityLabel`, the duplicate 409, the console's row label.
 * There is no separate tick box to forget to tick, and no way to type an address and get a domain.
 *
 * ⚠ WHAT IS REFUSED, AND WHY EACH ONE. This is the only writer of the widest grant in the product, so it
 * is strict on purpose and every refusal says what to type instead:
 *
 *   • a bare "@" — that is every domain on earth, which is to say the whole internet;
 *   • whitespace or a slash anywhere — a pasted URL ("@https://iitkgp.ac.in/") or two entries pasted at
 *     once, either of which stores a key nothing will ever match while LOOKING like it worked;
 *   • a second "@" — "@ada@iitkgp.ac.in" is somebody trying to write an address with the domain spelling;
 *   • one label and no dot — "@iitkgp" is not a domain, and "@in" is a country rather than an employer;
 *   • anything outside a-z, 0-9, "-" and "." — including non-ASCII, because a provider asserts the
 *     punycode form and a UTF-8 domain stored here would match nobody, silently, forever;
 *   • a public mail provider — see `OPEN_REGISTRATION_DOMAINS`, the one refusal that is about meaning
 *     rather than shape.
 *
 * The address branch is deliberately NOT re-implemented: the caller keeps Zod's `.email()` for that. Two
 * hand-rolled address validators is one more than anybody can keep in step.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function parseAccessSubject(raw: string): AccessSubject {
  const value = normaliseEmail(raw);

  if (!value.startsWith("@")) {
    // An address. `kind` is EMAIL and the caller's `.email()` has already had its say about the shape.
    return { ok: true, kind: "EMAIL", value };
  }

  const domain = value.slice(1);

  if (domain.length === 0) {
    return {
      ok: false,
      message:
        "“@” on its own would let anybody at any domain sign in. Write the domain after it, as in “@iitkgp.ac.in”."
    };
  }
  if (/[\s/]/.test(domain)) {
    return {
      ok: false,
      message:
        "A domain cannot contain a space or a slash. Write just the domain, as in “@iitkgp.ac.in” — not a web address, and one at a time."
    };
  }
  if (domain.includes("@")) {
    return {
      ok: false,
      message:
        "That has two “@” in it. Write one address in full (“ada@iitkgp.ac.in”), or one domain with a single leading “@” to allow everybody there (“@iitkgp.ac.in”)."
    };
  }
  if (domain.length > DOMAIN_MAX) {
    return { ok: false, message: "That is too long to be a domain. Check for a pasted address." };
  }
  if (!DOMAIN_PATTERN.test(domain)) {
    return {
      ok: false,
      message:
        "That does not look like a domain. It needs at least one dot and only letters, digits and hyphens — “@iitkgp.ac.in”. A domain written in a non-Latin script must be given in its punycode form, because that is the form a sign-in provider asserts."
    };
  }
  if (OPEN_REGISTRATION_DOMAINS.has(domain)) {
    return {
      ok: false,
      message:
        `“${value}” is a public mail provider, not an organisation: anybody in the world can create an address there, so allowing the whole domain would let anybody sign in to this studio. Add the individual addresses instead — “ada${value}”.`
    };
  }

  return { ok: true, kind: "DOMAIN", value };
}

export type AccessDecision =
  | { ok: true; grant: StudioAccess | null; viaGrace: boolean }
  | { ok: false; reason: "not-listed" | "revoked" | "provider-not-allowed" };

/**
 * The two questions every hit is put through, whichever kind of grant it came from.
 *
 * One function rather than two, so a domain grant and an exact address are checked by the SAME code and
 * not by two copies that agree today. A domain grant that is revoked, or narrowed to Google, has to mean
 * exactly what those mean on an individual entry — a second implementation is how "revoked" quietly
 * becomes "revoked, unless they arrive through the domain".
 */
function decideOnGrant(grant: StudioAccess, provider: AuthProvider): AccessDecision {
  if (grant.revokedAt) return { ok: false, reason: "revoked" };

  // An empty list means "any configured method". A populated one is an explicit narrowing — an
  // administrator who wrote "Google only" meant it, and a password must not be an unnoticed second door.
  if (grant.allowedProviders.length > 0 && !grant.allowedProviders.includes(provider)) {
    return { ok: false, reason: "provider-not-allowed" };
  }

  return { ok: true, grant, viaGrace: false };
}

/**
 * May this address sign in, by this method?
 *
 * Returns a DECISION rather than throwing, because the caller has to answer carefully: the message a
 * refused visitor sees must not reveal whether an address is on the list. See `ACCESS_REFUSED_MESSAGE`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE STEPS, IN THIS ORDER, AND EACH ONE ANSWERS RATHER THAN FALLING THROUGH.
 *
 *   1. THE EXACT ADDRESS. If a row names this person, its answer is FINAL — including when the answer is
 *      "no". ⚠ THIS IS WHAT MAKES REVOKING ONE PERSON WORK AT AN ALLOWED DOMAIN. If a revoked individual
 *      entry fell through to step 2, revoking ada@iitkgp.ac.in while @iitkgp.ac.in is granted would
 *      change nothing at all, and the master admin who did it would watch her sign in a minute later. The
 *      same reasoning covers `allowedProviders`: an entry narrowed to Google must not be widened again by
 *      a domain grant that permits passwords, or the narrowing is decoration.
 *   2. THE DOMAIN. Only now, and only for a well-formed address (`domainKeyOf` returns null otherwise, so
 *      a malformed one produces no query rather than a query for "@"). A hit is put through
 *      `decideOnGrant` — the very same revocation and sign-in-method checks an individual entry gets.
 *   3. THE GRACE PATH. Last, because it is the only soft edge in the whole gate and it must not be
 *      reached while ANY grant could have answered. It is conditional on the list being empty anyway, and
 *      a domain grant counts towards that count exactly as an address does: one domain grant means the
 *      allow-list is in use and is authoritative.
 *
 * The kind is checked on BOTH sides of the match, so a row hand-edited in psql to disagree with itself —
 * kind DOMAIN on an ordinary address, or kind EMAIL on an "@domain" key — grants nobody anything. It
 * fails closed, which is the only direction a mistake here is allowed to fail.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function resolveAccess(input: {
  email: string;
  provider: AuthProvider;
  /** The existing account, when one has already been found. Enables the grace path below. */
  existingUser?: Pick<User, "id" | "isActive" | "deletedAt"> | null;
}): Promise<AccessDecision> {
  const email = normaliseEmail(input.email);

  // ── 1. The exact address ───────────────────────────────────────────────────────────────────────
  const exact = await prisma.studioAccess.findUnique({ where: { email } });
  if (exact && exact.kind === "EMAIL") return decideOnGrant(exact, input.provider);

  // ── 2. The domain ──────────────────────────────────────────────────────────────────────────────
  // `domainKeyOf` returns the key a domain grant is STORED under, "@" and all, so this is the same
  // unique index and an exact equality — never a `LIKE`, a suffix scan or a second normalisation.
  const domainKey = domainKeyOf(email);
  const domainGrant =
    domainKey === null ? null : await prisma.studioAccess.findUnique({ where: { email: domainKey } });

  if (domainGrant && domainGrant.kind === "DOMAIN") {
    return decideOnGrant(domainGrant, input.provider);
  }

  // ── 3. The grace path ──────────────────────────────────────────────────────────────────────────
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
   * adds the first person. It counts DOMAIN rows too, and it must: an installation whose only grant is
   * "@iitkgp.ac.in" has configured its allow-list, and grace would otherwise keep admitting the accounts
   * that domain was written to stop admitting.
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

/**
 * A sentence for the AUDIT LOG — specific, because the reader is entitled to the detail.
 *
 * Worded as "a grant covering the address" rather than "the address is on the list", because since
 * domain grants exist the two are not the same thing: the entry that refused somebody may be
 * "@iitkgp.ac.in" and no row anywhere names them. The sentence has to be true of both, and an audit line
 * that says "the address is on the access list" about an entry the reader cannot then find on the access
 * list is worse than one that is merely brief.
 *
 * The signature deliberately takes only the reason: the three sign-in paths pass `decision.reason` and
 * nothing else, and a refusal has no grant to describe — see `AccessDecision`.
 */
export function describeRefusal(reason: Exclude<AccessDecision, { ok: true }>["reason"]): string {
  switch (reason) {
    case "not-listed":
      return "no entry on the studio access list covers the address, by name or by domain";
    case "revoked":
      return "the grant covering the address has been revoked";
    case "provider-not-allowed":
      return "a grant covers the address but not for this sign-in method";
  }
}

/**
 * Record that a grant was used.
 *
 * Never throws: a session that has been issued must not be reported as failed because a bookkeeping
 * write lost a race. The worst consequence of a missed stamp is one stale "last used" figure, and the
 * audit log holds the authoritative record either way.
 *
 * ON A DOMAIN GRANT THESE FIGURES ARE THE DOMAIN'S, NOT ONE PERSON'S. `signInCount` becomes "how many
 * sign-ins this domain has admitted" and `lastSignInAt` "when anybody at it last arrived", which is
 * exactly the number the console's "never used" filter needs to answer the prunability question for a
 * domain: a domain grant nobody has ever come through is one nothing depends on. WHO arrived is in the
 * audit log and on their own account, both of which name the person; this row could not name them
 * without becoming a second, worse copy of that.
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
 *
 * ⚠ ON A DOMAIN GRANT THE CAP IS DOING MORE WORK THAN IT LOOKS. `grantedRole` there is the role EVERY
 * account created from that domain arrives with — one careless "@iitkgp.ac.in as editor" is a thousand
 * potential editors rather than one — so the cap is what keeps the worst version of that mistake short of
 * "and they can all widen the list themselves".
 *
 * AND `name` ON A DOMAIN GRANT IS THE ORGANISATION, NEVER A PERSON. Anything deriving a person's display
 * name from a grant must test `kind` first, or every colleague whose provider asserted no name of their
 * own is created called "IIT Kharagpur".
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
