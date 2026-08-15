import type { Metadata } from "next";
import Link from "next/link";
import { MailCheck } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { PageHero } from "@/components/site/PageHero";
import { prisma } from "@/lib/db";
import { maskEmail } from "@/lib/newsletter/address";
import {
  NEWSLETTER_CONFIRM_ENDPOINT,
  NEWSLETTER_CONFIRM_PATH,
  NEWSLETTER_PATH
} from "@/lib/newsletter/paths";
import { newsletterNotice } from "@/lib/newsletter/states";
import { NEWSLETTER_TOKEN_QUERY_KEY, verifyNewsletterToken } from "@/lib/newsletter/tokens";
import { pageMetadata } from "@/lib/seo";
import { StateNotice } from "../StateNotice";

/**
 * /newsletter/confirm — where the link in the confirmation email lands.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ██  THIS PAGE MUTATES NOTHING. THAT IS ITS ENTIRE REASON FOR EXISTING.  ██
 *
 * The obvious design is a link that confirms the subscription when it is opened. It is wrong, and the
 * header of lib/newsletter/tokens.ts sets out why:
 *
 *     A link in an email is fetched by things that are not the recipient. Corporate mail gateways,
 *     "safe links" rewriters and antivirus scanners follow every URL in every message BEFORE a person
 *     sees it. A confirmation that mutated on GET would be opened by a security appliance, the
 *     subscription would confirm itself, and the double opt-in — the entire legal basis for sending
 *     anything — would silently become a single opt-in with nothing in the data to show it.
 *
 * So this page VERIFIES the token, shows the reader which address it is about, and offers a real
 * `<form method="post">`. No scanner performs a POST. The cost is one extra click; what it buys is that
 * the click is a person's.
 *
 * ⚠ THE READ BELOW IS A COURTESY, AND `app/api/public/newsletter/confirm/route.ts` REMAINS THE AUTHORITY.
 * This page asks one question of the database — "is this subscription already confirmed?" — so that a
 * reader who opens the link twice is told so immediately instead of being shown a button whose only
 * possible answer is "already confirmed". It deliberately does NOT re-check the nonce or the expiry: those
 * belong to the handler, and a second copy of them here would be a second implementation to keep in step.
 * A guard that only decides what to RENDER is not a guard (contract §1.7).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ `noIndex`, AND IT IS NOT OPTIONAL. The URL carries a credential in its query string. A crawler that
 * indexed it would publish somebody's confirmation token in a search result.
 *
 * ⚠ `force-dynamic`. The page is a function of a token in the query string and of one database row.
 * Anything cached here would be one reader's outcome served to the next.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Confirm your newsletter subscription",
  description:
    "Confirm that you would like the Centre's newsletter sent to your address. Nothing is sent until you do.",
  path: NEWSLETTER_CONFIRM_PATH,
  noIndex: true
});

const BREADCRUMBS = [
  { name: "Home", href: "/" },
  { name: "The newsletter", href: NEWSLETTER_PATH },
  { name: "Confirm", href: NEWSLETTER_CONFIRM_PATH }
] as const;

/** `?token=` may legally arrive repeated; take the first, exactly as `newsletterNotice` does with `state`. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NewsletterConfirmPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  /**
   * ⚠ A `?state=` CODE WINS OVER THE TOKEN, ALWAYS.
   *
   * After the form is posted, the handler answers `303` to THIS page with a state code and WITHOUT the
   * token — the token is spent, and putting a used credential back in an address bar (and in the browser's
   * history, and in any proxy log) would be careless. So on that pass there is no token to verify, and the
   * page's whole job is to render the outcome. Checking the token first would show "this link could not be
   * read" on top of a perfectly successful confirmation.
   */
  const notice = newsletterNotice("confirm", params.state);
  if (notice) {
    return (
      <ConfirmShell>
        <StateNotice notice={notice} />
        <NextSteps />
      </ConfirmShell>
    );
  }

  const token = firstValue(params[NEWSLETTER_TOKEN_QUERY_KEY]);

  // No token and no state: somebody has arrived here directly rather than from a message.
  if (!token) {
    return (
      <ConfirmShell>
        <div className="panel p-6 sm:p-8">
          <h2 className="display-title text-lg">This page needs the link from your email</h2>
          <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
            Confirming a subscription needs the one-time link that was sent to the address you signed up
            with — it is what proves the request came from whoever reads that mailbox, so there is nothing
            to confirm here without it. Open the message titled &ldquo;Confirm your newsletter
            subscription&rdquo; and use the link inside it.
          </p>
          <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
            If no message arrived, or it is too old to work,{" "}
            <Link href={NEWSLETTER_PATH} className={LINK}>
              sign up again
            </Link>{" "}
            and a fresh link will be sent.
          </p>
        </div>
      </ConfirmShell>
    );
  }

  /**
   * ⚠ THE PURPOSE `"confirm"` IS PASSED IN AND NOT READ FROM THE TOKEN. It is inside the signed message,
   * so an unsubscribe token presented here fails the signature check rather than being honoured as a
   * confirmation — the half of domain separation that actually does the work.
   */
  const verified = verifyNewsletterToken("confirm", token);

  if (!verified.ok) {
    /**
     * The token's three failure reasons, mapped onto the two the reader needs.
     *
     * ⚠ THE SAME COLLAPSE THE HANDLER MAKES, AND THE SAME WAY ROUND. Expired is its own sentence because
     * the reader's next step differs — sign up again for a fresh link. Malformed and forged share one,
     * because telling somebody their link was FORGED when their mail client mangled it is both wrong and
     * insulting, and telling an actual forger which attempt failed how is free tuning information.
     */
    const failure = newsletterNotice(
      "confirm",
      verified.reason === "expired" ? "expired" : "bad-link"
    );

    return (
      <ConfirmShell>
        {failure ? <StateNotice notice={failure} /> : null}
        <NextSteps />
      </ConfirmShell>
    );
  }

  /**
   * The courtesy read. See the header: one question, and the handler is still the authority.
   *
   * `deletedAt` is included because every read path filters on it — an erased row must read as absent here
   * too, or this page would offer to confirm a subscription the handler will correctly refuse.
   */
  const row = await prisma.newsletterSubscriber.findUnique({
    where: { emailKey: verified.emailKey },
    select: { status: true, deletedAt: true }
  });

  if (row && row.deletedAt === null && row.status === "CONFIRMED") {
    const already = newsletterNotice("confirm", "already-confirmed");
    return (
      <ConfirmShell>
        {already ? <StateNotice notice={already} /> : null}
        <NextSteps />
      </ConfirmShell>
    );
  }

  return (
    <ConfirmShell>
      <div className="panel p-6 sm:p-8">
        <h2 className="display-title text-lg">Confirm this subscription</h2>

        <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
          {/*
            ⚠ THE ADDRESS IS MASKED. This link may have been forwarded, and a forwarded link should not hand
            the whole address to whoever received it. `maskEmail` keeps the first character and the domain so
            the reader can recognise their own address — see its header, which is also clear that this is a
            courtesy and not a security control: anybody holding the token could read the address out of its
            payload.
          */}
          The Centre will send its newsletter to{" "}
          <strong className="font-semibold text-ink-900">{maskEmail(verified.emailKey)}</strong> once you
          confirm below. Nothing has been sent to that address so far except the message you are reading
          this from, and nothing will be until you press the button.
        </p>

        {/*
          A PLAIN FORM WITH NO JAVASCRIPT ANYWHERE. There is nothing to keep on this page — no filters, no
          scroll position worth preserving, no partial state — so a `fetch` would buy nothing and would cost
          this page its ability to work in a mail client's built-in browser with scripts disabled. The
          handler answers `303` back to this page with a `?state=` code, which the branch at the top renders.
        */}
        <form method="post" action={NEWSLETTER_CONFIRM_ENDPOINT} className="mt-6">
          {/*
            ⚠ THE FIELD NAME IS `NEWSLETTER_TOKEN_QUERY_KEY`, the same constant the emailed link uses for
            its query parameter and the handler's Zod schema uses for its key. One constant across all three
            is what stops this becoming `token` here and `t` there — a mismatch that presents as every link
            in every message being invalid, with nothing in a log to say why.
          */}
          <input type="hidden" name={NEWSLETTER_TOKEN_QUERY_KEY} value={token} />
          <Button type="submit" icon={MailCheck}>
            Yes, send me the newsletter
          </Button>
        </form>

        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          If you did not ask for this, close this page and do nothing. Without that button no newsletter is
          ever sent to that address, and the incomplete record is removed in due course.
        </p>
      </div>
    </ConfirmShell>
  );
}

