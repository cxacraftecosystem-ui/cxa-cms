"use client";

/**
 * SetPasswordForm — two boxes, a live list of what is still wrong, and one request.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * SIX THINGS IN HERE ARE NOT PREFERENCES.
 *
 * 1. `new FormData(event.currentTarget)` IS THE FIRST STATEMENT OF THE SUBMIT HANDLER. React nulls
 *    `currentTarget` when the handler yields, so reading it after an `await` — even one added later,
 *    three edits from now — throws "Cannot read properties of null". Read first, then do anything else.
 *    (contract §10)
 *
 * 2. THE FORM IS UNCONTROLLED: neither input carries a `value`, so the browser and the password manager
 *    own what is typed and the submitted values come from `FormData`. The copies held in state exist
 *    ONLY to compute the live list below, and nothing reads them on submit. That distinction is what
 *    keeps a password manager's fill from being fought over on every keystroke.
 *
 * 3. THE PROBLEMS ARE SHOWN AS THE READER TYPES, not only after a failed submit. A password refused at
 *    the end of a form is a form filled in twice, and the second attempt is usually weaker because the
 *    reader is now guessing at a rule nobody told them.
 *
 * 4. ⚠ THE RULES BELOW ARE A COPY OF `passwordProblems` IN `lib/auth/password.ts`, AND THE SERVER'S
 *    COPY IS THE AUTHORITY. That module is `import "server-only"` — because it also holds bcrypt — so a
 *    client component importing it is a build error, not a slow import. Duplicating it is the same trade
 *    `statusProblems()` in components/studio/StatusControl.tsx makes against `publishTransition` in
 *    lib/studio/crud.ts, and the same rule applies: **IF ONE CHANGES, CHANGE BOTH**, word for word. The
 *    cost of drift here is bounded — the server refuses with its own list and this form prints that list
 *    verbatim (see `serverProblems`), so a stale rule here shows the reader a hint that turns out to be
 *    incomplete rather than letting a weak password through. The tidy fix is to lift the pure policy
 *    function into a module with no `server-only` guard and have both sides import it.
 *
 * 5. THE TWO BOXES ARE COMPARED HERE, IN ONE SENTENCE, AND THE SECOND BOX IS NEVER SENT. A server has no
 *    way to say anything useful about a mismatch it cannot see, and a round trip to be told "they do not
 *    match" is a round trip for something the browser already knew.
 *
 * 6. ON SUCCESS IT IS `window.location.assign`, NOT A ROUTER PUSH. The response has just set the session
 *    cookies, and every Server Component above this one — the studio layout, the sidebar, the dashboard —
 *    was rendered for an anonymous request. A router navigation would leave all of it in place and the
 *    reader would land on a signed-in studio drawn for nobody.
 *
 * WHY PLAIN `fetch` AND NOT `lib/client/fetcher.ts`, the same two reasons as its twin `LoginForm.tsx`:
 * a failure here is about the link or the password, never an expired access token, so the shared
 * 401-refresh-and-redirect path must not run and throw away what has been typed; and a 429 has to be
 * read out of the `Retry-After` HEADER, which `apiFetch` does not expose. The body is read the way that
 * module reads it, so the sentence the reader sees is the same either way.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useRef, useState, type FormEvent } from "react";
import { CircleAlert, CircleCheck, KeyRound, LogIn, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { FieldBlock } from "@/components/ui/Field";
import { PasswordInput } from "@/components/ui/PasswordInput";

export interface SetPasswordFormProps {
  /** Already verified by the page: signature, shape, expiry and the single-use fingerprint. */
  token: string;
  /** Shown so the reader knows which account they are setting a password for. */
  email: string;
}

/**
 * ⚠ A COPY. `lib/auth/password.ts` is the authority — see point 4 in the header. Every sentence here is
 * word-for-word the server's, because the server's are what the reader sees if a rule is only caught
 * there and two wordings for one rule read as two different rules.
 */
function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) {
    problems.push("Use at least 12 characters. A short phrase of several words works well.");
  }
  if (password.length > 200) {
    problems.push("Keep it under 200 characters.");
  }
  if (/^\s|\s$/.test(password)) {
    problems.push("Remove the space at the start or end — it is easy to lose when typing it again.");
  }
  const lowered = password.toLowerCase();
  const COMMON = ["password", "12345678", "qwerty", "letmein", "welcome", "admin123", "iloveyou"];
  if (COMMON.some((entry) => lowered.includes(entry))) {
    problems.push("This contains a very common password. Choose something less predictable.");
  }
  if (new Set(password).size < 5) {
    problems.push("Use a wider variety of characters.");
  }
  return problems;
}

/** A body from `lib/api.ts` always carries `message`. Anything else gets the caller's fallback. */
function messageFrom(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return fallback;
  const value = (payload as Record<string, unknown>).message;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return fallback;
}

