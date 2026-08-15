import Link from "next/link";
import { Lock, LayoutDashboard } from "lucide-react";

import { currentUser } from "@/lib/auth/current-user";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/permissions";

/**
 * "You are signed in, and this is not yours to open."
 *
 * Rendered by Next when a page calls `forbidden()` — see `requireStudioCapability` in
 * lib/auth/current-user.ts. It carries a real **403** status, which is the whole reason it exists: the
 * alternative was a thrown error surfacing as a 500 that told an editor "something went wrong on our
 * side", which is false and sends somebody looking for a fault that is not there.
 *
 * WHAT THIS PAGE IS CAREFUL ABOUT:
 *
 *   • **It does not apologise, and it does not imply a mistake.** The refusal is deliberate and
 *     correct. The reader's problem is knowing what to do next, not being consoled.
 *   • **It says which tier they hold**, so the ask is concrete: "I have Author and I need Editor" is a
 *     request an administrator can act on in ten seconds. "I do not have access" is a support thread.
 *   • **It does not name the tier REQUIRED unless the caller passed it.** Enumerating exactly which
 *     role opens which door, to somebody who has just been refused, is more than the refusal needs to
 *     say — and the guard's own message already says it whenever it is useful.
 *   • **It offers a way back**, because a refusal that leaves somebody nowhere to go is a dead end
 *     even when the refusal itself is right.
 *
 * ⚠ IT LIVES UNDER `app/studio/`, NOT AT THE APP ROOT, AND THAT IS LOAD-BEARING. Next resolves the
 * NEAREST `forbidden.tsx`, so placing it here scopes it to the studio segment — which is the only place
 * that calls `forbidden()`.
 *
 * At the app root it is pulled into every route's shell, and because it reads `cookies()` (through
 * `currentUser()`) it makes those routes DYNAMIC. Routes with `generateStaticParams` — /news/[slug],
 * /events/[slug], /gallery/[slug] and the CMS catch-all — are expected to be static, so rendering a
 * path outside the prerendered set threw "Page changed from static to dynamic at runtime, reason:
 * cookies" and returned a **500 instead of a 404** for every unpublished article, event, album and page.
 * The leak check in scripts/leak-check.ts is what caught it.
 *
 * ⚠ It must not itself require a permission. A forbidden page that can be forbidden is a loop.
 */
export default async function Forbidden() {
  // `currentUser()` is cached per request and returns null rather than throwing, so this stays safe
  // even for the edge case of a session that expired between the guard and this render.
  const user = await currentUser();

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-2xl flex-col justify-center px-5 py-16 sm:px-8">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-surface-200 text-ink-500">
        <Lock aria-hidden="true" className="h-5 w-5" />
      </span>

      <h1 className="display-title mt-6 text-3xl md:text-4xl">This is not part of your access</h1>

      <p className="mt-4 text-base leading-7 text-ink-700">
        You are signed in, and the page you asked for is restricted to a higher level of access than
        your account holds. Nothing has gone wrong.
      </p>

      {user ? (
        <div className="mt-8 rounded-lg border border-line-200 bg-surface-50 p-5">
          <p className="text-sm text-ink-500">Signed in as</p>
          <p className="mt-1 font-medium text-ink-900">{user.email}</p>
          <p className="mt-4 text-sm text-ink-500">Your access level</p>
          <p className="mt-1 font-medium text-ink-900">{ROLE_LABELS[user.role]}</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-700">{ROLE_DESCRIPTIONS[user.role]}</p>
          <p className="mt-4 text-sm leading-relaxed text-ink-500">
            An administrator can raise this. Quoting the two lines above is enough for them to make the
            change.
          </p>
        </div>
      ) : null}

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/studio" className="field-button">
          <LayoutDashboard aria-hidden="true" className="h-4 w-4" />
          Back to the studio
        </Link>
        <Link href="/" className="field-button-secondary">
          View the site
        </Link>
      </div>
    </div>
  );
}
