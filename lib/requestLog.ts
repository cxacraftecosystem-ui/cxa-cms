import "server-only";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { accessLogEnabled } from "@/lib/env";
import { ACCESS_COOKIE } from "@/lib/auth/cookies";
import { verifyAccessToken } from "@/lib/auth/tokens";

/**
 * The access log: one row per request that reached a route handler.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. The hosting undertaking signed with IIT KGP's Computer and Informatics Centre
 * requires that website logs be retained for a MINIMUM OF 90 DAYS and produced to CIC on request, and
 * makes non-compliance grounds for deactivating the site. The deployment is on Vercel's Hobby plan,
 * which keeps runtime logs for ONE HOUR and puts Log Drains behind Pro — so every `console.log` in
 * this codebase satisfies exactly none of that, and the obligation has to be met from inside the
 * application, in a table we already operate.
 *
 * `audit_logs` is not that table, and the long note on `model AccessLog` in prisma/schema.prisma sets
 * out why at length. The short version: an audit row exists only where something CHANGED, and the
 * question an incident actually asks is about the requests that changed nothing — which is most of
 * them, and all reconnaissance.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FAILED AUTHENTICATION, WHICH IS THE FIRST THING AN AUDITOR ASKS FOR.
 *
 * `/api/auth/*` is inside the always-logged set, so every refusal on the sign-in surface lands here
 * with an address, a user agent, a status and a duration:
 *
 *   • a wrong password or unknown address → 401 on `POST /api/auth/login`
 *   • a wrong second factor               → 401 on the same path, later in the handler
 *   • a refused OAuth callback            → the four refusal paths in the provider callback
 *   • ⚠ AND THE ONE `audit_logs` CANNOT SEE AT ALL: the RATE-LIMITED attempt. The limiter in
 *     app/api/auth/login/route.ts runs before the body is parsed and returns its 429 before any
 *     `recordEvent` call, so a credential-stuffing sweep currently APPEARS TO TAPER OFF in the audit
 *     log at exactly the moment it reaches full volume. That 429 is a returned response, `route()`
 *     sees it like any other, and it becomes a row here with the source address on it. Closing the
 *     same gap in `audit_logs` is a change to that route and is not this module's to make.
 *
 * ⚠ THE ATTEMPTED PASSWORD IS NOT STORED, AND CANNOT BE. No request body is ever read here — not
 * parsed, not sampled, not hashed. The credential on a sign-in lives in the POST body, so the only way
 * it could reach this table is if somebody added body capture, and the argument against that is the
 * one lib/audit.ts already makes about password hashes: a log is read by more people than the users
 * table is, so it has to be INCAPABLE of holding a credential rather than merely careful with one.
 * The same reasoning excludes cookies and `Authorization`. `User-Agent` is the one header kept, and it
 * is kept because the audit trail already keeps it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS COSTS, WHICH ON A HOBBY PLAN IS A DESIGN CONSTRAINT AND NOT A FOOTNOTE.
 *
 * ONE INSERT, on the connection the handler already holds, inside the same function invocation. It is
 * not a `fetch`, not a route of its own, not a queue and not a drain — every one of those is an extra
 * function invocation per request on a plan that counts them, and would make the log a heavier load on
 * the platform than the traffic it records.
 *
 * It is also DEFERRED: the write is handed to `after()` from next/server, which runs it once the
 * response has been flushed but before the invocation is allowed to end. So the reader waits for the
 * handler and not for the log, while the row is still written inside the invocation that earned it. A
 * bare un-awaited promise would have been the cheap version of this and is wrong on serverless: the
 * runtime may freeze the instant the response is returned, and the write that gets dropped is the one
 * for the request somebody is about to ask about.
 *
 * ⚠ IT CANNOT FAIL A REQUEST, AND THAT IS STRUCTURAL RATHER THAN CAREFUL. `after()` runs after the
 * response is already on the wire, so nothing thrown in there can reach the caller; the try/catch
 * inside exists to get a failure onto the console rather than into an unhandled rejection. This is the
 * same contract `recordEvent` in lib/audit.ts states, for the reason it states: a save that succeeded
 * must never be reported as failed because a log insert hit a constraint.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The paths whose every request is recorded, refused or not. Everything else is recorded only when it
 * WAS refused — see `shouldRecord`.
 *
 *   • `/api/studio` — most of the protected surface, but NOT all of it. See `/studio` below.
 *   • `/api/auth`   — sign-in, sign-out, refresh, set-password, two-factor, OAuth. The surface an
 *                     attacker reaches first, and the one clause 4 exists for.
 *   • `/api/cron`   — two requests a day when it is the scheduler, and a 403 from
 *                     `assertCronAuthorised` whenever it is not. The latter is somebody probing for an
 *                     unauthenticated job runner, which is exactly the "suspected security anomaly"
 *                     the undertaking asks to be reported, and nothing else in the application
 *                     records it.
 *   • `/studio`     — ⚠ ADDED BECAUSE THE FIRST THREE WERE NOT THE PROTECTED SURFACE, WHICH IS WHAT
 *                     THIS COMMENT USED TO CLAIM. `app/studio/subscribers/export/route.ts` is a
 *                     `route()` handler that lives under `app/studio/` rather than `app/api/studio/`
 *                     — its own header explains why, and warns that tooling misses it for exactly
 *                     this reason. It is a capability-gated CSV dump of the ENTIRE newsletter list:
 *                     every address, the consent sentence, the source path and the stored user agent.
 *                     Under the three-prefix list a SUCCESSFUL download wrote no row at all (status
 *                     200, not an always-logged prefix) while a FAILED one did — so the one event
 *                     clause 4 would be asked about, "who took the mailing list and from which
 *                     address", was the single event this table did not hold. The sibling bulk export
 *                     at `app/api/studio/inquiries/export/route.ts` was always logged, so two
 *                     equivalent exports of personal data had opposite audit coverage.
 *
 *                     It is cheap as well as necessary: `/studio/**` pages are server components and
 *                     never reach `route()`, so the only handler this prefix newly captures is that
 *                     export — plus any future non-`/api` studio route, which is the point.
 */
