"use client";

/**
 * LoginForm — email, password, and (only when it is needed) a second factor.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FIVE THINGS IN HERE ARE NOT PREFERENCES.
 *
 * 1. `new FormData(event.currentTarget)` IS THE FIRST STATEMENT OF THE SUBMIT HANDLER. React nulls
 *    `currentTarget` when the handler yields, so reading it after an `await` — even after an `await`
 *    added later, three edits from now — throws "Cannot read properties of null". Read first, then do
 *    anything else. (contract §10)
 *
 * 2. THE FORM IS UNCONTROLLED, AND THAT IS WHAT MAKES THE TWO-STEP FLOW WORK. `/api/auth/login` is
 *    stateless: the second request must carry the email AND the password again, alongside the code. The
 *    inputs are never unmounted or re-keyed when the code field appears, so the browser keeps both
 *    values — and the password manager keeps its fill. A form that cleared the password at this point
 *    would turn the second step into a fresh sign-in, which is the failure this note exists to prevent.
 *    (Studio EDITING forms are controlled, because they autosave and track dirty state; a sign-in form
 *    has neither.)
 *
 * 3. A 200 CARRYING `{ twoFactorRequired: true }` IS NOT AN ERROR. The password was right and one more
 *    thing is needed. Treating it as a failure — or answering 401 for it, which the route deliberately
 *    does not — would be indistinguishable from a wrong password, and the reader would have no idea
 *    what to do next.
 *
 * 4. ONE MESSAGE FOR A WRONG ADDRESS AND A WRONG PASSWORD, READ FROM THE RESPONSE AND PRINTED
 *    VERBATIM. The staff directory is public; a form that confirmed which of those addresses can sign
 *    in would be an account enumerator. `lib/api.ts` guarantees `message` is a plain human sentence
 *    ready to render, so re-wording it here could only make the two halves of the product disagree.
 *
 * 5. THE AUTOCOMPLETE TOKENS ARE "username" / "current-password" / "one-time-code". Getting these
 *    wrong makes a password manager useless, and a password manager nobody can use is what pushes
 *    people onto passwords they can remember.
 *
 * 6. THE PROVIDER BUTTONS ARE LINKS, AND THEY ARE NOT `fetch`, AND THEY ARE NOT `LinkButton`.
 *
 *    A `fetch` cannot do this job at all: the start route answers a 302 to the provider's own domain,
 *    and an XHR cannot perform a top-level cross-origin navigation. It would follow the redirect
 *    invisibly, hand back a response the page cannot read, and leave the reader sitting here with
 *    nothing having happened.
 *
 *    `LinkButton` is wrong for a subtler reason: it routes internal hrefs through `next/link`, which
 *    PREFETCHES. Merely hovering the button would call the start route — minting a PKCE handshake and
 *    setting its state cookie — for a sign-in nobody has begun. The click then mints another, and
 *    whichever cookie landed last is the one the callback compares `state` against. A plain `<a>`
 *    navigates exactly once, when it is pressed, which is the only behaviour this flow can survive.
 *
 * 7. AN UNCONFIGURED PROVIDER IS ABSENT, NEVER DISABLED (contract §1.8). The page passes only the ones
 *    that can actually work; an empty list renders no divider, no buttons and no explanation.
 *
 * WHY PLAIN `fetch` AND NOT `lib/client/fetcher.ts`. Two reasons, both specific to this one endpoint:
 * a 401 here means "these credentials are wrong", not "this token expired", so the shared 401-refresh
 * path must not run (the fetcher already excludes `/api/auth/login` for exactly that reason); and a 429
 * has to be read out of the `Retry-After` HEADER, which `apiFetch` does not expose. The body shape is
 * still read the way that module reads it, so the sentence a reader sees is the same either way.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Info, KeyRound, LogIn, TriangleAlert } from "lucide-react";

import { Button, buttonClasses } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

/** Which brand mark to draw. The page derives it from the provider name; see `BrandMark`. */
export type ProviderMark = "google" | "microsoft" | "yahoo";

export interface LoginProvider {
  mark: ProviderMark;
  /** The provider's own name — "Google", "Microsoft", "Yahoo" — as the button says it. */
  label: string;
  /** The start route, with the already-validated `next` encoded into it. Built by the page. */
  href: string;
}

