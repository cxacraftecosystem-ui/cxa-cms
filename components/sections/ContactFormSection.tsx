"use client";

/**
 * ContactFormSection — the public enquiry form. Messages land in the studio inbox named by `formKey`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `new FormData(event.currentTarget)` IS THE FIRST STATEMENT OF THE SUBMIT HANDLER.
 *
 * React nulls `event.currentTarget` when the handler yields, so reading the form after the first
 * `await` throws — and it throws in the one situation nobody tests, which is the retry after a
 * failure. The values are pulled out of the DOM before anything else happens (contract §10).
 *
 * THE FORM IS UNCONTROLLED, and that is what keeps a failed send from costing somebody a paragraph.
 * The inputs are never unmounted and never re-rendered from state, so a 500 from the server, a
 * dropped connection or a validation failure leaves every character exactly where it was typed.
 * Losing a long message because a request failed is the worst outcome this component has.
 *
 * SUCCESS REPLACES THE FORM. It is not a toast: `aria-live="polite"` waits its turn and never
 * interrupts, so a reader who has already tabbed away may never hear it, and a toast that has faded
 * cannot be re-read by someone wondering whether their message actually went. A panel that stays on
 * screen, says what happens next and takes focus is the only version of this that can be trusted.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * TWO SPAM SIGNALS, BOTH DECIDED ON THE SERVER. This component only carries them:
 *
 *   • a honeypot field, off screen, `tabIndex={-1}`, `autoComplete="off"` and `aria-hidden`, so no
 *     person and no screen reader ever meets it while a form-filling script fills everything it sees;
 *   • how long the form was on screen. A submission completed in under about two seconds was not
 *     typed by a human.
 *
 * Both are posted as ordinary fields. Neither is checked here — a client-side spam check is a check
 * the spammer can read, and refusing a submission in the browser only teaches them which field to
 * leave alone. `elapsedMs` is a DURATION rather than a timestamp on purpose: it is measured against
 * one clock, so a visitor whose device clock is a day out is not silently classified as a bot.
 * `renderedAt` is sent alongside it for the same window, in case the route prefers absolute times.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PageSection } from "@prisma/client";
import { CheckCircle2, Send, TriangleAlert } from "lucide-react";

import { Reveal } from "@/components/motion";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { asApiClientError, post } from "@/lib/client/fetcher";
import type { ContactFormSectionData } from "@/lib/sections/schema";
import type { ContactSettings } from "@/lib/settings/schema";
import { cn } from "@/lib/utils";

/** The name of the field no human will ever see. Plausible enough that a script fills it in. */
const HONEYPOT_FIELD = "website";

/** Which inbox, in the words the confirmation uses. Mirrors `ContactSubmission.formKey`. */
const INBOX_LABELS: Record<ContactFormSectionData["formKey"], string> = {
  general: "general enquiries",
  admissions: "admissions",
  collaboration: "collaboration",
  media: "press and media"
};

/**
 * A shape test, not a validator.
 *
 * The authority is the Zod schema in the route handler (contract §9). This one exists so a missing
 * `@` is caught before a round trip, and it is deliberately permissive: every stricter regular
 * expression anybody writes rejects a real address somewhere, and refusing to send a correct message
 * is a worse failure than a bounced reply.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MAX_MESSAGE = 4000;

type FieldName = "name" | "email" | "organisation" | "phone" | "subject" | "message";

export interface ContactFormSectionProps {
  data: ContactFormSectionData;
  section: PageSection;
  /**
   * The Centre's contact details, from the `contact` settings group.
   *
   * Passed in rather than read here, because this is a Client Component and `lib/settings/service.ts`
   * is `server-only` — the page renderer reads the group once and hands it down. Null means "not
   * available", and the details column is then simply absent rather than empty.
   */
  contact?: ContactSettings | null;
}

