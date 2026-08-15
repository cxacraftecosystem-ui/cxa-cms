"use client";

/**
 * The public site's two browser-side WRITES, behind one `"use client"` boundary.
 *
 *   • `EventRegistration` — the registration form on an event page.
 *   • `ArticleViewBeacon` — the one-pixel-less beacon that counts a read of an article.
 *
 * They share this module deliberately: these are the only two places a public, unauthenticated page
 * posts anything, and keeping both behind one boundary means the whole public write surface is
 * auditable in a single file rather than discovered by grepping for `fetch`.
 *
 * ⚠ THE COST, STATED SO IT IS NOT DISCOVERED IN A BUNDLE REPORT: an article page imports only
 * `ArticleViewBeacon`, but importing one export from a client module pulls the module into that page's
 * client graph, so the registration form's code may travel with it unless the bundler manages to shake
 * it out. It is a couple of kilobytes and neither component holds a heavy dependency. If that ever
 * matters, the fix is to move the beacon to a file of its own — not to inline a `<script>`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FIVE HONEST STATES, DECIDED ON THE SERVER.
 *
 * `state` is a prop, not something this component works out. The page has the event row, the clock,
 * the capacity and the confirmed-registration count; this component has none of those and must never
 * guess. The five states are: not open yet (with the date it opens), open, full (with whether a
 * waiting list is offered), closed, and finished.
 *
 * NEVER A FORM THAT ACCEPTS A SUBMISSION THE SERVER WILL REFUSE. A form on a finished seminar, or on
 * one whose registration closed last week, is an invitation to type a name and an email address and be
 * told no — which is worse than being told no before typing. The only two states that render a form
 * are `open` and `full` WITH a waiting list, and in the second the button says so.
 *
 * ⚠ THE STATE IS AS FRESH AS THE LAST RENDER, AND THE ROUTE HANDLER IS THE AUTHORITY. Event pages are
 * prerendered and revalidated on a timer, so the last place can be taken between the render and the
 * submit. That is exactly why the failure path renders the handler's `message` verbatim: lib/api.ts
 * guarantees it is a plain human sentence, and "This event filled up while you were typing" is the
 * refusal a reader can act on.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ `new FormData(event.currentTarget)` IS THE FIRST STATEMENT OF THE SUBMIT HANDLER, BEFORE ANY
 * `await` (contract §10). React nulls `currentTarget` across an await, and the crash lands on the line
 * that reads the form rather than the line that awaited.
 *
 * The fields are UNCONTROLLED. A public form has no autosave and no dirty tracking to do, so there is
 * nothing for React state to buy here — and an uncontrolled form is the one that still submits with a
 * password manager, an autofill, or a paste that fires no `input` event.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  CalendarClock,
  CalendarX,
  CircleCheck,
  ExternalLink,
  TriangleAlert,
  Users,
  type LucideIcon
} from "lucide-react";

import { Button, LinkButton } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { cn } from "@/lib/utils";

export type RegistrationState = "not-open" | "open" | "full" | "closed" | "finished";

export interface EventRegistrationProps {
  /** The event's slug — the route this form posts to. */
  slug: string;
  /** Named in the confirmation, so a reader with three tabs open knows which event replied. */
  eventTitle: string;
  state: RegistrationState;
  /** When registration opens, already formatted in the Centre's zone by the page. */
  opensOn?: string | null;
  /** When it closed, or will close. Same formatting rule. */
  closesOn?: string | null;
  /** True when a full event still records arrivals on a waiting list. */
  waitlist?: boolean;
  /** Stated when it is known and the event is filling up — a number is more use than "limited places". */
  capacity?: number | null;
  /** Places left, when the page could establish it. `0` is a value, not an absence. */
  placesLeft?: number | null;
  /** An external registration system. When set, the form is replaced by a link to it. */
  externalUrl?: string | null;
  /** One extra sentence for the closed state — "Registration is switched off across the site." */
  note?: string | null;
  /**
   * True when a mail transport is configured, so the copy may promise an email.
   *
   * Decided by the server page from `mailerConfigured()` (lib/newsletter/delivery.ts) — the same
   * threading as `canSendEmail` on app/studio/users/page.tsx, and like the five states above it is
   * never something this component works out. When false, every sentence here says the registration
   * is RECORDED and the Centre's team confirms it; none names an inbox nothing is going to write to.
   */
  canSendEmail: boolean;
  className?: string;
}

