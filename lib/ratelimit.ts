import "server-only";
import { ApiError, clientIp, toErrorResponse } from "@/lib/api";
import type { NextResponse } from "next/server";

/**
 * Rate limiting, behind a store interface — with an in-process token bucket as the default.
 *
 * ⚠ **READ THIS BEFORE YOU RELY ON IT.** The DEFAULT store is per process. Every serverless instance,
 * every container replica and every region gets its OWN map, so a deployment running four instances
 * allows roughly four times the stated limit, and an instance that has just cold-started allows a full
 * burst because its map is empty. It is a SPEED BUMP against the ordinary case — one script hammering
 * one form from one address — and it is not a guarantee about anything.
 *
 * The real answer is a shared store: a Redis `INCR` with a TTL, or the platform's own edge rate
 * limiting, where all instances count against one number. That needs a service this deployment does not
 * require, so the in-memory bucket is the honest stand-in until one is added. Nothing here pretends
 * otherwise, and no security decision anywhere in this codebase may be built on it — `clientIp()` reads
 * a header the client can set when no trusted proxy is in front of the app (see its own note), so a
 * bucket key is not an identity either.
 *
 * ══ WHAT CHANGED, AND WHAT DELIBERATELY DID NOT ══
 *
 * The bucket used to be the only implementation. It is now `memoryRateLimitStore`, reachable through a
 * `RateLimitStore` interface, so a shared store can be dropped in at start-up with
 * `setRateLimitStore()` and nothing else in the codebase moves. **The arithmetic, the eviction, the
 * ceiling and every verdict the in-memory path returns are byte-for-byte the previous behaviour.** This
 * refactor is about where the counter LIVES, not about how it counts.
 *
 * ⚠ **THERE ARE TWO PARALLEL ENTRY POINTS AND THAT IS ON PURPOSE.** Eight route handlers call
 * `enforceRateLimit()` SYNCHRONOUSLY (`const limited = enforceRateLimit(...); if (limited) return
 * limited;`). A shared store is a network call and therefore async. Making the existing function async
 * would change the type of `limited` from `NextResponse | null` to a promise at every one of those call
 * sites, and a call site that forgot the `await` would compile — `if (promise)` is always truthy, so a
 * route would return a pending promise instead of a response, or (worse, if the type slipped through)
 * would never refuse anything at all. A limiter that is half migrated is worse than none. So:
 *
 *   • `enforceRateLimit` / `checkRateLimit` / `consumeRateLimit` stay SYNCHRONOUS. They use the
 *     registered store's synchronous path when it has one, and the in-memory bucket when it does not,
 *     warning once so the gap is visible rather than silent.
 *   • `enforceRateLimitAsync` / `checkRateLimitAsync` / `consumeRateLimitAsync` are the same functions
 *     with `await` in front of the store. They behave identically under the default store, so a handler
 *     can adopt them today at no cost, and they are what a route MUST use once a shared store is
 *     registered.
 *
 * Migrating a route is one word: `const limited = await enforceRateLimitAsync(...)`. Migrate the
 * sensitive ones first — sign-in, second factor, set-password — because those are the ones where the
 * per-instance multiplier actually matters.
 *
 * ══ WRITING A SHARED STORE (the adapter shape) ══
 *
 * No Redis client is a dependency here and none is provisioned. When one is added, the adapter is small
 * — a `RateLimitStore` whose `consume` runs one atomic script and returns the same verdict shape:
 *
 *     // lib/ratelimit-redis.ts, registered once from instrumentation.ts (server start-up):
 *     //
 *     //   setRateLimitStore(redisRateLimitStore(client));
 *     //
 *     // The Lua script does the whole token-bucket read-modify-write in ONE round trip, because
 *     // GET-then-SET from several instances at once loses counts — exactly the race a shared store
 *     // exists to close. It returns [allowed, retryAfterMs, remaining]; translate that into a
 *     // RateLimitVerdict and nothing else in this file or in any route changes.
 *     //
 *     //   consume(key, policy) => Promise<RateLimitVerdict>   required
 *     //   consumeSync?                                        omit it — a network call is not sync
 *     //   shared: true                                        so lib/runtime.ts stops warning
 *     //   name: "Redis (shared)"                              shown in the studio diagnostics panel
 *
 * A store that throws is NOT fatal: `consumeRateLimitAsync` falls back to the in-memory bucket and logs
 * it. A Redis outage must degrade the limiter to a per-instance speed bump, never take the contact form
 * down with it.
 *
 * ══ WHAT THE IN-MEMORY BUCKET DOES GET RIGHT ══
 *
 *   • **Continuous refill, not a fixed window.** A fixed window lets 2× the limit through across a
 *     boundary — five at 09:59:59 and five more at 10:00:00. Tokens here accrue smoothly, so the
 *     answer to "how long until I may try again" is a real number rather than "until the window
 *     rolls".
 *   • **Expired buckets are evicted on write.** An unbounded `Map` keyed by an attacker-controlled
 *     value is a memory leak with a remote trigger; a sweep on write keeps it bounded by the number
 *     of addresses seen in one window rather than by the number seen since boot.
 *   • **`retryAfterSeconds` is returned, not invented by the caller**, so the 429 can carry a
 *     `Retry-After` header AND a sentence that says how long — the same number in both places.
 */