export function ContactFormSection({ data, section, contact = null }: ContactFormSectionProps) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const confirmationRef = useRef<HTMLDivElement | null>(null);
  const formErrorRef = useRef<HTMLParagraphElement | null>(null);
  /**
   * When the form appeared, set in an effect rather than during render.
   *
   * `Date.now()` evaluated during render runs once on the server and again in the browser, so a
   * hidden input carrying it would differ between the prerendered HTML and the hydrated tree. An
   * effect runs only in the browser, which is where the clock that matters is.
   */
  const shownAtRef = useRef<number | null>(null);

  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  /** Bumped on every failed attempt, so a second identical failure still moves focus. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    shownAtRef.current = Date.now();
  }, []);

  // A failed submit must put focus on the first control that needs attention; the inline messages in
  // `Field` are described-by rather than live, precisely so the form decides when to speak (Field.tsx).
  useEffect(() => {
    if (attempt === 0) return;
    const form = formRef.current;
    if (!form) return;

    const firstInvalid = form.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    // No particular field is wrong — the request itself failed. Disabling the focused submit button
    // drops focus to `<body>` in several browsers (Button.tsx documents the same trap), which leaves a
    // keyboard reader standing nowhere at all. Only then is focus moved, and only to the explanation.
    if (document.activeElement === null || document.activeElement === document.body) {
      formErrorRef.current?.focus();
    }
  }, [attempt]);

  // The confirmation takes focus so a keyboard or screen-reader user lands on the answer rather than
  // discovering that the form has vanished from underneath them.
  useEffect(() => {
    if (!sent) return;
    confirmationRef.current?.focus();
  }, [sent]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    // FIRST. See the header — nothing may come before this, least of all an await.
    const entries = new FormData(event.currentTarget);
    event.preventDefault();

    if (sending) return;

    const read = (field: string) => String(entries.get(field) ?? "").trim();

    const values = {
      name: read("name"),
      email: read("email"),
      organisation: read("organisation"),
      phone: read("phone"),
      subject: read("subject"),
      message: read("message")
    };

    const nextErrors: Partial<Record<FieldName, string>> = {};
    if (values.name.length === 0) nextErrors.name = "Tell us who you are.";
    if (values.email.length === 0) {
      nextErrors.email = "We need an email address to reply to.";
    } else if (!EMAIL_SHAPE.test(values.email)) {
      nextErrors.email = "Enter a complete email address, such as name@example.ac.in.";
    }
    if (values.message.length === 0) {
      nextErrors.message = "Write your message before sending it.";
    } else if (values.message.length > MAX_MESSAGE) {
      nextErrors.message = `Keep the message to ${MAX_MESSAGE} characters or fewer.`;
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setFormError(null);
      setAttempt((count) => count + 1);
      return;
    }

    setErrors({});
    setFormError(null);
    setSending(true);

    const shownAt = shownAtRef.current;

    try {
      await post("/api/public/contact", {
        ...values,
        formKey: data.formKey,
        // Carried, never judged here. See the header.
        [HONEYPOT_FIELD]: String(entries.get(HONEYPOT_FIELD) ?? ""),
        elapsedMs: shownAt === null ? null : Math.max(0, Date.now() - shownAt),
        renderedAt: shownAt
      }, {
        // A public form is never signed in, so a 401 here would mean the route is wrong, not that a
        // token expired. Without this the fetcher would try to refresh a session that does not exist
        // and then navigate the reader to the studio login screen, taking their message with it.
        retryUnauthorized: false
      });

      setSent(true);
    } catch (thrown) {
      const failure = asApiClientError(thrown);
      // `message` from lib/api.ts is already a plain sentence written to be rendered verbatim.
      setFormError(failure.message);

      // Field errors from the server win over ours: it validated the values that actually arrived.
      const serverFields = failure.fieldErrors;
      if (serverFields) {
        const mapped: Partial<Record<FieldName, string>> = {};
        for (const field of ["name", "email", "organisation", "phone", "subject", "message"] as const) {
          const first = serverFields[field]?.[0];
          if (first) mapped[field] = first;
        }
        setErrors(mapped);
      }

      setAttempt((count) => count + 1);
    } finally {
      setSending(false);
    }
  };

  const hasHeading = data.heading.trim().length > 0;
  /** Is any of the header visible? Only then does it take space above the form. */
  const showsHeader =
    hasHeading || data.eyebrow.trim().length > 0 || data.body.trim().length > 0;
  const showAside = data.showContactDetails && contact !== null;

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        {/*
          ALWAYS RENDERED. This block already had the right fallback and the wrong condition around it:
          with all three fields blank it rendered no `<h2>` at all, and the confirmation panel and the
          contact-details column below are both `<h3>` — so the page went from `<h1>` straight to `<h3>`,
          a level missing from the outline a screen-reader user navigates by (contract §11).

          "Get in touch" rather than the block's registry name ("Contact form"): this heading can end up
          on screen at level 2 in the outline of a public page, and it should read as something a visitor
          would say. The heading is taken OFF SCREEN where the editor cleared it, and the margin is gated
          on there being something to see so a header that exists only for the outline leaves no gap.
        */}
        <Reveal>
          <SectionHeading
            eyebrow={data.eyebrow || undefined}
            title={hasHeading ? data.heading : "Get in touch"}
            description={data.body || undefined}
            className={showsHeader ? "mb-10" : undefined}
            titleClassName={hasHeading ? undefined : "sr-only"}
          />
        </Reveal>

        <div
          className={cn(
            "grid gap-10",
            showAside ? "lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-14" : "max-w-2xl"
          )}
        >
          <Reveal as="div" className="min-w-0">
            {sent ? (
              <div
                ref={confirmationRef}
                tabIndex={-1}
                className="rounded-lg border border-line-200 bg-card p-6 outline-none sm:p-8"
              >
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-success-100 text-success-600">
                  <CheckCircle2 aria-hidden="true" className="h-5 w-5" />
                </span>

                <h3 className="display-title mt-4 text-xl">Your message has been sent</h3>

                <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-700">
                  {data.successMessage ||
                    "Thank you. Your message has reached the Centre and someone will reply by email, usually within three working days."}
                </p>

                <p className="mt-4 text-xs text-ink-500">
                  It has gone to the {INBOX_LABELS[data.formKey]} inbox. Nothing else is needed from
                  you.
                </p>
              </div>
            ) : (
              <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
                {formError ? (
                  // `role="alert"` and not a toast: this is the reason the message did not send, and
                  // it has to stay on screen next to the button that failed.
                  <p
                    ref={formErrorRef}
                    role="alert"
                    tabIndex={-1}
                    className="flex items-start gap-2.5 rounded-md border border-error-200 bg-error-100 px-4 py-3 text-sm text-error-700 outline-none"
                  >
                    <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{formError}</span>
                  </p>
                ) : null}

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Your name" required error={errors.name}>
                    <Input name="name" autoComplete="name" maxLength={120} />
                  </Field>

                  <Field
                    label="Email address"
                    required
                    error={errors.email}
                    help="Where the reply will go."
                  >
                    <Input name="email" type="email" autoComplete="email" maxLength={254} />
                  </Field>

                  {data.showOrganisationField ? (
                    <Field label="Organisation" error={errors.organisation}>
                      <Input name="organisation" autoComplete="organization" maxLength={160} />
                    </Field>
                  ) : null}

                  {data.showPhoneField ? (
                    <Field
                      label="Telephone"
                      error={errors.phone}
                      help="Only if you would rather be telephoned than emailed."
                    >
                      <Input name="phone" type="tel" autoComplete="tel" maxLength={40} />
                    </Field>
                  ) : null}
                </div>

                <Field label="Subject" error={errors.subject}>
                  <Input name="subject" maxLength={200} />
                </Field>

                <Field
                  label="Message"
                  required
                  error={errors.message}
                  help="Say what you need and roughly when you need it."
                >
                  <Textarea name="message" rows={7} maxLength={MAX_MESSAGE} />
                </Field>

                {/*
                  THE HONEYPOT. Off screen rather than `display: none`, because the cheapest scripts
                  skip hidden fields but fill everything that has a label. `aria-hidden` and
                  `tabIndex={-1}` together mean no keyboard and no screen reader can reach it.
                */}
                <div
                  aria-hidden="true"
                  style={{ position: "absolute", left: "-9999px", top: 0 }}
                  className="h-px w-px overflow-hidden"
                >
                  <label htmlFor={`${HONEYPOT_FIELD}-field`}>Leave this field empty</label>
                  <input
                    id={`${HONEYPOT_FIELD}-field`}
                    name={HONEYPOT_FIELD}
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-4">
                  {/*
                    `isLoading` is deliberately NOT used. `Button` mounts its label inside a polite
                    live region already, so changing the words IS the announcement; `isLoading` would
                    append its own "— working" and the reader would hear "Sending… — working".
                  */}
                  <Button
                    type="submit"
                    disabled={sending}
                    aria-busy={sending || undefined}
                    icon={sending ? undefined : Send}
                  >
                    {sending ? "Sending…" : data.submitLabel || "Send message"}
                  </Button>

                  <p className="text-xs leading-relaxed text-ink-500">
                    Your details are used to answer this enquiry and nothing else.
                  </p>
                </div>
              </form>
            )}
          </Reveal>

          {showAside && contact ? <ContactDetails contact={contact} /> : null}
        </div>
      </div>
    </section>
  );
}

