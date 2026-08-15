import { NextResponse, type NextRequest } from "next/server";
import type { Role, StudioAccess } from "@prisma/client";
import { z } from "zod";
import { clientIp, notFound, route, userAgent } from "@/lib/api";
import { mutateWithHistory, recordEvent, type AuditContext } from "@/lib/audit";
import { prisma } from "@/lib/db";
import {
  describeRefusal,
  initialRoleFor,
  markGrantUsed,
  normaliseEmail,
  resolveAccess
} from "@/lib/auth/access";
import {
  exchangeCode,
  providerConfig,
  providerFromSlug,
  statesMatch,
  verifyIdToken,
  type VerifiedIdentity
} from "@/lib/auth/oauth";
import {
  DEFAULT_NEXT,
  clearHandshakeCookie,
  loginRedirect,
  readHandshakeCookie,
  requestOrigin,
  type SignInNotice
} from "@/lib/auth/oauth-cookies";
import { applySession } from "@/lib/auth/respond";
import { createSession, markSignedIn } from "@/lib/auth/session";

/**
 * The second half of the handshake — and the security-critical half.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ORDER OF THE STEPS BELOW IS THE DESIGN. Each one is a gate the next depends on:
 *
 *   1. clear the handshake        — a handshake that survives its own use is a replayable one
 *   2. an `error` from the provider — somebody pressed Cancel; that is not a fault
 *   3. `state`, in constant time  — the CSRF control for the whole flow
 *   4. exchange, then verify      — signature, issuer, audience and nonce, all in lib/auth/oauth.ts
 *   5. `email_verified`           — an allow-list keyed on an address is worth nothing without it
 *   6. find the link by `sub`     — NEVER by email
 *   7. **the allow-list**         — before a single row is written
 *   8. link or create             — one transaction
 *   9. active account only
 *  10. session, stamps, audit, onward
 *
 * ⚠ `assertSameOrigin()` IS NOT CALLED HERE, and its absence is deliberate rather than an omission.
 * This request is BY CONSTRUCTION a cross-site top-level navigation: the provider sent the browser
 * here. Refusing a foreign origin would refuse every real sign-in. The `state` check at step 3 is what
 * takes its place, and it is the stronger control — it proves the callback belongs to a handshake this
 * server opened for this browser, which an Origin header cannot.
 *
 * ⚠ NOTHING IS CREATED BEFORE STEP 7. That is the whole reason the allow-list exists: a provider
 * answers "who is this?", never "should they be here?", so a callback that created an account and then
 * checked would be a CMS open to every Google account on earth for the width of one transaction.
 *
 * EVERY REFUSAL SHOWS THE SAME SENTENCE. `ACCESS_REFUSED_MESSAGE` does not distinguish "not on the
 * list" from "revoked" from "wrong sign-in method", because a page that did would answer "does this
 * person work at the Centre?" for anybody who asked. The specific reason goes to the audit log.
 *
 * EVERY ANSWER IS A REDIRECT TO A PATH ON THIS ORIGIN. A browser is navigating; a JSON body would be
 * rendered as text in a blank window with no way back.
 *
 * NO RATE LIMIT HERE, unlike the start route: this route does no work at all until it has an open
 * handshake and a matching `state`, both of which cost one cookie read, and the handshake can only be
 * opened through the start route — which IS limited. Anything that reaches the token exchange has
 * already been paid for there.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * What the provider may put in the query string.
 *
 * Unknown keys are STRIPPED rather than refused — Google adds `scope`, `authuser`, `hd` and `prompt`,
 * and a schema that refused them would refuse every Google sign-in. The caps are shape checks: a `code`
 * is a few hundred characters, and anything vastly longer is not one.
 *
 * Read with `safeParse` rather than `parseQuery()` from lib/api.ts, because that helper throws a 422
 * with a JSON body and this is a browser navigation.
 */
const CallbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(2000).optional()
});

/**
 * The provider's way of saying "the person declined", as opposed to "something broke".
 *
 * A reader who pressed Cancel must not be shown a failure that looks like a fault — they would report a
 * broken sign-in, and somebody would go looking for it. Anything not in this set is treated as a genuine
 * problem and logged with its description.
 */
const DECLINED = new Set([
  "access_denied",
  "consent_required",
  "login_required",
  "interaction_required",
  "user_cancelled_authorize",
  "user_cancelled_login"
]);