// These four are directories, not endpoints: no route file serves any of them itself, only their
// children. So scripts/route-check.ts is right that they resolve to nothing, and wrong that anything
// here is asking them to — they are the left-hand side of a `startsWith` test on an INBOUND path. That
// is the case its opt-out marker exists for, and the marker has to be the line directly above.
// route-check: not-a-route — prefixes matched against an inbound path, never fetched.
const ALWAYS_LOGGED_PREFIXES = ["/api/studio", "/api/auth", "/api/cron", "/studio"] as const;

/**
 * Query-parameter names that carry a credential IN THIS APPLICATION. Matched case-insensitively.
 *
 * ⚠ WHY THIS IS NOT `REDACTED_KEYS` FROM lib/audit.ts, AND MUST NOT BE MERGED INTO IT.
 *
 * That list is applied to ENTITY SNAPSHOTS, and `Revision.data` is written through the same `redact()`
 * call, then read back and written to the database verbatim by a rollback. Adding `code`, `key` or
 * `state` to it would therefore not merely hide a field in a log: restoring version 4 of a record
 * would write the literal string "[redacted]" into whatever column was named `code`. This schema has
 * several such columns. The two vocabularies are genuinely different because the two surfaces are —
 * `passwordHash` never appears in a query string, and `token` never appears in an entity snapshot.
 *
 * So there is ONE redaction engine, `redact()` from lib/audit.ts, applied below, with two vocabularies
 * layered over it. Widening `REDACTED_KEYS` still widens this automatically, which is the property
 * worth keeping: a secret named there tomorrow is scrubbed from both tables at once.
 *
 * The entries that are not guesses:
 *   • `secret` — lib/cron.ts accepts the CRON_SECRET in a query string, and warns in its own header
 *     that "a secret in a query string is logged by every proxy between the scheduler and the app".
 *     This table would be one of those proxies.
 *   • `token` — `credentialLinkUrl()` in lib/auth/credential-token.ts builds `?token=<signed token>`
 *     for every invitation and every password link, and `NEWSLETTER_TOKEN_QUERY_KEY` is the same word.
 *     A live password link sitting in a table administrators can read is an account takeover.
 *   • `code`, `state` — the OAuth authorization code and its CSRF nonce, which the provider callback
 *     receives in its query string.
 */