/** The server's own list for the password field, validated rather than cast before it is rendered. */
function passwordErrorsFrom(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const fieldErrors = (payload as Record<string, unknown>).fieldErrors;
  if (typeof fieldErrors !== "object" || fieldErrors === null) return [];
  const entry = (fieldErrors as Record<string, unknown>).password;
  if (!Array.isArray(entry)) return [];
  return entry.filter((value): value is string => typeof value === "string");
}

function readBoolean(payload: unknown, key: string): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  return (payload as Record<string, unknown>)[key] === true;
}

/**
 * `Retry-After` in words. Mirrors `LoginForm.tsx`'s reader: the header is either a whole number of
 * seconds or an HTTP date, both are in the spec and both turn up, and a value that parses to nothing
 * returns null so the caller falls back to the server's own sentence rather than inventing a wait.
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

/** For a response that carried nothing usable — a proxy page, a gateway timeout, a dropped body. */
function statusFallback(status: number): string {
  if (status >= 500) {
    return `The server ran into a problem and did not answer properly (HTTP ${status}). Your password has not been changed — try again in a moment.`;
  }
  return `The server refused that (HTTP ${status}).`;
}

export function SetPasswordForm({ token, email }: SetPasswordFormProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server's list from a 422. Printed verbatim: it is the authority. See point 4 in the header. */
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  /**
   * Copies of what is typed, for the live list ONLY. The submitted values come from `FormData` — see
   * point 2 in the header.
   */
  const [typed, setTyped] = useState("");
  const [again, setAgain] = useState("");
  /**
   * Set when the password was accepted but no session was issued, which happens for an account with
   * two-step verification: the code has to be presented at the sign-in screen, and a password link that
   * signed somebody in without it would be a way round the second factor.
   */
  const [needsSecondFactor, setNeedsSecondFactor] = useState<string | null>(null);

  const passwordRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLInputElement | null>(null);

  const problems = passwordProblems(typed);
  const started = typed.length > 0;
  const mismatch = again.length > 0 && again !== typed;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // FIRST. Nothing above this line. See point 1 in the header.
    const data = new FormData(event.currentTarget);
    event.preventDefault();

    if (pending) return;

    const password = String(data.get("password") ?? "");
    const confirm = String(data.get("confirm") ?? "");

    setError(null);
    setServerProblems([]);

    // Checked here as well as on the server, so an obvious problem does not cost a round trip and focus
    // lands on the box that is actually wrong. The server's rules are still the authority.
    if (password.length === 0) {
      setError("Choose a password.");
      passwordRef.current?.focus();
      return;
    }
    const found = passwordProblems(password);
    if (found.length > 0) {
      setError("That password cannot be used yet. The list under the first box says what to change.");
      passwordRef.current?.focus();
      return;
    }
    if (confirm !== password) {
      setError("The two passwords are not the same. Type the new password again in the second box.");
      confirmRef.current?.focus();
      return;
    }

    setPending(true);

    let response: Response;
    try {
      response = await fetch("/api/auth/set-password", {
        method: "POST",
        // The whole point of the request is the cookies it sets.
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token, password })
      });
    } catch {
      // "The server is unreachable" and "your password was refused" are different claims, and saying the
      // second when the first happened sends somebody hunting for a rule they have not broken.
      setError(
        "The server could not be reached. Check your connection and try again — nothing you have typed has been lost, and no password has been set."
      );
      setPending(false);
      return;
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Not JSON. `messageFrom` falls through to the status sentence.
      payload = null;
    }

    if (response.status === 429) {
      const wait = describeRetryAfter(response.headers.get("retry-after"));
      const sentence = messageFrom(
        payload,
        "Too many attempts to set a password from this connection."
      );
      setError(wait ? `${sentence} ${wait}` : sentence);
      setPending(false);
      return;
    }

    if (!response.ok) {
      setError(messageFrom(payload, statusFallback(response.status)));
      setServerProblems(passwordErrorsFrom(payload));
      setPending(false);
      passwordRef.current?.focus();
      return;
    }

    if (readBoolean(payload, "signedIn")) {
      /**
       * A FULL page load, deliberately. See point 6 in the header. `pending` is left true so the button
       * stays busy for the whole navigation rather than flicking back to "Set my password" while the
       * browser is already leaving.
       */
      window.location.assign("/studio");
      return;
    }

    // The password IS set — the request succeeded — but no session was issued. Say so plainly rather
    // than navigating: a reader dropped onto a sign-in screen with no explanation assumes it failed.
    setNeedsSecondFactor(
      messageFrom(
        payload,
        "Your password is set. This account also asks for a code from your authenticator app, so sign in with your new password and have your phone to hand."
      )
    );
    setPending(false);
  }

  if (needsSecondFactor !== null) {
    return (
      <div>
        <p className="flex items-start gap-2 rounded-md border border-success-600/30 bg-success-100 px-3.5 py-3 text-sm leading-relaxed text-ink-900">
          {/* Icon AND words: colour never carries the meaning alone (contract §11). */}
          <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
          <span>{needsSecondFactor}</span>
        </p>

        {/*
          A BUTTON THAT NAVIGATES, rather than a `Link`. The response has just changed the session
          cookies (it cleared them, because no session was issued), so every Server Component above this
          one was rendered for whoever the browser used to be — the same reason point 6 in the header
          gives for `window.location.assign` on the success path. A client navigation would carry all of
          that stale tree onto the sign-in screen.
        */}
        <Button
          icon={LogIn}
          fullWidth
          className="mt-5"
          onClick={() => window.location.assign("/studio/login")}
        >
          Go to the sign-in screen
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      {/*
        Mounted from the first render, empty. Assistive technology only announces a change inside a live
        region that ALREADY EXISTED when the change happened — a `role="alert"` inserted at the same
        instant as its text is announced inconsistently, and this is the one message on the screen a
        reader cannot afford to miss.
      */}
      <div role="alert" aria-live="assertive">
        {error ? (
          <p className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>

      {/*
        A hidden field carrying the address, for the password manager only. Without a username in the
        form most managers will not offer to save the new password against the right account, and a
        password nobody's manager kept is a password that gets written on paper. It is `readOnly` rather
        than `disabled` so it is still submitted and still read by the manager; the server ignores it and
        takes the account from the signed token, so nothing here can change which account is written to.
      */}
      <input
        type="text"
        name="username"
        value={email}
        readOnly
        autoComplete="username"
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />

      {/*
        `FieldBlock` on both boxes, not `Field`: `PasswordInput` puts a reveal button beside the input,
        and a real `<label>` wrapped around a button forwards stray clicks to the input and folds the
        button's name into the input's own (Field.tsx's header sets out both traps).
      */}
      <FieldBlock
        label="New password"
        required
        maxLength={200}
        help={
          <>
            <span className="block">
              At least 12 characters. A short phrase of several words is both harder to guess and easier
              to remember than a jumble of symbols.
            </span>

            {/*
              THE LIVE LIST. Inside `help` on purpose: the wrapper wires its own help into the input's
              `aria-describedby`, so a screen-reader user hears these rules as the field's description
              instead of being shown something in the page that they are never told about (HelpText.tsx
              sets out that trap). Rendered as block `<span>`s and not a `<ul>` because the wrapper puts
              `help` inside a `<span>` of its own, which takes phrasing content only.

              It is NOT a live region — a list that re-announced itself on every keystroke would talk
              over the typing it is describing. The one moment worth announcing is handled below.
            */}
            {started && problems.length > 0 ? (
              <span className="mt-2 block space-y-1">
                {problems.map((problem) => (
                  <span key={problem} className="flex items-start gap-1.5 text-error-600">
                    <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{problem}</span>
                  </span>
                ))}
              </span>
            ) : null}

            {started && problems.length === 0 ? (
              <span className="mt-2 flex items-start gap-1.5 text-success-600">
                <CircleCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>This password meets the rules.</span>
              </span>
            ) : null}
          </>
        }
      >
        <PasswordInput
          ref={passwordRef}
          name="password"
          icon={KeyRound}
          // Two boxes on this screen, so neither eye may be called just "Show password" — a reader
          // listing the page's buttons would have no way to tell which of the two each one opens.
          subject="the new password"
          // "new-password", never "current-password": it is what tells a password manager to offer a
          // generated one and to save it against this account rather than filling in an old value.
          autoComplete="new-password"
          enterKeyHint="next"
          maxLength={200}
          disabled={pending}
          onChange={(event) => setTyped(event.target.value)}
        />
      </FieldBlock>

      <FieldBlock
        label="Type it again"
        required
        help="The same password once more, so a typo cannot lock you out of your own account."
        error={mismatch ? "These two do not match yet." : null}
      >
        <PasswordInput
          ref={confirmRef}
          name="confirm"
          subject="the repeated password"
          autoComplete="new-password"
          enterKeyHint="go"
          maxLength={200}
          disabled={pending}
          onChange={(event) => setAgain(event.target.value)}
        />
      </FieldBlock>

      {/*
        The server's own list, when it refused. Printed verbatim beneath the banner because it may
        contain a rule this file's copy does not know about — see point 4 in the header.
      */}
      {serverProblems.length > 0 ? (
        <ul className="space-y-1">
          {serverProblems.map((problem) => (
            <li key={problem} className="flex items-start gap-1.5 text-xs leading-relaxed text-error-600">
              <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{problem}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Button
        type="submit"
        icon={KeyRound}
        fullWidth
        isLoading={pending}
        loadingLabel="setting your password"
        className="mt-1"
      >
        Set my password and sign in
      </Button>

      <p className="text-xs leading-relaxed text-ink-500">
        Setting a password signs out every device that was signed in to this account, and this link stops
        working straight afterwards.
      </p>

      {/*
        Mounted from the first render so the region is registered before its content ever changes, and it
        holds one short sentence that appears only when the password becomes acceptable. The visible list
        above is deliberately silent for the reason given beside it. Same pattern as the character counter
        in components/ui/Field.tsx.
      */}
      <span role="status" className="sr-only">
        {started && problems.length === 0 ? "This password meets the rules." : ""}
      </span>
    </form>
  );
}
