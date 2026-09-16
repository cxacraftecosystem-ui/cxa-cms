import "server-only";
import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { recordAccess } from "@/lib/requestLog";

/**
 * Route-handler plumbing: one error shape, one success shape, one place that turns a thrown thing
 * into a response.
 *
 * The shape is fixed because the browser client (lib/client/fetcher.ts) parses it. The Field
 * Repository learned this the hard way (skill §12.11): FastAPI's 422 body is a LIST, and a client
 * that did `String(detail)` printed "[object Object]" to users for months. So:
 *
 *   • `message` is ALWAYS a plain human sentence, ready to render verbatim.
 *   • `fieldErrors` is the machine-readable half, keyed by form field path.
 *   • Nothing else is required to render an error.
 */

export interface ApiErrorBody {
  error: true;
  message: string;
  code: string;
  fieldErrors?: Record<string, string[]>;
  /** Present only in development — a stack in production tells an attacker about the deployment. */
  detail?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(
    status: number,
    message: string,
    options: { code?: string; fieldErrors?: Record<string, string[]>; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.status = status;
    this.code = options.code ?? defaultCodeForStatus(status);
    this.fieldErrors = options.fieldErrors;
  }
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "too_large";
    case 422:
      return "validation_failed";
    case 429:
      return "rate_limited";
    case 503:
      return "unavailable";
    default:
      return status >= 500 ? "server_error" : "error";
  }
}

export const unauthorized = (message = "Please sign in to continue.") =>
  new ApiError(401, message, { code: "unauthenticated" });

export const forbidden = (message = "You do not have access to this.") =>
  new ApiError(403, message, { code: "forbidden" });

export const notFound = (what = "That item") =>
  new ApiError(404, `${what} could not be found. It may have been deleted.`, { code: "not_found" });

export const conflict = (message: string) => new ApiError(409, message, { code: "conflict" });

export const badRequest = (message: string) => new ApiError(400, message, { code: "bad_request" });

/**
 * Turn anything thrown inside a route handler into a response.
 *
 * A non-`ApiError` is a BUG, so it becomes a generic 500 and the real message goes to the server log
 * only. Echoing an unexpected error's message to the client leaks table names, file paths and
 * occasionally credentials from a driver's connection-error string.
 */
export function toErrorResponse(error: unknown): NextResponse<ApiErrorBody> {
  if (error instanceof ApiError) {
    const body: ApiErrorBody = { error: true, message: error.message, code: error.code };
    if (error.fieldErrors) body.fieldErrors = error.fieldErrors;
    return NextResponse.json(body, { status: error.status });
  }

  if (error instanceof ZodError) {
    const { message, fieldErrors } = describeZodError(error);
    return NextResponse.json(
      { error: true, message, code: "validation_failed", fieldErrors },
      { status: 422 }
    );
  }

  console.error("[api] unhandled error", error);
  const body: ApiErrorBody = {
    error: true,
    message: "Something went wrong on our side. The change was not saved.",
    code: "server_error"
  };
  if (process.env.NODE_ENV !== "production") {
    body.detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  }
  return NextResponse.json(body, { status: 500 });
}

/**
 * A Zod failure as one readable sentence plus per-field messages.
 *
 * The sentence NAMES THE FIRST FIELD rather than saying "validation failed": a banner that does not
 * say which box is wrong sends the reader hunting through a twenty-field form.
 */
export function describeZodError(error: ZodError): {
  message: string;
  fieldErrors: Record<string, string[]>;
} {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "_form";
    (fieldErrors[path] ??= []).push(issue.message);
  }
  const first = error.issues[0];
  const firstPath = first && first.path.length > 0 ? first.path.join(" → ") : null;
  const message = first
    ? firstPath
      ? `${firstPath}: ${first.message}`
      : first.message
    : "Some of the values could not be saved.";
  const extra = error.issues.length - 1;
  return {
    message: extra > 0 ? `${message} (and ${extra} other problem${extra === 1 ? "" : "s"})` : message,
    fieldErrors
  };
}