const SECRET_QUERY_KEYS = new Set([
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "code",
  "state",
  "nonce",
  "key",
  "apikey",
  "api_key",
  "auth",
  "authorization",
  "signature",
  "sig",
  "password",
  "pass",
  "pwd",
  "totp",
  "otp",
  "recoverycode",
  "recovery_code",
  "session",
  "sid"
]);

/**
 * Length caps. Every one of these is applied to something A STRANGER CHOOSES THE BYTES OF — a path, a
 * query string, `User-Agent`, and `X-Forwarded-For`, which `clientIp()` reads and which nothing
 * validates because it is evidence and never an authorisation input.
 *
 * Uncapped, one request with an 8 KB path writes an 8 KB row, and a few thousand of them fill a free
 * database tier in an afternoon. That is a denial of service against the compliance mechanism itself,
 * and it is a cheaper attack than a denial of service against the site.
 *
 * `USER_AGENT` is 512 to match the two write sites in lib/audit.ts exactly, so that the same browser
 * truncates identically in both tables and a correlation between them does not silently miss.
 */
const MAX = {
  METHOD: 16,
  PATH: 512,
  QUERY: 512,
  QUERY_VALUE: 96,
  ERROR_CODE: 64,
  USER_AGENT: 512,
  IP: 64
} as const;

export interface AccessRecord {
  /** The handler's `Request`. Its body is never read. */
  request: Request;
  status: number;
  /** `ApiErrorBody.code` for a refusal, null for a success. Supplied by `route()`. */
  errorCode: string | null;
  /** `Date.now()` from immediately before the handler was invoked. */
  startedAt: number;
  /** `clientIp(request)` — resolved by the caller, so this module need not import lib/api.ts. */
  ipAddress: string | null;
  /** `userAgent(request)`, likewise. */
  userAgent: string | null;
}

/** Trim to `max`, treating an empty result as absent. */
function clip(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.length > max ? value.slice(0, max) : value;
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Remove C0 controls and DEL, by CODEPOINT rather than by a literal character range.
 *
 * `isSafeObjectKey` in lib/storage/keys.ts makes the same choice and records why: a literal range
 * written into a source file is at the mercy of whatever normalises that file next, and the version
 * that shipped there once rejected every key the system had ever issued.
 *
 * What it prevents here is log injection. A newline or carriage return inside a path survives into
 * whatever an operator exports this table as, and a CSV handed to CIC with a forged extra line in it
 * is worse than no log at all, because it is a log that lies.
 */
function stripControl(value: string): string {
  let out = "";
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) continue;
    out += character;
  }
  return out;
}

/**
 * Does this value look like a credential, whatever it happens to be called?
 *
 * ⚠ BELT AND BRACES OVER `SECRET_QUERY_KEYS`, and the distinction is the one `assertSameOrigin` draws
 * in lib/api.ts: "no parameter we know of carries a secret" and "no parameter CAN carry a secret" are
 * different claims, and only the second survives somebody adding a link builder next year without
 * having read this file.
 *
 * THE FALSE POSITIVE IT ACCEPTS, AND THE THREE IT REFUSES TO. A long `?q=` search phrase is redacted,
 * which costs a little incident detail and is arguably right anyway — a search phrase is personal
 * data, and `SearchQueryLog` already records those properly and aggregated. What must NOT be redacted,
 * because losing any of it would gut the log:
 *
 *   • A CUID. 25 characters, which is why the threshold is 32 and not something tighter: every entity
 *     id in every path and every query string has to survive intact or the log stops being joinable to
 *     the audit trail.
 *   • A SLUG — lowercase words joined by hyphens, with no single long run. A token is the opposite: one
 *     long run of the base64url alphabet.
 *   • A LONG WORD, which is the case that made this function wrong on its first pass. A filename such
 *     as `thisisaverylongfilenamewithnohyphens.pdf` is 32-plus characters of pure token alphabet and
 *     was being redacted out of `/api/public/files/…`. Every credential format this application issues
 *     — base64url session tokens, hex nonces, the signed credential links — MIXES CHARACTER CLASSES,
 *     so "no digit and no capital anywhere" is a reliable way to say "this is words, not a key".
 */
