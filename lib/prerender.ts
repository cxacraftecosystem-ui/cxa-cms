import "server-only";

/**
 * Prerender resilience for `generateStaticParams`.
 *
 * THE PROBLEM. `generateStaticParams` runs at BUILD time and reads the database. If the database is
 * briefly unreachable — a pooler restarting, a connection cap reached by a concurrent migration, a
 * network hiccup between the build machine and the database, or simply a developer running
 * `next build` on a laptop with nothing running — the query throws, and Next treats a throw in
 * `generateStaticParams` as a fatal build error. A deploy then fails for a reason that has nothing to
 * do with the change being deployed, and the previous version stays live while somebody works out
 * which of forty files broke.
 *
 * WHY RETURNING `[]` IS THE RIGHT ANSWER AND NOT A PAPERED-OVER FAILURE. `generateStaticParams` is
 * purely an OPTIMISATION: it tells Next which dynamic paths to render ahead of time. An empty list
 * means "prerender none of them" — every page then renders on FIRST REQUEST instead and is cached
 * from that point on, which is exactly the behaviour of a route that has no `generateStaticParams` at
 * all. Nothing is lost but the head start. The alternative, a failed build, loses the entire deploy.
 *
 * This is emphatically NOT the same as swallowing a database error at REQUEST time, where the honest
 * answer is a 500 and a loud log. The distinction is that a build-time read has a correct, complete
 * fallback and a request-time read does not.
 *
 * The failure is logged as an ERROR, not a warning, and it names the route — a build whose output is
 * quietly missing every prerendered article should say so in a log an operator will read.
 */
export async function prerenderParams<T>(
  route: string,
  read: () => Promise<T[]>
): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    console.error(
      `[prerender] ${route}: could not read the list of paths to prerender, so none will be. ` +
        "These pages will render on first request instead. " +
        `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * The same guard, for a PAGE's data read rather than for its list of paths.
 *
 * ⚠ IT MUST BE PAIRED WITH `export const revalidate`, AND THAT IS NOT OPTIONAL.
 *
 * `prerenderParams` above is safe on its own: an empty list simply means "prerender nothing", and every
 * page then renders on first request with real data. This is different. A page whose data read fell back
 * is prerendered WITH THE FALLBACK — an empty listing — and on a page with no `revalidate` that snapshot
 * is served until the next deploy. An empty People page that never repairs itself is worse than a failed
 * build, so a caller without a revalidation window should not use this.
 *
 * WHY HAVE IT AT ALL. A CMS-driven page reads content editors change, and `next build` evaluates it. An
 * unreachable database at that moment therefore does not degrade the page — it FAILS THE WHOLE DEPLOY,
 * one page at a time, for a reason unrelated to the change being shipped. It also makes the application
 * impossible to build anywhere the database is absent by design: a container image, or a CI job that
 * only wants to know whether the code compiles.
 *
 * The trade is stated plainly so nobody discovers it: with the database reachable at build — the normal
 * case, and what CI does — nothing here engages and the prerender is real. Without it, the page ships
 * empty and repairs itself at the first revalidation.
 */
export async function prerenderSafe<T>(route: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error(
      `[prerender] ${route}: the database could not be read, so this page was rendered with no content. ` +
        "It repairs itself at the next revalidation. " +
        `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
    return fallback;
  }
}
