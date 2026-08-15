import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { currentUser } from "@/lib/auth/current-user";
import { configuredProviders, providerSlug, type OAuthProviderName } from "@/lib/auth/oauth";
import { signInNoticeMessage } from "@/lib/auth/oauth-cookies";
import { getSettingCached } from "@/lib/settings/service";
import { LoginForm, type LoginProvider, type ProviderMark } from "./LoginForm";

/**
 * The studio sign-in screen.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS ITS OWN WHOLE PAGE, WITH NO STUDIO CHROME. `app/studio/layout.tsx` renders its children bare
 * when there is no user precisely so this screen can exist: a sign-in form wrapped in a sidebar that
 * needs a signed-in user to build is a circular dependency, and the redirect that would normally guard
 * the segment would send this page to itself.
 *
 * A SIGNED-IN READER IS SENT ONWARD, NOT SHOWN THE FORM. Landing on a sign-in page while already
 * signed in reads as "the session broke" — and the reader's next move is usually to sign in again,
 * which rotates a session that was perfectly healthy.
 *
 * `?next=` IS VALIDATED, NOT TRUSTED. An open redirect on a login flow is a phishing primitive: a link
 * that reads as the Centre's own domain and lands on somebody else's copy of this form. The checks
 * below are character-for-character the ones in `app/api/auth/refresh/route.ts` — the two must agree,
 * because middleware writes the parameter and either of them may be the one that consumes it.
 *
 * THE PROVIDER BUTTONS ARE BUILT FROM `configuredProviders()`, WHICH READS THE ENVIRONMENT. A provider
 * with no client id and secret is not rendered AT ALL — not greyed out, not "coming soon" (contract
 * §1.8). A disabled "Continue with Yahoo" invites a click that cannot succeed and makes an ordinary
 * deployment look half-built; an absent one simply is not offered. When none are configured this page
 * is exactly what it was before: a password form, saying nothing about anything being missing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in",
  // Restated rather than inherited. This is the one studio page a person may be sent a link to, so it
  // is the one most likely to be pasted somewhere a crawler will follow.
  robots: { index: false, follow: false }
};

const DEFAULT_NEXT = "/studio";

/**
 * Space and the C0/C7F control characters.
 *
 * A code-point scan rather than a regular expression because the characters being looked for are
 * invisible in source: a literal control character inside a character class cannot be reviewed.
 */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Only a same-origin PATH survives. Each rejection is an attack or a dead end, not a preference:
 *
 *  • `//evil.example` is a protocol-relative URL, not a path — it resolves to another host entirely.
 *  • `/\evil.example` is the same attack in disguise: the WHATWG URL parser treats a backslash as a
 *    slash for http(s) URLs, and it survives a naive "starts with one slash" test, which is exactly
 *    why that test is not enough on its own.
 *  • Control characters and spaces are refused because the parser STRIPS them, so a value that passed
 *    every check above can still turn into something else by the time it is resolved.
 *  • `/api/...` is refused because no useful journey ends at an API route, and a sign-in that finishes
 *    by downloading JSON reads as a broken sign-in.
 */
function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_NEXT;
  if (raw.length > 512) return DEFAULT_NEXT;
  if (!raw.startsWith("/")) return DEFAULT_NEXT;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_NEXT;
  if (hasUnsafeCharacter(raw)) return DEFAULT_NEXT;
  if (raw === "/api" || raw.startsWith("/api/")) return DEFAULT_NEXT;
  return raw;
}

/**
 * Which brand mark to draw beside each provider.
 *
 * An exhaustive record rather than a lookup that falls back to a blank square: adding a provider to
 * `OAUTH_PROVIDERS` should fail the build here, at the one place a logo has to be drawn by hand, and
 * not ship a nameless grey button nobody can identify. It maps to the DRAWING; `providerSlug()`
 * remains the authority for the URL.
 */
const PROVIDER_MARKS: Record<OAuthProviderName, ProviderMark> = {
  GOOGLE: "google",
  MICROSOFT: "microsoft",
  YAHOO: "yahoo"
};

/** A repeated parameter is an array. Take the first, as the URL parser does. */
function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The mark, inverted into a cream tile.
 *
 * The same reticle as `app/icon.svg`: a ring, a solid core, three cream ticks and one gold one. On the
 * deep purple band the tile is cream and the reticle is drawn in `purple-900`, which is the inversion
 * of the header lockup rather than a second logo. None of these colours moves with the theme, which is
 * correct — a logo that changed colour with a preference would not be a logo.
 */
function BrandTile() {
  return (
    <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-logo-cream shadow-glow-soft">
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className="h-9 w-9">
        <circle cx="32" cy="32" r="15" fill="none" strokeWidth="3" className="stroke-purple-900" />
        <circle cx="32" cy="32" r="5.5" className="fill-purple-900" />
        <g strokeWidth="3" strokeLinecap="round" className="stroke-purple-900">
          <line x1="32" y1="7" x2="32" y2="13" />
          <line x1="32" y1="51" x2="32" y2="57" />
          <line x1="7" y1="32" x2="13" y2="32" />
        </g>
        {/* The one deliberate asymmetry. Without it the mark reads as a loading spinner. */}
        <line
          x1="51"
          y1="32"
          x2="57"
          y2="32"
          strokeWidth="3"
          strokeLinecap="round"
          className="stroke-gold-600"
        />
      </svg>
    </span>
  );
}