const LINK = "underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700";

/** The page frame, so the four branches above cannot drift apart in layout or in heading structure. */
function ConfirmShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHero
        eyebrow="The newsletter"
        title="Confirm your subscription"
        description="One more step, and it exists so that nobody can be signed up by somebody else. Confirming tells the Centre that the person who reads this mailbox is the person who asked."
        breadcrumbs={BREADCRUMBS}
      />
      <section className="shell pb-24">
        <div className="shell-narrow flex flex-col gap-8 px-0">{children}</div>
      </section>
    </>
  );
}

/** Shown under every outcome: the two things a reader might want next. */
function NextSteps() {
  return (
    <div className="panel p-6 sm:p-8">
      <h2 className="display-title text-lg">What now</h2>
      <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
        If you need a fresh confirmation link, or you would like to change the address,{" "}
        <Link href={NEWSLETTER_PATH} className={LINK}>
          sign up again
        </Link>{" "}
        — it never creates a second subscription. If you would rather not receive the newsletter at all,
        doing nothing is enough: an unconfirmed sign-up is never sent anything else.
      </p>
      <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-700">
        If something here is not behaving as this page describes,{" "}
        <Link href="/contact" className={LINK}>
          write to the Centre
        </Link>{" "}
        and somebody will sort it out by hand.
      </p>
    </div>
  );
}
