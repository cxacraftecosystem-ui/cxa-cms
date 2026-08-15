import { Skeleton } from "@/components/ui/Skeleton";

/**
 * The search page's loading state.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS IS THE ONLY `loading.tsx` UNDER `app/(site)/`, AND THAT IS DELIBERATE. Adding another one
 * anywhere else in this route group is a bug, and a subtle one. Read this before you add a second.
 *
 * A `loading.tsx` wraps its segment — AND EVERY SEGMENT BENEATH IT — in a Suspense boundary. Next
 * then streams the response: it sends the boundary's fallback immediately, which FLUSHES THE HTTP
 * RESPONSE HEADERS, including the status line, as `200 OK`. Everything after that arrives in the body
 * of a response whose status has already been committed.
 *
 * So when a page under that boundary later calls `notFound()`, the not-found UI renders correctly
 * into the stream and the status stays **200**. The reader sees a 404 page; every machine sees a
 * success.
 *
 * That is a soft-404, and on a research institution's site it is genuinely damaging:
 *
 *   • a search engine indexes the 404 page under the dead URL and keeps serving it;
 *   • uptime and broken-link monitoring cannot detect anything, because every URL "works";
 *   • a citation pointing at a withdrawn publication looks like it resolved.
 *
 * This repository shipped exactly that: a `loading.tsx` at the route-group root meant EVERY missing
 * person, project, publication, article, event, album and craft returned 200 with 404 content.
 *
 * THE RULE. A `loading.tsx` may only go in a segment with NO `notFound()` call anywhere beneath it.
 * In this group that is `search`, `about` and `contact` — and of those, only search is slow enough to
 * need one. Every other segment either calls `notFound()` itself (the feature-flag gates on
 * `/events`, `/gallery` and `/craft-explorer`) or has a `[slug]` child that does.
 *
 * WHAT TO DO INSTEAD for a page that needs a loading state: put an explicit `<Suspense>` INSIDE the
 * page, around the slow part only, and make the `notFound()` decision BEFORE it. The status is then
 * settled before any streaming begins, and the reader still gets a progressive page.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export default function SearchLoading() {
  return (
    <div className="shell py-16">
      <span className="sr-only" role="status">
        Searching…
      </span>

      <div aria-hidden>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-4 h-10 w-2/3 max-w-xl" />
        <Skeleton className="mt-8 h-12 w-full max-w-2xl" />

        <div className="mt-10 flex gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-16" />
        </div>

        <div className="mt-10 space-y-6">
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="border-b border-line-200 pb-6">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-6 w-3/4" />
              <Skeleton className="mt-3 h-4 w-full" />
              <Skeleton className="mt-2 h-4 w-5/6" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
