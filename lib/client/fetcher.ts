/**
 * The browser's half of the API contract in `lib/api.ts`.
 *
 * Server Components read the database directly (contract §9); this module exists for the handful of
 * INTERACTIVE studio screens — list filters, autosave, uploads, drag-reorder — that have to talk
 * over HTTP because they are reacting to a click rather than to a navigation.
 *
 * It is deliberately the ONLY place in the client that knows:
 *
 *   • that the error body is `{ error, message, code, fieldErrors? }` and that `message` is already
 *     a human sentence — so nothing downstream ever has to invent one, and nothing downstream ever
 *     prints "[object Object]";
 *   • how a 401 is recovered from. See THE 401 RETRY below; getting this wrong signs people out.
 *
 * Browser-only. It is not marked `"use client"` so that pure helpers such as `buildQuery` remain
 * importable from server code, but every function that touches `fetch` refuses to run without a
 * `window` rather than failing later with "Failed to parse URL from /api/…".
 */

/** Refresh-token exchange. Called at most once per burst — see `refreshOnce`. */
const REFRESH_PATH = "/api/auth/refresh";

/** Where a reader lands when the session is genuinely gone. */
const LOGIN_PATH = "/studio/login";

/**
 * Endpoints for which 401 is a LEGITIMATE ANSWER rather than an expired access token.
 *
 * A wrong password on the login form answers 401. Without this list that 401 would trigger a
 * pointless refresh, fail, and then hard-navigate the browser to `/studio/login?next=/studio/login`
 * — throwing away the typed password and the error message that explained the problem.
 * Any other endpoint that owns its own 401 can opt out per-call with `retryUnauthorized: false`.
 */
const NO_REFRESH_PATHS: readonly string[] = [
  "/api/auth/login",
  "/api/auth/logout",
  REFRESH_PATH
];

export interface ApiClientErrorOptions {
  code?: string;
  fieldErrors?: Record<string, string[]>;
  cause?: unknown;
}

/**
 * Every failure this module produces, successful HTTP or not.
 *
 * `message` is the server's `message` VERBATIM. `lib/api.ts` guarantees it is a plain sentence ready
 * to render, so a component may put it straight on screen; re-wording it here would only make the
 * two halves of the product disagree about what happened.
 *
 * `status` is 0 when there was never a response at all — a dropped connection, a DNS failure, a
 * browser that refused the request. That is a different situation from any HTTP status and callers
 * that need to tell "offline" from "refused" can check for it.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(status: number, message: string, options: ApiClientErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ApiClientError";
    this.status = status;
    this.code = options.code ?? "error";
    this.fieldErrors = options.fieldErrors;
  }
}

/**
 * Normalise anything caught into an `ApiClientError`, so a `catch` block has one type to reason
 * about and no `unknown` leaks into component state.
 *
 * An unexpected `Error` keeps its stack on `cause` but does NOT keep its message: "Cannot read
 * properties of undefined" is a fact about our code, not something to show an editor mid-save.
 */
export function asApiClientError(thrown: unknown): ApiClientError {
  if (thrown instanceof ApiClientError) return thrown;
  return new ApiClientError(0, "Something went wrong on this page. Reload it and try again.", {
    code: "unexpected",
    cause: thrown
  });
}

/**
 * `RequestInit`, except `body` may be any JSON-serialisable value.
 *
 * `signal` passes straight through, so a caller that wants a real abort (contract §9) can supply
 * one. Note that an aborted fetch arrives here as a network failure with status 0.
 */
export interface ApiRequestInit extends Omit<RequestInit, "body"> {
  /**
   * A `string`, `FormData`, `Blob`, `URLSearchParams`, buffer or stream is sent untouched; anything
   * else is `JSON.stringify`-ed and given a JSON content type. A raw `string` is therefore sent as
   * text, matching plain `fetch` — pass an object if you want JSON.
   */
  body?: unknown;
  /** Set false where a 401 means "these credentials are wrong", not "this token expired". */
  retryUnauthorized?: boolean;
}

type JsonParse = { ok: true; value: unknown } | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bodies the platform can send as they are. Guarded with `typeof` so this module stays importable in Node. */
function isRawBody(value: unknown): value is BodyInit {
  if (typeof value === "string") return true;
  if (typeof FormData !== "undefined" && value instanceof FormData) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) return true;
  if (typeof ArrayBuffer !== "undefined" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) {
    return true;
  }
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) return true;
  return false;
}

