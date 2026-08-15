import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ApiError, assertSameOrigin, clientIp, ok, parseJson, route, userAgent } from "@/lib/api";
import { recordEvent, type AuditContext } from "@/lib/audit";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/ratelimit";
import { isLikelySpam, scoreSubmission, spamReasonText } from "@/lib/spam";
import { getSetting } from "@/lib/settings/service";

/**
 * The public contact form.
 *
 * THE ONE THING TO UNDERSTAND ABOUT THIS ROUTE: **the answer is identical whether or not the
 * submission was flagged as spam.** Same status, same body, same sentence. Two reasons, and both of
 * them are about what a different answer would cost:
 *
 *   • Telling a bot it was caught is free information for whoever is tuning it. "Your message was
 *     rejected" is a test result; they change one field and try again until the message stops
 *     appearing, and at that point the filter is worthless.
 *   • Telling a PERSON their message was rejected is worse. A false positive who is told they were
 *     refused does not write again — they conclude the Centre does not want to hear from them, and
 *     nobody ever finds out. Whereas a flagged message that was stored and confirmed is answerable a
 *     day late by an editor who opens the Spam filter.
 *
 * So: score it, store it either way (lib/spam.ts marks, it never deletes), and say thank you.
 *
 * ⚠ THE HONEYPOT CONTRACT WITH THE FORM. The form must render an input that is hidden from sight and
 * from assistive technology, left empty, and named `website` — which is what `ContactFormSection`
 * renders, and the name a script is most likely to fill in. `websiteUrl` and `honeypot` are accepted
 * as aliases, so a mismatch between this route and a form degrades to "the honeypot is unused" rather
 * than to a 422 on every submission. That degradation is not cheap: the honeypot is the ONLY signal
 * weighted heavily enough to mark a submission on its own (lib/spam.ts), so a name this schema does
 * not list is silently dropped by Zod and the filter quietly needs two signals instead of one. Hide
 * the field with CSS plus `tabindex="-1"` and `aria-hidden="true"` — NOT with `type="hidden"`, which
 * most bots skip, and never with `required`.
 *
 * ⚠ THE TIMING CONTRACT IS A DURATION, NOT A TIMESTAMP. The form measures `elapsedMs` between render
 * and submit entirely on the visitor's own clock and posts that; this route turns it into a stamp on
 * the SERVER clock before scoring, so the subtraction in lib/spam.ts stays within one clock. Sending
 * the render time itself would not: a laptop running forty seconds fast makes a genuine enquiry look
 * as though it were submitted instantly, which is half of a spam score. `renderedAt` is still read
 * when no duration arrives, for a page cached from an older release — it is the weaker of the two and
 * only ever the fallback.
 */

export const dynamic = "force-dynamic";

/** `""` and "absent" mean the same thing for an optional box; folded here so nothing downstream cares. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

/** The four forms on the site, matching `ContactSubmission.formKey` in the schema. */
const FORM_KEYS = ["general", "admissions", "collaboration", "media"] as const;

const ContactBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter your name so we know who is writing.")
    .max(120, "Keep the name to 120 characters or fewer."),
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address — it is the only way we can reply.")
    .max(254)
    .email("That does not look like an email address. Check for a missing @ or a typo in the domain."),
  organisation: optionalText(160),
  phone: optionalText(40),
  subject: optionalText(200),
  message: z
    .string()
    .trim()
    .min(10, "Tell us a little more — a sentence or two is enough to route your message to the right person.")
    .max(5000, "Keep the message to 5 000 characters or fewer. Attach detail by email once we reply."),
  formKey: z.enum(FORM_KEYS).default("general"),
  /**
   * The honeypot, under all three names it has been given. See the header.
   *
   * Never rendered back, never stored. ⚠ A name missing from this list is not an error — Zod strips it
   * and the decisive signal simply stops firing — so the list must be widened, never swapped, whenever
   * a form is added.
   */
  website: z.string().max(200).optional(),
  websiteUrl: z.string().max(200).optional(),
  honeypot: z.string().max(200).optional(),
  /** How long the form was on screen, measured on one clock by the browser. The signal the route prefers. */
  elapsedMs: z.number().int().nonnegative().nullish(),
  /** The fallback stamp: a browser clock, so it is only read when no duration arrived. See the header. */
  renderedAt: z.union([z.number().int(), z.string().trim().max(64)]).nullish()
});

