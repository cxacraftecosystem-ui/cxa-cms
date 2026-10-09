/**
 * Leave this page for a freshly loaded document at `path`.
 *
 * A FULL LOAD, NEVER `router.push`, and only ever for the moments the SESSION has just changed under
 * the page: signing in, signing out, a session found to have ended. Every Server Component payload the
 * client router is holding was rendered for whoever the browser used to be, so a client navigation would
 * carry that stale tree onto the next screen — a studio shell for somebody who has just signed out, or a
 * sign-in screen still holding the previous account's menus.
 *
 * Next's lint rule `no-location-assign-relative-destination` exists to stop `location.assign` standing
 * in for `router.push` on ordinary in-app navigation, which is the right default and why this is the one
 * place it is written. An ordinary link or button that goes somewhere inside the site uses `<Link>` or
 * `useRouter()`; reaching for this instead throws away the router's cache for nothing.
 */
export function navigateWithFullLoad(path: string): void {
  window.location.assign(path);
}
