"use client";

import { ErrorPanel, type ErrorBoundaryProps } from "@/app/error";

/**
 * The error boundary FOR THE PUBLIC SITE.
 *
 * As with the 404 beside it, this file exists for where the boundary sits. Next inserts the error
 * boundary at the segment that owns the file, so without this one a render failure anywhere in
 * `app/(site)/**` unwound past `app/(site)/layout.tsx` and left the reader with a bare panel under
 * `RootLayout` — the header, the navigation and the footer all gone at the moment they are most
 * needed. Here the frame survives and only the failed segment is replaced.
 *
 * The panel is `ErrorPanel`, shared with `app/error.tsx`, rendered WITHOUT `page-top`: the clearance
 * is paid once by `<main class="page-top">` above it (contract §7).
 */
export default function SiteError({ error, reset }: ErrorBoundaryProps) {
  return <ErrorPanel error={error} reset={reset} />;
}