function ContactDetails({ contact }: { contact: ContactSettings }) {
  const addressLines = [
    contact.addressLine1,
    contact.addressLine2,
    [contact.city, contact.state].filter(Boolean).join(", "),
    [contact.postalCode, contact.country].filter(Boolean).join(" ")
  ]
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const departments = contact.departments.filter((department) => department.name.trim().length > 0);

  // Nothing has been filled in yet. An empty bordered column beside the form is a hole; no column at
  // all is simply a one-column form, which is a complete design in itself.
  if (
    addressLines.length === 0 &&
    contact.email.length === 0 &&
    contact.phone.length === 0 &&
    departments.length === 0
  ) {
    return null;
  }

  return (
    <Reveal as="aside" delay={0.08} className="min-w-0">
      <div className="rounded-lg border border-line-200 bg-surface-50 p-6">
        <h3 className="field-label">Contact details</h3>

        {addressLines.length > 0 ? (
          <address className="mt-3 text-sm not-italic leading-relaxed text-ink-700">
            {addressLines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </address>
        ) : null}

        {contact.email || contact.phone ? (
          <ul className="mt-4 flex flex-col gap-1.5 text-sm">
            {contact.email ? (
              <li>
                <a
                  href={`mailto:${contact.email}`}
                  className="font-medium text-purple-700 transition-colors hover:text-purple-800"
                >
                  {contact.email}
                </a>
              </li>
            ) : null}
            {contact.phone ? (
              <li>
                <a
                  // A telephone number is a link on every device that can dial and harmless on the
                  // ones that cannot.
                  href={`tel:${contact.phone.replace(/\s+/g, "")}`}
                  className="font-medium text-purple-700 transition-colors hover:text-purple-800"
                >
                  {contact.phone}
                </a>
              </li>
            ) : null}
          </ul>
        ) : null}

        {departments.length > 0 ? (
          <dl className="mt-5 flex flex-col gap-4 border-t border-line-200 pt-5">
            {departments.map((department) => (
              <div key={department.name}>
                <dt className="text-sm font-semibold text-ink-900">{department.name}</dt>
                <dd className="mt-0.5 text-sm leading-relaxed text-ink-500">
                  {department.note ? <span className="block">{department.note}</span> : null}
                  {department.email ? (
                    <a
                      href={`mailto:${department.email}`}
                      className="text-purple-700 transition-colors hover:text-purple-800"
                    >
                      {department.email}
                    </a>
                  ) : null}
                  {department.email && department.phone ? <span> · </span> : null}
                  {department.phone ? <span>{department.phone}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </Reveal>
  );
}