function looksLikeSecret(value: string): boolean {
  if (value.length < 32) return false;
  // A JWT: three base64url runs separated by dots. Both session tokens are this shape.
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return true;
  // A space, or punctuation outside the token alphabet, means prose rather than a credential.
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(value)) return false;
  // No digit and no capital anywhere: words, not a key. See the filename case above.
  if (!/[0-9]/.test(value) && !/[A-Z]/.test(value)) return false;
  // Lowercase words joined by hyphens, none of them long: a slug. Keep it.
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value) && !/[a-z0-9]{24,}/.test(value)) return false;
  return true;
}

/**
 * The path, scrubbed.
 *
 * Segment by segment rather than whole, so that one credential-shaped segment does not take the rest
 * of the path with it: `/api/studio/pages/[redacted]` is worth a great deal more than `[redacted]`. No
 * route in the application puts a secret in a path segment today; this is here so that the one
 * somebody adds later is covered on the day it is added rather than on the day it is noticed.
 *
 * ⚠ THE CAP COMES FIRST, BEFORE ANY OF THE SCRUBBING WORK, and that ordering is the fix for a real
 * defect rather than tidiness. Written the other way round, every byte of an attacker's path was walked
 * codepoint by codepoint by `stripControl` and then run through four regexes, before anything shortened
 * it — so a request whose only content was a very long URL bought more CPU inside the log than it did
 * inside the handler. Node caps a request line at around 16 KB, so it was never unbounded; it was
 * simply work done on bytes that were about to be thrown away.
 *
 * ⚠ EXPORTED, AND THE SECOND CALLER IS NOT A ROUTE. `frameDelivery` in lib/drains.ts runs every
 * Vercel log-drain record through this pair before the bytes reach the bucket, because a drain record
 * carries `proxy.path` — "request path with query parameters", Vercel's own words — into the same
 * `files/logs/` root this table's archive lives under. There must be ONE vocabulary for "a credential
 * in a URL must never reach a log", not a second copy that drifts: a key added to
 * `SECRET_QUERY_KEYS` or to `REDACTED_KEYS` has to cover both surfaces on the day it is added.
 */
export function scrubPath(pathname: string): string {
  const capped = pathname.length > MAX.PATH ? pathname.slice(0, MAX.PATH) : pathname;
  const scrubbed = stripControl(capped)
    .split("/")
    .map((segment) => (looksLikeSecret(segment) ? "[redacted]" : segment))
    .join("/");
  return clip(scrubbed, MAX.PATH) ?? "/";
}

/**
 * The query string with every VALUE scrubbed and the NAMES kept.
 *
 * Keeping the names is the point of storing it at all: that a request carried `token` is the fact an
 * incident needs — somebody opened a password link, somebody replayed one — while the token itself is
 * the one thing that must never be in a table an administrator can read. `URLSearchParams` does the
 * parsing, so a malformed or repeated parameter behaves the way the Web platform says it does rather
 * than the way this module guessed.
 *
 * THREE LAYERS, IN THIS ORDER, and each catches what the one before it cannot:
 *   1. `SECRET_QUERY_KEYS` — the names this application is known to put credentials in.
 *   2. `redact()` from lib/audit.ts — the audit trail's vocabulary, inherited rather than copied, so
 *      that a key added there is scrubbed here without anybody remembering to do it twice.
 *   3. `looksLikeSecret` — the shape guard, for the parameter nobody has thought of yet.
 * Then a length cap, because a value that survived all three is still attacker-controlled.
 */