/** What the server did with the registration. Anything else is treated as `PENDING`. */
type RegistrationOutcome = "CONFIRMED" | "WAITLISTED" | "PENDING";

interface SubmittedRegistration {
  email: string;
  outcome: RegistrationOutcome;
}

interface SubmitFailure {
  /** Incremented per attempt, so the focus effect fires again on a second identical failure. */
  attempt: number;
  message: string;
  fieldErrors: Record<string, string[]>;
}

const PANEL_BASE = "rounded-lg border border-line-200 bg-surface-50 p-5 sm:p-6";

/**
 * One field error, as a sentence.
 *
 * lib/api.ts sends `fieldErrors` keyed by field path with an array of messages. Only the first is
 * rendered under the box: a reader fixes one thing at a time, and stacking three messages under one
 * input makes the form taller than the screen at the exact moment somebody is trying to correct it.
 */
function firstError(fieldErrors: Record<string, string[]>, field: string): string | undefined {
  return fieldErrors[field]?.[0];
}

/** Narrow an unknown JSON body far enough to read the two things this form needs from it. */
function readErrorBody(body: unknown): { message: string | null; fieldErrors: Record<string, string[]> } {
  if (typeof body !== "object" || body === null) return { message: null, fieldErrors: {} };
  const record = body as Record<string, unknown>;
  const message = typeof record.message === "string" && record.message.trim().length > 0
    ? record.message.trim()
    : null;

  const fieldErrors: Record<string, string[]> = {};
  const raw = record.fieldErrors;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const messages = value.filter((entry): entry is string => typeof entry === "string");
        if (messages.length > 0) fieldErrors[key] = messages;
      } else if (typeof value === "string") {
        fieldErrors[key] = [value];
      }
    }
  }

  return { message, fieldErrors };
}

/** The registration's resulting state, when the handler reports one. */
function readOutcome(body: unknown): RegistrationOutcome {
  if (typeof body !== "object" || body === null) return "PENDING";
  const value = (body as Record<string, unknown>).state;
  if (value === "CONFIRMED" || value === "WAITLISTED") return value;
  return "PENDING";
}

