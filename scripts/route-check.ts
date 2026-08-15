/**
 * The route-coverage check.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT PROVES, AND WHY IT HAD TO BE WRITTEN.
 *
 * A studio screen and the handler it calls are two halves of one contract written in two files, and
 * nothing in TypeScript connects them: a `fetch("/api/studio/lookup")` is a STRING. So a client can
 * call a route that does not exist and everything still typechecks, lints and builds — the failure only
 * appears when somebody clicks the button, as a 404 or, worse, as a 405 from a neighbouring dynamic
 * route that swallowed the path.
 *
 * That is exactly what happened here. An adversarial review found more than twenty client call sites
 * addressing routes that had never been implemented — including `/api/studio/lookup`, the relation
 * picker used by every editor in the CMS, which meant not one relation could be set anywhere. None of
 * it was visible to any tool in the pipeline.
 *
 * This script closes the gap mechanically: it extracts every `/api/...` literal from the source, works
 * out which file Next would resolve it to, and reports the ones that resolve to nothing — or to a
 * handler that does not export the method being used.
 *
 * ⚠ IT IS A STATIC CHECK, AND HERE IS EXACTLY WHAT IT DOES NOT CATCH. A clean report is evidence, not
 * proof, and the two blind spots are worth knowing precisely rather than vaguely:
 *
 *   1. **A path assembled entirely from a variable** has no literal to find and is skipped.
 *   2. **Dynamic-segment shadowing, when the method cannot be seen.** A static path with no directory
 *      of its own still RESOLVES if a dynamic sibling can swallow it: `/api/studio/media/<anything>`
 *      matches `media/[id]/route.ts` with `id="<anything>"`, so the path check passes even when no
 *      handler for that name exists and the request 405s at runtime. Flagging it would need the HTTP
 *      method, and most paths here live in an endpoint MAP whose method is supplied by a call site in
 *      another file (see `CallSite.method`). Guessing GET there produced eight false positives, which
 *      is worse: noise is what gets a check switched off.
 *
 *      ⚠ THE EXAMPLE IS HYPOTHETICAL ON PURPOSE. This caveat used to name `/api/studio/media/duplicates`,
 *      which has had `app/api/studio/media/duplicates/route.ts` — exporting GET and POST — since before
 *      this file was last written, and `resolve()` prefers it over the `[id]` sibling because it has
 *      fewer dynamic segments. A caveat that names a live, covered route is read as a live defect by
 *      the next person to audit the suite, and these admissions are only useful while they are exact.
 *      What actually closes the gap for a real path is `smoke.ts`, whose `STUDIO_GET_ENDPOINTS` list
 *      calls `/api/studio/media/duplicates` against the running application; a new endpoint of this
 *      shape should be added there.
 *
 * So a missing route whose path happens to fit a sibling's dynamic segment slips through. What the
 * check reliably catches is a path that resolves to NOTHING, which is the majority of the class and the
 * form the real defects took here.
 *
 * USAGE
 *   npx tsx scripts/route-check.ts          # exits non-zero when a call has no handler
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const APP_DIR = join(ROOT, "app");

/** Where client code lives. `app/api` is excluded: a handler is not a caller. */
const SCAN_DIRS = [join(ROOT, "app"), join(ROOT, "components"), join(ROOT, "lib")];

interface RouteHandler {
  /** Segments as Next sees them, e.g. ["api","studio","media","[id]"]. */
  segments: string[];
  file: string;
  methods: Set<string>;
}

