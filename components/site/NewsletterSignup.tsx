"use client";

/**
 * The newsletter sign-up form — the reader's way in.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE FORM, TWO PATHS, AND THE PLAIN ONE IS THE REAL ONE.
 *
 * This is a genuine `<form method="post" action="…">`. With JavaScript switched off, blocked by a
 * corporate proxy, or still downloading, pressing the button posts the form and the browser follows the
 * `303 See Other` the handler answers with — landing back on a page that says what happened. With
 * JavaScript, `onSubmit` intercepts and does the same POST through `fetch`, so the reader keeps their
 * place on the page and their scroll position.
 *
 * ⚠ BOTH PATHS POST THE **SAME `application/x-www-form-urlencoded` BODY** TO THE **SAME URL**, and that
 * is the property that keeps this honest. `NEWSLETTER_SUBSCRIBE_ENDPOINT` is one constant used for the
 * `action` attribute AND the `fetch` URL, and the body is built by handing `FormData` to
 * `URLSearchParams`, which is precisely the encoding a native form POST produces. So there is one body
 * format, one Zod schema and one set of field names. The alternative — a JSON payload for the enhanced
 * path — means two schemas, and the no-script path is the one nobody would ever notice had broken.
 *
 * ⚠ WHY NOT `URLSearchParams(new FormData(form))` DIRECTLY, WHICH LOOKS TIDIER: `FormData` can yield a
 * `File` for a file input, `URLSearchParams` would stringify it as "[object File]", and TypeScript
 * refuses the conversion outright for that reason. This form has no file input and never will, so the
 * loop below simply keeps only string values — which is also what `readNewsletterSubmission` does on the
 * server, so the two ends discard the same thing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ WHY THE FORM SITS IN A THEMED CARD, WHICH LOOKS LIKE A DESIGN CHOICE AND IS A CORRECTNESS ONE ══
 *
 * Its main home is `SiteFooter`, whose band is `bg-purple-950` in BOTH themes — literal brand oklch that
 * does not invert. Every themed colour inside it is therefore a hazard: `.field-label` is `text-ink-500`
 * and `Checkbox`'s label is `text-ink-900`, and the `ink-*` ladder DOES invert, so a label written
 * straight onto that band is dark grey on near-black in the LIGHT theme — invisible, and invisible in only
 * one theme, which is exactly how the footer's accessibility-menu bug survived review (see the header of
 * SiteFooter.tsx).
 *
 * The fix is not a pile of `[&_.field-label]:!text-white` overrides reaching into another component's
 * internals — those break silently the day `Field` renames a class, and they break in one theme only. It
 * is to put the form on an ORDINARY THEMED SURFACE floating above the band, so every control inside is
 * correct in both themes by construction and nothing is overridden at all. `EventRegistration`'s success
 * panel makes the same argument for the same reason.
 *
 * ══ THE CONSENT CHECKBOX CARRIES THE WORDING VERSION AS ITS `value` ══
 *
 * `value={CURRENT_CONSENT_VERSION}`, and the sign-up route reads that one field as both "did they tick
 * it" and "which wording did they read". A browser sends neither the name nor the value of an unticked
 * checkbox, so it is unrepresentable for a version to arrive without agreement — which a separate hidden
 * `consentVersion` field would have allowed, recording consent to a sentence nobody saw.
 *
 * The label is `currentConsentText()` VERBATIM. It must be: `lib/newsletter/consent.ts` exists to
 * guarantee that the sentence shown is the sentence stored, and paraphrasing it here would break that
 * guarantee in the one direction that matters — the stored evidence would no longer match the screen.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleCheck, Mail, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { EMAIL_MAX_LENGTH, type NewsletterSource } from "@/lib/newsletter/address";
import { CURRENT_CONSENT_VERSION, currentConsentText } from "@/lib/newsletter/consent";
import { NEWSLETTER_PATH, NEWSLETTER_SUBSCRIBE_ENDPOINT } from "@/lib/newsletter/paths";
import { cn } from "@/lib/utils";

export interface NewsletterSignupProps {
  /**
   * Which surface this is, from the closed list in lib/newsletter/address.ts.
   *
   * A closed list rather than free text because `source` is a FILTER on the studio's screen: one
   * component shipping `"footer "` with a trailing space would create a second option in that filter
   * that looks identical to the first and matches none of the same rows.
   */
  source: NewsletterSource;
  /** The heading. A real heading element — see `headingLevel`. */
  heading?: string;
  /** One or two sentences above the field. Says what arrives and how often. */
  blurb?: ReactNode;
  /**
   * Which heading level to render.
   *
   * ⚠ NOT decoration. In the footer every column heading is an `h2` because the page's own `h1` is the
   * only level above it, so an `h2` can never skip (contract §11, and the note in SiteFooter). On a page
   * that has its own `h1` and section `h2`s, this is an `h3`.
   */
  headingLevel?: 2 | 3;
  className?: string;
}