export interface LoginFormProps {
  /** Already validated as a single-slash, same-origin, non-API path by the page. */
  next: string;
  /**
   * Only the providers that are configured on this deployment. Usually empty, and an empty list is a
   * normal state rather than a fault — most installations sign in with a password alone.
   */
  providers: LoginProvider[];
  /**
   * A failure the OAuth callback redirected back with, already turned into a sentence by the page.
   *
   * It seeds the SAME banner the form uses for its own errors rather than getting one of its own. Two
   * alert regions stacked above one form is how a reader ends up correcting the wrong thing: the stale
   * "that sign-in was cancelled" sits there contradicting the fresh "your password is wrong". This one
   * is cleared by the next submit, like any other message in that box.
   */
  signInError: string | null;
}

/** A body from `lib/api.ts` always carries `message`. Anything else gets the caller's fallback. */
function messageFrom(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return fallback;
  const value = (payload as Record<string, unknown>).message;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return fallback;
}

function isTwoFactorChallenge(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  return (payload as Record<string, unknown>).twoFactorRequired === true;
}

/**
 * `Retry-After` in words.
 *
 * The header is either a whole number of seconds or an HTTP date — both forms are in the spec and both
 * turn up in the wild, so both are handled. A value that parses to nothing at all returns null and the
 * caller falls back to the server's own sentence rather than inventing a wait it cannot vouch for.
 *
 * Under ninety seconds the answer is given in seconds, because "try again in 1 minute" for a 20-second
 * wait makes somebody sit and watch a clock for three times longer than they needed to.
 */
