import type { Metadata } from "next";
import Link from "next/link";
import { MailX } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { PageHero } from "@/components/site/PageHero";
import { maskEmail } from "@/lib/newsletter/address";
import {
  NEWSLETTER_PATH,
  NEWSLETTER_UNSUBSCRIBE_ENDPOINT,
  NEWSLETTER_UNSUBSCRIBE_PATH
} from "@/lib/newsletter/paths";
import { newsletterNotice } from "@/lib/newsletter/states";
import { NEWSLETTER_TOKEN_QUERY_KEY, verifyNewsletterToken } from "@/lib/newsletter/tokens";
import { pageMetadata } from "@/lib/seo";
import { StateNotice } from "../StateNotice";

/**
 * /newsletter/unsubscribe — where the "stop these emails" link in every message lands.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ██  THE MOST IMPORTANT PAGE IN THIS FEATURE. EVERY DECISION HERE FAVOURS LETTING SOMEBODY OUT.  ██
 *
 * A reader who cannot make the mail stop does not conclude that a website has a bug. They conclude that
 * the institution will not let them leave, and their next action is a spam report or a complaint to a
 * regulator. So:
 *
 *   • **No branch of this page is a dead end.** Every outcome — success, an unreadable link, an address
 *     that is not on the list — names another way out: the link in a newer message, or the contact page,
 *     where somebody will remove the address by hand.
 *   • **"Not on the list" is presented as SUCCESS, not as an error.** The reader clicked "unsubscribe" and
 *     what they wanted is already true. A page headed "not found" after that click reads as a broken link.
 *     (The tone lives in lib/newsletter/states.ts, where the reasoning is written next to the sentence.)
 *   • **The token never expires**, so a message dug out of a three-year-old archive still works. That is a
 *     deliberate trade set out in lib/newsletter/tokens.ts: the worst case for a leaked unsubscribe link is
 *     somebody stops receiving something they can sign up for again in ten seconds, and the worst case for
 *     an expired one is a person who cannot make the mail stop.
 *
 * ⚠ AND IT IS STILL A POST, FOR THE OPPOSITE OF A PEDANTIC REASON. If opening this URL unsubscribed the
 * reader, then every corporate mail gateway and "safe links" scanner that pre-fetches URLs in messages
 * would unsubscribe people who never asked — silent, undetectable data loss wearing the costume of a
 * privacy feature. So the emailed link lands here, this page names the address, and a real form does the
 * work. No scanner performs a POST.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THIS PAGE ASKS THE DATABASE NOTHING, UNLIKE THE CONFIRMATION PAGE — deliberately. The confirmation page
 * reads one row so that a second click is not offered a pointless button. Here, showing the button
 * unconditionally is the SAFER answer: if the row is already UNSUBSCRIBED the handler says so idempotently,
 * and if a read were to fail or a status were misread the reader would be shown a page that appears to
 * refuse them. There is no state in which this page should decline to offer the button.
 *
 * ⚠ `noIndex`. The URL carries a signed token. A crawler that indexed it would publish a working
 * unsubscribe link for a real person's address in a search result — where anybody could use it.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Unsubscribe from the newsletter",
  description: "Stop the Centre's newsletter being sent to your address. One click, no account needed.",
  path: NEWSLETTER_UNSUBSCRIBE_PATH,
  noIndex: true
});

const BREADCRUMBS = [
  { name: "Home", href: "/" },
  { name: "The newsletter", href: NEWSLETTER_PATH },
  { name: "Unsubscribe", href: NEWSLETTER_UNSUBSCRIBE_PATH }
] as const;

const LINK = "underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700";

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NewsletterUnsubscribePage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  /**
   * ⚠ A `?state=` CODE WINS OVER THE TOKEN. After the form is posted the handler answers `303` back to this
   * page with a state code and without the token, so on that pass there is nothing to verify and the page's
   * whole job is to render the outcome. Verifying first would print "that link could not be read" over a
   * successful unsubscribe — which, on this page of all pages, is the worst possible thing to say.
   */
  const notice = newsletterNotice("unsubscribe", params.state);
  if (notice) {
    return (
      <UnsubscribeShell>
        <StateNotice notice={notice} />
        <OtherWaysOut />
      </UnsubscribeShell>
    );
  }

  const token = firstValue(params[NEWSLETTER_TOKEN_QUERY_KEY]);

  if (!token) {
    return (
      <UnsubscribeShell>
        <div className="panel p-6 sm:p-8">
          <h2 className="display-title text-lg">This page needs the link from a message</h2>
          <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
            Every newsletter the Centre sends carries a link at the foot of it that stops them. That link is
            what identifies the address to remove — it means nobody has to sign in, and it also means nobody
            else can unsubscribe you. Open any message from the newsletter and use the link inside it.
          </p>
          <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
            If you no longer have a copy,{" "}
            <Link href="/contact" className={LINK}>
              write to the Centre
            </Link>{" "}
            with the address you would like removed and somebody will remove it by hand. You will not be
            asked to explain why.
          </p>
        </div>
        <OtherWaysOut />
      </UnsubscribeShell>
    );
  }

  /** ⚠ Purpose passed IN, never read from the token — a confirmation token must not work here. */
  const verified = verifyNewsletterToken("unsubscribe", token);

  if (!verified.ok) {
    /**
     * ⚠ ONE ANSWER FOR ALL THREE REASONS, unlike the confirmation page.
     *
     * An unsubscribe token carries no expiry at all, so `"expired"` is unreachable by construction and a
     * branch for it would be a sentence about a deadline that does not exist. Malformed and forged are
     * collapsed because the only thing worth telling this reader is how to get out anyway — which the
     * sentence in lib/newsletter/states.ts does, and which `OtherWaysOut` below repeats in full.
     */
    const failure = newsletterNotice("unsubscribe", "bad-link");
    return (
      <UnsubscribeShell>
        {failure ? <StateNotice notice={failure} /> : null}
        <OtherWaysOut />
      </UnsubscribeShell>
    );
  }

  return (
    <UnsubscribeShell>
      <div className="panel p-6 sm:p-8">
        <h2 className="display-title text-lg">Stop the newsletter</h2>

        <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
          {/*
            ⚠ MASKED. This link may have been forwarded — that is exactly the case `maskEmail` was written
            for — so the page proves it has the right address without printing it in full for whoever else
            received the message.
          */}
          Press the button and{" "}
          <strong className="font-semibold text-ink-900">{maskEmail(verified.emailKey)}</strong> will be
          removed from the newsletter immediately. Nothing further will be sent to it.
        </p>

        <form method="post" action={NEWSLETTER_UNSUBSCRIBE_ENDPOINT} className="mt-6">
          <input type="hidden" name={NEWSLETTER_TOKEN_QUERY_KEY} value={token} />
          {/*
            ⚠ `variant="danger"` WOULD BE WRONG HERE, and the choice is worth a line. Red is the colour this
            application uses for a refusal or a destructive mistake; unsubscribing is neither. It is a
            perfectly ordinary thing a reader is entitled to do, and dressing it as a hazard is a small piece
            of pressure not to. The same argument is why `SUBSCRIBER_STATUS_TONES` colours UNSUBSCRIBED
            neutral rather than error.
          */}
          <Button type="submit" icon={MailX}>
            Unsubscribe this address
          </Button>
        </form>

        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          What is kept afterwards is a note that this address asked to stop, and nothing else. It is kept on
          purpose: without it, a later import or a form filled in by somebody else could quietly put you back
          on the list.
        </p>
      </div>
    </UnsubscribeShell>
  );
}

