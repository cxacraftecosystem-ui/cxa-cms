import { NotFoundBody } from "@/app/not-found";

/**
 * The 404 FOR THE PUBLIC SITE.
 *
 * This file exists for where the boundary sits, not for what it draws. Next inserts the not-found
 * boundary at the segment that owns the file, so without this one every `notFound()` in
 * `app/(site)/**` — a retired publication, a hidden profile, a mistyped craft slug — unwound past
 * `app/(site)/layout.tsx` and rendered under `RootLayout` alone: no header, no navigation, no footer
 * with the Centre's address, and no skip link. A reader arriving on a dead citation was shown a page
 * with no way into the site except the links written into the body.
 *
 * The words are `NotFoundBody`, shared with `app/not-found.tsx` so the two cannot drift. It is
 * rendered WITHOUT `page-top`: `<main class="page-top">` in the site layout has already paid
 * `--nav-clearance`, and paying it twice is exactly the drift contract §7 exists to stop.
 */
export default function SiteNotFound() {
  return <NotFoundBody />;
}
