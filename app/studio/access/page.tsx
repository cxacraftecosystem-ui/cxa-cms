import type { Metadata } from "next";
import type { AuthProvider } from "@prisma/client";

import { normaliseEmail } from "@/lib/auth/access";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { configuredProviders } from "@/lib/auth/oauth";
import { prisma } from "@/lib/db";
import { canManageStudioAccess } from "@/lib/permissions";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { AccessManager } from "./AccessManager";

/**
 * Studio access — the list of addresses that may sign in at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageStudioAccess)` IS THE FIRST STATEMENT. It is the PAGE guard, which
 * calls Next's `forbidden()` and renders `app/forbidden.tsx` with a real 403; `requireCapability` — the
 * one the `/api/studio/access/*` handlers use — throws an `ApiError`, which inside a Server Component
 * becomes an unhandled throw and a **500** telling a reader the site is broken when in fact they were
 * deliberately refused (contract §1.9). They are not interchangeable.
 *
 * MASTER ADMIN ONLY, and the same predicate the two route handlers call. An administrator manages the
 * site; a master admin decides who is allowed near it, so the account used every day — the one most
 * likely to be phished — cannot widen the circle of people who can sign in.
 *
 * THE AUTHORITATIVE ROW, NOT THE TOKEN. The guard reads through `currentUser()`, which re-reads the user
 * row rather than trusting the signed access token. A token minted before a demotion stays valid until it
 * expires, and this is the worst screen in the product for that window to matter.
 *
 * FOUR FACTS ARE HANDED DOWN THAT ONLY THE SERVER CAN KNOW:
 *
 *   • WHICH ADDRESS IS LOOKING, normalised, so the screen can withhold the revoke and delete controls on
 *     the reader's own entry and say why. ⚠ A courtesy: the route handlers enforce it.
 *   • WHICH SIGN-IN METHODS THIS INSTALLATION HAS SET UP. `configuredProviders()` reads the OAuth client
 *     ids and secrets from the environment, which a browser must never see, so the screen is told only
 *     the names. Without it a master admin could restrict somebody to "Google" on an installation where
 *     Google is not configured, and that person could never sign in — with nothing on either screen to
 *     say why.
 *   • WHETHER THE READER'S OWN ADDRESS IS ON THE LIST. It can legitimately be missing: an account that
 *     predates the list is admitted by the grace path in lib/auth/access.ts, which logs a warning nobody
 *     reads. Saying it here turns that into something a person can fix.
 *   • HOW MANY ENTRIES THERE ARE, for the header. The live figures come with the list itself, so they
 *     stay right after a change.
 *
 * THE LIST IS FETCHED BY THE CLIENT COMPONENT. Every action on this screen — revoking, restoring,
 * changing a role — has to leave the reader looking at the same row, which a server-rendered list cannot
 * do.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Studio access"
};

export default async function StudioAccessPage() {
  const user = await requireStudioCapability(
    canManageStudioAccess,
    "The studio access list is only visible to a master administrator. It decides who can sign in at all, " +
      "so it is kept apart from the people who manage the site day to day."
  );

  const email = normaliseEmail(user.email);

  const [total, ownEntry] = await prisma.$transaction([
    prisma.studioAccess.count(),
    prisma.studioAccess.findUnique({ where: { email }, select: { id: true, revokedAt: true } })
  ]);

  /**
   * The provider NAMES only — never the client ids or secrets `providerConfig()` reads to decide this.
   *
   * `OAuthProviderName` is a narrower union than `AuthProvider` (there is no "Continue with password"
   * button), and every one of its members is an `AuthProvider`, so the widening is safe and keeps the
   * client's prop the same enum its checkboxes write. The labels `configuredProviders()` also returns are
   * deliberately dropped: the screen has its own copy of them, because lib/auth/oauth.ts is `server-only`
   * and two short label maps that agree are a better trade than making the OIDC layer importable by a
   * browser.
   */
  const methods: AuthProvider[] = configuredProviders().map((entry) => entry.provider);

  return (
    <div className="mx-auto w-full max-w-[100rem] space-y-6">
      <StudioPageHeader
        title="Studio access"
        description="Nobody whose email address is not on this list can sign in to the studio — not with a password, and not with Google, Microsoft or Yahoo. Signing in with one of those proves who somebody is; this list is what decides whether they belong here."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 address" : `${total} addresses`}
          </span>
        }
      />

      <AccessManager
        currentUserEmail={email}
        currentUserName={user.name}
        ownEntryExists={ownEntry !== null}
        ownEntryRevoked={ownEntry !== null && ownEntry.revokedAt !== null}
        configuredMethods={methods}
      />
    </div>
  );
}
