import type { Metadata } from "next";

import { currentUser } from "@/lib/auth/current-user";
import { UnsavedChangesProvider } from "@/components/studio/useUnsavedChanges";
import { ConfirmProvider } from "@/components/ui/ConfirmProvider";
import { StudioShell } from "@/components/studio/StudioShell";

/**
 * The studio frame.
 *
 * A SERVER COMPONENT, and it stays one: the authoritative role is read from the database here, once
 * per request, and handed down. `currentClaims()` would be cheaper but it reads a signed token that
 * may have been minted before a demotion and stays valid for up to half an hour — so the sidebar would
 * go on offering Settings to somebody who lost that access this morning.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO `redirect("/studio/login")` HERE, AND WHY THAT IS NOT A HOLE.
 *
 * The sign-in screen lives at `/studio/login`, which is a DESCENDANT of this segment, so this layout
 * renders for it too. Next gives a server layout no way to know the pathname (a layout receives
 * `params`, never `searchParams` and never the URL), and the login route cannot be lifted into a route
 * group without moving every other studio segment into one alongside it — route groups do not escape a
 * parent layout, only a layout declared inside the group is scoped to it.
 *
 * So a `redirect()` on the signed-out branch would send the login screen to ITSELF: an endless chain of
 * 307s, ERR_TOO_MANY_REDIRECTS, and no way into the CMS at all. Instead the signed-out branch renders
 * the children BARE — no sidebar, no top bar, nothing that needs a user — and the login page draws its
 * own full-page shell.
 *
 * The guard is therefore in three places, none of which is this one:
 *
 *   • `middleware.ts` refuses every `/studio/*` path but the login screen when there is no live
 *     session, and redirects with `?next=` so the reader lands back where they were going;
 *   • every studio page calls `requireUser()` / `requireCapability()` as its FIRST statement, which
 *     re-reads the row and throws rather than rendering;
 *   • every `/api/studio/*` handler does the same, which is the boundary that actually matters.
 *
 * What this layout adds on top of those is the one thing it is uniquely placed to do: it never renders
 * the CMS chrome for a request it could not attach a real user to. A sidebar built for nobody is how a
 * screen ends up offering an action the server will refuse.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT IS DELIBERATELY ABSENT:
 *
 *   • `ToastProvider` and `PreferencesProvider` — both are mounted once in `app/layout.tsx`. A nested
 *     `ToastProvider` renders a second `aria-live` region and a screen reader reads every notice twice;
 *     a nested `PreferencesProvider` shadows the real one, so the studio's theme toggle would stop
 *     moving the public site's theme.
 *   • `SmoothScroll` (Lenis). A CMS that scrolls with inertia feels broken when you are trying to land
 *     on a table row, so it is scoped to `app/(site)` and never mounted here.
 *
 * `ConfirmProvider` and `UnsavedChangesProvider` are each mounted EXACTLY ONCE, here, above every
 * screen that asks a question or holds an editor.
 *
 *   • A second nested `ConfirmProvider` takes over `useConfirm()` for everything below it and renders
 *     its own dialog, which — given the same rung and portalled from elsewhere in the tree — can appear
 *     BEHIND the surface that raised it. The reader sees a frozen screen and a modal they cannot reach.
 *   • `UnsavedChangesProvider` must sit ABOVE BOTH the leave-guard's consumers and the back control,
 *     because they are siblings rather than parent and child: the guard is registered by an editor deep
 *     in the tree and consulted by navigation chrome beside it. Anywhere lower and one of the two
 *     cannot see it.
 *
 * ⚠ ORDER MATTERS BETWEEN THESE TWO. `UnsavedChangesProvider` is OUTSIDE `ConfirmProvider` because the
 * leave guard asks a question — an editor abandoning unsaved work gets a confirm dialog — so the
 * confirm machinery has to be reachable from inside the guard's subtree, not the other way round.
 */

export const metadata: Metadata = {
  // Belt and braces. `next.config.ts` already sends `X-Robots-Tag: noindex` for `/studio/:path*` and
  // middleware repeats it on the redirects, but a header is invisible when you are reading the HTML
  // and a crawler that only honours the meta tag is still a crawler.
  robots: { index: false, follow: false },
  title: { default: "Studio", template: "%s · Studio" }
};

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();

  // See the header: the login screen is a child of this segment, so this branch is the one that keeps
  // it renderable. `currentUser()` returns null — not a stale user — when the row has since been
  // deactivated or soft-deleted, so a token outliving its account lands here too.
  if (!user) return <>{children}</>;

  return (
    <StudioShell user={user}>
      <UnsavedChangesProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </UnsavedChangesProvider>
    </StudioShell>
  );
}