export interface RateLimitPolicy {
  /** Bucket capacity: the largest burst allowed before anything is refused. */
  limit: number;
  /** Seconds for an empty bucket to refill completely. */
  windowSeconds: number;
}

export interface RateLimitVerdict {
  ok: boolean;
  /** Whole seconds until one token is available. Zero when `ok` — never negative. */
  retryAfterSeconds: number;
  limit: number;
  /** Tokens left after this request, floored. For a refusal this is 0. */
  remaining: number;
}

/**
 * Every policy in one place, so the numbers a route ENFORCES and the numbers its message QUOTES
 * cannot drift apart, and so "what are the limits on the public API" is answerable by reading one
 * object rather than seven route files.
 *
 * The shapes are deliberately different. A contact form is submitted once, thought about, and maybe
 * submitted again after a typo — five in ten minutes is generous for a person and useless for a
 * script. A search box is typed into continuously, so its allowance is an order of magnitude larger
 * and its window an order of magnitude shorter.
 */
export const RATE_LIMITS = {
  /** The contact form. Five is two genuine attempts plus three mistakes. */
  contact: { limit: 5, windowSeconds: 10 * 60 },
  /** Event registration. Higher than contact because a lab or an office shares one address. */
  eventRegistration: { limit: 6, windowSeconds: 15 * 60 },
  /** Full search. One per submitted query, not per keystroke. */
  search: { limit: 30, windowSeconds: 60 },
  /** Header suggestions. Fires while typing, so the allowance assumes a debounce, not a keystroke. */
  suggest: { limit: 60, windowSeconds: 60 },
  /**
   * Search-analytics WRITES, per (IP, normalised query) — consumed by `logSearch` in
   * lib/search/query.ts with a hand-built key rather than by a route through `enforceRateLimit`.
   * The `search` policy above paces how often one connection may ASK; this one caps how often its
   * IDENTICAL query may reach the SearchQueryLog table, which an unauthenticated GET can otherwise
   * drive as an attacker-controlled INSERT loop (the audit's words). Five repeats per ten minutes
   * is generous for a person re-running a search they are refining, and it is the point at which a
   * replayed phrase stops inflating the "top searches" tally.
   */
  searchLog: { limit: 5, windowSeconds: 10 * 60 },
  /** The view beacon. One per article read; anything beyond this is not a reader. */
  views: { limit: 40, windowSeconds: 10 * 60 },
  /** Counted downloads. Each one costs a storage HEAD and a signature. */
  download: { limit: 30, windowSeconds: 10 * 60 },

  /**
   * Sign-in attempts, PER IP ADDRESS.
   *
   * ⚠ THIS IS NOT REDUNDANT WITH THE PER-ACCOUNT LOCKOUT. `lib/auth/session.ts` locks an ACCOUNT after
   * eight consecutive failures, which stops somebody grinding at one person's password. It does nothing
   * at all about the attack that actually happens against an institutional site whose staff directory is
   * public: **credential stuffing** — one guess against each of two hundred known addresses, where no
   * single account ever reaches its own threshold.
   *
   * Twenty in fifteen minutes is deliberately generous for a person: a mistyped password, a forgotten
   * variant, a second attempt with the right one, and an authenticator code entered a moment too late
   * all count. It is useless for a script.
   *
   * The window is long rather than short on purpose. A one-minute window merely paces an attacker;
   * fifteen minutes makes a sustained sweep cost real time.
   */
  login: { limit: 20, windowSeconds: 15 * 60 },

  /**
   * Second-factor attempts, per IP.
   *
   * Tighter than `login` because reaching this point means the password was already correct, so every
   * request here is a guess at a six-digit code with a one-in-a-million chance — and an attacker who
   * holds a password has every reason to keep trying. Ten attempts per quarter hour is more than a
   * person needs to retype a code that expired while they were reading it.
   */
  secondFactor: { limit: 10, windowSeconds: 15 * 60 },

  /**
   * Claiming an invitation or a password-reset link.
   *
   * The token in the link is the credential, so this endpoint is the one place a token can be guessed.
   * The token is long enough that guessing is not a real threat; the limit exists so that it stays true
   * if the token is ever shortened, and so a broken client cannot hammer it.
   */
  setPassword: { limit: 10, windowSeconds: 15 * 60 }
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * The store interface
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Where the counters live.
 *
 * `consume` is the whole contract: take one token from `key`'s bucket under `policy` and say what
 * happened. It is `async` because the useful implementations are network calls; the in-memory one
 * resolves immediately and additionally offers `consumeSync`.
 *
 * ⚠ **`consume` MUST BE ATOMIC.** A read-then-write pair against a shared store loses counts whenever
 * two instances are debiting the same key, which is precisely the situation a shared store exists to
 * handle. Use a Lua script, a stored procedure, or a single conditional update — not two commands.
 */
export interface RateLimitStore {
  /**
   * A short name for the studio's diagnostics panel — an administrator reads this, so it says what it
   * is in plain words: "in-memory (per instance)", "Redis (shared)".
   */
  readonly name: string;
  /**
   * True only when every instance of the application counts against the SAME numbers.
   *
   * `lib/runtime.ts` reads this to decide whether to warn that the configured limits are multiplied by
   * the instance count. An adapter that sets it optimistically silences a warning that is still true,
   * so set it only when the counter is genuinely shared.
   */
  readonly shared: boolean;
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitVerdict>;
  /**
   * The synchronous path, for the eight handlers that call `enforceRateLimit()` without `await`.
   *
   * Only an in-process store can offer this. Omit it in a network-backed adapter: the synchronous
   * entry points then fall back to the in-memory bucket and say so once in the log, which is a visible
   * gap rather than a silent one.
   */
  consumeSync?(key: string, policy: RateLimitPolicy): RateLimitVerdict;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * The default: an in-process token bucket
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

interface Bucket {
  /** Fractional tokens available, as of `updatedAt`. */
  tokens: number;
  updatedAt: number;
  /**
   * When this bucket becomes indistinguishable from a fresh one — i.e. when it has refilled to
   * capacity. After that instant, keeping it costs memory and changes no decision, which is exactly
   * what makes it safe to evict.
   */
  expiresAt: number;
}

interface RateLimitState {
  buckets: Map<string, Bucket>;
  lastSweepAt: number;
  /** The registered store, or null while the in-memory default is in use. */
  store: RateLimitStore | null;
  /** So the "no synchronous path" warning is one line per process rather than one per request. */
  syncFallbackWarned: boolean;
}

/**
 * The state lives on `globalThis`, for the same reason the Prisma client does (lib/db.ts): the dev
 * server re-evaluates modules on every hot reload, and module-scoped state would reset the limits on
 * every file save — which is the one situation where you are most likely to be testing them. It is set
 * unconditionally rather than only in development, because a runtime that evaluates this module twice
 * would otherwise keep two half-populated maps and enforce roughly double the limit.
 *
 * ⚠ The REGISTERED STORE is held here too, not in a module-scoped `let`. Otherwise a hot reload would
 * silently drop a Redis adapter registered at start-up and fall back to the per-instance bucket, and the
 * limits would quietly loosen mid-session with nothing in the log to say why.
 */
const globalForRateLimit = globalThis as unknown as { __cxaRateLimit?: RateLimitState };

const state: RateLimitState =
  globalForRateLimit.__cxaRateLimit ?? {
    buckets: new Map(),
    lastSweepAt: 0,
    store: null,
    syncFallbackWarned: false
  };
globalForRateLimit.__cxaRateLimit = state;

/**
 * A full sweep runs at most this often. Sweeping on every request would make each one O(buckets),
 * which under the load a limiter exists to survive is itself the problem.
 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * The hard ceiling on distinct buckets.
 *
 * A sweep only removes buckets that have refilled. A flood from tens of thousands of fresh addresses
 * inside one window produces buckets that are all still live, so the sweep cannot help and the map
 * would grow with the attack. Past this ceiling the oldest entries are dropped, which FORGIVES
 * whatever they had counted — a deliberate release valve, and one more reason this module is a speed
 * bump rather than a guarantee. 20 000 buckets is a few megabytes.
 */
const MAX_BUCKETS = 20_000;

function sweep(now: number): void {
  for (const [key, bucket] of state.buckets) {
    if (bucket.expiresAt <= now) state.buckets.delete(key);
  }
  state.lastSweepAt = now;

  if (state.buckets.size <= MAX_BUCKETS) return;

  // Still over the ceiling: shed the buckets closest to expiring, since they are the ones whose
  // removal changes the fewest decisions. Sorting only happens on the path that is already degraded.
  const excess = state.buckets.size - MAX_BUCKETS;
  const oldest = [...state.buckets.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, excess);
  for (const [key] of oldest) state.buckets.delete(key);

  console.warn(
    `[ratelimit] the bucket map hit its ${MAX_BUCKETS}-entry ceiling and ${excess} bucket(s) were ` +
      "dropped, so those callers start again with a full allowance. If this recurs, the deployment " +
      "needs a shared limiter (Redis or the platform's edge rate limiting) rather than this in-process one."
  );
}

/**
 * Take one token from `key`'s bucket, in this process's map.
 *
 * A bucket that does not exist is created FULL and immediately debited, so a first request is always
 * allowed and the caller never has to special-case a cold start.
 */
function consumeInMemory(key: string, policy: RateLimitPolicy): RateLimitVerdict {
  const limit = Math.max(1, Math.floor(policy.limit));
  const windowMs = Math.max(1_000, Math.floor(policy.windowSeconds * 1000));
  const tokensPerMs = limit / windowMs;
  const now = Date.now();

  if (now - state.lastSweepAt > SWEEP_INTERVAL_MS || state.buckets.size > MAX_BUCKETS) {
    sweep(now);
  }

  const existing = state.buckets.get(key);
  // `Math.max(0, …)` guards a clock that has stepped backwards: a negative elapsed time would
  // otherwise DRAIN the bucket and lock out a caller who did nothing wrong.
  const elapsed = existing ? Math.max(0, now - existing.updatedAt) : 0;
  const tokens = existing ? Math.min(limit, existing.tokens + elapsed * tokensPerMs) : limit;

  if (tokens < 1) {
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - tokens) / tokensPerMs / 1000));
    // The bucket is still written back, with its refilled total, so the next attempt is measured from
    // now rather than from the last ALLOWED request. A refusal must not reset the clock.
    state.buckets.set(key, { tokens, updatedAt: now, expiresAt: now + windowMs });
    return { ok: false, retryAfterSeconds, limit, remaining: 0 };
  }

  const remaining = tokens - 1;
  state.buckets.set(key, {
    tokens: remaining,
    updatedAt: now,
    // Measured from `now`: the bucket is full again one whole window after its last debit.
    expiresAt: now + windowMs
  });
  return { ok: true, retryAfterSeconds: 0, limit, remaining: Math.floor(remaining) };
}