/**
 * The neutral confirmation. Returned VERBATIM for a clean submission and for a flagged one.
 *
 * It promises a reply and says nothing about a queue position, a reference number or a state, because
 * every one of those would be a channel through which the two cases could be told apart.
 */
const CONFIRMATION =
  "Thank you — your message has reached the Centre. Somebody will read it and reply to the address you gave.";

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  // Before the body is parsed: a refusal should cost as little as possible, and a script sending
  // megabytes of JSON should not have it read.
  const limited = enforceRateLimit(
    request,
    "contact",
    RATE_LIMITS.contact,
    (phrase) =>
      `This form has been submitted ${RATE_LIMITS.contact.limit} times from your connection in the ` +
      `last few minutes, so it is paused. Try again in ${phrase} — nothing you have already sent has been lost.`
  );
  if (limited) return limited;

  // The feature flag gates the ROUTE, not only the form. A switch that hides the form but leaves the
  // endpoint accepting submissions means messages arriving in a queue nobody has been told to watch.
  const features = await getSetting("features");
  if (!features.contactForm) {
    throw new ApiError(
      503,
      "The contact form is switched off on this site at the moment. The contact page lists the " +
        "Centre's postal address, email address and telephone number, all of which still reach us.",
      { code: "feature_disabled" }
    );
  }

  const body = await parseJson(request, ContactBody);

  const email = body.email.toLowerCase();
  const ipAddress = clientIp(request);
  const agent = userAgent(request);

  // The duration the browser measured, restated as an instant on THIS clock, so lib/spam.ts subtracts two
  // server-clock values however wrong the visitor's clock is. Only when no duration arrived does the browser's
  // own stamp get used, and then the comparison is as unreliable as the header says.
  const renderedAt =
    typeof body.elapsedMs === "number" ? Date.now() - body.elapsedMs : body.renderedAt ?? null;

  const assessment = scoreSubmission({
    // Any of the three field names counts as filled — see the header's honeypot contract.
    honeypot: body.website ?? body.websiteUrl ?? body.honeypot ?? null,
    renderedAt,
    message: body.message,
    email,
    name: body.name,
    subject: body.subject ?? null,
    ipAddress
  });

  const flagged = isLikelySpam(assessment.score);

  const submission = await prisma.contactSubmission.create({
    data: {
      name: body.name,
      email,
      organisation: body.organisation ?? null,
      phone: body.phone ?? null,
      subject: body.subject ?? null,
      message: body.message,
      formKey: body.formKey,
      state: flagged ? "SPAM" : "NEW",
      // The evidence is stored on EVERY row, not only the flagged ones. A score of 0.35 on a message
      // that turned out to be spam is how the weights in lib/spam.ts get corrected; discarding the
      // score for anything below the threshold throws away the only data that would inform that.
      spamScore: assessment.score,
      spamReason: spamReasonText(assessment.reasons),
      ipAddress,
      userAgent: agent?.slice(0, 512) ?? null
    },
    select: { id: true }
  });

  const context: AuditContext = { actor: null, ipAddress, userAgent: agent };

  // METADATA ONLY in the audit entry. The message body is already stored on the submission and the
  // inquiries screen renders it; copying it into `audit_logs` as well would double the amount of
  // somebody's personal correspondence held in a table that is read by more people and gets exported.
  await recordEvent(context, {
    action: "CREATE",
    entityType: "ContactSubmission",
    entityId: submission.id,
    entityLabel: `${body.name} <${email}>`,
    after: {
      formKey: body.formKey,
      state: flagged ? "SPAM" : "NEW",
      spamScore: assessment.score,
      spamReasons: assessment.reasons,
      messageChars: body.message.length,
      hasSubject: Boolean(body.subject)
    }
  });

  // One answer, both paths. Do not add a field here that differs between them.
  return ok({ received: true, message: CONFIRMATION });
});
