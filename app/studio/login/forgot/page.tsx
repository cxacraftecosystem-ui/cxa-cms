import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { currentUser } from "@/lib/auth/current-user";
import { RESET_TTL_HOURS } from "@/lib/auth/credential-token";
import { getSettingCached } from "@/lib/settings/service";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

/**
 * "Forgot your password?" — ask for a one-time link by email.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT LIVES AT `/studio/login/forgot`. The proxy's matcher (`/studio/((?!login$|login/).*)`) already
 * leaves everything under `/studio/login/` open to a signed-out reader, and `next.config.ts` still sends
 * `X-Robots-Tag: noindex` for `/studio/:path*`. A new top-level studio address would have needed a third
 * exemption in proxy.ts, and an exemption that is forgotten there is a screen nobody locked out can reach.
 *
 * IT SAYS THE SAME THING WHATEVER IS TYPED. The form shows the one sentence the endpoint returns
 * (`FORGOT_PASSWORD_MESSAGE`), identical for a real account and an address nobody has ever used — see
 * `app/api/auth/forgot-password/route.ts`. Nothing on this screen depends on whether email is set up
 * either: telling a stranger that would be telling them something about the installation.
 *
 * A SIGNED-IN READER IS SENT TO THEIR ACCOUNT SCREEN, where a password is changed with the current one.
 * The studio layout would otherwise wrap this bare page in the full studio chrome.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Forgot your password?",
  robots: { index: false, follow: false }
};

export default async function ForgotPasswordPage() {
  const [user, branding] = await Promise.all([currentUser(), getSettingCached("branding")]);
  if (user) redirect("/studio/account");

  return (
    <main className="grad-mesh flex min-h-screen flex-col justify-center bg-bg-0 px-5 py-12 sm:px-8">
      <div className="mx-auto w-full max-w-md">
        <p className="mb-6 truncate font-display text-base font-semibold text-ink-900">{branding.siteName}</p>

        {/* The same frosted mount as the sign-in screen, for the same reason — see app/studio/login/page.tsx. */}
        <div className="glass-card rounded-xl p-2 shadow-cinema">
          <div className="rounded-lg bg-card p-6 sm:p-8">
            <h1 className="display-title text-2xl">Forgot your password?</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-500">
              Enter the email address you sign in with. If it belongs to a studio account that uses a
              password, we will email it a link to choose a new one. The link works once and lasts{" "}
              {RESET_TTL_HOURS} hours. If two-step verification is on for your account, you will still need
              your authenticator app to sign in afterwards.
            </p>

            <div className="mt-7">
              <ForgotPasswordForm />
            </div>
          </div>
        </div>

        <p className="mt-6 text-sm">
          <Link
            href="/studio/login"
            className="inline-flex items-center gap-1.5 font-medium text-purple-700 underline-offset-4 hover:underline focus-visible:underline"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
            Back to sign in
          </Link>
        </p>

        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          No email? Ask an administrator — they can make you a link from the Users screen. Nobody at the
          Centre can see your password, and nobody will ever ask you for it.
        </p>
      </div>
    </main>
  );
}