/**
 * The default store, and the fallback whenever a registered one cannot answer.
 *
 * Exported so a shared adapter can delegate to it — a Redis store that wants to keep working through an
 * outage can catch its own error and return `memoryRateLimitStore.consumeSync(key, policy)`.
 */
export const memoryRateLimitStore: RateLimitStore = {
  name: "in-memory (per instance)",
  shared: false,
  consumeSync: consumeInMemory,
  consume: (key, policy) => Promise.resolve(consumeInMemory(key, policy))
};

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * Registration
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Install a shared store. Call it ONCE, at start-up, before any request is served —
 * `instrumentation.ts` is the place Next provides for exactly this.
 *
 * Registering a second store replaces the first and warns, because two stores in one process means two
 * sets of counters and neither one is the answer.
 */
export function setRateLimitStore(store: RateLimitStore): void {
  if (state.store && state.store !== store) {
    console.warn(
      `[ratelimit] the store was already set to "${state.store.name}" and has been replaced with ` +
        `"${store.name}". Anything counted against the first one is forgotten, so those callers start ` +
        "again with a full allowance. Register the store once, at start-up."
    );
  }
  state.store = store;
  // Announced at INFO, not warn: a deployment that has done the right thing should be able to prove it
  // from the log rather than by reading code.
  console.log(
    `[ratelimit] store set to "${store.name}"` +
      (store.shared
        ? " — counters are shared across instances."
        : " — counters are PER INSTANCE, so the effective limit is the configured one times the number " +
          "of running instances.") +
      (store.consumeSync
        ? ""
        : " It has no synchronous path, so any route still calling enforceRateLimit() without `await` " +
          "falls back to the in-process bucket. See the header of lib/ratelimit.ts.")
  );
}

