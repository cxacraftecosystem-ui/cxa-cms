import type { Metadata } from "next";
import Link from "next/link";
import { CircleAlert, Clock, KeyRound, LogIn, ShieldAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  INVITE_TTL_HOURS,
  RESET_TTL_HOURS,
  credentialFingerprintMatches,
  verifyCredentialToken,
  type CredentialPurpose
} from "@/lib/auth/credential-token";
import { currentUser } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { getSettingCached } from "@/lib/settings/service";
import { HelpText } from "@/components/studio/HelpText";
import { SetPasswordForm } from "./SetPasswordForm";

/**
 * Set your password — where an invitation and a password link land.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WITHOUT THIS SCREEN NO INVITED COLLEAGUE COULD EVER CLAIM AN ACCOUNT. `app/api/studio/users/route.ts`
 * has always created an invited account with no password and handed back a link to this address; the
 * address did not exist, so the link 404ed and the sign-in screen's promise that "an administrator can
 * set a new one for you" was true of no code path in the application.
 *
 * IT REQUIRES NO SESSION, AND MUST NOT. The whole point is an account that has no password yet, so
 * there is nothing to sign in with. `middleware.ts` exempts this one path from the studio door for
 * exactly that reason — if that exemption is ever removed, every invitation dies again, silently.
 *
 * THE TOKEN IS VALIDATED BEFORE THE FORM IS RENDERED. A form that cannot succeed is worse than a
 * message: the reader types a password twice, waits, and is told no — and has no idea whether the fault
 * is theirs. So a bad, expired or already-used link renders an explanation and a way onward instead.
 *
 * ⚠ `notFound()` AND `forbidden()` ARE BOTH WRONG HERE and were considered. This is a legitimate
 * visitor holding a link somebody sent them: a 404 says the address is wrong when it is not, and the
 * permission screen says they lack access they were never asked to have. Neither tells them the one
 * thing they can act on, which is "ask for a fresh link". A page in the ordinary style, saying what
 * happened in a sentence, is the correct answer.
 *
 * HOW SPECIFIC IT IS ALLOWED TO BE, AND WHY THAT IS NOT AN ORACLE. `POST /api/auth/set-password`
 * answers every token failure with one sentence, because it is an unauthenticated endpoint and a more
 * specific answer would confirm which addresses on a public staff directory have accounts here. This
 * screen distinguishes "expired" from "already used" only AFTER the signature has verified — which
 * needs the installation's signing key — so every specific message below is one that can only be
 * reached by somebody already holding a link this installation issued. The one state that is folded
 * into a vague sentence is the account's: `unavailable` covers deleted, switched off and gone, and says
 * which of the three to nobody.
 *
 * IT IS THE SIGN-IN SCREEN'S TWIN by design — the same deep purple brand panel, the same glass mount on
 * the mesh — because it is the same moment in the same journey, and a second visual language at the
 * point somebody is typing a credential reads as a different site.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set your password",
  // Restated rather than inherited from the studio layout. This is a page people are sent a link to, so
  // it is the studio page most likely to be pasted somewhere a crawler will follow.
  robots: { index: false, follow: false }
};

/** What the token turned out to be. Every branch renders exactly one `<h1>`. */
type Outcome =
  | { state: "ready"; token: string; name: string; email: string; purpose: CredentialPurpose }
  | { state: "no-token" }
  | { state: "unreadable" }
  | { state: "expired" }
  | { state: "used" }
  | { state: "unavailable" };

async function inspect(token: string): Promise<Outcome> {
  const verdict = verifyCredentialToken(token);

  if (!verdict.ok) {
    if (verdict.reason === "missing") return { state: "no-token" };
    if (verdict.reason === "expired") return { state: "expired" };
    return { state: "unreadable" };
  }

  /**
   * `passwordHash` is read here, and it is the only secret column this page touches. It exists in this
   * function only to be turned into a 16-character digest and compared; it is not returned, not put in
   * the `Outcome`, and therefore cannot reach the client component below. That comparison IS the
   * single-use guarantee — see `lib/auth/credential-token.ts`.
   */
  const user = await prisma.user.findUnique({
    where: { id: verdict.payload.sub },
    select: { name: true, email: true, isActive: true, deletedAt: true, passwordHash: true }
  });

  if (!user || !user.isActive || user.deletedAt) return { state: "unavailable" };
  if (!credentialFingerprintMatches(user.passwordHash, verdict.payload.cred)) {
    return { state: "used" };
  }

  return {
    state: "ready",
    token,
    name: user.name,
    email: user.email,
    purpose: verdict.payload.purpose
  };
}

