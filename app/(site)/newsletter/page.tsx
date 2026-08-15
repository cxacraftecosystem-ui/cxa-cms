import type { Metadata } from "next";
import Link from "next/link";
import { MailX, ShieldCheck, Timer } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { NewsletterSignup } from "@/components/site/NewsletterSignup";
import { PageHero } from "@/components/site/PageHero";
import { CONFIRMATION_TTL_HOURS } from "@/lib/newsletter/tokens";
import { mailerConfigured } from "@/lib/newsletter/delivery";
import { newsletterNotice } from "@/lib/newsletter/states";
import { NEWSLETTER_PATH } from "@/lib/newsletter/paths";
import { pageMetadata } from "@/lib/seo";
import { StateNotice } from "./StateNotice";

/**
 * /newsletter — the sign-up page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS PAGE EXISTS WHEN THE FORM IS ALREADY IN THE FOOTER OF EVERY PAGE.
 *
 * Three jobs, and only the first is the obvious one:
 *
 *   1. **An address that can be quoted.** A leaflet, a conference slide or a colleague's email can print
 *      "sign up at …/newsletter". A footer cannot be linked to.
 *   2. **The destination of the no-script sign-up.** A browser with scripting off posts the footer's form
 *      and receives `303 See Other` to THIS page with a `?state=` code — so this page is where the outcome
 *      of that submission is actually explained. Without it, that reader's sign-up would end on a 404 and
 *      they would have no idea whether it worked. `sendUnsubscribeReceipt()` also prints this address as
 *      the way back for somebody who changes their mind.
 *   3. **Room to say what subscribing means**, which a footer has no space for: how often, what arrives,
 *      that it takes two steps, and how to leave. The footer form promises a newsletter; this page is
 *      where the Centre says what it is promising.
 *
 * ⚠ THE `?state=` CODE IS LOOKED UP IN A TABLE AND NEVER RENDERED. `newsletterNotice()` maps a code to a
 * sentence this application wrote; an unrecognised code renders nothing at all. Printing the query
 * parameter would let anybody craft a link showing a reader any message they liked over the Centre's
 * branding — the same rule the studio's `?problem=` codes follow.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ `force-dynamic`. The page reads `searchParams`, and a prerendered copy would serve one reader's
 * outcome banner to the next. It also means the consent wording rendered into the form is always the
 * CURRENT one, which matters: a statically cached form would post a version the register may have moved
 * past, and every submission from it would be refused as stale.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "The Centre's newsletter",
  description:
    "A few times a year: what the Centre has recorded, published and restored. Sign up with your email address — it is used for nothing else, and every message carries a one-click link to stop them.",
  path: NEWSLETTER_PATH
});

const BREADCRUMBS = [
  { name: "Home", href: "/" },
  { name: "The newsletter", href: NEWSLETTER_PATH }
] as const;

/**
 * The three promises, each one a fact about the implementation rather than a sentiment.
 *
 * A function of `canSendEmail` rather than a constant, because the first promise describes a message
 * being SENT — and on a deployment with no mail transport (nothing registers one until
 * `instrumentation.ts` exists; see lib/newsletter/delivery.ts) that would be a promise about mail
 * nobody will ever receive. The degraded wording says what actually happens: the sign-up is recorded,
 * and the confirmation goes out when the Centre begins sending. The two-step guarantee itself — no
 * newsletter without a confirming click — is true either way, so the title does not change.
 */
function promisesFor(canSendEmail: boolean): ReadonlyArray<{
  icon: typeof ShieldCheck;
  title: string;
  body: string;
}> {
  return [
    {
      icon: Timer,
      title: "It takes two steps, on purpose",
      body: canSendEmail
        ? "Signing up records nothing but a pending entry and sends one message to the address you gave. " +
          `That message carries a link, valid for ${CONFIRMATION_TTL_HOURS} hours, and until somebody opens ` +
          "it no newsletter is ever sent. It means nobody can subscribe you by typing your address into this " +
          "form, and it means the Centre never writes to an address that has not asked for it."
        : "Signing up records nothing but a pending entry. The Centre is not sending messages yet, so the " +
          "confirmation is not immediate: when sending begins, a message with a link goes to the address " +
          "you gave, and until somebody opens that link no newsletter is ever sent. It means nobody can " +
          "subscribe you by typing your address into this form, and it means the Centre never writes to an " +
          "address that has not asked for it."
    },
    {
      icon: MailX,
      title: "Leaving takes one click, for ever",
      body:
        "Every message carries a link that stops them immediately. It needs no account and no password, it " +
        "does not expire, and it still works if you find the message in an archive years later. What is " +
        "kept afterwards is a note that you asked to stop — and nothing else — so that a later import " +
        "cannot put you back on the list by accident."
    },
    {
      icon: ShieldCheck,
      title: "The address is used for this and nothing else",
      body:
        "It is not passed to anybody, not sold, and not used to write to you about anything other than the " +
        "newsletter. Alongside it the Centre keeps the exact wording you agreed to, so that what you " +
        "consented to can be answered years later with the sentence you actually read rather than with " +
        "whatever the wording has become."
    }
  ];
}

