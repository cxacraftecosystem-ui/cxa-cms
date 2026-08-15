import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * "Continue with Google / Microsoft / Yahoo" — OpenID Connect, one implementation for all three.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES AND DOES NOT DECIDE.
 *
 * A provider answers exactly one question: **who is this?** It never answers "should they be here?" —
 * that is `lib/auth/access.ts`, and the callback consults it before any account is created. Skipping
 * that step is how a CMS acquires a "Continue with Google" button that lets in the entire internet.
 *
 * FIVE THINGS THAT ARE NOT OPTIONAL, each of which is a real attack when omitted:
 *
 *  1. **The ID token's signature is verified against the provider's JWKS**, with the issuer and the
 *     audience pinned. Reading the claims without verifying is the whole vulnerability: the token
 *     arrives in a response the browser can see, and an unverified one is a value the caller chose.
 *  2. **`state` is compared in constant time** against a cookie set before the redirect. Without it,
 *     an attacker completes their own sign-in in your browser (login CSRF) and you edit the site as
 *     them, or they capture a code issued for you.
 *  3. **PKCE** on every provider, not only the ones that demand it. The `code` travels through a
 *     redirect and lands in browser history and in server logs; without the verifier, a code lifted
 *     from either is exchangeable.
 *  4. **`nonce` is bound into the ID token** and checked, which is what stops a token minted for a
 *     different session being replayed into this one.
 *  5. **`email_verified` must be true.** Several providers will happily assert an unverified address,
 *     and an allow-list keyed on email is worth nothing if somebody can claim an address they do not
 *     own. Microsoft is the awkward one — see `emailIsVerified`.
 *
 * ⚠ ACCOUNTS ARE FOUND BY `sub`, NEVER BY EMAIL. An email is reassignable inside an organisation; the
 * provider's subject identifier is not. Email is used ONCE, at first link, to match an invitation.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const OAUTH_PROVIDERS = ["GOOGLE", "MICROSOFT", "YAHOO"] as const;
export type OAuthProviderName = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProviderName {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/** The slug used in URLs — lower case, because a path segment should not shout. */
export function providerSlug(provider: OAuthProviderName): string {
  return provider.toLowerCase();
}

export function providerFromSlug(slug: string): OAuthProviderName | null {
  const upper = slug.toUpperCase();
  return isOAuthProvider(upper) ? upper : null;
}

export interface ProviderConfig {
  provider: OAuthProviderName;
  label: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  /** Accepted `iss` values. Microsoft's varies by tenant, hence a list rather than a string. */
  issuers: string[];
  scope: string;
}

function read(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Microsoft's tenant.
 *
 * `common` accepts any Microsoft account, personal ones included — which is right for a public sign-in
 * and wrong for an institution that means "our staff". A deployment that sets `MICROSOFT_TENANT_ID` to
 * its directory id gets the narrower door. The allow-list is the real gate either way, so `common` is a
 * safe default rather than a permissive one.
 */
function microsoftTenant(): string {
  return read("MICROSOFT_TENANT_ID") ?? "common";
}

/**
 * The configuration for one provider, or null when it has not been set up.
 *
 * NULL RATHER THAN A THROW, because an unconfigured provider is a normal state — most deployments will
 * enable one or two — and the sign-in page renders only the buttons that can actually work. A button
 * that leads to a crash is worse than no button.
 */
export function providerConfig(provider: OAuthProviderName): ProviderConfig | null {
  const clientId = read(`${provider}_CLIENT_ID`);
  const clientSecret = read(`${provider}_CLIENT_SECRET`);
  if (!clientId || !clientSecret) return null;

  switch (provider) {
    case "GOOGLE":
      return {
        provider,
        label: "Google",
        clientId,
        clientSecret,
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
        // Google issues both spellings and has done for years; accepting one only is a sporadic failure.
        issuers: ["https://accounts.google.com", "accounts.google.com"],
        scope: "openid email profile"
      };
    case "MICROSOFT": {
      const tenant = microsoftTenant();
      return {
        provider,
        label: "Microsoft",
        clientId,
        clientSecret,
        authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        jwksUrl: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
        /**
         * ⚠ WITH `common`, THE ISSUER IS PER-TENANT and cannot be known in advance — the token says
         * `https://login.microsoftonline.com/<the signer's tenant guid>/v2.0`. An empty list here means
         * "do not pin", and `verifyIdToken` then applies a PATTERN check instead. Pinning is restored
         * the moment a deployment names its tenant, which is the configuration an institution wants.
         */
        issuers:
          tenant === "common" || tenant === "organizations" || tenant === "consumers"
            ? []
            : [`https://login.microsoftonline.com/${tenant}/v2.0`],
        scope: "openid email profile"
      };
    }
    case "YAHOO":
      return {
        provider,
        label: "Yahoo",
        clientId,
        clientSecret,
        authorizeUrl: "https://api.login.yahoo.com/oauth2/request_auth",
        tokenUrl: "https://api.login.yahoo.com/oauth2/get_token",
        jwksUrl: "https://api.login.yahoo.com/openid/v1/certs",
        issuers: ["https://api.login.yahoo.com"],
        scope: "openid email profile"
      };
  }
}

/** Every provider that is actually usable, for the sign-in page. */
export function configuredProviders(): { provider: OAuthProviderName; label: string }[] {
  return OAUTH_PROVIDERS.map((provider) => providerConfig(provider))
    .filter((config): config is ProviderConfig => config !== null)
    .map((config) => ({ provider: config.provider, label: config.label }));
}

export function redirectUri(provider: OAuthProviderName, origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/auth/oauth/${providerSlug(provider)}/callback`;
}

// ── The handshake values ────────────────────────────────────────────────────

export interface Handshake {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * PKCE and the two anti-replay values.
 *
 * 32 bytes each. The verifier is base64url of raw entropy — NOT a hash of something guessable — and the
 * challenge is its SHA-256, which is the only transformation `S256` permits.
 */
export function createHandshake(): Handshake {
  const codeVerifier = randomBytes(32).toString("base64url");
  return {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url")
  };
}

/** Constant-time comparison for `state`. A `===` here is a timing oracle on a CSRF token. */
export function statesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function authorizeUrl(input: {
  config: ProviderConfig;
  origin: string;
  handshake: Handshake;
}): string {
  const url = new URL(input.config.authorizeUrl);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", redirectUri(input.config.provider, input.origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.config.scope);
  url.searchParams.set("state", input.handshake.state);
  url.searchParams.set("nonce", input.handshake.nonce);
  url.searchParams.set("code_challenge", input.handshake.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Ask for an account chooser rather than silently reusing whichever account the browser last used —
  // on a shared machine that is how somebody edits the site as a colleague without noticing.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Exchange the authorisation code for tokens.
 *
 * The client secret goes in the BODY rather than in a Basic header: every one of these three accepts
 * it there, and Yahoo has historically been particular about the header form. The verifier is what
 * proves this exchange belongs to the browser that started the handshake.
 */
export async function exchangeCode(input: {
  config: ProviderConfig;
  code: string;
  origin: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: redirectUri(input.config.provider, input.origin),
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code_verifier: input.codeVerifier
  });

  const response = await fetch(input.config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    // A hung provider must not hold a request open indefinitely.
    signal: AbortSignal.timeout(15_000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${input.config.label} refused the code exchange (${response.status}). ${detail.slice(0, 300)}`
    );
  }

  return (await response.json()) as TokenResponse;
}