/**
 * What the server said, and enough to render it.
 *
 * ⚠ THERE WAS AN `attempt: number` HERE AND IT HAS BEEN DELETED, because its comment named a mechanism
 * that was not the mechanism — the shape this repository treats as worse than no comment at all. It read
 * "incremented per attempt, so the focus effect fires again on a second identical failure", and the effect
 * that moves focus depends on the `failure` OBJECT, not on any field of it. `setFailure` is always given a
 * fresh object literal, so its identity changes on every refusal and the effect re-runs whether or not a
 * single value inside it differs. The counter was written, stored and never read by anything.
 *
 * ⚠ SO THE REAL RULE IS ABOUT THE DEPENDENCY, AND IT IS RECORDED WHERE IT CAN BE BROKEN: see the effect
 * below. Narrowing that dependency to `failure?.message` — which looks like a tidy-up — is what would
 * genuinely stop focus moving on a second identical refusal, and no counter here would save it.
 */
interface Failure {
  message: string;
  /** Keyed by field name, exactly as `lib/api.ts` sends them. */
  fieldErrors: Record<string, string[]>;
}

/**
 * Narrow an unknown JSON body far enough to read what this form needs.
 *
 * Copied in shape from `EventRegistration`'s reader, deliberately: both talk to `lib/api.ts`'s error
 * body, and a second, subtly different narrowing of the same contract is how one of them ends up
 * dropping `fieldErrors` on a body the other reads fine.
 */