/** The frame, so every branch shares one layout and one heading structure. */
function UnsubscribeShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHero
        eyebrow="The newsletter"
        title="Unsubscribe"
        description="Stopping the newsletter takes one click and needs no account. Nobody will ask you why, and nothing else about you is kept."
        breadcrumbs={BREADCRUMBS}
      />
      <section className="shell pb-24">
        <div className="shell-narrow flex flex-col gap-8 px-0">{children}</div>
      </section>
    </>
  );
}

/**
 * The other ways out, under every branch.
 *
 * ⚠ THIS IS NOT BOILERPLATE. It is rendered under the failure states as well as the successful ones,
 * because the whole argument of this page is that no branch may be a dead end: a reader whose link will not
 * work has to leave this page knowing two things that still would.
 */
function OtherWaysOut() {
  return (
    <div className="panel p-6 sm:p-8">
      <h2 className="display-title text-lg">Other ways to stop it</h2>
      <ul className="prose-measure mt-3 flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-ink-700">
        <li>
          The link at the foot of any newer message from the newsletter does the same job. Those links do not
          expire, so the newest copy you have will work.
        </li>
        <li>
          <Link href="/contact" className={LINK}>
            Write to the Centre
          </Link>{" "}
          with the address you want removed. Somebody will remove it by hand, and you will not be asked to
          explain why.
        </li>
        <li>
          Marking a message as junk in your own mail programme stops it reaching you, but the Centre never
          finds out — so the address stays on the list. One of the two above is better for both sides.
        </li>
      </ul>
    </div>
  );
}
