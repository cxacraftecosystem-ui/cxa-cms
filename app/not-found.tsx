import Link from "next/link";
import { Compass, Search } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The 404.
 *
 * A 404 on an institutional site is usually a citation that has outlived a URL, not a typo — someone
 * followed a link from a paper, a syllabus or an email written years ago. So this page does the two
 * things that actually help in that situation: it offers SEARCH (the reader knows what they were
 * looking for, just not where it moved to) and it names the handful of places the thing probably is.
 *
 * It does NOT apologise at length, and it does not say "Oops". The reader's problem is finding
 * something, not being consoled.
 *
 * Editors can also close this gap properly: the studio's Redirects screen writes a `Redirect` row so
 * a moved page keeps answering its old address.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ IT IS RENDERED FROM TWO PLACES, AND ONLY ONE OF THEM HAS A HEADER ABOVE IT.
 *
 * Next inserts the not-found boundary at the SEGMENT THAT OWNS THE FILE, so a `notFound()` thrown
 * inside `app/(site)/**` unwinds past `app/(site)/layout.tsx` and would render this file as a direct
 * child of `RootLayout` — no site header, no footer, no skip link. `app/(site)/not-found.tsx` exists to
 * keep the boundary inside the site frame; it renders `NotFoundBody` with no clearance of its own,
 * because `<main class="page-top">` above it has already paid `--nav-clearance` (contract §7).
 *
 * This default export is the boundary for everything OUTSIDE that group — the studio, and any
 * root-level address the site's catch-all never sees. Nothing renders a header there, so it pays the
 * clearance itself. `page-top` therefore belongs on this one and NOT on the site copy; putting it on
 * both would pay the same clearance twice.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The places a reader who lost an address is most likely to be heading for. */
const DESTINATIONS = [
  { href: "/research", label: "Research areas" },
  { href: "/projects", label: "Projects" },
  { href: "/publications", label: "Publications" },
  { href: "/people", label: "People" },
  { href: "/craft-explorer", label: "Craft Explorer" },
  { href: "/news", label: "Newsroom" },
  { href: "/events", label: "Events" },
  { href: "/contact", label: "Contact" }
] as const;

/**
 * The page itself, without deciding whether it sits under a header.
 *
 * `className` is the ONE thing the two mount points differ by. It is appended last, but `cn()` is a
 * plain join and later classes do not win (contract §5), so it must only ever ADD a class that is not
 * already in the base — which is why the base carries no top padding at all.
 */
export function NotFoundBody({ className }: { className?: string }) {
  return (
    <div className={cn("shell flex min-h-[70vh] flex-col justify-center pb-24", className)}>
      <div className="max-w-2xl">
        <p className="eyebrow">Error 404</p>
        <h1 className="display-title mt-3 text-4xl md:text-5xl">
          That page is not here any more
        </h1>
        <p className="mt-4 max-w-prose text-base leading-7 text-ink-700">
          The address may have changed since it was written down, or the item may have been retired.
          Searching usually finds it — the content is almost always still on the site under a
          different address.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/search" className="field-button">
            <Search className="h-4 w-4" aria-hidden />
            Search the site
          </Link>
          <Link href="/" className="field-button-secondary">
            <Compass className="h-4 w-4" aria-hidden />
            Go to the home page
          </Link>
        </div>

        <div className="mt-12 border-t border-line-200 pt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            The most-linked places
          </h2>
          <ul className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {DESTINATIONS.map((entry) => (
              <li key={entry.href}>
                <Link
                  href={entry.href}
                  className="inline-flex py-1 text-sm text-purple-700 underline decoration-purple-300 underline-offset-4 transition hover:decoration-purple-700"
                >
                  {entry.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function NotFound() {
  // Nothing draws a header above this one, so it pays the clearance itself. See the header.
  return <NotFoundBody className="page-top" />;
}
