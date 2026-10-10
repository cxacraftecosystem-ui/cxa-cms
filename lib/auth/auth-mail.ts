import "server-only";

import { authEmailConfigured, authEmailEnv, siteName, siteUrl } from "@/lib/env";
import { renderAccountEmail } from "@/lib/newsletter/email-layout";
import { createSesTransactionalMailer, type TransactionalMailer } from "@/lib/newsletter/mailer-ses";

/**
 * Account mail — the password-reset link — sent IMMEDIATELY through the existing Amazon SES adapter.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT.
 *
 *   • IT IS THE SAME SES ACCOUNT, CLIENT AND ERROR CLASSIFICATION AS THE NEWSLETTER
 *     (`createSesTransactionalMailer` in lib/newsletter/mailer-ses.ts), with the same IAM user. Only the
 *     From line may differ — `authEmailEnv()` in lib/env.ts.
 *   • IT IS NOT THE NEWSLETTER OUTBOX. Nothing here writes a `NewsletterDelivery` row, consults consent,
 *     bounce or complaint state, or adds `List-Unsubscribe`. A reset link is sent by the request that asked
 *     for it or not at all; the caller is told which, and says so. See `TransactionalMessage` for why.
 *   • IT NEVER LOGS AN ADDRESS OR A BODY. The body carries a live credential.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

interface AuthMailerState {
  mailer: TransactionalMailer | null;
  /** True once something has decided the mailer — the environment, or a test through `setAuthMailer`. */
  decided: boolean;
}

/** On `globalThis` for the reason lib/newsletter/delivery.ts gives: a hot reload must not drop it. */
const globalForAuthMailer = globalThis as unknown as { __cxaAuthMailer?: AuthMailerState };
const state: AuthMailerState = globalForAuthMailer.__cxaAuthMailer ?? { mailer: null, decided: false };
globalForAuthMailer.__cxaAuthMailer = state;

/**
 * Install a sender, or `null` for "none configured". For the tests, which hand in a fake that records
 * what it was asked to send; `undefined` puts the environment back in charge.
 */
export function setAuthMailer(mailer: TransactionalMailer | null | undefined): void {
  if (mailer === undefined) {
    state.mailer = null;
    state.decided = false;
    return;
  }
  state.mailer = mailer;
  state.decided = true;
}

/**
 * The sender, built from the environment on first use, or null when account mail is not set up.
 *
 * ⚠ A MALFORMED CONFIGURATION IS LOGGED AND LEAVES NO SENDER, rather than throwing: the screens then say
 * "email is not set up — make a link instead", which is the truth and leaves a way forward.
 */
export function activeAuthMailer(): TransactionalMailer | null {
  if (state.decided) return state.mailer;
  state.decided = true;
  if (!authEmailConfigured()) return null;
  try {
    state.mailer = createSesTransactionalMailer(authEmailEnv());
  } catch (error) {
    console.error("[auth-mail] the SES configuration could not be read, so no password link can be emailed.", error);
    state.mailer = null;
  }
  return state.mailer;
}

/**
 * What Settings → Diagnostics shows. The from-address is shown because it is the one thing an operator
 * most often gets wrong (an address outside the verified identity), and it is not a secret.
 */
export function authMailInfo(): { configured: boolean; fromAddress: string | null } {
  if (!authEmailConfigured()) return { configured: false, fromAddress: null };
  try {
    return { configured: true, fromAddress: authEmailEnv().fromAddress };
  } catch {
    return { configured: false, fromAddress: null };
  }
}

export interface RenderedAccountEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * The password-reset message.
 *
 * ⚠ IT SAYS NOTHING ABOUT THE ACCOUNT'S SECOND FACTOR. Whether two-step verification is on is not
 * something to put in a mailbox; the sentence below is true of every account ("if your account uses…"),
 * and the set-password screen and sign-in ask for the code when there is one.
 *
 * `link` must come from `issueCredentialLink`, which builds it from `siteUrl()` — the configured origin,
 * never a request header — so nobody who can forge a `Host` can choose where this credential points.
 */
export function renderPasswordResetEmail(input: {
  name: string;
  link: string;
  ttlHours: number;
  requestedBy: "self" | "administrator";
}): RenderedAccountEmail {
  const site = siteName();
  const origin = siteUrl();
  const hours = `${input.ttlHours} hour${input.ttlHours === 1 ? "" : "s"}`;
  const who =
    input.requestedBy === "self"
      ? "Somebody — we hope you — asked to set a new password for your account on the studio."
      : "An administrator of the studio has sent you a link to set a new password for your account.";

  const rendered = renderAccountEmail({
    title: "Set a new password",
    preheader: `This link works once and stops working after ${hours}.`,
    intro: [
      `Hello ${input.name},`,
      who,
      `Choose a new password using the button below. The link works once, and stops working after ${hours} or as soon as a password is set — whichever comes first.`
    ],
    action: { label: "Set a new password", url: input.link },
    outro: [
      input.requestedBy === "self"
        ? "If you did not ask for this, you can ignore this email: your password has not changed, and nobody can use this link without access to your mailbox."
        : "If you were not expecting this, tell the administrator who looks after your account. Your current password stops working only when a new one is set.",
      "If your account uses two-step verification, you will still be asked for a code from your authenticator app when you sign in.",
      "Nobody from the Centre will ever ask you for your password."
    ],
    reason: `Sent because a password link was requested for your ${site} studio account.`,
    siteName: site,
    siteOrigin: origin
  });

  return { subject: `Set a new password for the ${site} studio`, text: rendered.text, html: rendered.html };
}