export default async function NewsletterPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const notice = newsletterNotice("signup", params.state);

  /**
   * Whether the copy on this page may promise that a message is sent — read per request (the page is
   * `force-dynamic`) from the mail seam, lib/newsletter/delivery.ts, the same way
   * app/studio/users/page.tsx hands `canSendEmail` to its screen. Only the boolean is used; no
   * provider name or other environment detail reaches the markup. Until an adapter is registered
   * from `instrumentation.ts` this is false everywhere, and the page says a sign-up is RECORDED and
   * messages start when the Centre begins sending — never that one is already on its way.
   */
  const canSendEmail = mailerConfigured();
  const promises = promisesFor(canSendEmail);

  return (
    <>
      <PageHero
        eyebrow="Keep in touch"
        title="The Centre's newsletter"
        description="A few times a year, an account of what the Centre has recorded, published and restored — the crafts documented, the field records opened, the work of the artisans it is written with. No more than that, and nothing else."
        breadcrumbs={BREADCRUMBS}
      />

      <section className="shell pb-24">
        <div className="shell-narrow px-0">
          {/*
            THE BANNER COMES FIRST, ABOVE THE FORM. It is the answer to something the reader just did, and
            an outcome printed below the form they are looking at is an outcome they will not see. Its id is
            also the target of the redirect's `#outcome` fragment, so focus lands here.
          */}
          {notice ? <StateNotice notice={notice} className="mb-8" /> : null}

          <Reveal>
            {/*
              ⚠ `headingLevel={2}`, not 3. The hero above renders the page's `h1` and nothing between it and
              this is a heading, so an `h3` here would skip a level (contract §11).

              ⚠ `source="newsletter-page"` — from the closed list in lib/newsletter/address.ts, so the
              studio's source filter stays a closed set. This is what lets an administrator tell a sign-up
              made deliberately from this page apart from one made from the footer of an article.
            */}
            <NewsletterSignup
              source="newsletter-page"
              headingLevel={2}
              heading="Sign up"
              blurb={
                canSendEmail
                  ? "Enter the address it should go to. You will be sent one message with a link to confirm, and nothing else until you open it."
                  : "Enter the address it should go to. It joins the list straight away; a message with a link to confirm follows when the Centre begins sending, and no newsletter arrives until you open it."
              }
            />
          </Reveal>

          <Reveal className="mt-12">
            <h2 className="display-title text-xl">What you are agreeing to</h2>

            <ul className="mt-6 flex flex-col gap-6">
              {promises.map((promise) => {
                const Icon = promise.icon;
                return (
                  <li key={promise.title} className="flex items-start gap-4">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line-200 bg-surface-50 text-purple-700"
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <div>
                      {/* h3 under the h2 above. */}
                      <h3 className="font-display text-base font-semibold leading-snug text-ink-900">
                        {promise.title}
                      </h3>
                      <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">
                        {promise.body}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Reveal>

          <Reveal className="mt-12">
            <div className="panel p-6 sm:p-8">
              <h2 className="display-title text-lg">If something is not working</h2>
              {/* The same gate as the promises above: "check your bulk-mail folder" is advice about a
                  message that, with no transport, never left — the honest sentence is that none is
                  expected yet. */}
              <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
                {canSendEmail
                  ? "If the confirmation message does not arrive, look in whichever folder your mail programme files bulk mail in, and check the address for a typo. Signing up a second time is safe: it never creates a second subscription, and it sends a fresh link."
                  : "The Centre has not begun sending messages yet, so the confirmation is not expected straight away — nothing is wrong if none has arrived. Signing up a second time is safe either way: it never creates a second subscription."}
              </p>
              <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
                If you are trying to STOP the newsletter and the link in your copy will not work, the link
                at the foot of any newer message will do the same job — or{" "}
                <Link href="/contact" className="underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700">
                  write to the Centre
                </Link>{" "}
                and the address will be removed by hand. Nobody should have to ask twice.
              </p>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