function parseJsonSafely(raw: string): JsonParse {
  if (raw.length === 0) return { ok: false };
  try {
    const value: unknown = JSON.parse(raw);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * `fieldErrors` from a body we did not write. Validated rather than cast: a form attaches these to
 * controls, and a non-array value there would render as "[object Object]" under an input.
 */
function readFieldErrors(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) continue;
    const messages = raw.filter((entry): entry is string => typeof entry === "string");
    if (messages.length > 0) out[key] = messages;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The fallback sentence for a response that carried no usable `message` — an HTML error page from a
 * proxy, a gateway timeout, a body that never arrived.
 *
 * It NAMES THE STATUS. "Something went wrong" with no number sends an operator hunting through
 * three layers; "HTTP 502" tells them immediately that the request never reached the application.
 */
function statusSentence(status: number): string {
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "You do not have access to this.";
  if (status === 404) return "That address does not exist on the server (HTTP 404).";
  if (status === 413) return "That upload is larger than the server accepts.";
  if (status === 429) return "Too many requests in a short time. Wait a moment and try again.";
  if (status >= 500) {
    return `The server ran into a problem and did not answer properly (HTTP ${status}). Try again in a moment.`;
  }
  if (status >= 400) return `The server refused that request (HTTP ${status}).`;
  return `The server replied with something this page could not read (HTTP ${status}).`;
}

function errorFromResponse(status: number, parsed: JsonParse): ApiClientError {
  if (parsed.ok && isRecord(parsed.value)) {
    const payload = parsed.value;
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (message.length > 0) {
      const code = typeof payload.code === "string" && payload.code.length > 0 ? payload.code : undefined;
      return new ApiClientError(status, message, {
        code,
        fieldErrors: readFieldErrors(payload.fieldErrors)
      });
    }
  }
  // Either not JSON at all, or JSON without a message. Both mean the response did not come from
  // `lib/api.ts`, so there is nothing to render verbatim and we say what we do know.
  return new ApiClientError(status, statusSentence(status), { code: "malformed_response" });
}

/**
 * THE SHARED REFRESH.
 *
 * A studio screen commonly has four or five requests in flight at once — a list, a count, the
 * settings, an autosave. When the access token expires they all 401 within a few milliseconds. Ten
 * concurrent rotations of ONE refresh token is exactly the pattern `lib/auth/session.ts` treats as
 * theft: the first rotation marks the row `rotatedTo`, the second presents the now-rotated token,
 * and the reuse detector revokes the whole family and signs the user out of every device.
 *
 * So the promise is MODULE-LEVEL and shared. Ten 401s join one refresh.
 *
 * It is cleared only when this attempt settles and only if it is still the current one, so a later
 * burst gets a fresh refresh instead of the stale answer to an old one, and an attempt started in
 * the gap is not wiped by an older attempt's cleanup.
 */
let refreshInFlight: Promise<boolean> | null = null;

function refreshOnce(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  const attempt = (async (): Promise<boolean> => {
    try {
      // Deliberately plain `fetch`, not `apiFetch`: a 401 from the refresh endpoint must not
      // recurse into another refresh.
      const response = await fetch(REFRESH_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" }
      });
      if (response.ok) return true;

      /**
       * ⚠ A LOST REFRESH RACE COUNTS AS SUCCESS, BECAUSE THE COOKIES ARE ALREADY GOOD.
       *
       * The promise above dedupes concurrent refreshes within THIS tab, and that is all it can do: a
       * second tab has its own copy of this module, and middleware refreshes a page navigation without
       * coming through here at all. So one browser really does present the same refresh token twice, and
       * the server now answers the loser with 409 `refresh_raced` instead of tearing the session down
       * (lib/auth/session.ts, ROTATION_GRACE_MS).
       *
       * The winner's `Set-Cookie` has landed by the time that 409 arrives, so retrying the original
       * request is exactly the right move — and reporting failure here was the last step of the old
       * behaviour, which redirected the editor to the login screen with a perfectly good session in the
       * cookie jar.
       */
      if (response.status === 409) {
        const body: unknown = await response.json().catch(() => null);
        if (isRecord(body) && body.code === "refresh_raced") return true;
      }
      return false;
    } catch {
      // The network died mid-refresh. Reported as failure so the caller stops, but see
      // `request()`: a network failure is never treated as "you are signed out".
      return false;
    }
  })();

  refreshInFlight = attempt;
  void attempt.finally(() => {
    if (refreshInFlight === attempt) refreshInFlight = null;
  });
  return attempt;
}

/**
 * One redirect per page life, whatever happens.
 *
 * Without the flag, five simultaneous unrecoverable 401s call `assign` five times; and a redirect
 * fired while already on the login screen would reload it, discarding whatever the reader had typed.
 */
let redirecting = false;

function redirectToLogin(): void {
  if (typeof window === "undefined" || redirecting) return;
  if (window.location.pathname.startsWith(LOGIN_PATH)) return;
  redirecting = true;
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  // A full navigation rather than a router push: the session is gone, so every cached RSC payload
  // on this page was rendered for someone who is no longer signed in.
  window.location.assign(`${LOGIN_PATH}?next=${encodeURIComponent(next)}`);
}

function mayAttemptRefresh(path: string, init: ApiRequestInit): boolean {
  if (init.retryUnauthorized === false) return false;
  const pathname = path.split("?")[0] ?? path;
  return !NO_REFRESH_PATHS.includes(pathname);
}

function buildInit(init: ApiRequestInit): RequestInit {
  const { body, retryUnauthorized: _retryUnauthorized, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");

  const requestInit: RequestInit = {
    ...rest,
    headers,
    // Forced, not defaulted: the session cookies are the whole point, and a caller that passed
    // "omit" by accident would get an unexplainable 401 on every request.
    credentials: "same-origin",
    // The studio must never read a list from the HTTP cache — a saved row that reappears with its
    // old title reads as a lost save. A caller may still override this deliberately.
    cache: rest.cache ?? "no-store"
  };

  if (body !== undefined) {
    if (body === null || isRawBody(body)) {
      requestInit.body = body;
    } else {
      requestInit.body = JSON.stringify(body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  return requestInit;
}

/**
 * `allowRetry` is false on the replay, so the 401 path can run at most once per call. The init is
 * rebuilt from the caller's values on each attempt rather than reusing a `Request` object, because a
 * `Request` body is consumed by the first send. (A `ReadableStream` body still cannot be replayed —
 * nothing in the studio streams a request body, and this is why.)
 */
async function request<T>(path: string, init: ApiRequestInit, allowRetry: boolean): Promise<T> {
  if (typeof window === "undefined") {
    throw new ApiClientError(0, "This data can only be loaded in the browser.", {
      code: "not_in_browser"
    });
  }

  let response: Response;
  try {
    response = await fetch(path, buildInit(init));
  } catch (cause) {
    // "The server is unreachable" and "you are signed out" are different claims. Nothing is
    // cleared, no refresh is attempted and no redirect fires: treating a dropped Wi-Fi connection
    // as a sign-out throws away whatever the editor had not saved.
    throw new ApiClientError(
      0,
      "The server could not be reached. Check your connection and try again — nothing on this screen has been discarded.",
      { code: "network", cause }
    );
  }

  if (response.status === 401 && allowRetry && mayAttemptRefresh(path, init)) {
    const refreshed = await refreshOnce();
    if (refreshed) return request<T>(path, init, false);
    // The refresh failed too, so the session really is over.
    redirectToLogin();
    // Fall through: the original 401's message is still the most accurate thing to throw, and the
    // navigation above takes a moment during which a component may still render.
  }

  // A 403 is never retried. Refreshing changes who the server thinks you are only in the sense of
  // "still signed in" — the role that refused this action will refuse it again, and a retry loop
  // against a permission check is just noise in the audit log. Same for a 5xx.

  // 204/205 are body-less by contract (`noContent()` in lib/api.ts).
  if (response.status === 204 || response.status === 205) return undefined as T;

  const raw = await response.text();
  const parsed = parseJsonSafely(raw);

  if (!response.ok) throw errorFromResponse(response.status, parsed);

  // A 200 with an empty body is the same promise as a 204 and is treated as one.
  if (raw.length === 0) return undefined as T;

  if (!parsed.ok) {
    // An HTML error page, a proxy notice, a truncated stream. Casting that text to T would push a
    // string into a component expecting a list and produce a crash far from the cause.
    throw new ApiClientError(
      response.status,
      `The server replied with something other than JSON (HTTP ${response.status}). The request may have reached the wrong address.`,
      { code: "malformed_response" }
    );
  }

  return parsed.value as T;
}

/**
 * Fetch JSON from a same-origin API route.
 *
 * Throws `ApiClientError` for every failure — HTTP or network — so a caller has exactly one shape
 * to catch. A 204 resolves to `undefined`.
 */
export function apiFetch<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return request<T>(path, init ?? {}, true);
}

/**
 * Build `?a=1&b=2` from a params object, or `""` when nothing survives.
 *
 * Drops `undefined`, `null` AND the empty string, so a cleared search box and an untouched one
 * produce the same URL — which is what keeps `useResource`'s key stable and stops a cleared filter
 * from issuing a request that differs from the unfiltered one only in noise.
 *
 * ⚠ THE CONSEQUENCE: an intentionally-empty value cannot be sent. A filter meaning "records with no
 * category" must use a reserved word — `category=none` — and the route handler must map it. Sending
 * `category=` would be indistinguishable from not filtering at all.
 *
 * Non-finite numbers are dropped for the same reason: `?page=NaN` is always a bug upstream, and the
 * server's default page is a better answer than a 422 about a value the reader never typed.
 */
export function buildQuery(
  params: Record<string, string | number | boolean | undefined | null>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      if (value === "") continue;
      search.set(key, value);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      search.set(key, String(value));
      continue;
    }
    search.set(key, value ? "true" : "false");
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : "";
}

export function get<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "GET" });
}

export function post<T>(path: string, body?: unknown, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "POST", body });
}

export function patch<T>(path: string, body?: unknown, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "PATCH", body });
}

/** Named `del` because `delete` is reserved. A DELETE that needs a body passes it through `init`. */
export function del<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "DELETE" });
}
