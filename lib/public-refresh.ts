import "server-only";

import { revalidatePath } from "next/cache";

/**
 * Publishing is immediate: a successful write that can change what a visitor sees marks the public
 * site's cached pages stale, and the next visit to each page renders it fresh.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. Every public page is a prerendered snapshot refreshed on a timer
 * (`export const revalidate = 300`), and until this module nothing told Next that content had changed —
 * so a published edit took up to five minutes to appear, while the studio said "publishes your changes
 * to the site immediately". The timer stays, as the safety net for what changes with the clock alone
 * (an event moving from upcoming to past, registration closing); this is what makes a save show up at
 * once. It is the on-demand half of incremental static regeneration: the snapshot is kept until
 * something changes, instead of being rebuilt on a schedule whether or not anything did.
 *
 * WHY THE WHOLE PUBLIC SITE AND NOT JUST THE CHANGED RECORD'S PAGE. In this product almost nothing
 * lives on one page. The header on EVERY page reads the navigation and the people-group counts; the
 * footer reads the settings; showcase blocks put news, people, projects, events and publications on the
 * home page and on any page built in the studio; detail pages cross-reference each other (a project's
 * team, a publication's authors). A per-record list of affected paths would be a second copy of every
 * query on the site, and the day it missed one an edit would silently not appear — the exact complaint
 * this fixes. Marking the root layout stale is exact by construction, and it is cheap: nothing is
 * re-rendered in bulk. `revalidatePath` only marks; each page is rebuilt on its NEXT VISIT, once, so a
 * save costs one fresh render per page somebody actually opens afterwards.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function refreshPublicSite(): void {
  revalidatePath("/", "layout");
}

/**
 * Studio resources whose writes never reach a public page, by their first path segment under
 * `/api/studio/`. Everything NOT listed refreshes the site after a successful write.
 *
 * ⚠ THIS IS A DENY-LIST ON PURPOSE. A new studio resource that publishes something then works without
 * anybody remembering this file; the cost of forgetting to list a private one is a harmless refresh.
 * The opposite design — listing what IS public — fails silently, as stale content, the first time
 * somebody adds a resource and forgets.
 */
const PRIVATE_RESOURCES: ReadonlySet<string> = new Set([
  "access", // sign-in allow-list
  // NOT "account": an editor's own name, title and picture are the byline on every article they wrote.
  "analytics",
  "audit",
  "export", // a backup download
  "inquiries", // contact-form submissions
  "locks", // who is editing what
  "lookup",
  "newsletter", // issues are emailed; the public newsletter page is rendered per request anyway
  "reindex", // the search index; /search is rendered per request
  "search",
  "templates" // page templates are studio-only until used
]);

/** Sub-paths of otherwise-public resources that change nothing a visitor sees. */
const PRIVATE_SUBPATHS: readonly RegExp[] = [
  /^media\/presign$/, // an upload ticket; the media row arrives with media/complete
  /^files\/presign$/,
  /^media\/duplicates$/,
  /^media\/collections\/search$/,
  /^pages\/[^/]+\/preview-draft$/, // a draft preview, by definition not the live page
  /^files\/[^/]+\/preview$/,
  /^events\/[^/]+\/registrations\/[^/]+\/certificate$/, // a certificate document, sent to one person
  /^publications\/import\/preview$/, // a dry run of an import: nothing is written
  /^users\/[^/]+\/(sessions|two-factor|password-reset)(\/|$)/ // sign-in security, not public identity
];

const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Does a successful request with this method and path change what a visitor can see?
 *
 * Pure, so the rule can be tested without a request: `/api/studio/news/abc` with PATCH is `true`,
 * `/api/studio/inquiries/abc` with PATCH and anything with GET are `false`.
 */
export function studioWriteReachesPublicSite(method: string, pathname: string): boolean {
  if (!WRITE_METHODS.has(method.toUpperCase())) return false;

  // route-check: not-a-route — a prefix this function matches incoming paths against, not a request.
  const prefix = "/api/studio/";
  if (!pathname.startsWith(prefix)) return false;

  const rest = pathname.slice(prefix.length).replace(/\/+$/, "");
  const resource = rest.split("/")[0] ?? "";
  if (resource === "" || PRIVATE_RESOURCES.has(resource)) return false;

  return !PRIVATE_SUBPATHS.some((pattern) => pattern.test(rest));
}
