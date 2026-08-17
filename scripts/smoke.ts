/**
 * The end-to-end smoke test.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHAT IT CATCHES THAT NOTHING ELSE DOES.
 *
 * Three checks already guard this codebase, and each has a blind spot the others do not cover:
 *
 *   • `tsc` proves the code is internally consistent. It cannot see that a `fetch` string names a route
 *     that does not exist, because a path is a string.
 *   • `route-check` proves every path literal resolves to a handler exporting that method. It cannot see
 *     whether the handler WORKS — a route can exist, resolve, and 500 on every call.
 *   • `leak-check` proves nothing unpublished is publicly reachable. It never signs in, so it says
 *     nothing at all about the studio.
 *
 * What was missing is the obvious one: **does a request actually succeed?** Twenty-odd studio routes
 * shipped unreachable, and every single check above was green. The only thing that would have caught it
 * is asking the running application.
 *
 * So this drives the real HTTP surface, signed in, and asserts on what comes back — status codes
 * throughout, and for the public pages the BODY as well, because a page can answer 200 with the
 * studio's own "Add a heading" still in it and every check above stays green (see the header on
 * `PLACEHOLDER_PROMPTS` below — the only assertion anywhere that reads a visitor's HTML for the
 * studio's PROMPT TEXT; `scripts/leak-check.ts` also reads served bodies, for unpublished content):
 *
 *   1. every public route answers 200 AND serves none of the studio's own placeholder prompts, and a
 *      missing record answers 404 (never a soft-404);
 *   2. the studio is shut to an anonymous caller — pages redirect, API routes answer 401 JSON;
 *   3. every studio screen renders for an administrator;
 *   4. a lower tier is REFUSED with 403, not 500 — a refusal must not look like a fault;
 *   5. every studio GET endpoint answers rather than 404/405/500;
 *   6. a full content lifecycle works: create, read back, publish, appear publicly, soft-delete, 404.
 *
 * It creates its own fixtures and removes them in a `finally`, so a failed run leaves nothing behind.
 *
 * USAGE
 *   npm run build && npx next start -p 3000 &
 *   npm run smoke -- http://127.0.0.1:3000
 *
 * ⚠ IT WRITES TO THE DATABASE and it signs in as the seeded administrator, so it needs
 * SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD in the environment. It refuses to run with
 * NODE_ENV=production.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

import { pagePreviewToken } from "../lib/pages";
import { allPlaceholderPrompts } from "../lib/sections/schema";

const prisma = new PrismaClient();

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");

const MARKER = "ZZSMOKE4KJ";

/** A lower-privilege account, created and removed by this script, to prove a refusal is a 403. */
const LOW_EMAIL = `${MARKER.toLowerCase()}-author@cxa.local`;
const LOW_PASSWORD = "correct-horse-battery-staple-smoke";

interface Failure {
  what: string;
  detail: string;
}

const failures: Failure[] = [];
let checks = 0;

function check(ok: boolean, what: string, detail: string): void {
  checks += 1;
  if (!ok) failures.push({ what, detail });
}

/** A tiny cookie jar. `fetch` does not keep cookies, and the session is three of them. */
class Jar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    // `getSetCookie` is the only correct reader: several cookies arrive in separate headers and
    // `get("set-cookie")` collapses them into one comma-joined string that cannot be split safely,
    // because an Expires date contains a comma.
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === "" ) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }
}

async function request(
  path: string,
  options: { method?: string; jar?: Jar; body?: unknown; expectRedirect?: boolean } = {}
): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = { Origin: base };
  if (options.jar) {
    const cookie = options.jar.header();
    if (cookie) headers.Cookie = cookie;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    // `manual` so a 307 is observable rather than followed — "the studio redirects an anonymous
    // caller" is the assertion, and following it would turn a correct refusal into a 200.
    redirect: "manual"
  });

  if (options.jar) options.jar.absorb(response);

  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