function walk(dir: string, onFile: (path: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

/** Every route handler in the app, with the HTTP methods it actually exports. */
function collectHandlers(): RouteHandler[] {
  const handlers: RouteHandler[] = [];

  walk(APP_DIR, (file) => {
    if (!file.endsWith(`${sep}route.ts`) && !file.endsWith(`${sep}route.tsx`)) return;

    const source = readFileSync(file, "utf8");
    const methods = new Set<string>();
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      // `export const GET = route(...)` and `export async function GET(` are both used in this codebase.
      const pattern = new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`);
      if (pattern.test(source)) methods.add(method);
    }

    const segments = relative(APP_DIR, file)
      .split(sep)
      .slice(0, -1)
      // Route GROUPS — "(site)" — are organisational and contribute no URL segment.
      .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));

    handlers.push({ segments, file: relative(ROOT, file), methods });
  });

  return handlers;
}

/** Does a concrete request path match a handler's segment pattern? */
function matches(requestSegments: string[], handler: RouteHandler): boolean {
  const pattern = handler.segments;

  // A catch-all consumes the remainder, so it can match a longer path.
  const lastPattern = pattern[pattern.length - 1];
  const isCatchAll = Boolean(lastPattern && /^\[\.{3}.+\]$/.test(lastPattern));
  const isOptionalCatchAll = Boolean(lastPattern && /^\[\[\.{3}.+\]\]$/.test(lastPattern));

  if (!isCatchAll && !isOptionalCatchAll && pattern.length !== requestSegments.length) return false;
  if (isCatchAll && requestSegments.length < pattern.length) return false;

  for (let index = 0; index < pattern.length; index += 1) {
    const patternSegment = pattern[index];
    if (patternSegment === undefined) return false;
    if (/^\[\[?\.{3}.+\]\]?$/.test(patternSegment)) return true; // catch-all: the rest is consumed
    if (/^\[.+\]$/.test(patternSegment)) continue; // a dynamic segment matches any single value
    if (patternSegment !== requestSegments[index]) return false;
  }
  return true;
}

/**
 * Resolve a request path the way Next does: a STATIC segment always beats a dynamic one.
 *
 * That precedence is why a missing route is often a 405 rather than a 404 — `/api/studio/files/presign`
 * with no `presign` directory resolves to `files/[id]/route.ts` with `id="presign"`, which exports GET
 * and PATCH but not POST. The report says so explicitly, because "405 on a path that looks right" sends
 * people looking in the wrong place entirely.
 */
function resolve(requestPath: string, handlers: RouteHandler[]): RouteHandler | null {
  const requestSegments = requestPath.split("/").filter(Boolean);
  const candidates = handlers.filter((handler) => matches(requestSegments, handler));
  if (candidates.length === 0) return null;

  // Fewest dynamic segments wins, then the longest literal prefix.
  candidates.sort((a, b) => {
    const dynamicA = a.segments.filter((segment) => segment.startsWith("[")).length;
    const dynamicB = b.segments.filter((segment) => segment.startsWith("[")).length;
    if (dynamicA !== dynamicB) return dynamicA - dynamicB;
    return b.segments.length - a.segments.length;
  });
  return candidates[0] ?? null;
}

interface CallSite {
  path: string;
  /**
   * The HTTP method, or null when it could not be established from the surrounding lines.
   *
   * ⚠ NULL IS COMMON AND MUST NOT BE GUESSED. Most paths in this codebase live in an endpoint MAP —
   * `MEDIA_ENDPOINTS.presign = "/api/studio/media/presign"` — and the method is supplied by a call site
   * in a different file. Defaulting to GET there reported eight healthy POST-only routes as broken,
   * which is precisely the sort of noise that gets a check switched off. When the method is unknown the
   * path's EXISTENCE is still checked; only the method assertion is skipped.
   */
  method: string | null;
  file: string;
  line: number;
}

/**
 * Every `/api/...` literal in the source, with the method it is called with.
 *
 * Template placeholders (`${id}`) become `_` — a stand-in for "some concrete value" — which is exactly
 * what a dynamic segment matches. A path built entirely from a variable has no literal to find and is
 * silently skipped; see the caveat in the header.
 */
function collectCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  const seen = new Set<string>();

  for (const dir of SCAN_DIRS) {
    walk(dir, (file) => {
      if (!/\.(ts|tsx)$/.test(file)) return;
      // A handler naming its own path in a comment is not a caller.
      if (file.includes(`${sep}api${sep}`) && file.endsWith("route.ts")) return;

      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");

      lines.forEach((line, index) => {
        // Skip comment lines: this file and several others quote example URLs in prose.
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;

        /**
         * An explicit opt-out, because not every `/api/...` string is a request target.
         *
         * A cookie's `Path` attribute is the real case: `/api/auth/oauth` scopes the OAuth handshake
         * cookie so the browser does not send it to every other endpoint, and no route serves that path
         * itself — only its children. Reported as a gap it is noise, and noise is what gets a check
         * switched off.
         *
         * An opt-out MARKER is better than widening the scanner to guess: a static reader cannot tell a
         * cookie path from a fetch target, and a guess that is wrong in either direction is worse than a
         * line somebody had to justify in writing. Put the marker on the line above:
         *
         *     // route-check: not-a-route — <why>
         */
        const previous = lines[index - 1] ?? "";
        if (previous.includes("route-check: not-a-route")) return;

        /**
         * ⚠ A REGULAR EXPRESSION CANNOT DO THIS, AND TWO ATTEMPTS PROVED IT.
         *
         * The paths in this codebase are template literals whose placeholders contain arbitrary
         * expressions — `${encodeURIComponent(id)}` and, worse, `${buildQuery({ type, q, limit })}`,
         * which nests braces. A character class that omitted parentheses skipped every path of the first
         * kind; a lazy `[^}]*` then stopped at the INNER brace of the second kind and skipped those too.
         * Each version reported one gap where thirteen existed.
         *
         * That failure mode is the reason this is now a scanner: **a coverage check with a false negative
         * is worse than no check at all**, because it converts "unknown" into a confident wrong answer.
         * So the quoted string is walked character by character, tracking brace depth, which handles any
         * nesting by construction rather than by guessing how deep it goes.
         */
        for (const quote of ['"', "'", "`"]) {
          let cursor = 0;
          while (true) {
            const start = line.indexOf(`${quote}/api/`, cursor);
            if (start === -1) break;

            const bodyStart = start + 1;
            let depth = 0;
            let end = -1;
            for (let scan = bodyStart; scan < line.length; scan += 1) {
              const char = line[scan];
              if (char === "{") depth += 1;
              else if (char === "}") depth = Math.max(0, depth - 1);
              // The closing quote only counts at depth 0: a quote inside `${ ... "x" ... }` is not it.
              else if (char === quote && depth === 0) {
                end = scan;
                break;
              }
            }
            if (end === -1) break;

            const raw = line.slice(bodyStart, end);
            cursor = end + 1;

            /**
             * A placeholder that does NOT directly follow a slash is a SUFFIX, not a path segment —
             * `/api/studio/files${query}` appends a query string, and turning it into
             * `/api/studio/files_` invents a segment no route could ever match. Strip those first, then
             * treat a placeholder that DOES follow a slash as the dynamic segment it is.
             *
             * The placeholder body is matched with `[\s\S]*?` up to a balanced-enough closing brace via
             * a depth-aware pass below rather than a naive `[^}]*`, for the reason in the note above.
             */
            /**
             * Normalise the placeholders in ONE pass.
             *
             * A placeholder that directly follows a slash is a path SEGMENT and becomes `_`, which a
             * dynamic route segment matches. One that does not is a SUFFIX — `/api/studio/files${query}`
             * appends a query string — and is dropped, because turning it into `files_` would invent a
             * segment no route could match.
             *
             * ⚠ ONE PASS, NOT TWO. A two-pass version had to leave placeholders it was not replacing
             * intact for the second pass, and instead skipped past them — deleting the segment and
             * producing `/api/studio/events//registrations/bulk`, which resolves to nothing and reported
             * a healthy route as missing. Deciding each placeholder once removes the possibility.
             */
            const normalisePlaceholders = (input: string): string => {
              let out = "";
              let scan = 0;
              while (scan < input.length) {
                if (input.startsWith("${", scan)) {
                  // Walk to the placeholder's own closing brace, counting depth so a nested object
                  // literal — `${buildQuery({ type, q })}` — does not end it early.
                  let depth = 0;
                  let close = scan + 1;
                  for (; close < input.length; close += 1) {
                    if (input[close] === "{") depth += 1;
                    else if (input[close] === "}") {
                      depth -= 1;
                      if (depth === 0) break;
                    }
                  }
                  if (close >= input.length) break; // unterminated: stop rather than guess
                  out += out.endsWith("/") ? "_" : "";
                  scan = close + 1;
                  continue;
                }
                out += input[scan];
                scan += 1;
              }
              return out;
            };

            const normalised = normalisePlaceholders(raw)
              .replace(/\?.*$/, "")
              .replace(/\/+$/, "");

            if (!normalised.startsWith("/api/")) continue;
            // A wildcard or an obviously non-literal fragment is not checkable.
            if (normalised.includes("*") || normalised.includes("$")) continue;

            // The method, when it can be seen nearby. `null`, never a default — see CallSite.method.
            const window = lines.slice(index, index + 6).join(" ");
            const methodMatch = /method:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/.exec(window);
            const method = methodMatch?.[1] ?? null;

            const key = `${normalised}|${method ?? "?"}`;
            if (seen.has(key)) continue;
            seen.add(key);

            sites.push({ path: normalised, method, file: relative(ROOT, file), line: index + 1 });
          }
        }
      });
    });
  }

  return sites;
}

