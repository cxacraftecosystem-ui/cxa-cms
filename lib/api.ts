import "server-only";
import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";

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

/** Wrap a route handler so every throw becomes a well-formed response. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse> | NextResponse
) {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (error) {
      return toErrorResponse(error);
    }
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