/** Exactly the columns a session needs. Never the whole row — see rule 2 in app/api/studio/users/route.ts. */
interface SignedInUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/**
 * What to call somebody whose account is being created for them.
 *
 * The provider's `name` first, then the name a master admin typed on the access list, then the part of
 * the address before the `@` — which is poor but honest, and better than an empty column on the people
 * screen. Capped, because `User.name` has no length limit in the database and a token is not a form.
 */
function displayName(
  identity: VerifiedIdentity,
  grant: StudioAccess | null,
  email: string
): string {
  const candidate = identity.name?.trim() || grant?.name?.trim() || email.split("@")[0] || email;
  return candidate.slice(0, 120);
}

/**
 * Record that a linked account was used.
 *
 * Never throws, for the same reason as `markSignedIn` and `markGrantUsed`: a session that has been
 * issued must not be reported as a failed sign-in because a bookkeeping write lost a race.
 *
 * `email` is deliberately NOT refreshed. The column records what the provider asserted AT LINK TIME
 * (prisma/schema.prisma), and today's assertion is already on the LOGIN audit entry — overwriting it
 * would quietly erase the evidence that the address on this identity has changed.
 */
async function touchLinkedAccount(id: string): Promise<void> {
  try {
    await prisma.oAuthAccount.update({ where: { id }, data: { lastUsedAt: new Date() } });
  } catch (error) {
    console.error("[oauth] could not record when the linked account was last used", id, error);
  }
}