function main(): void {
  const handlers = collectHandlers();
  const sites = collectCallSites();

  const missing: { site: CallSite; reason: string }[] = [];

  for (const site of sites) {
    const handler = resolve(site.path, handlers);
    if (!handler) {
      missing.push({ site, reason: "no route file resolves this path" });
      continue;
    }
    // Only assert the method when it was actually found in the source. See CallSite.method.
    if (site.method !== null && !handler.methods.has(site.method)) {
      missing.push({
        site,
        reason:
          `resolves to ${handler.file}, which exports ` +
          `${[...handler.methods].sort().join("/") || "no methods"} but not ${site.method}` +
          (handler.segments.some((segment) => segment.startsWith("["))
            ? " — a dynamic segment is swallowing what should be a static route"
            : "")
      });
    }
  }

  console.log(`\nRoute coverage: ${sites.length} call site(s) against ${handlers.length} handler(s).\n`);

  if (missing.length === 0) {
    console.log("  PASS — every API path called from the source resolves to a handler that exports it.\n");
    return;
  }

  console.error(`  FAIL — ${missing.length} call site(s) with no working handler:\n`);
  for (const entry of missing) {
    console.error(`    ${entry.site.method ?? "(method unknown)"} ${entry.site.path}`);
    console.error(`      called from ${entry.site.file}:${entry.site.line}`);
    console.error(`      ${entry.reason}\n`);
  }
  process.exitCode = 1;
}

main();