const PUBLIC_OK = [
  "/",
  "/about",
  "/contact",
  "/research",
  "/projects",
  "/publications",
  "/people",
  "/craft-explorer",
  "/gallery",
  "/news",
  "/events",
  "/search",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest"
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE STUDIO'S OWN PROMPT TEXT, AS A VISITOR ACTUALLY RECEIVES IT.
 *
 * ⚠ THIS IS THE ONLY CHECK THAT READS THE HTML A READER IS SERVED **FOR PROMPT TEXT**. Every other
 * placeholder check reads STORED DATA on its way somewhere: `pagePublishBlockers()` in lib/pages.ts
 * walks a block's raw payload at the crossing into publication, `lib/health.ts` reports on the same
 * payloads, and `seedSearchIndex()` in prisma/seed.ts reads the text flattened for the search corpus.
 * A page can be served with a prompt in it and satisfy all three, which is how the homepage published
 * `<h2>Add a heading</h2>`. Nothing mechanical saw it; somebody opened a screen.
 * (`scripts/leak-check.ts` also asserts on served bodies — for UNPUBLISHED content, not for prompts.
 * The two do not overlap, and neither should grow into the other.)
 *
 * ⚠ IT IS NOT A SUPERSET OF THE PAYLOAD CHECKS AND IT IS NOT SUBSUMED BY THEM. The pair that proves
 * it, measured on this development database:
 *
 *   • `/about` served three prompts to the public ("Write the text for this section.", "Add what
 *     happened", "Add a date") — the defect this check was written for. **Now repaired**: its blocks
 *     were restored from the seed's own copy by `--repair-placeholder-prose`, and every one of the 15
 *     paths in `PUBLIC_OK` is clean, so the suite is green rather than red.
 *   • `/contact` carries TWO prompts in its stored payload ("Add a line about how long a reply
 *     usually takes.", "Add the postal address") and its renderer prints NEITHER. Invisible here, and
 *     correctly so — this check answers "what does a reader see", and a reader sees neither.
 *
 * ⚠ AND A SERVED PAGE CAN LAG ITS PAYLOAD BY A WHOLE DEPLOY, which is the sharper reason this check
 * cannot be replaced by a payload one. `/about` is a build-time static prerender (its page declares no
 * `revalidate`), so after the repair the DATABASE was clean while the SERVER went on serving all three
 * prompts from the previous build until it was rebuilt. A payload check would have reported success
 * over a site that was still publishing the falsehood to every visitor.
 *
 * So the payload checks catch what an editor must still fill in; this one catches what the public is
 * already reading. Do not let either grow into a weaker copy of the other, and do not "fix" the
 * `/contact` gap by reading the database here — that is the question prisma/seed.ts and lib/health.ts
 * already answer, from the payload, where it can be answered properly.
 *
 * ⚠ SUBSTRING, AND SAFE FOR EXACTLY ONE REASON — the one set out at length in lib/sections/schema.ts.
 * The strings matched are WHOLE prompts, never the leading verb that selected them, so the seeded
 * homepage's finished CTA button "Write to the Centre" cannot match "Write the text for this
 * section.". A pattern test (`/^(?:add|write|replace)\b/i`) against rendered markup would report the
 * site's own front page for ever, and could not be silenced by editing any block. Never loosen this.
 *
 * ⚠ VERIFIED TO DISCRIMINATE IN BOTH DIRECTIONS, because a rule that cannot match is indistinguishable
 * from clean code and this repository has shipped one of those (a social-card probe that built a 404
 * path, matched no fixture, and reported success). ⚠ **NOW THAT EVERY PAGE IS CLEAN, THE LIVE RUN NO
 * LONGER PROVES THE RULE CAN FIRE** — an all-green scan is exactly what a broken rule produces. So it
 * was re-proved directly against this vocabulary, three ways:
 *
 *   • a synthetic body carrying one prompt verbatim → the scan REPORTS it (the rule is not vacuous);
 *   • the seeded homepage's finished CTA "Write to the Centre" → NOT reported (no false positive, and
 *     this is the case the substring rule below exists to get right);
 *   • all 15 live paths in `PUBLIC_OK` → none reported.
 *
 * ⚠ Re-prove the first of those whenever this vocabulary or `promptsServedIn` changes. A green suite
 * over a clean site is evidence of nothing on its own.
 *
 * ⚠ THE COUNT IS 15 AND IT IS LOAD-BEARING, WHICH IS WHY THE EARLIER "16" IS CORRECTED HERE RATHER THAN
 * QUIETLY OVERWRITTEN. `PUBLIC_OK` contributes TWO checks per path, so the total this file reports —
 * "PASS — 136 checks", the number the unconditional-assertion note below depends on being stable — only
 * adds up at 15. A reader who trusted 16 would go hunting for a path that is not in the list, and the
 * next person to add one has to move both numbers together: one path is two checks.
 *
 * ⚠ NO PATH IS EXCLUDED FROM THE SCAN, and that is deliberate. `/robots.txt`, `/sitemap.xml` and
 * `/manifest.webmanifest` cannot plausibly carry a section prompt, but they are cheap, they were
 * measured clean, and a second list of "pages worth scanning" is a list that drifts from `PUBLIC_OK`
 * the moment somebody adds a route. The manifest does derive from settings, so a prompt reaching a
 * site name would in fact be caught. No path here contains prompt-like prose that would have to be
 * excused, so there is no vocabulary problem to report.
 *
 * ⚠ NONE OF THE 45 STRINGS CONTAINS A CHARACTER HTML ESCAPES (measured: no `&`, `<`, `>`, `"` or `'`),
 * which is the only reason a raw substring test against markup can work at all. A prompt containing an
 * apostrophe would arrive as `&#x27;` and this check would silently stop matching it — so if one is
 * ever added to `SECTION_PLACEHOLDERS`, this comparison has to decode the body first.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
const PLACEHOLDER_PROMPTS = allPlaceholderPrompts();

/**
 * The prompts a served body is still carrying, longest first.
 *
 * The de-duplicating `continue` is a twin of `promptsInIndexedText()` in prisma/seed.ts, and it is a
 * GUARD rather than a live path: measured over the 45 strings, no prompt is currently a substring of
 * another, so nothing reaches it. It is kept because `allPlaceholderPrompts()` sorts longest-first
 * precisely so the more specific string wins, and the day somebody writes a prompt extending an
 * existing one, a report that counted one field as two would send an editor hunting for a field that
 * does not exist.
 */
function promptsServedIn(body: string): string[] {
  const carried: string[] = [];
  for (const prompt of PLACEHOLDER_PROMPTS) {
    if (!body.includes(prompt)) continue;
    if (carried.some((longer) => longer.includes(prompt))) continue;
    carried.push(prompt);
  }
  return carried;
}

/** Missing records. Every one must be a real 404 — a 200 here is a soft-404 (contract §13a). */
const PUBLIC_404 = [
  `/${MARKER}-no-such-page`,
  `/news/${MARKER}-none`,
  `/events/${MARKER}-none`,
  `/gallery/${MARKER}-none`,
  `/people/${MARKER}-none`,
  `/projects/${MARKER}-none`,
  `/research/${MARKER}-none`,
  `/publications/${MARKER}-none`,
  `/craft-explorer/${MARKER}-none`
];

const STUDIO_SCREENS = [
  "/studio",
  "/studio/pages",
  "/studio/news",
  "/studio/news/taxonomy",
  "/studio/events",
  "/studio/gallery",
  "/studio/research",
  "/studio/projects",
  "/studio/publications",
  "/studio/publications/import",
  "/studio/people",
  "/studio/crafts",
  "/studio/media",
  "/studio/files",
  "/studio/inquiries",
  "/studio/navigation",
  "/studio/redirects",
  "/studio/settings",
  "/studio/users",
  "/studio/audit",
  "/studio/recycle-bin",
  "/studio/analytics",
  "/studio/account",
  // The oversight tier and the self-sustaining tools. Added when they landed: a screen that renders for
  // nobody is indistinguishable from a screen that was never wired up.
  "/studio/access",
  "/studio/provenance",
  "/studio/announcements",
  "/studio/health",
  "/studio/templates"
];

/** Screens an AUTHOR must be refused. The assertion is 403 — emphatically not 500. */
const STUDIO_FORBIDDEN_FOR_AUTHOR = [
  "/studio/users",
  "/studio/settings",
  "/studio/audit",
  "/studio/recycle-bin",
  // MASTER-ADMIN ONLY, and these two matter most: the access list decides who may sign in at all, and
  // the provenance console is a record of colleagues' activity rather than of content. An author reaching
  // either would be a genuine privilege escalation, not a cosmetic leak.
  "/studio/access",
  "/studio/provenance"
];

/**
 * Studio GET endpoints.
 *
 * The assertion is deliberately weak — "not 404, 405 or 5xx" — because that is precisely the class of
 * failure that shipped: a route that does not exist, or that exists at a path a sibling's dynamic
 * segment swallows. A 400 from a handler that wanted different parameters is a route that WORKS.
 */
const STUDIO_GET_ENDPOINTS = [
  "/api/studio/pages",
  "/api/studio/news",
  "/api/studio/events",
  "/api/studio/gallery",
  "/api/studio/research",
  "/api/studio/projects",
  "/api/studio/publications",
  "/api/studio/people",
  "/api/studio/crafts",
  "/api/studio/media",
  "/api/studio/media/folders",
  "/api/studio/media/duplicates",
  "/api/studio/media/tags",
  "/api/studio/files",
  "/api/studio/inquiries",
  "/api/studio/navigation",
  "/api/studio/redirects",
  "/api/studio/settings",
  "/api/studio/users",
  "/api/studio/audit",
  "/api/studio/recycle-bin",
  "/api/studio/analytics",
  "/api/studio/account",
  "/api/studio/search?q=test",
  "/api/studio/lookup?type=person&q=a",
  "/api/studio/lookup?type=project&q=a",
  "/api/studio/lookup?type=media&q=a",
  "/api/studio/news/categories",
  "/api/studio/news/tags",
  "/api/studio/access",
  "/api/studio/announcements",
  "/api/studio/provenance?scope=installation",
  /*
   * Added with the editable page templates.
   *
   * ⚠ THIS IS THE BLIND SPOT `route-check` DOCUMENTS, CLOSED BY HAND. That script proves a path
   * RESOLVES to a handler; it cannot prove the handler works, and — where a sibling has a dynamic
   * segment — it cannot even prove the path resolves to the RIGHT one. `/api/studio/templates`
   * resolves whether or not it exists, because `templates/[id]` would swallow it. Only a request
   * settles it, which is what this line is.
   *
   * Its own header asks for exactly this: "a new one should be added to its list."
   */
  "/api/studio/templates"
];

/**
 * Studio screens that are reachable ONLY through a record that has to exist first.
 *
 * They are absent from `STUDIO_PAGES` above because that list is fetched with no setup, and a
 * `[key]` or `[id]` route with a made-up parameter correctly answers 404 — which would fail an
 * assertion that is really asking "does this screen render at all".
 *
 * ⚠ THE TEMPLATE EDITOR IS THE ONE THAT MATTERS HERE. Its parameter is a template KEY, and the
 * built-in keys are compiled into `lib/page-templates.ts` rather than stored, so one of them can be
 * requested with no fixture at all — which makes it the only new dynamic studio screen this script
 * can reach without inventing state.
 */
const STUDIO_PARAMETERISED_PAGES = ["/studio/templates/programme"];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run against production: this script writes rows and signs in.");
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set — the studio half of this test signs in."
    );
  }

  console.log(`\nSmoke test against ${base}\n`);

  let lowUserId: string | null = null;
  const created: { model: "researchArea"; id: string }[] = [];

  try {
    // ── 1. Public surfaces ───────────────────────────────────────────────────
    for (const path of PUBLIC_OK) {
      const { status, text } = await request(path);
      check(status === 200, `GET ${path}`, `expected 200, got ${status}`);

      /*
       * ⚠ BOTH ASSERTIONS RUN UNCONDITIONALLY, even when the status was not 200. Skipping the second
       * one on a bad status would make the total check count depend on whether the run passed, and
       * "PASS — 136 checks" is only meaningful if 136 is the same number every time. An error body
       * carries no prompts, so the extra assertion costs a passing check and never a spurious failure.
       */
      const served = promptsServedIn(text);
      check(
        served.length === 0,
        `GET ${path} serves no studio prompt text`,
        `the body a visitor receives still contains the studio's own placeholder wording — ${served
          .map((prompt) => JSON.stringify(prompt))
          .join(", ")} — so a block was published without being filled in`
      );
    }
    for (const path of PUBLIC_404) {
      const { status } = await request(path);
      check(
        status === 404,
        `GET ${path}`,
        status === 200
          ? "returned 200 — a SOFT-404: the page renders 404 content with a success status (contract §13a)"
          : `expected 404, got ${status}`
      );
    }

    /*
     * ── 1b. The PREVIEW route, and why it has its own block ──────────────────
     *
     * ⚠ THIS ROUTE DID NOT EXIST FOR AN ENTIRE RELEASE. The page builder had always pointed its
     * preview iframe at `/studio/preview/<slug>?preview=<token>` and no route answered there, so the
     * device widths, the theme toggle and the whole live-draft mechanism were a working front end
     * aimed at a 404. Nothing caught it: a preview address is a STRING, and `route-check`
     * deliberately resolves only `/api/…` literals, so a missing PAGE route is outside what it can
     * see. These three assertions are the only mechanical guard there is.
     *
     * The token is the gate, so all three cases matter: the right one renders, a wrong one is
     * refused, and an absent one is refused identically — refusing them DIFFERENTLY would turn the
     * route into an oracle for which unpublished slugs exist.
     */
    {
      const token = pagePreviewToken("about");
      const ok = await request(`/preview/about?preview=${token}`);
      check(
        ok.status === 200,
        "GET /preview/about with a valid token",
        ok.status === 404
          ? "404 — the preview route is missing again, or the token no longer matches"
          : `expected 200, got ${ok.status}`
      );

      const wrong = await request("/preview/about?preview=0000000000000000000000000000000f");
      check(wrong.status === 404, "GET /preview/about with a wrong token", `expected 404, got ${wrong.status}`);

      const none = await request("/preview/about");
      check(none.status === 404, "GET /preview/about with no token", `expected 404, got ${none.status}`);
    }

    // ── 2. The studio is shut to an anonymous caller ─────────────────────────
    for (const path of ["/studio", "/studio/pages", "/studio/users"]) {
      const { status } = await request(path);
      check(status === 307 || status === 302, `anonymous GET ${path}`, `expected a redirect, got ${status}`);
    }
    {
      const { status, json } = await request("/api/studio/pages");
      check(status === 401, "anonymous GET /api/studio/pages", `expected 401, got ${status}`);
      // An HTML login page here reports "Unexpected token '<'" in the browser, which is the least
      // useful thing a failed save can say.
      check(
        json !== null && typeof json === "object" && "code" in (json as object),
        "anonymous studio API body",
        "expected the JSON error shape from lib/api.ts, got something else (an HTML page?)"
      );
    }

    // ── 3. Sign in ───────────────────────────────────────────────────────────
    const admin = new Jar();
    {
      const { status } = await request("/api/auth/login", {
        method: "POST",
        jar: admin,
        body: { email: adminEmail, password: adminPassword }
      });
      check(status === 200, "administrator sign-in", `expected 200, got ${status}`);
      check(admin.has("cxa_access"), "access cookie", "no cxa_access cookie was set");
      check(admin.has("cxa_refresh"), "refresh cookie", "no cxa_refresh cookie was set");
      if (status !== 200) {
        throw new Error("Cannot continue: the administrator could not sign in.");
      }
    }

    // Wrong credentials must not distinguish a bad address from a bad password.
    {
      const wrongPassword = await request("/api/auth/login", {
        method: "POST",
        body: { email: adminEmail, password: `${adminPassword}-wrong` }
      });
      const wrongEmail = await request("/api/auth/login", {
        method: "POST",
        body: { email: `nobody-${MARKER}@cxa.local`, password: adminPassword }
      });
      const messageOf = (value: unknown) =>
        value && typeof value === "object" && "message" in value ? String((value as { message: unknown }).message) : "";
      check(
        wrongPassword.status === 401 && wrongEmail.status === 401,
        "failed sign-in status",
        `expected 401 for both, got ${wrongPassword.status} and ${wrongEmail.status}`
      );
      check(
        messageOf(wrongPassword.json) === messageOf(wrongEmail.json),
        "failed sign-in message",
        "a wrong address and a wrong password produce DIFFERENT messages — an account-existence oracle"
      );
    }

    // A cross-site mutation must be refused even with a valid session.
    {
      const response = await fetch(`${base}/api/studio/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: admin.header() },
        body: JSON.stringify({ title: "x", slug: "x" }),
        redirect: "manual"
      });
      check(response.status === 403, "cross-origin POST", `expected 403, got ${response.status}`);
    }

    // ── 4. Every studio screen renders ──────────────────────────────────────
    for (const path of STUDIO_SCREENS) {
      const { status } = await request(path, { jar: admin });
      check(status === 200, `admin GET ${path}`, `expected 200, got ${status}`);
    }

    /*
     * The dynamic studio screens that can be reached without a fixture.
     *
     * ⚠ A 404 HERE IS A FAILURE, NOT A PASS. The parameter is a built-in template key compiled into
     * `lib/page-templates.ts`, so the screen must find it; answering 404 would mean the merge between
     * the file-based built-ins and the stored rows has stopped resolving them, which is the exact
     * failure that would otherwise show up as "all my templates disappeared" and nowhere else.
     */
    for (const path of STUDIO_PARAMETERISED_PAGES) {
      const { status } = await request(path, { jar: admin });
      check(status === 200, `admin GET ${path}`, `expected 200, got ${status}`);
    }

    // ── 5. Every studio GET endpoint answers ────────────────────────────────
    for (const path of STUDIO_GET_ENDPOINTS) {
      const { status } = await request(path, { jar: admin });
      const broken = status === 404 || status === 405 || status >= 500;
      check(
        !broken,
        `admin GET ${path}`,
        status === 404
          ? "404 — no handler resolves this path"
          : status === 405
            ? "405 — the path is being swallowed by a sibling's dynamic segment"
            : `${status} — the handler threw`
      );
    }

    // ── 6. A lower tier is REFUSED, not broken ──────────────────────────────
    {
      const low = await prisma.user.upsert({
        where: { email: LOW_EMAIL },
        update: { role: "AUTHOR", isActive: true },
        create: {
          email: LOW_EMAIL,
          name: "Smoke Author",
          role: "AUTHOR",
          passwordHash: await bcrypt.hash(LOW_PASSWORD, 12)
        }
      });
      lowUserId = low.id;

      /**
       * ⚠ THE PROBE NEEDS A STUDIO ACCESS GRANT, or it cannot sign in at all.
       *
       * The allow-list (lib/auth/access.ts) is a real gate: an address without a grant is refused
       * whatever its password, because a provider proves an identity and never grants access. A fixture
       * inserted straight into `users` therefore has an account and no permission to use it.
       *
       * This is not the test working around the product — it is the test MODELLING it. A real colleague
       * is added to the list first and signs in second, and a fixture that skipped the list would be
       * testing a path no person can take. When this was missing, the refusal assertion below failed with
       * 401 instead of 403: the sign-in never happened, so there was no session to refuse.
       */
      await prisma.studioAccess.upsert({
        where: { email: LOW_EMAIL },
        update: { grantedRole: "AUTHOR", revokedAt: null, allowedProviders: [] },
        create: {
          email: LOW_EMAIL,
          name: "Smoke Author",
          grantedRole: "AUTHOR",
          allowedProviders: [],
          note: "Created by scripts/smoke.ts. Removed again when the run finishes."
        }
      });

      const author = new Jar();
      const signIn = await request("/api/auth/login", {
        method: "POST",
        jar: author,
        body: { email: LOW_EMAIL, password: LOW_PASSWORD }
      });
      check(signIn.status === 200, "author sign-in", `expected 200, got ${signIn.status}`);

      for (const path of STUDIO_FORBIDDEN_FOR_AUTHOR) {
        const { status } = await request(path, { jar: author });
        check(
          status === 403,
          `author GET ${path}`,
          status === 500
            ? "500 — a deliberate refusal is being reported as a server fault (contract §1.9)"
            : status === 200
              ? "200 — an author can open a screen restricted to administrators"
              : `expected 403, got ${status}`
        );
      }

      // And the API boundary refuses too, in JSON.
      const denied = await request("/api/studio/settings", {
        method: "PATCH",
        jar: author,
        body: { key: "branding", value: {} }
      });
      check(denied.status === 403, "author PATCH settings", `expected 403, got ${denied.status}`);
    }

    /*
     * ── 6b. A PAGE ADDRESS THE ROUTER COULD NEVER SERVE IS REFUSED ───────────
     *
     * `Page.slug` is a full path, so an editor can type one the router will never reach:
     * `news/annual-review` is matched by `app/(site)/news/[slug]`, which looks for an article called
     * "annual-review", finds none, and answers 404. The row would sit in the studio marked PUBLISHED,
     * appear in every listing, and 404 for the editor who made it — and nothing downstream could tell
     * that apart from a page nobody had written yet.
     *
     * ⚠ THE SECOND ASSERTION IS THE ONE THAT MATTERS. It is easy to write a reserved-prefix rule so
     * broad that it refuses `about`, which is a SEEDED, structural page whose route deliberately reads
     * its own row — and a seed the validator rejects is an installation that cannot be re-seeded. So
     * this checks both directions: the unreachable address is refused, and the legitimate one is not.
     */
    {
      const refused = await request("/api/studio/pages", {
        method: "POST",
        jar: admin,
        body: { title: `${MARKER} nested`, slug: "news/annual-review", status: "DRAFT" }
      });
      check(
        refused.status === 422,
        "POST /api/studio/pages with an unreachable slug",
        `expected 422, got ${refused.status} — a page under a listing route's prefix can never be served`
      );

      const allowed = await request("/api/studio/pages", {
        method: "POST",
        jar: admin,
        body: { title: `${MARKER} ordinary`, slug: `${MARKER.toLowerCase()}-ordinary-page`, status: "DRAFT" }
      });
      check(
        allowed.status === 201 || allowed.status === 200,
        "POST /api/studio/pages with an ordinary slug",
        `expected a create, got ${allowed.status} — the reserved-address rule is refusing too much`
      );

      // Removed immediately: this script leaves nothing behind, and a draft page named after the
      // marker would otherwise accumulate one row per run.
      await prisma.page.deleteMany({ where: { slug: `${MARKER.toLowerCase()}-ordinary-page` } });
    }

    // ── 7. A full content lifecycle ─────────────────────────────────────────
    const slug = `${MARKER.toLowerCase()}-area`;
    {
      const create = await request("/api/studio/research", {
        method: "POST",
        jar: admin,
        body: {
          title: `${MARKER} Research Area`,
          slug,
          summary: "Created by the smoke test.",
          status: "PUBLISHED"
        }
      });
      check(
        create.status === 200 || create.status === 201,
        "create a research area",
        `expected 200/201, got ${create.status}: ${create.text.slice(0, 200)}`
      );

      const id =
        create.json && typeof create.json === "object" && "id" in create.json
          ? String((create.json as { id: unknown }).id)
          : null;

      if (id) {
        created.push({ model: "researchArea", id });

        // The write must have produced its audit entry, its revision and its index row — the three
        // things lib/audit.ts promises are written in one transaction with the row.
        const [audit, revision, indexed] = await Promise.all([
          prisma.auditLog.count({ where: { entityType: "ResearchArea", entityId: id } }),
          prisma.revision.count({ where: { entityType: "ResearchArea", entityId: id } }),
          prisma.searchDocument.count({ where: { entityType: "research-area", entityId: id } })
        ]);
        check(audit > 0, "audit entry written", "the create left no audit trail");
        check(revision > 0, "revision written", "the create left no revision");
        check(indexed > 0, "search index written", "the create was not indexed");

        // Published, so it must be publicly readable and publicly findable.
        const publicPage = await request(`/research/${slug}`);
        check(publicPage.status === 200, "published area is public", `got ${publicPage.status}`);

        const found = await request(`/api/public/search?q=${MARKER}`);
        const total =
          found.json && typeof found.json === "object" && "total" in found.json
            ? Number((found.json as { total: unknown }).total)
            : -1;
        check(total > 0, "published area is searchable", `public search returned total=${total}`);

        // Soft-delete, and it must vanish from the public site with an honest 404.
        const remove = await request(`/api/studio/research/${id}`, { method: "DELETE", jar: admin });
        check(remove.status === 200 || remove.status === 204, "soft-delete", `got ${remove.status}`);

        const gone = await request(`/research/${slug}`);
        check(
          gone.status === 404,
          "deleted area is gone",
          gone.status === 200 ? "still returns 200 after deletion" : `expected 404, got ${gone.status}`
        );

        const row = await prisma.researchArea.findUnique({ where: { id }, select: { deletedAt: true } });
        check(row?.deletedAt != null, "soft delete, not hard", "the row was removed rather than flagged");
      }
    }

    /**
     * ── 7b. RE-ORDERING A GROUP OF PEOPLE ────────────────────────────────────
     *
     * ⚠ THIS BLOCK EXISTS BECAUSE THE PEOPLE BOARD SHIPPED UNABLE TO SAVE AN ORDER, and every check
     * in the repository was green while it did. `tsc` was happy, `route-check` proved the path
     * resolved, and the handler answered 500 on every single call: it renumbered a group one profile
     * at a time, each one a round trip, all inside one interactive transaction, and the transaction
     * ran out of time before the loop ran out of people. The only thing that could have caught it is
     * asking the running application to actually move somebody.
     *
     * SO THE ASSERTION THAT MATTERS IS THE FIRST ONE: **not a 500.** A re-order may legitimately be
     * refused — 409 when the roster moved underneath the request, 403 for a tier that may not — and
     * every one of those refusals is a sentence somebody can act on. A 500 is the one answer that
     * means nobody can do anything at all.
     *
     * SELF-RESTORING. The group is read, reversed, saved, and put straight back, so a run leaves the
     * roster exactly as it found it. `finally` is not enough on its own here — there is no fixture to
     * delete, only somebody's curated order to hand back — so the restore is asserted too.
     */
    {
      const group = "FACULTY" as const;
      const before = await prisma.person.findMany({
        where: { kind: group, deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true }
      });
      const original = before.map((row) => row.id);

      if (original.length < 2) {
        // Nothing to prove with fewer than two names, and inventing a second profile would leave a
        // person-shaped fixture in a table that real people are in.
        check(true, "reorder skipped (fewer than two faculty)", "");
      } else {
        const reversed = [...original].reverse();

        const moved = await request("/api/studio/people/reorder", {
          method: "POST",
          jar: admin,
          body: { kind: group, ids: reversed }
        });
        check(
          moved.status !== 500,
          "reorder is not a server error",
          `POST /api/studio/people/reorder answered 500: ${moved.text.slice(0, 200)}`
        );
        check(moved.status === 200, "reorder saved", `expected 200, got ${moved.status}`);

        const stored = await prisma.person.findMany({
          where: { kind: group, deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true }
        });
        check(
          stored.map((row) => row.id).join() === reversed.join(),
          "reorder actually moved the rows",
          "the endpoint answered 200 but the stored order did not change"
        );

        // The order is a change like any other, so it leaves a trail. `entityId` is the GROUP: no one
        // profile is what changed.
        const trail = await prisma.auditLog.count({ where: { entityType: "People", entityId: group } });
        check(trail > 0, "reorder left an audit entry", "the re-order wrote no audit trail");

        // A partial list is a refusal with an explanation, never a fault.
        const partial = await request("/api/studio/people/reorder", {
          method: "POST",
          jar: admin,
          body: { kind: group, ids: reversed.slice(0, 1) }
        });
        check(
          partial.status === 409,
          "an incomplete order is refused",
          `expected 409, got ${partial.status}`
        );

        const restored = await request("/api/studio/people/reorder", {
          method: "POST",
          jar: admin,
          body: { kind: group, ids: original }
        });
        check(restored.status === 200, "reorder restored", `expected 200, got ${restored.status}`);

        const after = await prisma.person.findMany({
          where: { kind: group, deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true }
        });
        check(
          after.map((row) => row.id).join() === original.join(),
          "the roster was handed back as it was found",
          "the smoke run left the faculty in a different order than it started in"
        );
      }
    }

    // ── 8. Sign out ─────────────────────────────────────────────────────────
    {
      const { status } = await request("/api/auth/logout", { method: "POST", jar: admin });
      check(status === 200 || status === 204, "sign out", `got ${status}`);
      const after = await request("/api/studio/pages", { jar: admin });
      check(after.status === 401, "session is dead after sign-out", `got ${after.status}`);
    }
  } finally {
    // Always. A failed run must not leave a fixture behind for the next one to trip over.
    for (const entry of created) {
      try {
        await prisma.researchArea.delete({ where: { id: entry.id } });
      } catch {
        // Already gone, or a relation holds it: reported by the next run rather than hidden here.
      }
    }
    await prisma.searchDocument.deleteMany({ where: { title: { contains: MARKER } } });
    // The grant is keyed on the email rather than the id, so it is removed whether or not the user row
    // was found — a fixture left behind would make the NEXT run's refusal assertion pass for the wrong
    // reason.
    await prisma.studioAccess.deleteMany({ where: { email: LOW_EMAIL } });
    if (lowUserId) {
      await prisma.session.deleteMany({ where: { userId: lowUserId } });
      await prisma.auditLog.deleteMany({ where: { actorId: lowUserId } });
      await prisma.user.delete({ where: { id: lowUserId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }

  if (failures.length === 0) {
    console.log(`  PASS — ${checks} checks.\n`);
    return;
  }

  console.error(`  FAIL — ${failures.length} of ${checks} checks:\n`);
  for (const failure of failures) {
    console.error(`    ${failure.what}\n      ${failure.detail}\n`);
  }
  process.exitCode = 1;
}

main().catch(async (error) => {
  console.error("\nSmoke test could not complete:\n", error, "\n");
  await prisma.$disconnect();
  process.exitCode = 1;
});