/**
 * The `Request` Next passed, if there is one.
 *
 * DUCK-TYPED RATHER THAN `instanceof Request`, and the difference is not pedantry: `instanceof` is
 * identity against one class object, and a runtime that ends up with two copies of the WHATWG fetch
 * classes — a polyfill loaded beside the built-in, a bundler resolving `undici` twice — answers false
 * for a perfectly good request. The failure would be silent and total: every row would simply stop
 * being written, with nothing in any log to say why.
 *
 * It returns null rather than throwing for the handlers declared with no parameters at all
 * (`route(async () => …)` — app/api/auth/me, app/api/public/stats, app/api/studio/account). Next passes
 * the request to those too, so they are logged like any other; the null branch is for a caller that is
 * not Next.
 */
function requestFrom(args: unknown[]): Request | null {
  const candidate = args[0];
  if (!candidate || typeof candidate !== "object") return null;
  const maybe = candidate as { url?: unknown; method?: unknown; headers?: { get?: unknown } };
  if (typeof maybe.url !== "string" || typeof maybe.method !== "string") return null;
  if (!maybe.headers || typeof maybe.headers.get !== "function") return null;
  return candidate as Request;
}

/**
 * The `ApiErrorBody.code` that went out with this response, for the access log.
 *
 * Read off the ERROR where there was one, because that is the authoritative answer — an `ApiError`
 * carries a code chosen by the call site (`write_failed`, `bad_object_key`, `token_expired`) that no
 * amount of staring at a status can recover.
 *
 * Where there was no throw and the status is still a refusal, the status is all there is. That case is
 * real and it is the important one: `enforceRateLimit` in lib/ratelimit.ts RETURNS its 429 rather than
 * throwing it, so a credential-stuffing sweep arrives here as a returned response with no error
 * object. `defaultCodeForStatus` gives it "rate_limited", which is the same string the body carries.
 *
 * ⚠ THE RESPONSE BODY IS NEVER READ TO FIND OUT. A `NextResponse` body is a stream and reading it here
 * would consume it, so the caller would receive an empty response — a logging change that broke every
 * API call in the application.
 */
function errorCodeFor(error: unknown, status: number): string | null {
  if (status < 400) return null;
  if (error instanceof ApiError) return error.code;
  if (error instanceof ZodError) return "validation_failed";
  if (error) return "server_error";
  return defaultCodeForStatus(status);
}

/**
 * Wrap a route handler so every throw becomes a well-formed response — AND so every request to the
 * protected surface leaves a row in `access_logs`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE LOGGING IS HERE AND NOWHERE ELSE. This function is a genuine chokepoint: all 91 route files
 * under `app/api/studio` call it, so do the eight under `app/api/auth`, and so does every public and
 * cron route. One edit covers 168 exported HTTP methods, and a route added next year is covered the
 * moment it is written, because writing it without `route()` is not something anybody does here.
 *
 * The alternatives were considered and rejected:
 *
 *   • MIDDLEWARE cannot do it. It runs on the Edge, where Prisma does not run at all — see the header
 *     of middleware.ts. Logging from there means an HTTP call to something that can write, which is an
 *     extra function invocation per request on a plan that counts them, and a self-inflicted
 *     amplification vector the moment somebody floods `/api/studio/*` while signed out.
 *   • A `app/studio/**` LAYOUT would log page renders, but Next prefetches studio links on hover, so
 *     every hovered link would become a logged "view" — and a screen render changes nothing anyway.
 *     Every studio state change already passes through here.
 *
 * ⚠ THE COST IS ONE INSERT, DEFERRED. `recordAccess` hands the write to `after()`, so the reader waits
 * for the handler and not for the log; it is not a subrequest, and it never throws — see the long note
 * at the top of lib/requestLog.ts. This function's promise to its 113 callers is that it returns a
 * response, and nothing added here may weaken that.
 *
 * ⚠ IT IS NOT A SECOND AUDIT TRAIL AND MUST NOT BECOME ONE. Nothing here writes an `AuditLog` row. A
 * mutation that already writes one through lib/audit.ts gets exactly the row it always got, in the
 * same transaction, plus a transport record in a different table with different columns. The two are
 * correlated on `(actorId, path, at)`, never deduplicated: suppressing the access row for audited
 * requests would delete precisely the record that separates "the usual editor saved from the usual
 * address" from "the same account, from an address it has never used".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse> | NextResponse
) {
  return async (...args: Args): Promise<NextResponse> => {
    const startedAt = Date.now();
    let response: NextResponse;
    let thrown: unknown = null;

    try {
      response = await handler(...args);
    } catch (error) {
      thrown = error;
      response = toErrorResponse(error);
    }

    // Both branches, deliberately. A log that only records the requests that succeeded answers the one
    // question nobody has to ask.
    //
    // ⚠ THE STATUS IS CHECKED FOR EXISTENCE EVEN THOUGH IT CANNOT BE ABSENT. `response` is typed
    // `NextResponse` and all 113 call sites typecheck, so it always has one. The guard is here because
    // everything below this line runs AFTER the handler has already succeeded: a `TypeError` thrown
    // while logging would convert a save that completed into a 500, for a reason that has nothing to do
    // with the save, and this function's single promise to its callers is that it returns a response.
    const request = requestFrom(args);
    if (request && typeof response?.status === "number") {
      recordAccess({
        request,
        status: response.status,
        errorCode: errorCodeFor(thrown, response.status),
        startedAt,
        // `clientIp` and `userAgent` are the ones directly below, the same two `buildAuditContext`
        // uses — so an access row and an audit row for the same request cannot disagree about where it
        // came from.
        ipAddress: clientIp(request),
        userAgent: userAgent(request)
      });
    }

    return response;
  };
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, init);
}

/** 204. Deliberately body-less — a client that reads JSON from it gets `undefined`, never a lie. */
export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/**
 * Parse and validate a JSON body.
 *
 * A malformed body produces a 400 with a sentence, not a 500 — the request never reached the
 * handler's logic, so calling it a server error would send an operator looking in the wrong place.
 */
