import type { Metadata } from "next";
import Link from "next/link";
import { MailX, ShieldCheck, Timer } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { NewsletterSignup } from "@/components/site/NewsletterSignup";
import { PageHero } from "@/components/site/PageHero";
import { CONFIRMATION_TTL_HOURS } from "@/lib/newsletter/tokens";
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
 * ⚠ THE FIRST ONE IS NO LONGER CONDITIONAL. It used to have a second wording for a deployment that could
 * not send mail, and that wording told readers their confirmation "follows" at some unstated time. The
 * confirmation now goes out inline the moment somebody signs up (lib/newsletter/delivery.ts), and on a
 * deployment without a sender it is queued and sent by the drain once there is one — so the promise below
 * is true in both cases, and a public page has no business describing the operator's configuration.
 */
const PROMISES: ReadonlyArray<{
  icon: typeof ShieldCheck;
  title: string;
  body: string;
}> = [
    {
      icon: Timer,
      title: "It takes two steps, on purpose",
      body:
        "Signing up records nothing but a pending entry and sends one message to the address you gave. " +
        `That message carries a link, valid for ${CONFIRMATION_TTL_HOURS} hours, and until somebody opens ` +
        "it no newsletter is ever sent. It means nobody can subscribe you by typing your address into this " +
        "form, and it means the Centre never writes to an address that has not asked for it."
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

export default async function NewsletterPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const notice = newsletterNotice("signup", params.state);

  const promises = PROMISES;

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
              blurb="Enter the address it should go to. You will be sent one message with a link to confirm, and nothing else until you open it."
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
              <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
                If the confirmation message does not arrive, look in whichever folder your mail programme
                files bulk mail in, and check the address for a typo. Signing up a second time is safe: it
                never creates a second subscription, and it sends a fresh link.
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