interface Explanation {
  icon: LucideIcon;
  title: string;
  body: string[];
}

/**
 * The refusals, in words.
 *
 * Each one names what happened and what to do next, in that order, because the second is the only part
 * the reader can act on. No jargon: there is no "token", no "payload" and no "signature" in any of them
 * — the thing in the address bar is a "link", which is what it is to the person holding it.
 */
function explain(state: Exclude<Outcome["state"], "ready">): Explanation {
  switch (state) {
    case "no-token":
      return {
        icon: CircleAlert,
        title: "This page needs a link",
        body: [
          "The address you have opened has no link code in it, so there is nothing for this page to check. Almost always this means the address was cut short somewhere between being sent and being opened — an email program that wrapped it onto two lines is the usual culprit.",
          "Ask whoever sent it to send the whole address again, and open it in one piece."
        ]
      };
    case "unreadable":
      return {
        icon: CircleAlert,
        title: "This is not a link this site issued",
        body: [
          "The code in the address could not be read. That happens when part of it is lost in copying or forwarding, and it also happens when an address has been changed by hand.",
          "Ask an administrator for a fresh link. Nothing has been changed on any account."
        ]
      };
    case "expired":
      return {
        icon: Clock,
        title: "This link has expired",
        body: [
          `A link lasts a short time on purpose, so that one left sitting in an inbox cannot be used weeks later by whoever finds it. An invitation is good for ${INVITE_TTL_HOURS} hours and a password link for ${RESET_TTL_HOURS} hours.`,
          "Ask an administrator for a new one — it takes them a moment, and nothing about the account needs setting up again."
        ]
      };
    case "used":
      return {
        icon: ShieldAlert,
        title: "This link has already been used",
        body: [
          "A link works once. It stops working the moment a password is set on the account, which is what stops somebody using the same link twice.",
          "If you set that password, sign in with it. If you did not, tell an administrator straight away and ask them to sign the account out of every device — somebody else may have opened this link before you."
        ]
      };
    case "unavailable":
      return {
        icon: CircleAlert,
        title: "This link cannot be used",
        body: [
          "The account it was made for cannot be signed in to at the moment.",
          "An administrator can look into it and send a new link once the account is ready."
        ]
      };
  }
}

