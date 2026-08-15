"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RefreshCw, Home } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The route-level error boundary.
 *
 * WHAT IT DOES NOT DO: print the error. `error.message` on a server-rendered failure is either a
 * redacted digest (Next replaces the real message in production precisely so a stack trace does not
 * reach a visitor) or, in development, a message that is useful only to a developer. Showing either
 * to a member of the public is noise at best and a disclosure at worst.
 *
 * WHAT IT DOES: names the digest, which is the ONE thing a reader can usefully quote to whoever
 * maintains the site, offers a retry that actually retries (`reset()` re-renders the segment rather
 * than reloading the document), and gives a way out.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ IT IS RENDERED FROM TWO PLACES, AND ONLY ONE OF THEM HAS A HEADER ABOVE IT.
 *
 * Next inserts the error boundary at the SEGMENT THAT OWNS THE FILE, so a failure inside
 * `app/(site)/**` unwinds past `app/(site)/layout.tsx` and would render this file as a direct child of
 * `RootLayout` — leaving a reader whose page failed with no header, no footer and no way back into the
 * site except the two buttons below. `app/(site)/error.tsx` exists to keep the boundary inside the
 * site frame; it renders `ErrorPanel` with no clearance of its own, because `<main class="page-top">`
 * above it has already paid `--nav-clearance` (contract §7).
 *
 * This default export is the boundary for everything OUTSIDE that group. Nothing renders a header
 * there, so it pays the clearance itself — and `page-top` must therefore not appear on both.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * The panel itself, without deciding whether it sits under a header.
 *
 * `className` is the ONE thing the two mount points differ by, and it only ever ADDS a class — `cn()`
 * is a plain join and a later class does not beat an earlier one (contract §5).
 */
export function ErrorPanel({
  error,
  reset,
  className
}: ErrorBoundaryProps & { className?: string }) {
  useEffect(() => {
    // The server has already logged this. Logging it here too is what makes a client-side failure
    // visible in a browser console during support, where there is no server log to read.
    console.error("[site] render failed", error);
  }, [error]);

  return (
    <div className={cn("shell flex min-h-[70vh] flex-col justify-center pb-24", className)}>
      <div className="max-w-2xl">
        <p className="eyebrow">Something went wrong</p>
        <h1 className="display-title mt-3 text-4xl md:text-5xl">This page could not be loaded</h1>
        <p className="mt-4 max-w-prose text-base leading-7 text-ink-700">
          The fault is on our side, not yours. Trying again often works — the underlying problem is
          usually momentary.
        </p>

        {error.digest ? (
          <p className="mt-6 rounded-md border border-line-200 bg-surface-50 px-4 py-3 font-mono text-sm text-ink-500">
            Reference: {error.digest}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap gap-3">
          <button type="button" onClick={reset} className="field-button">
            <RefreshCw className="h-4 w-4" aria-hidden />
            Try again
          </button>
          <Link href="/" className="field-button-secondary">
            <Home className="h-4 w-4" aria-hidden />
            Go to the home page
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function ErrorBoundary({ error, reset }: ErrorBoundaryProps) {
  // Nothing draws a header above this one, so it pays the clearance itself. See the header.
  return <ErrorPanel error={error} reset={reset} className="page-top" />;
}