/** Undo `setRateLimitStore` and go back to the in-memory bucket. For tests and for a controlled failover. */
export function clearRateLimitStore(): void {
  state.store = null;
  state.syncFallbackWarned = false;
}

/**
 * What the studio's diagnostics panel and `lib/runtime.ts` read to describe the limiter honestly.
 *
 * `synchronous` is part of the answer rather than an implementation detail: a shared store with no
 * synchronous path means the synchronous call sites are STILL counting per instance, and an
 * administrator looking at "Redis (shared)" would otherwise reasonably conclude the whole problem is
 * solved.
 */
export function rateLimitStoreInfo(): { name: string; shared: boolean; synchronous: boolean } {
  const store = state.store ?? memoryRateLimitStore;
  return { name: store.name, shared: store.shared, synchronous: Boolean(store.consumeSync) };
}

function warnSyncFallbackOnce(storeName: string): void {
  if (state.syncFallbackWarned) return;
  state.syncFallbackWarned = true;
  console.warn(
    `[ratelimit] the registered store "${storeName}" has no synchronous path, so calls made through ` +
      "enforceRateLimit() are being counted in this process's own bucket instead of the shared one. " +
      "Those routes are still limited, but per instance. Move them to enforceRateLimitAsync() — see " +
      "the header of lib/ratelimit.ts."
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * Consuming a token
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Take one token, synchronously.
 *
 * Uses the registered store when it can answer without awaiting, and the in-process bucket otherwise.
 * Kept because eight route handlers call it through `enforceRateLimit` with no `await` — see the header
 * for why that was not simply changed.
 */
export function consumeRateLimit(key: string, policy: RateLimitPolicy): RateLimitVerdict {
  const store = state.store;
  if (!store) return consumeInMemory(key, policy);
  if (store.consumeSync) return store.consumeSync(key, policy);
  warnSyncFallbackOnce(store.name);
  return consumeInMemory(key, policy);
}

/**
 * Take one token, awaiting the store.
 *
 * ⚠ A STORE FAILURE FALLS BACK TO THE IN-PROCESS BUCKET rather than throwing. The alternatives are both
 * worse: throwing turns a Redis hiccup into a 500 on the contact form, and returning `ok` turns it into
 * an open endpoint. Degrading to a per-instance speed bump keeps the limit approximately in force and
 * keeps the site up, and the log says which one answered.
 */
export async function consumeRateLimitAsync(
  key: string,
  policy: RateLimitPolicy
): Promise<RateLimitVerdict> {
  const store = state.store;
  if (!store) return consumeInMemory(key, policy);
  try {
    return await store.consume(key, policy);
  } catch (error) {
    console.error(
      `[ratelimit] the store "${store.name}" failed, so this request was counted in the local ` +
        "in-process bucket instead. Limits are per instance until it recovers.",
      error
    );
    return consumeInMemory(key, policy);
  }
}

/**
 * The bucket key for a request.
 *
 * The route name is part of the key so a reader who has used up their contact-form allowance can
 * still search — one shared bucket per address would make any single abused endpoint disable the whole
 * public API for that caller.
 *
 * ⚠ A request with no forwarded address falls into ONE SHARED bucket named `no-ip`. That is the
 * conservative direction (skipping the limit entirely would make the header's absence a bypass), and
 * it has a real cost: behind a proxy that does not set `X-Forwarded-For`, every visitor shares one
 * allowance and legitimate traffic is throttled. Setting that header at the proxy is part of deploying
 * this application.
 */
function bucketKey(request: Request, route: string): string {
  return `${route}:${clientIp(request) ?? "no-ip"}`;
}

export function checkRateLimit(
  request: Request,
  route: string,
  policy: RateLimitPolicy
): RateLimitVerdict {
  return consumeRateLimit(bucketKey(request, route), policy);
}

/** `checkRateLimit` through the registered store. Identical verdicts under the default store. */
export function checkRateLimitAsync(
  request: Request,
  route: string,
  policy: RateLimitPolicy
): Promise<RateLimitVerdict> {
  return consumeRateLimitAsync(bucketKey(request, route), policy);
}

/**
 * "in 45 seconds" / "in about 4 minutes" — the phrase that goes in the sentence.
 *
 * Rounded UP, always: a message that says "try again in 1 minute" when the answer is 61 seconds
 * teaches the reader that the number is a lie, and they retry into a second refusal.
 */
export function retryAfterPhrase(seconds: number): string {
  const safe = Math.max(1, Math.ceil(seconds));
  if (safe < 60) return `${safe} second${safe === 1 ? "" : "s"}`;
  const minutes = Math.ceil(safe / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * The 429.
 *
 * Built as a response rather than thrown as an `ApiError`, because `toErrorResponse` cannot attach a
 * header and `Retry-After` is the machine-readable half of this answer — a client that backs off
 * correctly needs it, and a client that shows the sentence needs the same number in words. The body is
 * the standard error shape, so `lib/client/fetcher.ts` renders `message` verbatim like any other
 * failure.
 *
 * `Cache-Control: no-store` matters more than it looks: a shared proxy that cached one visitor's 429
 * would serve it to everybody behind that proxy for its lifetime, turning a rate limit into an outage.
 */
export function rateLimitResponse(verdict: RateLimitVerdict, message?: string): NextResponse {
  const seconds = Math.max(1, Math.ceil(verdict.retryAfterSeconds));
  const sentence =
    message ??
    `Too many requests from this connection. Try again in ${retryAfterPhrase(seconds)}.`;

  const response = toErrorResponse(new ApiError(429, sentence, { code: "rate_limited" }));
  response.headers.set("Retry-After", String(seconds));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * The one-liner every route uses: `const limited = enforceRateLimit(...); if (limited) return limited;`
 *
 * Returns `null` when the request may proceed. Deliberately NOT a throw — a thrown `ApiError` would
 * lose the `Retry-After` header on its way through `route()`, and a limiter whose answer omits the
 * back-off interval leaves every client guessing.
 *
 * `message` should be a complete sentence about THIS endpoint. Pass `retryAfterPhrase(verdict.retryAfterSeconds)`
 * into it — see the call sites — so the wording and the header agree.
 *
 * ⚠ SYNCHRONOUS, AND THAT IS THE WHOLE REASON THIS FUNCTION STILL EXISTS in its original shape. It
 * cannot reach a network-backed store. Under the default in-memory store that costs nothing; once a
 * shared store is registered, this counts in the local bucket and warns. `enforceRateLimitAsync` is the
 * one to move to.
 */
export function enforceRateLimit(
  request: Request,
  route: string,
  policy: RateLimitPolicy,
  message?: (phrase: string) => string
): NextResponse | null {
  return verdictToResponse(checkRateLimit(request, route, policy), message);
}

/**
 * `enforceRateLimit` through the registered store: `const limited = await enforceRateLimitAsync(...)`.
 *
 * The identical contract — `null` means proceed — and identical verdicts under the default store, so a
 * route can switch to it before any shared store exists and see no change in behaviour. That is the
 * point: the migration is safe to do early and in pieces.
 */
export async function enforceRateLimitAsync(
  request: Request,
  route: string,
  policy: RateLimitPolicy,
  message?: (phrase: string) => string
): Promise<NextResponse | null> {
  return verdictToResponse(await checkRateLimitAsync(request, route, policy), message);
}

/** Shared by both entry points, so the sentence and the header can never differ between them. */
function verdictToResponse(
  verdict: RateLimitVerdict,
  message?: (phrase: string) => string
): NextResponse | null {
  if (verdict.ok) return null;
  const phrase = retryAfterPhrase(verdict.retryAfterSeconds);
  return rateLimitResponse(verdict, message ? message(phrase) : undefined);
}