// JWKS clients are cached per provider: each holds its own fetch cache and rotation schedule, and
// building one per request re-fetches the key set on every sign-in.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(config: ProviderConfig) {
  const existing = jwksCache.get(config.jwksUrl);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(config.jwksUrl));
  jwksCache.set(config.jwksUrl, created);
  return created;
}

export interface VerifiedIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Verify the ID token and pull out the identity.
 *
 * `audience` is pinned to our own client id — a token minted for a DIFFERENT application, signed by the
 * same provider with the same keys, is otherwise perfectly valid. That is the confused-deputy attack,
 * and the audience check is the whole of the defence.
 */
export async function verifyIdToken(input: {
  config: ProviderConfig;
  idToken: string;
  nonce: string;
}): Promise<VerifiedIdentity> {
  const { payload } = await jwtVerify(input.idToken, jwks(input.config), {
    audience: input.config.clientId,
    ...(input.config.issuers.length > 0 ? { issuer: input.config.issuers } : {}),
    clockTolerance: 60
  });

  // With Microsoft's `common` tenant the issuer is per-tenant and cannot be listed, so it is checked by
  // SHAPE instead. Accepting anything at all would let a token from an unrelated issuer through.
  if (input.config.issuers.length === 0) {
    const issuer = String(payload.iss ?? "");
    const shape = /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i;
    if (!shape.test(issuer)) {
      throw new Error(`Unexpected issuer for ${input.config.label}: ${issuer}`);
    }
  }

  if (typeof payload.nonce !== "string" || !statesMatch(payload.nonce, input.nonce)) {
    throw new Error("The sign-in could not be matched to the request that started it.");
  }

  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (!subject) throw new Error("The provider did not identify the account.");

  const email = readEmail(payload);
  if (!email) throw new Error("The provider did not supply an email address.");

  return {
    subject,
    email,
    emailVerified: emailIsVerified(input.config.provider, payload),
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null
  };
}

function readEmail(payload: Record<string, unknown>): string | null {
  const direct = payload.email;
  if (typeof direct === "string" && direct.includes("@")) return direct.trim().toLowerCase();
  // Microsoft frequently omits `email` and supplies `preferred_username`, which for a work account is
  // the address. It is only trusted when it looks like one.
  const preferred = payload.preferred_username;
  if (typeof preferred === "string" && preferred.includes("@")) return preferred.trim().toLowerCase();
  return null;
}

/**
 * Is the address one the provider has actually confirmed?
 *
 * Google and Yahoo say so with `email_verified`, and a missing or false claim is treated as unverified.
 *
 * ⚠ MICROSOFT DOES NOT SEND `email_verified` AT ALL, and that is not an oversight to work around by
 * assuming true. Its `xms_edov` claim ("email domain owner verified") is the real signal, and it is only
 * emitted when the application has opted in. So: trust `xms_edov` when present; otherwise trust a WORK
 * account, whose address is issued by a directory the organisation controls, and refuse a personal one
 * — `tid` equal to the well-known consumer tenant — because a personal Microsoft account can be created
 * with an arbitrary address and the allow-list is keyed on the address.
 */
function emailIsVerified(provider: OAuthProviderName, payload: Record<string, unknown>): boolean {
  if (provider !== "MICROSOFT") return payload.email_verified === true;

  if (typeof payload.xms_edov === "boolean") return payload.xms_edov;
  if (payload.xms_edov === "1" || payload.xms_edov === 1) return true;

  const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const tenant = typeof payload.tid === "string" ? payload.tid.toLowerCase() : "";
  return tenant.length > 0 && tenant !== CONSUMER_TENANT;
}