/**
 * The mark, inverted into a cream tile.
 *
 * ⚠ A VERBATIM COPY of `BrandTile` in `app/studio/login/page.tsx`. Next type-checks a `page.tsx` against
 * a fixed set of allowed exports, so the login page cannot share it, and the two screens are one
 * lockup that must not drift. It belongs in `components/site/` — lift it there when that folder is next
 * touched, and delete both copies in the same change. None of these colours moves with the theme, which
 * is correct: a logo that changed colour with a preference would not be a logo.
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

export default async function SetPasswordPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  /**
   * A repeated `?token=` arrives as an array. The FIRST is taken, which is the same choice the URL
   * parser makes — taking the last would let a second value appended to a legitimate address win.
   * Under `noUncheckedIndexedAccess` the index is `string | undefined`, which is the empty case.
   */
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? "";

  const [branding, outcome, signedIn] = await Promise.all([
    getSettingCached("branding"),
    inspect(token),
    /**
     * Only to WARN, never to gate. This screen must work for a visitor with no session, and it must also
     * work for one who happens to be signed in as somebody else on a shared machine — the note below
     * tells them what continuing will do rather than refusing them.
     */
    currentUser()
  ]);

  const otherAccount =
    outcome.state === "ready" && signedIn !== null && signedIn.email !== outcome.email
      ? signedIn.email
      : null;

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,42%)_minmax(0,58%)]">
      {/*
        The brand panel. `relative` and `overflow-hidden` are what `.noise` needs: its grain is an
        absolutely positioned `::after` that would otherwise be placed against the page and spill.
        Hidden below `lg` — on a phone the form is the whole point and a decorative half-screen above it
        is half a screen of scrolling before anybody can type.
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
            The one gold line on the screen. Gold is marketing-only and never appears on a studio screen
            — the sign-in shell is the documented exception (contract §1.1), and this screen is its twin.
          */}
          <p className="text-gold-gradient font-display text-sm font-semibold uppercase tracking-[0.14em]">
            Your account, your password
          </p>
          <p className="mt-5 font-display text-3xl font-bold leading-tight tracking-tight text-balance">
            Nobody here has chosen your password for you.
          </p>
          <p className="mt-4 text-base leading-relaxed text-white/70">
            No administrator has typed one, seen one, or had one emailed to them. The link you followed
            lets you set your own, once, and then stops working.
          </p>
        </div>

        <p className="max-w-md text-sm leading-relaxed text-white/50">
          Choose something long rather than something complicated. A short phrase of several words is
          both harder to guess and easier to remember than a jumble of symbols.
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
            THE FROSTED MOUNT, AND WHY THE CONTENT SITS ON AN OPAQUE PANEL INSIDE IT.

            `.glass-card` is a fixed 72%-white fill and does NOT invert with the theme, by design. Themed
            text on it would paint `ink-900` — near-white in the dark theme — onto a white card. So the
            glass is the mount and everything readable sits on `bg-card` inside it, where every themed
            token is correct in both themes. The inner panel is opaque, so no glass is nested in glass.
            Identical to the sign-in screen.
          */}
          <div className="glass-card rounded-xl p-2 shadow-cinema">
            <div className="rounded-lg bg-card p-6 sm:p-8">
              {outcome.state === "ready" ? (
                <>
                  <h1 className="display-title text-2xl">
                    {outcome.purpose === "invite" ? "Set your password" : "Set a new password"}
                  </h1>
                  <p className="mt-2 text-sm leading-relaxed text-ink-500">
                    {outcome.purpose === "invite" ? (
                      <>
                        Welcome, {outcome.name}. Choose a password for{" "}
                        <span className="font-medium text-ink-900">{outcome.email}</span> and you will be
                        signed in to the studio.
                      </>
                    ) : (
                      <>
                        Choose a new password for{" "}
                        <span className="font-medium text-ink-900">{outcome.email}</span>. The old one no
                        longer works, and neither will this link once you have finished.
                      </>
                    )}
                  </p>

                  {otherAccount !== null ? (
                    <div className="mt-5">
                      <HelpText tone="warn">
                        You are signed in on this device as {otherAccount}. Setting a password with this
                        link will sign this device out of that account and sign you in as {outcome.email}{" "}
                        instead. If this is a shared computer, check the link was meant for you before you
                        go on.
                      </HelpText>
                    </div>
                  ) : null}

                  <div className="mt-7">
                    <SetPasswordForm token={outcome.token} email={outcome.email} />
                  </div>
                </>
              ) : (
                <Refusal state={outcome.state} />
              )}
            </div>
          </div>

          <p className="mt-6 text-xs leading-relaxed text-ink-500">
            {outcome.state === "ready"
              ? "Nothing on this screen is visible to the public, and this page is never listed by search engines. Your password is stored only as a one-way scramble that nobody here can reverse."
              : "Nothing on this screen is visible to the public, and this page is never listed by search engines."}
          </p>
        </div>
      </main>
    </div>
  );
}

/** One refusal, in the ordinary style: a heading, two sentences, and the one way onward. */
function Refusal({ state }: { state: Exclude<Outcome["state"], "ready"> }) {
  const { icon: Icon, title, body } = explain(state);

  return (
    <>
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-amber-100 text-amber-800">
        {/* Decorative: the heading and the sentences carry the whole message (contract §11). */}
        <Icon aria-hidden="true" className="h-5 w-5" />
      </span>

      <h1 className="display-title mt-4 text-2xl">{title}</h1>

      {body.map((sentence) => (
        <p key={sentence.slice(0, 40)} className="mt-3 text-sm leading-relaxed text-ink-700">
          {sentence}
        </p>
      ))}

      {/*
        A `Link`, not a `Button`. Buttons in this codebase are client components that take a component
        type for `icon`, which a Server Component cannot pass across the boundary (Input.tsx's header
        sets out the trap). The `.field-button-secondary` recipe is the same appearance.
      */}
      <Link href="/studio/login" className="field-button-secondary mt-7">
        <LogIn aria-hidden="true" className="h-4 w-4" />
        Go to the sign-in screen
      </Link>

      <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-ink-500">
        <KeyRound aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Nobody at the Centre can see or choose your password, so a new link is the only way to set one.
          Ask whoever looks after the studio.
        </span>
      </p>
    </>
  );
}