export function scrubQuery(search: string, redact: (value: unknown) => unknown): string | null {
  if (!search || search === "?") return null;

  // Bound the input before parsing it, for the reason `scrubPath` gives at length: none of the work
  // below should be proportional to how long a stranger decided to make the URL. `RAW_QUERY` is
  // generous against the cap on the stored result so that an ordinary query is never touched by it; a
  // value cut in half here is a value that was never going to fit in the column anyway.
  const RAW_QUERY = MAX.QUERY * 4;
  const bounded = search.length > RAW_QUERY ? search.slice(0, RAW_QUERY) : search;

  const params = new URLSearchParams(bounded);
  const flat: Record<string, string> = {};
  params.forEach((value, key) => {
    // Truncate on the way in, not on the way out: `stripControl` walks every codepoint it is given.
    flat[key.slice(0, MAX.QUERY_VALUE)] = value.slice(0, MAX.QUERY_VALUE);
  });
  if (Object.keys(flat).length === 0) return null;

  const audited = (redact(flat) ?? {}) as Record<string, unknown>;
  const out = new URLSearchParams();

  for (const [key, raw] of Object.entries(flat)) {
    const afterAudit = audited[key];
    const value = typeof afterAudit === "string" ? afterAudit : raw;

    if (SECRET_QUERY_KEYS.has(key.toLowerCase()) || value === "[redacted]") {
      out.append(key, "[redacted]");
      continue;
    }
    const cleaned = stripControl(value);
    out.append(key, looksLikeSecret(cleaned) ? "[redacted]" : cleaned);
  }

  return clip(out.toString(), MAX.QUERY);
}

/**
 * One request target — `/path?query`, or a whole `https://host/path?query` — scrubbed end to end.
 *
 * `recordAccess` never needs this, because `new URL(request.url)` has already split the two halves for
 * it. Everything OUTSIDE this module has them joined: a Vercel drain record's `proxy.path` is
 * documented as "Request path with query parameters" and arrives as one string, and a `Referer` is a
 * whole absolute URL. Rejoining `scrubPath` and `scrubQuery` at each of those call sites is how the
 * third, weaker copy of this vocabulary gets written, so the join lives here once.
 *
 * ⚠ THE ORIGIN IS KEPT VERBATIM WHEN THERE IS ONE. A host and a scheme are not credentials, they are
 * the part of a referer that says where the visitor came from, and losing them would gut the field
 * for the sake of nothing. Only the path and the query are scrubbed. A value that is neither — a
 * fragment of prose, an empty string — comes back unchanged apart from the control-character strip,
 * because guessing at a shape we do not recognise is how a scrubber corrupts evidence.
 *
 * A `#fragment` is dropped rather than scrubbed: fragments are not sent to servers, so a drain record
 * cannot carry one, and if a future caller passes something that has one the safe reading is that it
 * is not part of the request.
 */
export function scrubRequestTarget(
  target: string | null | undefined,
  redact: (value: unknown) => unknown
): string | null {
  if (!target) return null;

  // Bound first, for the reason `scrubPath` gives at length: no work below should be proportional to
  // how long a stranger decided to make the URL. Both halves are capped again by their own scrubbers.
  const capped = target.length > MAX.PATH + MAX.QUERY * 4 ? target.slice(0, MAX.PATH + MAX.QUERY * 4) : target;

  // An absolute URL. `URL` throws on anything that is not one, which is the test — there is no cheap
  // string check that distinguishes `https://host/p` from a relative path containing a colon.
  let origin = "";
  let rest = capped;
  try {
    const parsed = new URL(capped);
    origin = parsed.origin === "null" ? `${parsed.protocol}//` : parsed.origin;
    rest = `${parsed.pathname}${parsed.search}`;
  } catch {
    // Relative, or not a URL at all. Fall through with the value as given.
  }

  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);

  const split = rest.indexOf("?");
  if (split < 0) {
    // No query string. A leading slash is what makes this a path rather than free text; without one,
    // `scrubPath`'s segment split would still be correct but its `?? "/"` fallback would invent a path
    // for an empty value, so the honest answer for a non-path is the control-stripped original.
    const cleaned = stripControl(capped);
    if (!rest.startsWith("/")) return clip(cleaned, MAX.PATH);
    return `${origin}${scrubPath(rest)}`;
  }

  const path = scrubPath(rest.slice(0, split));
  const query = scrubQuery(rest.slice(split), redact);
  return query ? `${origin}${path}?${query}` : `${origin}${path}`;
}