export default async function StudioLoginPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // An array means the parameter was repeated. Taking the first is the same choice the URL parser
  // makes, and taking the last would let an attacker append a second value after a legitimate one.
  const next = safeNextPath(firstValue(params.next));

  /**
   * What the OAuth callback sent the reader back with, as `?error=<code>`.
   *
   * ⚠ THE PARAMETER IS A CODE, AND THE SENTENCE IS LOOKED UP — never rendered from the URL. The closed
   * set and the prose both live in `lib/auth/oauth-cookies.ts`, which is also where the callback writes
   * the code, so the two halves cannot drift apart into a page that displays a message no route sends.
   * An unrecognised code returns null and shows nothing: a code this build does not know about is not
   * something the reader could act on, and echoing it back would let any crafted link put words on the
   * Centre's own sign-in page.
   *
   * `access_denied` resolves to the very same `ACCESS_REFUSED_MESSAGE` the password route answers with.
   * If the two paths refused in different words, the difference would be the tell that says which
   * addresses are on the access list.
   */
  const signInError = signInNoticeMessage(params.error);

  const [user, branding] = await Promise.all([currentUser(), getSettingCached("branding")]);

  // See the header. `next` is already proved to be a single-slash, same-origin, non-API path.
  if (user) redirect(next);

  /**
   * The providers that are actually usable, with their start URLs built HERE.
   *
   * Built on the server so the client component never has to know the slug rule or re-derive the
   * address, and so `next` is encoded once, by the same code that just validated it.
   */
  const providers: LoginProvider[] = configuredProviders().map(({ provider, label }) => ({
    mark: PROVIDER_MARKS[provider],
    label,
    href: `/api/auth/oauth/${providerSlug(provider)}/start?next=${encodeURIComponent(next)}`
  }));

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,42%)_minmax(0,58%)]">
      {/*
        The brand panel. `relative` and `overflow-hidden` are what `.noise` needs: its grain is an
        absolutely positioned `::after` that would otherwise be placed against the page and spill.
        Hidden below `lg` — on a phone the form is the whole point and a decorative half-screen above
        it is half a screen of scrolling before anybody can type.
      */}
      <aside className="noise relative hidden flex-col justify-between overflow-hidden bg-purple-950 px-10 py-12 text-white lg:flex">
        <div className="flex items-center gap-4">
          <BrandTile />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-display text-lg font-semibold leading-tight">
              {branding.siteName}
            </span>
            <span className="mt-1 text-sm leading-snug text-white/60">Content studio</span>
          </span>
        </div>

        <div className="max-w-md">
          {/*
            The one gold line on the whole screen. Gold is marketing-only and never appears on a studio
            screen — the sign-in shell is the documented exception (contract §1.1, tailwind.config.ts:
            hero, auth and institutional headline spans).
          */}
          <p className="text-gold-gradient font-display text-sm font-semibold uppercase tracking-[0.14em]">
            The Centre&rsquo;s own record
          </p>
          <p className="mt-5 font-display text-3xl font-bold leading-tight tracking-tight text-balance">
            Everything the public site says is written here.
          </p>
          <p className="mt-4 text-base leading-relaxed text-white/70">
            Pages, research, people, publications and the living craft archive — edited once, published
            everywhere, and every change kept with the name of whoever made it.
          </p>
        </div>

        <p className="max-w-md text-sm leading-relaxed text-white/50">
          This area is for staff of the Centre. If you have not been given an account, ask an
          administrator rather than creating one — there is no self sign-up, by design.
        </p>
      </aside>

      <main className="grad-mesh flex flex-col justify-center bg-bg-0 px-5 py-12 sm:px-8">
        <div className="mx-auto w-full max-w-md">
          {/* The lockup again, for the widths where the brand panel is not on screen at all. */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-purple-700">
              <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className="h-7 w-7">
                <circle
                  cx="32"
                  cy="32"
                  r="15"
                  fill="none"
                  strokeWidth="3"
                  className="stroke-logo-cream/90"
                />
                <circle cx="32" cy="32" r="5.5" className="fill-logo-cream" />
              </svg>
            </span>
            <span className="min-w-0 truncate font-display text-base font-semibold text-ink-900">
              {branding.siteName}
            </span>
          </div>

          {/*
            THE FROSTED MOUNT, AND WHY THE FORM ITSELF SITS ON AN OPAQUE PANEL INSIDE IT.

            `.glass-card` is a fixed 72%-white fill: it does NOT invert with the theme, by design. Put
            themed text on it and the dark theme paints `ink-900` — which is near-white — onto a white
            card. So the glass is the mount (it refracts the mesh behind it, which is the effect asked
            for) and the form sits on `bg-card` inside it, where every themed token is correct in both
            themes. The inner panel is opaque, so no glass is nested inside glass.
          */}
          <div className="glass-card rounded-xl p-2 shadow-cinema">
            <div className="rounded-lg bg-card p-6 sm:p-8">
              <h1 className="display-title text-2xl">Sign in to the studio</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-500">
                Use the email address the Centre gave you. If two-step sign-in is switched on for your
                account, you will be asked for a code next.
              </p>

              <div className="mt-7">
                <LoginForm next={next} providers={providers} signInError={signInError} />
              </div>
            </div>
          </div>

          <p className="mt-6 text-xs leading-relaxed text-ink-500">
            Forgotten your password? An administrator can set a new one for you. Nothing on this screen
            is visible to the public, and this page is never listed by search engines.
          </p>
        </div>
      </main>
    </div>
  );
}
