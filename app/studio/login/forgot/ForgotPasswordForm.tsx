"use client";

/**
 * ForgotPasswordForm — one email box, one button, one answer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ANSWER IS PRINTED VERBATIM AND IS THE SAME FOR EVERY ADDRESS. `POST /api/auth/forgot-password`
 * returns `FORGOT_PASSWORD_MESSAGE` whether or not the address has an account, so this component has no
 * branch that could say otherwise — there is deliberately no "we could not find that address".
 *
 * The only failures it can show are about the REQUEST: a malformed address (422), too many requests from
 * this connection (429, with the `Retry-After` header in words) and an unreachable server.
 *
 * `new FormData(event.currentTarget)` IS THE FIRST STATEMENT of the submit handler (contract §10), and the
 * form is plain `fetch`, for the reasons `../LoginForm.tsx` gives: a 401-refresh replay is meaningless for
 * a signed-out reader, and the 429's `Retry-After` header is read here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useRef, useState, type FormEvent } from "react";
import { CircleCheck, Mail, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { describeRetryAfter, messageFrom } from "../LoginForm";

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // FIRST. Nothing above this line (contract §10).
    const data = new FormData(event.currentTarget);
    event.preventDefault();
    if (pending) return;

    const email = String(data.get("email") ?? "").trim();
    if (email.length === 0) {
      setError("Enter your email address.");
      emailRef.current?.focus();
      return;
    }

    setPending(true);
    setError(null);
    setSent(null);

    let response: Response;
    try {
      response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email })
      });
    } catch {
      setError("The server could not be reached. Check your connection and try again.");
      setPending(false);
      return;
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.status === 429) {
      const wait = describeRetryAfter(response.headers.get("retry-after"));
      const sentence = messageFrom(payload, "Too many requests from this connection.");
      setError(wait ? `${sentence} ${wait}` : sentence);
      setPending(false);
      return;
    }

    if (!response.ok) {
      setError(
        messageFrom(
          payload,
          response.status >= 500
            ? "Something went wrong on our side. Try again in a moment."
            : "That request did not work. Check the address and try again."
        )
      );
      setPending(false);
      emailRef.current?.focus();
      return;
    }

    setSent(messageFrom(payload, "If that address has a studio account, a link is on its way."));
    setPending(false);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      {/* Mounted from the first render so assistive technology announces what lands in it. */}
      <div role="alert" aria-live="assertive">
        {error ? (
          <p className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>

      <div role="status" aria-live="polite">
        {sent ? (
          <p className="flex items-start gap-2 rounded-md border border-success-600/25 bg-success-100 px-3.5 py-3 text-sm leading-relaxed text-success-600">
            <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{sent}</span>
          </p>
        ) : null}
      </div>

      <Field label="Email address" required help="The address you sign in to the studio with." className="block">
        <Input
          ref={emailRef}
          name="email"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="email"
          enterKeyHint="send"
          maxLength={320}
          disabled={pending}
        />
      </Field>

      <Button type="submit" icon={Mail} fullWidth isLoading={pending} loadingLabel="sending">
        Email me a link
      </Button>
    </form>
  );
}