/** Pull one cookie out of a `Cookie` header, without dragging `next/headers` into this module. */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Who made this request, from the VERIFIED access token.
 *
 * ⚠ VERIFIED, NOT DECODED. Reading the claims without checking the signature would let anybody write
 * any user's id into this table by setting a cookie, and a log an attacker can author is worse than no
 * log, because it is believed.
 *
 * ⚠ AND IT IS NOT A DATABASE READ. `verifyAccessToken` is an HMAC over a short string through
 * WebCrypto: microseconds, no round trip, and it runs inside `after()` where it is off the response
 * path entirely. `currentUser()` would have been the obvious alternative and is wrong twice over — it
 * costs a query per request, and lib/auth/current-user.ts imports lib/api.ts, which would make that
 * module, lib/api.ts and this one a cycle.
 *
 * The identity recorded is the one the request PRESENTED, which is deliberately not the same as "a
 * user who currently exists". An access token outlives a deactivation by up to its full lifetime by
 * design, so a request from a just-disabled account is recorded under that account — which is exactly
 * the row an incident review is hunting for. It is also why `actorId` carries no foreign key; the
 * schema note on `model AccessLog` sets out the rest of that argument.
 */
async function actorFrom(request: Request): Promise<{ id: string; email: string } | null> {
  const token = readCookie(request.headers.get("cookie"), ACCESS_COOKIE);
  if (!token) return null;
  const claims = await verifyAccessToken(token);
  if (!claims) return null;
  return { id: claims.sub, email: claims.email };
}

/**
 * Is this request in scope?
 *
 * THE PROTECTED SURFACE, ALWAYS. EVERYTHING ELSE, ONLY WHEN IT WAS REFUSED.
 *
 * A successful `GET /api/public/publications` is a cacheable read of content that is published on
 * purpose: a row for it answers no question clause 4 asks, and would multiply this table by the size
 * of the public audience. A 403, 422 or 429 on `/api/public/contact` or on an event registration is
 * somebody probing a form, which is an anomaly worth a record. The same rule covers the few non-`/api`
 * routes that use `route()`, such as the calendar feed.
 */