function describeRetryAfter(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number.parseInt(trimmed, 10);
  } else {
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return null;
    seconds = Math.ceil((at - Date.now()) / 1000);
  }

  if (!Number.isFinite(seconds)) return null;
  if (seconds <= 0) return "You can try again now.";
  if (seconds < 90) return `Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/**
 * The provider marks.
 *
 * ⚠ LITERAL BRAND HEX, AND DELIBERATELY OUTSIDE EVERY TOKEN LADDER. These are not decoration and not
 * status colours: they are three companies' logos, and a logo that shifted with the studio's purple
 * ramp or inverted with the theme would no longer be the logo — it would be a lookalike, which is
 * worse than a plain wordmark because it reads as the real thing at a glance. The same reasoning the
 * page's `BrandTile` gives for the Centre's own mark, applied to somebody else's.
 *
 * 18px, and `aria-hidden` on every one: the button already says "Continue with Google" in words, so a
 * second announcement of the same fact is noise. Colour never carries the meaning here (contract §11)
 * — the label does, and the mark is recognition, not information.
 */
function BrandMark({ mark }: { mark: ProviderMark }) {
  switch (mark) {
    case "google":
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          className="shrink-0"
        >
          <path
            fill="#4285F4"
            d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.642h6.458a5.52 5.52 0 0 1-2.394 3.622v3.01h3.878c2.269-2.09 3.578-5.168 3.578-8.82Z"
          />
          <path
            fill="#34A853"
            d="M12 24c3.24 0 5.956-1.075 7.942-2.908l-3.878-3.01c-1.075.72-2.45 1.145-4.064 1.145-3.125 0-5.77-2.11-6.715-4.947H1.276v3.11A11.995 11.995 0 0 0 12 24Z"
          />
          <path
            fill="#FBBC05"
            d="M5.285 14.28a7.212 7.212 0 0 1 0-4.56V6.61H1.276a12.01 12.01 0 0 0 0 10.78l4.009-3.11Z"
          />
          <path
            fill="#EA4335"
            d="M12 4.773c1.762 0 3.343.606 4.587 1.794l3.44-3.44C17.951 1.19 15.235 0 12 0 7.31 0 3.256 2.69 1.276 6.61l4.009 3.11C6.23 6.883 8.875 4.773 12 4.773Z"
          />
        </svg>
      );
    case "microsoft":
      // Four squares, in the order Microsoft draws them: red, green, blue, yellow.
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          className="shrink-0"
        >
          <path fill="#F25022" d="M1 1h10.2v10.2H1Z" />
          <path fill="#7FBA00" d="M12.8 1H23v10.2H12.8Z" />
          <path fill="#00A4EF" d="M1 12.8h10.2V23H1Z" />
          <path fill="#FFB900" d="M12.8 12.8H23V23H12.8Z" />
        </svg>
      );
    case "yahoo":
      // The purple tile with the white "y!", drawn from primitives rather than traced: at 18px the
      // silhouette is all that reads, and a hand-cut path of somebody else's letterform would be a
      // worse likeness at the size it is actually seen.
      return (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          className="shrink-0"
        >
          <rect width="24" height="24" rx="5" fill="#6001D2" />
          <g stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round">
            <path d="M4.8 7.6 10 15" />
            <path d="M15.2 7.6 7 19" />
          </g>
          <rect x="17.8" y="7.6" width="2.4" height="5.4" rx="1.2" fill="#FFFFFF" />
          <circle cx="19" cy="16.2" r="1.5" fill="#FFFFFF" />
        </svg>
      );
  }
}

/** For a response that carried nothing usable — a proxy page, a gateway timeout, a dropped body. */
function statusFallback(status: number): string {
  if (status >= 500) {
    return `The server ran into a problem and did not answer properly (HTTP ${status}). Try again in a moment.`;
  }
  return `The server refused that sign-in (HTTP ${status}).`;
}

export function LoginForm({ next, providers, signInError }: LoginFormProps) {
  const [pending, setPending] = useState(false);
  // Seeded with whatever the OAuth callback sent us back with. See `signInError` in the props above.
  const [error, setError] = useState<string | null>(signInError);
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  /**
   * The address that got as far as the second step.
   *
   * Held in state so the challenge can name it: a reader who has just been asked for a code needs to
   * know which account they are being asked about, particularly on a shared machine. The PASSWORD is
   * deliberately not in state — it stays in the input the browser is already holding, which is both
   * fewer copies of it in memory and what keeps the field filled (see point 2 in the header).
   */
  const [challengeEmail, setChallengeEmail] = useState("");

  const emailRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  // Focus follows the new field the moment it appears. Without this the reader is looking at a box that
  // was not there a second ago while their cursor is still in the password field two rows above.
  useEffect(() => {
    if (twoFactorRequired) codeRef.current?.focus();
  }, [twoFactorRequired]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // FIRST. Nothing above this line. See point 1 in the header.
    const data = new FormData(event.currentTarget);
    event.preventDefault();

    if (pending) return;

    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const code = String(data.get("code") ?? "").trim();

    // Checked here as well as on the server so an empty box does not cost a round trip, and so focus
    // lands on the field that is actually missing. The server's Zod schema is still the authority.
    if (email.length === 0) {
      setError("Enter your email address.");
      emailRef.current?.focus();
      return;
    }
    if (password.length === 0) {
      setError("Enter your password.");
      passwordRef.current?.focus();
      return;
    }
    if (twoFactorRequired && code.length === 0) {
      setError(
        "Enter the six-digit code from your authenticator app, or one of your recovery codes."
      );
      codeRef.current?.focus();
      return;
    }

    setPending(true);
    setError(null);

    let response: Response;
    try {
      response = await fetch("/api/auth/login", {
        method: "POST",
        // The whole point of the request is the cookies it sets.
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        // `totp` carries either form: the route recognises a recovery code in this field, so a reader
        // who has lost their phone does not have to find a second box first.
        body: JSON.stringify({ email, password, totp: code.length > 0 ? code : undefined })
      });
    } catch {
      // "The server is unreachable" and "your details are wrong" are different claims, and saying the
      // second when the first happened sends somebody hunting for a password that was never wrong.
      setError(
        "The server could not be reached. Check your connection and try again — nothing you have typed has been lost."
      );
      setPending(false);
      return;
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Not JSON. `messageFrom` will fall through to the status sentence.
      payload = null;
    }

    if (response.status === 429) {
      const wait = describeRetryAfter(response.headers.get("retry-after"));
      const sentence = messageFrom(
        payload,
        "Too many sign-in attempts in a short time from this address."
      );
      setError(wait ? `${sentence} ${wait}` : sentence);
      setPending(false);
      return;
    }

    if (!response.ok) {
      setError(messageFrom(payload, statusFallback(response.status)));
      setPending(false);
      // The password is the field to correct in every case the server can answer with — including a
      // wrong address, where the message deliberately does not say which half was wrong.
      if (twoFactorRequired) codeRef.current?.focus();
      else passwordRef.current?.focus();
      return;
    }

    if (isTwoFactorChallenge(payload)) {
      setChallengeEmail(email);
      setTwoFactorRequired(true);
      setPending(false);
      return;
    }

    // Signed in. A FULL page load rather than a router push: the session cookies have just changed and
    // every Server Component above this one — the layout, the sidebar, the dashboard — has to be
    // rendered again by the server for the person who now exists. `next` was validated by the page.
    // `pending` is deliberately left true so the button stays busy for the whole navigation.
    window.location.assign(next);
  }

  return (
    <>
      <form onSubmit={handleSubmit} noValidate className="space-y-5">
        {/*
          Mounted from the first render, usually empty. Assistive technology only announces a change
          inside a live region that ALREADY EXISTED when the change happened — a `role="alert"` inserted
          at the same instant as its text is announced inconsistently, and this is the one message on the
          screen a reader cannot afford to miss.

          It arrives already filled when a provider sign-in has just failed and sent the reader back here
          (`signInError`). That text is part of the first paint rather than a later change, so it is read
          in document order by anything traversing the page, which is the behaviour that message wants —
          it explains why the reader is looking at this form again.
        */}
        <div role="alert" aria-live="assertive">
          {error ? (
            <p className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700">
              {/* Icon AND words: colour never carries the meaning alone (contract §11). */}
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}
        </div>

        <Field
          label="Email address"
          required
          help="The address the Centre gave you."
          className="block"
        >
          <Input
            ref={emailRef}
            name="email"
            type="email"
            // "username", not "email": it is what a password manager matches a saved login on.
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="email"
            enterKeyHint="next"
            maxLength={320}
            disabled={pending}
          />
        </Field>

        <Field label="Password" required>
          <Input
            ref={passwordRef}
            name="password"
            type="password"
            autoComplete="current-password"
            enterKeyHint={twoFactorRequired ? "next" : "go"}
            maxLength={200}
            disabled={pending}
          />
        </Field>

        {twoFactorRequired ? (
          <div className="space-y-4 rounded-md border border-purple-200 bg-purple-50 p-4">
            <p className="flex items-start gap-2 text-sm leading-relaxed text-ink-700">
              <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-purple-700" />
              <span>
                Your password was accepted. This account also needs a code
                {challengeEmail ? (
                  <>
                    {" "}
                    — you are signing in as <span className="font-medium">{challengeEmail}</span>
                  </>
                ) : null}
                . Open your authenticator app and type the six digits showing now, or use one of the
                recovery codes you saved when you set it up.
              </span>
            </p>

            <Field
              label="Verification code"
              required
              help="Six digits from your authenticator app, or one recovery code."
            >
              <Input
                ref={codeRef}
                name="code"
                type="text"
                icon={KeyRound}
                // "one-time-code" is what lets a phone offer the code from a message or an app.
                autoComplete="one-time-code"
                // Not `numeric`: a recovery code is letters and digits, and a numeric keypad on a phone
                // would leave a reader who has lost their authenticator unable to type the one thing
                // that would let them in.
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                maxLength={64}
                disabled={pending}
              />
            </Field>
          </div>
        ) : null}

        <Button
          type="submit"
          icon={LogIn}
          fullWidth
          isLoading={pending}
          loadingLabel="signing in"
          className="mt-1"
        >
          {twoFactorRequired ? "Verify and sign in" : "Sign in"}
        </Button>
      </form>
      {/*
        THE OTHER WAY IN.

        Rendered only when at least one provider is configured — no divider, no heading and no
        explanation otherwise, because "Google sign-in is not set up here" is a sentence about the
        deployment that a person trying to sign in can do nothing with (contract §1.8).

        A worded divider rather than a bare rule: a line on its own leaves the reader to infer whether
        the buttons below are an alternative to the form or a second step of it.
      */}
      {providers.length > 0 ? (
        <div className="mt-7">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="h-px flex-1 bg-line-200" />
            <span className="text-xs font-medium uppercase tracking-wider text-ink-500">or</span>
            <span aria-hidden="true" className="h-px flex-1 bg-line-200" />
          </div>

          <ul className="mt-5 space-y-3">
            {providers.map((provider) => (
              <li key={provider.mark}>
                {/*
                  A real anchor, styled as a secondary button — see point 6 in the header for why it is
                  neither a fetch nor a `LinkButton`. `buttonClasses` is the exported recipe for exactly
                  this case: something that must look like a button and cannot be one.
                */}
                <a
                  href={provider.href}
                  className={buttonClasses({ variant: "secondary", fullWidth: true })}
                >
                  <BrandMark mark={provider.mark} />
                  <span>Continue with {provider.label}</span>
                </a>
              </li>
            ))}
          </ul>

          <p className="mt-4 text-xs leading-relaxed text-ink-500">
            You can only sign in this way if your address is already on the studio&rsquo;s access list.
            Signing in with a provider never creates an account.
          </p>
        </div>
      ) : null}
    </>
  );
}