function readBody(body: unknown): { message: string | null; fieldErrors: Record<string, string[]> } {
  if (typeof body !== "object" || body === null) return { message: null, fieldErrors: {} };
  const record = body as Record<string, unknown>;

  const message =
    typeof record.message === "string" && record.message.trim().length > 0
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

/** The sentence shown when the handler answered but said nothing this form could read. */
const OPAQUE_FAILURE =
  "Your sign-up could not be completed. Please try again in a moment — nothing has been saved, so " +
  "nothing has been half-done.";

/** A connection that never got there. Says explicitly that nothing was recorded. */
const OFFLINE_FAILURE =
  "Your sign-up could not be sent — the connection failed, and nothing has been recorded. Check your " +
  "connection and try again.";

export function NewsletterSignup({
  source,
  heading = "The Centre's newsletter",
  blurb,
  headingLevel = 2,
  className
}: NewsletterSignupProps) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const failureRef = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef<HTMLDivElement | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /**
   * The page the reader was on when they signed up.
   *
   * ⚠ RENDERED AS A HIDDEN INPUT RATHER THAN READ IN THE HANDLER, so the NO-SCRIPT path carries it too.
   * `usePathname()` runs during the server render of this client component, so the attribute is already
   * in the HTML the reader receives — a value computed in `onSubmit` would be present for one path and
   * silently absent for the other, and "which page were they reading" is the useful half of provenance
   * for a form that appears on every page of the site.
   */
  const pathname = usePathname();

  /**
   * A failed submit MOVES FOCUS. `Field` wires its message with `aria-describedby` and deliberately
   * leaves it silent, so announcing the refusal is this form's job: focus lands on the invalid control,
   * whose description is then read out, or on the summary when the refusal was not about a single box.
   *
   * ⚠ THE DEPENDENCY IS THE WHOLE `failure` OBJECT, AND THAT IS WHAT MAKES A REPEATED REFUSAL ANNOUNCE
   * ITSELF. `setFailure` is always called with a NEW object literal, so submitting the same bad address
   * twice produces two distinct values and React re-runs this effect both times — focus returns to the
   * box, and its `aria-describedby` sentence is read out again. Depending on `failure?.message` instead
   * would compare equal on the second attempt, the effect would not run, and a screen-reader user would
   * press the button and be told nothing at all. It is the kind of narrowing a linter never objects to.
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

  /** Success REPLACES the form, so focus has to be put somewhere — on the confirmation itself. */
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    /**
     * ⚠ FIRST STATEMENT, BEFORE ANY `await` (contract §10). React nulls `currentTarget` across an await,
     * and the crash then lands on the line that reads the form rather than on the line that awaited.
     */
    const form = event.currentTarget;
    const data = new FormData(form);
    event.preventDefault();

    // The exact encoding a native form POST produces. See the header for why not `new
    // URLSearchParams(data)`.
    const body = new URLSearchParams();
    data.forEach((value, key) => {
      if (typeof value === "string") body.append(key, value);
    });

    setSubmitting(true);
    setFailure(null);

    try {
      const response = await fetch(NEWSLETTER_SUBSCRIBE_ENDPOINT, {
        method: "POST",
        headers: {
          /**
           * ⚠ THIS HEADER IS WHAT ASKS FOR A JSON ANSWER INSTEAD OF A REDIRECT.
           *
           * `newsletterWantsJson()` on the server tests for exactly this string. Without it the handler
           * answers `303 See Other`, `fetch` follows the redirect transparently, and this code would
           * receive the HTML of the newsletter page and report a successful sign-up as a failure to parse
           * — the enhanced path silently broken while the plain one worked perfectly.
           */
          accept: "application/json"
          // ⚠ NO `content-type` HEADER. `fetch` sets `application/x-www-form-urlencoded;charset=UTF-8`
          // itself for a `URLSearchParams` body, and setting it by hand risks writing one the body is not.
        },
        // Same-origin, so the handler's `assertSameOrigin` sees an `Origin` it recognises.
        credentials: "same-origin",
        body
      });

      // Tolerant of a body that is not JSON: a proxy error page or a 502 from the edge is HTML, and
      // `response.json()` would throw a parse error that says nothing about what actually went wrong.
      const payload: unknown = await response.json().catch(() => null);
      const { message, fieldErrors } = readBody(payload);

      if (!response.ok) {
        // ⚠ A FRESH OBJECT, NEVER A MUTATION OF THE PREVIOUS ONE. Its identity is what re-fires the focus
        // effect above on a second identical refusal — the reason the updater form and its counter went.
        setFailure({ message: message ?? OPAQUE_FAILURE, fieldErrors });
        return;
      }

      /**
       * The handler's own sentence, rendered verbatim.
       *
       * ⚠ NOT a sentence written here. The sign-up route answers IDENTICALLY for every address — a new
       * one, one already waiting to confirm, one already subscribed — because a form that said "you are
       * already subscribed" would be an oracle anybody could use to test whether a colleague reads this
       * newsletter. Composing a different confirmation here from the status code would reopen exactly
       * that hole from the client side.
       */
      setDone(message ?? "Thank you. Check your inbox for a link to confirm.");
    } catch {
      setFailure({ message: OFFLINE_FAILURE, fieldErrors: {} });
    } finally {
      setSubmitting(false);
    }
  };

  const Heading = headingLevel === 2 ? "h2" : "h3";

  // ── Done ──────────────────────────────────────────────────────────────────

  if (done) {
    return (
      <div
        ref={doneRef}
        tabIndex={-1}
        /**
         * `status`, not `alert`: the reader asked for this and is not being interrupted. Focus is moved
         * here as well, because the form they were standing in has just been removed from the page.
         *
         * ⚠ A THEMED SURFACE WITH A LITERAL-COLOURED HEADING, never a `bg-success-100` panel. The status
         * ramps are literal and do not invert; the `ink-*` ladder does. A `text-ink-700` paragraph on a
         * pale green panel is near-white on pale green under `data-theme="dark"` — the same trap
         * `EventRegistration` documents.
         */
        role="status"
        className={cn(
          "rounded-lg border border-success-600/25 bg-card p-5 shadow-sm outline-none sm:p-6",
          className
        )}
      >
        <Heading className="flex items-start gap-2.5 font-display text-base font-semibold leading-snug text-success-600">
          <CircleCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
          Nearly there — one more click
        </Heading>

        <p className="mt-3 text-sm leading-relaxed text-ink-700">{done}</p>

        {/*
          WHY NOTHING HAS ARRIVED YET, STATED HERE RATHER THAN LEFT TO BE INFERRED. Double opt-in is
          unusual enough that a reader who is not told to expect a second step concludes the form failed
          and signs up again — which is why the sentence names the step instead of thanking them twice.
        */}
        <p className="mt-2 text-sm leading-relaxed text-ink-500">
          Nothing will be sent to you until you open that link, and the link works for three days. If it
          does not arrive, signing up again is safe — it never creates a second subscription.
        </p>
      </div>
    );
  }

  // ── The form ──────────────────────────────────────────────────────────────

  const emailError = failure?.fieldErrors.email?.[0];
  const consentError = failure?.fieldErrors.consent?.[0];

  /**
   * Errors the server reported against a field this form does not render.
   *
   * Shown with the summary rather than dropped. A refusal nobody can see is a form that appears to fail
   * for no reason — and it is the shape a schema change takes when the two ends drift apart.
   */
  const unplaced = failure
    ? Object.entries(failure.fieldErrors)
        .filter(([key]) => key !== "email" && key !== "consent")
        .flatMap(([key, messages]) => messages.map((message) => `${key}: ${message}`))
    : [];

  return (
    <div className={cn("rounded-lg border border-line-200 bg-card p-5 shadow-sm sm:p-6", className)}>
      <Heading className="flex items-start gap-2.5 font-display text-base font-semibold leading-snug text-ink-900">
        <Mail aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-purple-700" />
        {heading}
      </Heading>

      {blurb ? <p className="mt-2 text-sm leading-relaxed text-ink-500">{blurb}</p> : null}

      {failure ? (
        <div
          ref={failureRef}
          tabIndex={-1}
          // `alert`: the reader has just tried to do something and been stopped, which is the one case
          // that warrants interrupting them.
          role="alert"
          className="mt-4 flex items-start gap-2.5 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700 outline-none"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {failure.message}
            {unplaced.length > 0 ? <span className="mt-1.5 block">{unplaced.join(" ")}</span> : null}
          </span>
        </div>
      ) : null}

      <form
        ref={formRef}
        /**
         * ⚠ `method` AND `action` ARE REAL, AND THEY ARE THE NO-SCRIPT PATH. Deleting either — because
         * `onSubmit` "handles it" — is what would turn this into a form that does nothing at all for a
         * reader whose scripts have not loaded, with no error anywhere to say so.
         */
        method="post"
        action={NEWSLETTER_SUBSCRIBE_ENDPOINT}
        onSubmit={onSubmit}
        /**
         * ⚠ NO `noValidate`, UNLIKE `EventRegistration`. That form does its own emptiness checks and
         * therefore has to suppress the browser's; this one wants the browser's, because they are the
         * ONLY client-side checks the no-script path can possibly get. `required` on the field and on the
         * checkbox is what stops an empty submission making a round trip, in both paths equally.
         */
        // The half a screen-reader user gets; the dimming below is the half a sighted reader gets.
        aria-busy={submitting || undefined}
        className={cn(
          "mt-4 flex flex-col gap-4 transition-opacity duration-200 ease-out",
          submitting && "opacity-60"
        )}
      >
        {/*
          Provenance, and both are hidden inputs so the no-script path carries them too. `source` is from
          the closed list; `sourcePath` is where they actually were.
        */}
        <input type="hidden" name="source" value={source} />
        <input type="hidden" name="sourcePath" value={pathname} />

        <Field
          label="Email address"
          required
          error={emailError}
          help="The only thing it is used for. It is not passed to anybody."
        >
          <Input
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={EMAIL_MAX_LENGTH}
            placeholder="you@example.org"
            /*
              ⚠ NO `invalid` PROP. `Input` reads `field.invalid` off `useFieldContext()` (Input.tsx line
              83), so passing `error` to the `Field` above already produces `aria-invalid="true"` here —
              which is what the focus effect above searches for. Passing both would be a second source of
              truth for the same fact, and the day they disagree the ring and the message would too.
            */
          />
        </Field>

        {/*
          ⚠ `Checkbox`, NOT `Field` wrapped around one. `Field` renders a real `<label>` and nesting a
          control that carries its own label inside it gives that control two — see Field.tsx's header.

          ⚠ `value` IS THE CONSENT VERSION. See the file header: this is what makes "ticked" and "which
          wording" one indivisible fact.
        */}
        <Checkbox
          name="consent"
          value={CURRENT_CONSENT_VERSION}
          required
          label={currentConsentText()}
          /**
           * ⚠ `!items-start` WITH THE BANG, AND IT IS NOT OPTIONAL.
           *
           * `Checkbox` sets `items-center` on its label, which is right for a three-word label and wrong
           * for this one — the consent sentence runs to three lines, and centring puts the box halfway
           * down the paragraph, next to no line in particular. `cn()` is a plain join, so class ORDER in
           * the attribute decides nothing: both utilities set `align-items`, and Tailwind emits
           * `items-start` BEFORE `items-center` in its own fixed order, so the component's class would win
           * every time. `!` is the only thing that beats it (contract §5, and the same reason SiteFooter's
           * accessibility-menu overrides carry it).
           */
          className="!items-start"
          aria-invalid={consentError ? true : undefined}
        />

        {consentError ? (
          <p className="flex items-start gap-1.5 text-sm text-error-600">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{consentError}</span>
          </p>
        ) : null}

        <div>
          <Button
            type="submit"
            isLoading={submitting}
            loadingLabel="Signing up…"
            icon={Mail}
            fullWidth
          >
            Send me the newsletter
          </Button>
        </div>
      </form>

      {/*
        ══════════════════════════════════════════════════════════════════════════════════════════
        ⚠ THE ONLY LINK TO `/newsletter` A READER MEETS WITHOUT GOING LOOKING FOR IT — WHICH IS WHY IT
        IS HERE, AND IS A NARROWER CLAIM THAN THIS NOTE USED TO MAKE.

        ⚠ IT USED TO READ "THE ONLY LINK ANYWHERE IN THE PRODUCT", over an enumeration of "not the
        header, not the footer's reference row, not the A–Z index". Counted on a running server,
        `href="/newsletter"` appears 3× on `/newsletter/confirm` (its breadcrumb, its "sign up again"
        link, and this card), 2× on `/newsletter/unsubscribe` (its breadcrumb and this card), 2× on
        `/a-z` (the `SITE_SECTIONS` entry and this card), 1× on every ordinary page of the site, and 0×
        on `/newsletter` itself. The A–Z clause is the NEWEST falsehood — `SITE_SECTIONS` gained
        `/newsletter` in the same pass that added it to the sitemap. The heading was never true at all:
        both breadcrumbs are unconditional consts inside the confirm and unsubscribe pages, which are
        part of this very feature, so no build that has ever had those pages in it had only one link to
        `/newsletter`. What survives of the enumeration: no header nav item points here — though those
        menus are editor-managed through `/studio/navigation`, so that is a fact about today's data and
        not a guarantee — and `REFERENCE_LINKS` in SiteFooter is `/a-z`, `/accessibility`, `/credits`
        and nothing else.

        ⚠ IF YOU RECOUNT THOSE NUMBERS, DO NOT COUNT A 404 WITH `curl` — it will tell you zero and it is
        lying. Next serves a not-found through its `__next_error__` shell, whose flight payload carries a
        CLIENT component as a module reference rather than as rendered HTML, so this whole card is
        mounted there and never appears in the response body. The figures above are for ordinary pages,
        where the card is server-rendered into the HTML and `curl` sees what a reader sees. This trap
        very nearly put a fresh false sentence into this very comment.

        ⚠ THE STALE SENTENCE DID MEASURABLE DAMAGE, which is why it is recorded here rather than quietly
        overwritten: a later agent quoted "not the A–Z index" out of this comment as established fact,
        and two agents then spent a pass disagreeing about whether the footer linked the page at all.

        THE WARNING SURVIVES IN THE NARROWER FORM, because none of those other links can DISCOVER the
        page for a reader who does not already know it exists. Both breadcrumbs sit on pages a reader
        gets to by following the one-time link in a message sent because they had already signed up —
        circular. The A–Z entry is real, but it takes opening the index and knowing what to scan for,
        and it files under T rather than N, because `SiteSection.name` is verbatim what the page calls
        itself: "The Centre's newsletter". Delete the link below and the page goes back to being
        findable only by somebody already looking for it — the exact defect this whole feature was
        rescued from, in miniature: a facility fully built and arrived at by nobody.

        This form is rendered in the footer of every public page, so one conditional link here makes the
        page reachable from everywhere at once. It also earns its place: the footer has room for a
        promise and no room for the three things a reader is actually agreeing to, and that page is where
        those are set out.

        ⚠ HIDDEN WHEN THE READER IS ALREADY ON THAT PAGE. A link to the page you are standing on is not
        navigation, it is noise — and on the `?state=` pass it would sit directly under an outcome banner
        offering to take somebody back to where they already are. `usePathname()` is already read above
        for `sourcePath`, so this costs nothing extra.
        ══════════════════════════════════════════════════════════════════════════════════════════
      */}
      {pathname !== NEWSLETTER_PATH ? (
        <p className="mt-4 border-t border-line-200 pt-3 text-xs leading-relaxed text-ink-500">
          <Link
            href={NEWSLETTER_PATH}
            className="underline decoration-line-200 underline-offset-2 transition-colors hover:text-purple-700 hover:decoration-purple-700"
          >
            What the newsletter is, and what you are agreeing to
          </Link>
        </p>
      ) : null}
    </div>
  );
}