function shouldRecord(pathname: string, status: number): boolean {
  const protectedSurface = ALWAYS_LOGGED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  return protectedSurface || status >= 400;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ AN ANONYMOUS STRANGER MUST NOT OWN AN UNBOUNDED INSERT INTO THIS TABLE.
 *
 * `shouldRecord` above is written for evidence, and on its own it hands a write primitive away.
 * Three facts compose into it, and each of them is individually correct:
 *
 *   1. `/api/cron` is always-logged, and both cron routes go straight to `assertCronAuthorised`,
 *      which answers a missing or wrong secret with a 403 that touches no database at all.
 *   2. `/api/auth` is always-logged, and `enforceRateLimit` RETURNS its 429 rather than throwing, so
 *      `route()` sees it like any other response and logs it. That is the slice's headline win —
 *      `audit_logs` cannot see a throttled sign-in attempt and this table can — and it means the
 *      limiter caps password guesses, not row inserts.
 *   3. `proxy.ts` matches only `/studio` and `/api/studio/*`, so neither surface is refused
 *      earlier.
 *
 * So `GET /api/cron/purge` in a loop costs the attacker one connection and costs the deployment one
 * indexed INSERT, unthrottled. At a few hundred requests a second that is tens of millions of rows a
 * day; a free Postgres tier is full in hours, and once Postgres refuses writes EVERY write in the
 * application fails — including the `AuditLog` inserts inside `mutateWithHistory`, which is the
 * compliance trail this whole slice exists to protect. It also inverts the property
 * app/api/auth/login/route.ts states in capitals, that "a flood costs one map lookup rather than a
 * bcrypt comparison": it cost one map lookup and one INSERT.
 *
 * ── WHAT IS SAMPLED, AND WHAT IS NEVER SAMPLED ────────────────────────────────────────────────
 *
 * ONLY ANONYMOUS REFUSALS. Two conditions, both required:
 *
 *   • `status >= 400`. A successful request is never dropped. The studio's bulk exports, every
 *     audited mutation, every 200 on an always-logged prefix — all recorded whole, always.
 *   • NO VERIFIED ACTOR. `actorFrom` runs first and its result decides this, so a request carrying a
 *     signed access token is never dropped either. A stranger cannot forge one, and a signed-in
 *     account's refusals are bounded by that account's own behaviour and are exactly the rows an
 *     incident review needs complete.
 *
 * ── WHAT IS LOST, STATED PLAINLY ──────────────────────────────────────────────────────────────
 *
 * The MAGNITUDE of a flood, not its existence. Past thirty rows per ten minutes for one
 * (address, path, status), the table keeps a HEARTBEAT — thirty more every ten minutes, indefinitely,
 * for as long as the flood runs — rather than a complete transcript. An anomaly that sustains for
 * hours is if anything easier to see in a heartbeat than in ten million identical rows. The exact
 * count of what was dropped goes to the console, once per key per window, and on Hobby that line
 * lasts an hour: that is a real loss and it is the lesser one, because the alternative on the table
 * was a full transcript that fills the database and takes the audit trail down with it.
 *
 * REJECTED: rate-limiting `/api/cron/*` itself, which the finding that prompted this also suggested.
 * The 403 is already free, so it would bound function invocations rather than rows — and a
 * per-instance limiter in front of a compliance job that runs once a night can only ever cost that
 * job a run it needed. The amplification belongs to the rule in this module, so the bound belongs
 * here too, which is what app/api/drains/logs/route.ts's header already said it would.
 *
 * ⚠ THE BUCKET IS PER INSTANCE, exactly as the header of lib/ratelimit.ts warns. Four instances allow
 * roughly four times this, and a cold start allows a full burst. That is fine for what this is: the
 * point is to turn an unbounded write primitive into a bounded one, and a bound that is four or forty
 * times the stated number is still a bound. It is not, and must not be read as, a security control.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function refusalIsOverSampled(input: {
  path: string;
  status: number;
  ipAddress: string | null;
}): Promise<boolean> {
  // ⚠ DYNAMIC, FOR THE SAME REASON THE `@/lib/audit` IMPORT BELOW IS. lib/ratelimit.ts imports
  // lib/api.ts, and lib/api.ts imports this module — a static import would close that ring in the one
  // module every route file in the application depends on. This runs after the response is flushed
  // and the module registry caches the result, so the cost is not measurable.
  const { RATE_LIMITS, consumeRateLimit } = await import("@/lib/ratelimit");

  // The SCRUBBED path, so the key is bounded and so two requests that differ only in a redacted
  // credential share one bucket rather than each getting their own allowance.
  const key = `access-log:${input.ipAddress ?? "no-ip"}:${input.status}:${input.path}`;
  const verdict = consumeRateLimit(key, RATE_LIMITS.accessLogRefusal);
  if (verdict.ok) {
    suppressed.delete(key);
    return false;
  }

  // One line per key per window, carrying the count — so "how big was it" survives somewhere, even if
  // only for the hour the platform keeps it. An entry is cleared when that key's bucket has refilled
  // and it is hit again, so a live flood costs one entry; a key that is never hit again keeps its
  // entry until the instance is recycled, which is exactly what `MAX_SUPPRESSED_KEYS` is sized for.
  const count = (suppressed.get(key) ?? 0) + 1;
  if (suppressed.size < MAX_SUPPRESSED_KEYS || suppressed.has(key)) suppressed.set(key, count);
  if (count === 1 || count % SUPPRESSION_REPORT_EVERY === 0) {
    console.warn(
      `[access] not recording further refusals for ${input.ipAddress ?? "an unknown address"} on ` +
        `${input.path} (status ${input.status}): ${count} row(s) dropped in this window. The table ` +
        "keeps a heartbeat of this flood rather than every request — see RATE_LIMITS.accessLogRefusal."
    );
  }
  return true;
}

/**
 * How many rows have been dropped per key in the current window, for the console line only.
 *
 * Capped, because it is keyed on something a stranger chooses: without the cap, a flood that varies
 * the path or forges a new `X-Forwarded-For` per request would grow this map without bound and turn a
 * defence against filling the database into a way to fill the heap instead.
 */
const MAX_SUPPRESSED_KEYS = 5_000;
const SUPPRESSION_REPORT_EVERY = 1_000;
const suppressed = new Map<string, number>();

/**
 * Run `task` after the response has been flushed, still inside this invocation.
 *
 * `after()` throws when there is no request scope to attach it to — a script that imports a handler, a
 * test harness. That is not a reason for the caller to fail, so the fallback runs the task detached.
 * Detached is the WRONG default on serverless, because the instance may freeze the moment the response
 * is returned and silently drop the write; it is the right fallback here, because the only way to
 * reach it is to be somewhere that is not serverless.
 */
function schedule(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/**
 * Record one request. Returns immediately; never throws.
 *
 * Called from `route()` in lib/api.ts on BOTH branches — the handler's own response, and the one
 * `toErrorResponse` built out of a throw — so a request that failed is logged exactly like one that
 * did not, which is the half of the log that matters.
 */
export function recordAccess(record: AccessRecord): void {
  // ⚠ THE WHOLE BODY IS INSIDE ONE TRY, and that is the promise `route()` relies on. `route()` gives
  // 113 route files the guarantee that it returns a response; a log that could throw on the way past
  // would turn a successful save into a 500 for a reason that has nothing to do with the save. So
  // nothing here — not a malformed URL, not a configuration value, not a bug added later — is allowed
  // to escape, and the caller needs no guard of its own.
  try {
    // `accessLogEnabled()` throws on a value that is not a boolean. Treat that as ON: the compliant
    // state is the right thing to fail towards, and `configurationWarnings()` already reports the
    // malformed value where an administrator will read it.
    let enabled = true;
    try {
      enabled = accessLogEnabled();
    } catch {
      enabled = true;
    }
    if (!enabled) return;

    // A request whose URL cannot be read cannot be attributed to a path, and a row that guessed one
    // would be worse than a missing row, because it would be read as evidence. `new URL` throwing here
    // lands in the outer catch and the request goes unlogged, which is the honest outcome.
    const url = new URL(record.request.url);
    const pathname = url.pathname;
    const search = url.search;

    if (!shouldRecord(pathname, record.status)) return;

    const at = new Date(record.startedAt);
    const durationMs = Math.max(0, Date.now() - record.startedAt);
    const method = clip(record.request.method, MAX.METHOD) ?? "UNKNOWN";
    const request = record.request;

    schedule(async () => {
      try {
        // ⚠ DYNAMIC, AND NOT A STYLE CHOICE. lib/audit.ts imports lib/api.ts for `ApiError`, and
        // lib/api.ts imports this module — so a static `import { redact } from "@/lib/audit"` would
        // make the three of them a cycle, in the one module every route file in the application
        // depends on. That cycle would in fact resolve today, because neither module touches the
        // other's exports at evaluation time; it would stop resolving the first time one did, and the
        // failure would be an `undefined` binding in production only. Importing here costs nothing
        // measurable: the module is already resident (every studio route imports it), this runs after
        // the response is flushed, and the module registry caches the result.
        const { redact } = await import("@/lib/audit");

        const path = scrubPath(pathname);
        const ipAddress = clip(record.ipAddress, MAX.IP);

        /*
         * ⚠ THE ACTOR IS RESOLVED BEFORE THE SAMPLER, AND THE ORDER IS THE SAFETY PROPERTY.
         *
         * `refusalIsOverSampled` may drop a row, and the one row it must never drop is one belonging
         * to somebody who is signed in. Asking `actorFrom` first — an HMAC over a short string, no
         * round trip — is what makes "anonymous only" a fact rather than an intention. See the long
         * note on that function for the rest of the rule.
         */
        const actor = await actorFrom(request);

        if (
          record.status >= 400 &&
          !actor &&
          (await refusalIsOverSampled({ path, status: record.status, ipAddress }))
        ) {
          return;
        }

        await prisma.accessLog.create({
          data: {
            at,
            method,
            path,
            query: scrubQuery(search, redact),
            status: record.status,
            errorCode: clip(record.errorCode, MAX.ERROR_CODE),
            durationMs,
            actorId: actor?.id ?? null,
            actorEmail: actor?.email ?? null,
            ipAddress,
            userAgent: clip(record.userAgent, MAX.USER_AGENT)
          }
        });
      } catch (error) {
        // The request is long since answered, so there is nobody left to tell but the console. One
        // line, carrying the path, because "the access log is not being written" is a compliance
        // failure an operator has to be able to watch accumulating — and on Hobby that line lasts an
        // hour, which is the whole reason this table exists.
        console.error("[access] could not record request", method, pathname, error);
      }
    });
  } catch (error) {
    console.error("[access] could not record request", error);
  }
}