export function EventRegistration({
  slug,
  eventTitle,
  state,
  opensOn,
  closesOn,
  waitlist = false,
  capacity,
  placesLeft,
  externalUrl,
  note,
  canSendEmail,
  className
}: EventRegistrationProps) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const failureRef = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef<HTMLDivElement | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [done, setDone] = useState<SubmittedRegistration | null>(null);

  /**
   * A failed submit MOVES FOCUS. `Field` wires its message with `aria-describedby` and deliberately
   * leaves it silent (components/ui/Field.tsx) — eight failing fields would otherwise fire eight
   * interruptions in a row. Announcing the failure is this form's job: focus lands on the first
   * invalid control, whose description is then read out, or on the summary when the refusal was not
   * about any one box.
   */
  useEffect(() => {
    if (!failure) return;
    const invalid = formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']");
    if (invalid) {
      invalid.focus();
      return;
    }
    failureRef.current?.focus();
  }, [failure]);

  /** Success replaces the form, so focus has to be put somewhere — on the confirmation itself. */
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    // FIRST STATEMENT, BEFORE ANY AWAIT. See the file header.
    const data = new FormData(event.currentTarget);
    event.preventDefault();

    const payload = {
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
      organisation: String(data.get("organisation") ?? "").trim(),
      phone: String(data.get("phone") ?? "").trim(),
      notes: String(data.get("notes") ?? "").trim()
    };

    /**
     * The only checks done here are for EMPTINESS, and they exist to save a round trip on an obvious
     * slip. No email regex: every one anybody writes refuses a real address somewhere, and the server's
     * Zod schema is the single authority on what a valid registration looks like (contract §9).
     */
    const local: Record<string, string[]> = {};
    if (payload.name.length === 0) local.name = ["Enter the name the place should be booked in."];
    if (payload.email.length === 0) {
      local.email = ["Enter an email address so the Centre can confirm your place."];
    }
    if (Object.keys(local).length > 0) {
      setFailure((current) => ({
        attempt: (current?.attempt ?? 0) + 1,
        message: "Two details are needed before this can be sent.",
        fieldErrors: local
      }));
      return;
    }

    setSubmitting(true);
    setFailure(null);

    try {
      const response = await fetch(`/api/public/events/${encodeURIComponent(slug)}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Same-origin, so the handler's `assertSameOrigin` sees an Origin it recognises.
        credentials: "same-origin",
        body: JSON.stringify(payload)
      });

      // Tolerant of a body that is not JSON: a proxy error page or a 502 from the edge is HTML, and
      // `response.json()` would throw a parse error that says nothing about what went wrong.
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const { message, fieldErrors } = readErrorBody(body);
        setFailure((current) => ({
          attempt: (current?.attempt ?? 0) + 1,
          message:
            message ??
            "Your registration could not be sent. Please try again in a moment, or write to the Centre.",
          fieldErrors
        }));
        return;
      }

      setDone({ email: payload.email, outcome: readOutcome(body) });
    } catch {
      // A network failure, an aborted request, an offline device. Nothing was recorded, and saying so
      // matters: a reader who thinks they have registered will not try again.
      setFailure((current) => ({
        attempt: (current?.attempt ?? 0) + 1,
        message:
          "Your registration could not be sent — the connection failed, and nothing has been recorded. " +
          "Please check your connection and try again.",
        fieldErrors: {}
      }));
    } finally {
      setSubmitting(false);
    }
  };

  // ── The four states that render no form ────────────────────────────────────────────────────

  if (state === "finished") {
    return (
      <StatePanel
        className={className}
        icon={CalendarX}
        title="This event has finished"
        body={
          <>
            Registration for {eventTitle} is closed because the event has already taken place. Anything
            published from it — photographs, recordings, papers — appears on this page.
          </>
        }
      />
    );
  }

  if (state === "not-open") {
    return (
      <StatePanel
        className={className}
        icon={CalendarClock}
        title="Registration has not opened yet"
        body={
          opensOn
            ? <>Registration for {eventTitle} opens on {opensOn}. There is nothing to fill in until then.</>
            : <>Registration for {eventTitle} is not open yet. No opening date has been announced.</>
        }
      />
    );
  }

  if (state === "closed") {
    return (
      <StatePanel
        className={className}
        icon={CalendarX}
        title="Registration is closed"
        body={
          <>
            {closesOn
              ? `Registration for ${eventTitle} closed on ${closesOn}.`
              : `Registration for ${eventTitle} is closed.`}
            {note ? ` ${note}` : ""}
          </>
        }
      />
    );
  }

  if (state === "full" && !waitlist) {
    return (
      <StatePanel
        className={className}
        icon={Users}
        title="Every place has been taken"
        body={
          <>
            {eventTitle} is full
            {typeof capacity === "number" ? ` — all ${capacity} places are booked` : ""}, and no waiting
            list is being kept for it.
          </>
        }
      />
    );
  }

  // ── Registration handled somewhere else ────────────────────────────────────────────────────

  if (externalUrl) {
    return (
      <div className={cn(PANEL_BASE, className)}>
        <h3 className="display-title text-lg leading-snug">
          {state === "full" ? "Join the waiting list" : "Register for this event"}
        </h3>
        <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-700">
          Registration for {eventTitle} is handled on another site, so this takes you away from the
          Centre&rsquo;s pages.
          {state === "full" ? " Every place is booked, so you would be joining a waiting list." : ""}
        </p>
        <div className="mt-5">
          <LinkButton href={externalUrl} icon={ExternalLink} iconPosition="end" newTab>
            Register on the organiser&rsquo;s site
          </LinkButton>
        </div>
      </div>
    );
  }

  // ── Done ───────────────────────────────────────────────────────────────────────────────────

  if (done) {
    return (
      <div
        ref={doneRef}
        tabIndex={-1}
        // `status`, so a reader who submitted with the keyboard is told the outcome without the
        // interruption an `alert` would make of it. Focus is moved here as well, because the form they
        // were standing in has just been removed from the page.
        role="status"
        /**
         * ⚠ A THEMED SURFACE WITH A LITERAL-COLOURED HEADING, NEVER A `bg-success-100` PANEL.
         *
         * The status ramps are literal hex and do NOT invert, by design — a status must read the same in
         * both themes (contract §3). The themed `ink-*` ladder DOES invert. Put the two together and a
         * `text-ink-900` paragraph on a pale green panel becomes near-white on pale green under
         * `data-theme="dark"`: invisible, and only in one theme, which is how it survives review. So the
         * panel is the ordinary card surface and only the heading and its glyph carry the success colour.
         */
        className={cn(
          "rounded-lg border border-success-600/25 bg-surface-50 p-5 outline-none sm:p-6",
          className
        )}
      >
        <h3 className="flex items-start gap-2.5 font-display text-lg font-semibold leading-snug text-success-600">
          <CircleCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
          {done.outcome === "WAITLISTED"
            ? "You are on the waiting list"
            : done.outcome === "CONFIRMED"
              ? "Your place is confirmed"
              : "Your registration has been received"}
        </h3>

        {/*
          WHAT HAPPENS NEXT, not "thank you". A confirmation that does not say what to expect leaves a
          reader refreshing their inbox with no idea whether they should be.

          ⚠ AND NO EMAIL IS PROMISED THAT NOTHING CAN SEND. Every branch here has a `canSendEmail`
          variant, because on a deployment with no mail transport "instructions go to {email}" is a
          promise about a message no code path can produce — the reader it strands is the one who
          checks that inbox for days. The degraded sentences say what is actually true: the
          registration is recorded, and the Centre's team confirms it.
        */}
        <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
          {done.outcome === "WAITLISTED" ? (
            canSendEmail ? (
              <>
                {eventTitle} is full, so your name has been added to the waiting list. If a place frees
                up the Centre will write to {done.email}. You do not need to register again.
              </>
            ) : (
              <>
                {eventTitle} is full, so your name has been recorded on the waiting list. If a place
                frees up the Centre&rsquo;s team will be in touch. You do not need to register again.
              </>
            )
          ) : done.outcome === "CONFIRMED" ? (
            canSendEmail ? (
              <>
                A place at {eventTitle} is held in your name. Details of the venue and the joining
                instructions go to {done.email}. Bring the confirmation email with you.
              </>
            ) : (
              <>
                A place at {eventTitle} is held in your name and your registration has been recorded.
                The Centre&rsquo;s team will confirm the details of the venue and the joining
                arrangements with you.
              </>
            )
          ) : canSendEmail ? (
            <>
              Your registration for {eventTitle} has been recorded and is waiting for the organisers to
              confirm it. They will write to {done.email} — usually within a few working days. There is
              nothing else to do in the meantime.
            </>
          ) : (
            <>
              Your registration for {eventTitle} has been recorded and is waiting for the organisers to
              confirm it. The Centre&rsquo;s team handles confirmations, so there is nothing else to do
              in the meantime.
            </>
          )}
        </p>

        <p className="mt-3 text-sm leading-relaxed text-ink-700">
          If nothing arrives, write to the Centre using the contact page rather than registering a
          second time — a duplicate registration is refused, not doubled.
        </p>
      </div>
    );
  }

  // ── The form ───────────────────────────────────────────────────────────────────────────────

  const joiningWaitlist = state === "full";
  const nameError = failure ? firstError(failure.fieldErrors, "name") : undefined;
  const emailError = failure ? firstError(failure.fieldErrors, "email") : undefined;
  const organisationError = failure ? firstError(failure.fieldErrors, "organisation") : undefined;
  const phoneError = failure ? firstError(failure.fieldErrors, "phone") : undefined;
  const notesError = failure ? firstError(failure.fieldErrors, "notes") : undefined;

  // Errors the server reported against a field this form does not render. Shown with the summary
  // rather than dropped — a refusal nobody can see is a form that appears to fail for no reason.
  const unplacedErrors = failure
    ? Object.entries(failure.fieldErrors)
        .filter(([key]) => !["name", "email", "organisation", "phone", "notes"].includes(key))
        .flatMap(([key, messages]) => messages.map((message) => `${key}: ${message}`))
    : [];

  return (
    <div className={cn(PANEL_BASE, className)}>
      <h3 className="display-title text-lg leading-snug">
        {joiningWaitlist ? "Join the waiting list" : "Register for this event"}
      </h3>

      {/* The same `canSendEmail` gate as the confirmation above: "will write" and "by email" are
          promises only a deployment with a mail transport may make. */}
      <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-700">
        {joiningWaitlist ? (
          <>
            Every place at {eventTitle} is booked
            {typeof capacity === "number" ? ` — all ${capacity} of them` : ""}. Leave your details and
            {canSendEmail
              ? " the Centre will write if one frees up."
              : " the Centre's team will be in touch if one frees up."}{" "}
            Nothing is held for you until it does.
          </>
        ) : (
          <>
            {canSendEmail
              ? "Leave your details and the Centre will confirm your place by email."
              : "Leave your details — your registration is recorded straight away, and the Centre's team will confirm your place."}
            {typeof placesLeft === "number" && placesLeft > 0 && placesLeft <= 20
              ? ` ${placesLeft} ${placesLeft === 1 ? "place" : "places"} remain.`
              : ""}
            {closesOn ? ` Registration closes on ${closesOn}.` : ""}
          </>
        )}
      </p>

      {failure ? (
        <div
          ref={failureRef}
          tabIndex={-1}
          role="alert"
          className="mt-5 flex items-start gap-2.5 rounded-md border border-error-200 bg-error-100 px-4 py-3 text-sm leading-relaxed text-error-700 outline-none"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {failure.message}
            {unplacedErrors.length > 0 ? (
              <span className="mt-1.5 block">{unplacedErrors.join(" ")}</span>
            ) : null}
          </span>
        </div>
      ) : null}

      <form ref={formRef} onSubmit={onSubmit} noValidate className="mt-5 flex flex-col gap-5">
        {/*
          `Field` — a real <label> — is correct for every control here: they are all plain inputs and a
          textarea, so there is no button inside for the label's click forwarding to slam shut
          (components/ui/Field.tsx).
        */}
        <Field
          label="Your name"
          required
          error={nameError}
          help="As it should appear on the attendance list and on any certificate."
        >
          <Input name="name" autoComplete="name" maxLength={120} enterKeyHint="next" />
        </Field>

        <Field
          label="Email address"
          required
          error={emailError}
          help={
            canSendEmail
              ? "Where the confirmation and the joining instructions are sent."
              : "How the Centre's team reaches you about your place."
          }
        >
          <Input name="email" type="email" inputMode="email" autoComplete="email" maxLength={254} />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Organisation" error={organisationError} help="Optional — your institution, company or department.">
            <Input name="organisation" autoComplete="organization" maxLength={160} />
          </Field>

          <Field label="Telephone" error={phoneError} help="Optional. Used only if the Centre cannot reach you by email.">
            <Input name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} />
          </Field>
        </div>

        <Field
          label="Anything the organisers should know"
          error={notesError}
          help="Optional — access requirements, dietary needs, a question about the programme."
        >
          <Textarea name="notes" rows={4} maxLength={1000} />
        </Field>

        <div className="flex flex-wrap items-center gap-4">
          <Button
            type="submit"
            isLoading={submitting}
            loadingLabel="sending"
            icon={joiningWaitlist ? Users : CircleCheck}
          >
            {joiningWaitlist ? "Join the waiting list" : "Register"}
          </Button>

          <p className="text-xs leading-relaxed text-ink-500">
            Your details are used to run this event and are not passed to anyone else.
          </p>
        </div>
      </form>
    </div>
  );
}

/** The shell every no-form state shares: an icon, a heading and one honest paragraph. */
function StatePanel({
  icon: Icon,
  title,
  body,
  className
}: {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(PANEL_BASE, className)}>
      <h3 className="flex items-start gap-2.5 font-display text-lg font-semibold leading-snug text-ink-900">
        {/* An icon AND a word, always: colour and a glyph never carry the meaning alone (contract §11). */}
        <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-ink-500" />
        {title}
      </h3>
      <p className="prose-measure mt-2.5 text-sm leading-relaxed text-ink-700">{body}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The view beacon
// ─────────────────────────────────────────────────────────────────────────────

export interface ArticleViewBeaconProps {
  /** `Post.id`. The route resolves the row from this and increments its `viewCount`. */
  entityId: string;
  /** The article's own path, for the coarse day/path counters in `PageViewDaily`. */
  path: string;
}

/**
 * Counts one read of an article, from the browser, after the reader has actually stayed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A `prisma.post.update` IN THE PAGE.
 *
 * A PAGE RENDER IS NOT A VIEW. A Next.js `<Link>` prefetches on hover, a crawler renders, and ISR
 * re-renders the page on a timer with nobody reading it — each of those would count. And a write
 * inside a Server Component makes the page uncacheable: a page that mutates cannot be prerendered,
 * so the most-read article on the site becomes the one page that is rendered from scratch for every
 * visitor.
 *
 * THE TRADE-OFF, STATED PLAINLY: an effect runs only in a real browser with JavaScript enabled, so
 * this UNDERCOUNTS. Readers with scripting off, and anything that fetches the HTML without executing
 * it, are invisible to it. That is the right direction to be wrong in — `viewCount` is an editorial
 * signal ("which pieces land"), and a number inflated by prefetches and bots is worse than one that
 * is a little low, because it cannot be corrected after the fact.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ONCE PER SESSION PER ARTICLE. `sessionStorage` is the dedupe, so a Back-then-Forward or a client-side
 * re-navigation does not count twice. It is wrapped in a try/catch: storage throws outright in some
 * private-browsing modes, and a beacon must never be the thing that breaks an article page.
 *
 * Renders nothing. There is no visible signal and there should not be one — a reader has no use for
 * "we counted you".
 */
export function ArticleViewBeacon({ entityId, path }: ArticleViewBeaconProps) {
  useEffect(() => {
    // A tab restored in the background, or a prerendered page that has never been looked at, has not
    // been read. The listener below picks it up if and when it is brought to the front.
    let sent = false;

    const key = `cxa:viewed:${entityId}`;
    try {
      if (window.sessionStorage.getItem(key) !== null) return;
    } catch {
      // Storage is unavailable; carry on without the dedupe rather than not counting at all.
    }

    const send = () => {
      if (sent) return;
      sent = true;
      try {
        window.sessionStorage.setItem(key, "1");
      } catch {
        /* see above */
      }
      // Fire-and-forget, and the failure is swallowed on purpose: a counter that surfaces an error to
      // a reader has its priorities the wrong way round.
      void fetch("/api/public/views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        // Survives the request if the reader navigates away the instant the timer fires.
        keepalive: true,
        body: JSON.stringify({ entityType: "post", entityId, path })
      }).catch(() => {});
    };

    // Two seconds. A bounce that lasts 300ms is not a read, and the delay also means a reader who
    // lands on the wrong article and leaves immediately is not counted against it.
    let timer: number | null = null;

    const start = () => {
      if (timer !== null || sent) return;
      timer = window.setTimeout(send, 2000);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [entityId, path]);

  return null;
}