export const GET = route(
  async (request: NextRequest, context: { params: Promise<{ provider: string }> }) => {
    const { provider: slug } = await context.params;
    const provider = providerFromSlug(slug);
    // As in the start route: nothing links here but our own buttons, so an unknown slug is a 404.
    if (!provider) throw notFound("That way of signing in");

    // ── 1. Read the handshake, and guarantee it is closed on the way out ────────────────────────
    const handshake = readHandshakeCookie(request);
    const next = handshake?.next ?? DEFAULT_NEXT;

    /**
     * EVERY response from here on goes through this, success included. The cookie is cleared whatever
     * happened, so a `state`, a `nonce` and a PKCE verifier can each be presented exactly once.
     */
    const finish = (response: NextResponse): NextResponse => {
      clearHandshakeCookie(response);
      response.headers.set("Cache-Control", "no-store");
      return response;
    };
    const refuse = (notice: SignInNotice): NextResponse =>
      finish(loginRedirect(request, notice, next));

    // No cookie is the ordinary case, not a suspicious one: ten minutes passed, or the browser dropped
    // it. The sentence says so plainly rather than implying something went wrong.
    if (!handshake) return refuse("handshake_expired");

    // The cookie holds ONE handshake (see `writeHandshakeCookie`). A callback for a different provider
    // than the one it was opened for is a stale tab or a replayed URL, and its `state` would not match
    // anyway — this simply refuses it before any network call is made.
    if (handshake.provider !== provider) return refuse("request_mismatch");

    const rawQuery: Record<string, string> = {};
    request.nextUrl.searchParams.forEach((value, key) => {
      rawQuery[key] = value;
    });
    const parsedQuery = CallbackQuery.safeParse(rawQuery);
    if (!parsedQuery.success) return refuse("sign_in_failed");
    const query = parsedQuery.data;

    const auditContext: AuditContext = {
      actor: null,
      ipAddress: clientIp(request),
      userAgent: userAgent(request)
    };

    // ── 2. The provider refused, or the person changed their mind ───────────────────────────────
    if (query.error) {
      // The description goes to the server log and NEVER into the URL: it is text chosen by somebody
      // else, and a sign-in page that renders arbitrary text is a phishing surface.
      console.warn(
        `[oauth] ${provider} returned "${query.error}"`,
        query.error_description ?? "(no description)"
      );
      return refuse(DECLINED.has(query.error) ? "provider_cancelled" : "sign_in_failed");
    }

    // ── 3. state ────────────────────────────────────────────────────────────────────────────────
    // Constant time, via `statesMatch`. Without this check an attacker completes their own sign-in in
    // your browser and you edit the site as them, or they capture a code issued for you.
    if (!statesMatch(handshake.state, query.state ?? "")) {
      await recordEvent(auditContext, {
        action: "LOGIN_FAILED",
        entityType: "User",
        after: {
          provider,
          reason:
            "the sign-in did not carry the one-time value issued when the handshake started, so it could not be matched to a request from this browser"
        }
      });
      return refuse("request_mismatch");
    }

    if (!query.code) return refuse("sign_in_failed");

    // Configuration can change between the two halves of a handshake — a deployment restarted with a
    // secret removed. A plain sentence, not a crash.
    const config = providerConfig(provider);
    if (!config) return refuse("provider_unavailable");

    // ── 4. Exchange the code, then verify the token ─────────────────────────────────────────────
    // The same helper the start route used, so `redirect_uri` is byte-identical in both messages —
    // every provider compares them, and a mismatch is refused with an error that names no cause.
    const origin = requestOrigin(request);

    let identity: VerifiedIdentity;
    try {
      const tokens = await exchangeCode({
        config,
        code: query.code,
        origin,
        codeVerifier: handshake.codeVerifier
      });
      // A token response with no ID token is not an identity. It happens when the `openid` scope was
      // dropped from the registration, and reading the access token instead would be trusting a value
      // nothing has verified.
      if (!tokens.id_token) throw new Error("the token response carried no id_token");

      identity = await verifyIdToken({
        config,
        idToken: tokens.id_token,
        nonce: handshake.nonce
      });
    } catch (error) {
      // The real reason is for the operator. The reader gets one sentence, because the difference
      // between "the secret is wrong" and "the nonce did not match" is not something they can act on.
      console.error(`[oauth] ${provider} sign-in could not be verified`, error);
      return refuse("sign_in_failed");
    }

    const email = normaliseEmail(identity.email);

    // ── 5. The provider must vouch for the address ──────────────────────────────────────────────
    // The allow-list is keyed on an email address, so it is worth nothing if somebody can assert an
    // address they do not own. `emailIsVerified` in lib/auth/oauth.ts explains Microsoft's exception.
    if (!identity.emailVerified) {
      await recordEvent(auditContext, {
        action: "LOGIN_FAILED",
        entityType: "User",
        entityLabel: email,
        after: {
          email,
          provider,
          reason: "the provider did not confirm that this email address belongs to the account"
        }
      });
      return refuse("email_unverified");
    }

    // ── 6. Find the link by the provider's subject, never by email ──────────────────────────────
    // An address is reassignable inside an organisation — a leaver's mailbox becomes a shared inbox,
    // and matching on it would hand their CMS account to whoever holds it next. `sub` is not.
    const account = await prisma.oAuthAccount.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId: identity.subject } },
      select: {
        id: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            deletedAt: true
          }
        }
      }
    });

    // Only looked up when there is no link yet, and only ever used for the merge at step 8 — never as a
    // way of finding an account for somebody who already has one.
    const linkCandidate = account
      ? null
      : await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            deletedAt: true
          }
        });

    const existingUser = account?.user ?? linkCandidate;

    // ── 7. THE ALLOW-LIST. Nothing has been written yet, and nothing will be if this refuses ─────
    const decision = await resolveAccess({ email, provider, existingUser });

    if (!decision.ok) {
      await recordEvent(auditContext, {
        action: "LOGIN_FAILED",
        entityType: "User",
        entityId: existingUser?.id ?? null,
        entityLabel: email,
        // The SPECIFIC reason, here and only here. The reader is told nothing that distinguishes it.
        after: { email, provider, reason: describeRefusal(decision.reason) }
      });
      return refuse("access_denied");
    }

    // ── 9, hoisted. A deactivated account is refused BEFORE anything is linked to it ─────────────
    // The allow-list can say yes about an address whose account has since been switched off, and
    // linking a fresh identity to a disabled account would leave a tidy way back in for somebody who
    // was deliberately locked out. Same sentence as every other refusal.
    if (existingUser && (!existingUser.isActive || existingUser.deletedAt)) {
      await recordEvent(auditContext, {
        action: "LOGIN_FAILED",
        entityType: "User",
        entityId: existingUser.id,
        entityLabel: email,
        after: {
          email,
          provider,
          reason: existingUser.deletedAt
            ? "the account has been deleted"
            : "the account has been deactivated"
        }
      });
      return refuse("access_denied");
    }

    // ── 8. Link, merge or create — each in ONE transaction ──────────────────────────────────────
    let signedIn: SignedInUser;
    let outcome: "already linked" | "linked to an existing account" | "new account";

    if (account) {
      signedIn = {
        id: account.user.id,
        email: account.user.email,
        name: account.user.name,
        role: account.user.role
      };
      outcome = "already linked";
      await touchLinkedAccount(account.id);
    } else if (existingUser) {
      /**
       * THE MERGE. An account already exists at this address and has never used this provider, so the
       * two are joined.
       *
       * ⚠ THIS IS ONLY SAFE BECAUSE OF THE TWO CHECKS ABOVE IT. The address was VERIFIED BY THE PROVIDER
       * at step 5, so the person genuinely holds it; and it is ON THE ALLOW-LIST at step 7, so somebody
       * with authority has said it belongs here. Without the first, anyone able to assert an address
       * would take over the account at it — which is precisely how "Sign in with Google" becomes an
       * account-takeover primitive on a site that merges on an unverified email.
       *
       * The role is NOT re-read from the grant: `grantedRole` is the role an account is created with,
       * and applying it here would silently undo a later promotion or demotion.
       */
      signedIn = await mutateWithHistory<SignedInUser>(
        auditContext,
        {
          action: "UPDATE",
          entityType: "User",
          entityLabel: `${existingUser.name} <${existingUser.email}>`,
          // No revision: a user row is not versioned content, and one here would only be a second copy
          // of the audit entry. Same reasoning as the invitation route.
          revise: false
        },
        async (tx) => {
          await tx.oAuthAccount.create({
            data: {
              provider,
              providerAccountId: identity.subject,
              userId: existingUser.id,
              email
            }
          });
          return {
            id: existingUser.id,
            email: existingUser.email,
            name: existingUser.name,
            role: existingUser.role,
            linkedProvider: provider,
            linkedAddress: email
          };
        }
      );
      outcome = "linked to an existing account";
    } else {
      /**
       * A first sign-in. The account and its link are created together, so a failure cannot leave a user
       * row nobody can sign in to.
       *
       * NO PASSWORD — absent, not blank. `verifyPassword()` cannot authenticate against `null`
       * (lib/auth/password.ts), so this account has exactly one way in until its owner asks an
       * administrator for a password link. `initialRoleFor` caps the role below master admin however
       * generous the grant is: a newly seen account must not arrive already able to widen the allow-list.
       */
      const name = displayName(identity, decision.grant, email);
      const role = initialRoleFor(decision.grant);

      signedIn = await mutateWithHistory<SignedInUser>(
        auditContext,
        {
          action: "CREATE",
          entityType: "User",
          entityLabel: `${name} <${email}>`,
          revise: false
        },
        async (tx) => {
          const created = await tx.user.create({
            data: { email, name, role, passwordHash: null, isActive: true },
            // Explicit, so nothing secret reaches the audit payload or this function's result.
            select: { id: true, email: true, name: true, role: true }
          });
          await tx.oAuthAccount.create({
            data: {
              provider,
              providerAccountId: identity.subject,
              userId: created.id,
              email
            }
          });
          return { ...created, createdVia: provider };
        }
      );
      outcome = "new account";
    }

    // ── 10. The session, the stamps, the log, and onward ────────────────────────────────────────
    const session = await createSession({
      userId: signedIn.id,
      userAgent: userAgent(request),
      ipAddress: clientIp(request)
    });

    // `next` came out of the handshake cookie and was validated on the way in and on the way out, so it
    // is a single-slash, same-origin, non-API path and this cannot leave the site.
    const response = NextResponse.redirect(new URL(next, origin), 307);
    await applySession(response, signedIn, session);

    // Only now is this a sign-in, which is why both stamps are here rather than earlier. Neither throws.
    await markSignedIn(signedIn.id);
    if (decision.grant) await markGrantUsed(decision.grant.id, provider);

    await recordEvent(
      { ...auditContext, actor: { id: signedIn.id, email: signedIn.email } },
      {
        action: "LOGIN",
        entityType: "User",
        entityId: signedIn.id,
        entityLabel: signedIn.email,
        after: {
          method: config.label,
          provider,
          account: outcome,
          // True when the account was admitted without a grant because it already existed and is active
          // — `resolveAccess` warns about it in the server log, and this is the durable record.
          admittedWithoutGrant: decision.viaGrace
        }
      }
    );

    return finish(response);
  }
);