export async function parseJson<T>(request: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest("The request body was not valid JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const { message, fieldErrors } = describeZodError(result.error);
    throw new ApiError(422, message, { code: "validation_failed", fieldErrors });
  }
  return result.data;
}

/** Parse `?a=1&b=2` against a schema. Repeated keys collapse to the LAST value, matching URLSearchParams.get. */
export function parseQuery<T>(request: Request, schema: ZodSchema<T>): T {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string> = {};
  params.forEach((value, key) => {
    raw[key] = value;
  });
  const result = schema.safeParse(raw);
  if (!result.success) {
    const { message, fieldErrors } = describeZodError(result.error);
    throw new ApiError(422, message, { code: "validation_failed", fieldErrors });
  }
  return result.data;
}

/**
 * Defence in depth against CSRF, on top of `SameSite=Lax`.
 *
 * Lax already withholds the session cookies from a cross-site POST, so this should never fire. It
 * exists because "should never fire" and "cannot fire" are different claims: a future cookie change,
 * a proxy that rewrites SameSite, or a browser bug all turn the first into the second.
 *
 * A request with NO Origin header is allowed: same-origin GETs and some server-to-server callers
 * omit it entirely, and refusing those breaks legitimate traffic to stop an attack that requires an
 * Origin to be present.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const origin = request.headers.get("origin");
  if (!origin) return;

  let requestHost: string;
  try {
    requestHost = new URL(request.url).host;
  } catch {
    throw badRequest("The request URL could not be read.");
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden("This request was blocked because its origin could not be read.");
  }

  // Compare against the forwarded host when behind a proxy — `request.url`'s host is the internal
  // one there, and comparing to it would reject every legitimate request in production.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const allowed = new Set([requestHost, forwardedHost].filter(Boolean) as string[]);

  if (!allowed.has(originHost)) {
    throw forbidden("This request was blocked because it came from another site.");
  }
}

/**
 * The client's IP, best effort.
 *
 * Reads the LEFTMOST entry of `x-forwarded-for`, which is the original client when the header is set
 * by a trusted proxy and spoofable when it is not. Used only for rate-limit buckets and audit
 * context — never for an authorisation decision, because a value a client can set is not an
 * identity.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? null;
}

export function userAgent(request: Request): string | null {
  return request.headers.get("user-agent");
}
