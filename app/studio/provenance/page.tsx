import type { Metadata } from "next";
import { Eye } from "lucide-react";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canViewProvenance } from "@/lib/permissions";
import { PROVENANCE_NOTICE } from "@/lib/provenance";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { ProvenanceConsole } from "./ProvenanceConsole";

/**
 * The provenance console — "where did this come from, and who touched it?"
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canViewProvenance)` IS THE FIRST STATEMENT — master admin only.
 *
 * It is the PAGE half of the pair: it calls Next's `forbidden()`, which renders `app/forbidden.tsx`
 * with a real 403 status. `requireCapability` — the route-handler half, used by
 * app/api/studio/provenance/route.ts — throws an `ApiError`, and an `ApiError` thrown inside a Server
 * Component becomes an unhandled server error and a **500** telling the reader the studio is broken
 * (contract §1.9). The two are not interchangeable.
 *
 * WHY THIS IS NOT `/studio/audit`, WHICH AN ADMINISTRATOR ALREADY HAS. The audit screen answers "what
 * happened to this page?" — a log, ordered by time. This one answers three questions, and the second
 * of them is "what has this PERSON done, everywhere, and from which addresses?" That is a record of a
 * colleague rather than of content, so the tier that may read it is the tier that already decides who
 * may sign in at all — which keeps the account used every day, and therefore the account most likely
 * to be phished, from being the account that can read it.
 *
 * ⚠ THE NOTICE AT THE TOP IS NOT DECORATION AND MUST NOT BE MOVED BELOW THE FOLD. The people whose
 * actions are listed here are entitled to know the record exists; saying so where the person reading it
 * cannot miss it is the difference between a record and surveillance. The sentence lives in
 * lib/provenance.ts so that the API answer carries the same words — a client cannot render the data
 * without also having been handed the statement.
 *
 * THE FIGURES BELOW ARE READ HERE, ON THE SERVER, and nothing else on this screen is. They answer "how
 * far back does this record go", which frames everything the console shows: a console that looks empty
 * because the log only starts on Tuesday is a very different thing from a quiet installation, and only
 * a page that has already counted can say which. Everything else is a sequence of searches and
 * selections, so it lives in a client component that talks to the endpoint (contract §9).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Provenance"
};

/** A date in a NAMED zone. UTC, matching the audit screen and the buckets every query here uses. */
function formatDay(date: Date): string {
  return `${date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  })}`;
}

export default async function StudioProvenancePage() {
  await requireStudioCapability(
    canViewProvenance,
    "The provenance console needs master administrator access. The audit log, which answers what happened to a particular page, is open to administrators."
  );

  const [entryCount, revisionCount, peopleRecorded, oldest] = await prisma.$transaction([
    prisma.auditLog.count(),
    prisma.revision.count(),
    /**
     * People with at least one recorded action — a relation filter rather than a `distinct` over the
     * whole log, which would read every row to count the names in it.
     */
    prisma.user.count({ where: { auditLogs: { some: {} } } }),
    prisma.auditLog.findFirst({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { createdAt: true }
    })
  ]);

  return (
    <div className="mx-auto w-full max-w-[100rem] space-y-6">
      <StudioPageHeader
        title="Provenance"
        description="Where a record came from, who has touched it, and what has been happening in this studio. Nothing here can be changed or removed — it is assembled from the history the studio writes as it works."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {entryCount === 1 ? "1 recorded action" : `${entryCount.toLocaleString("en-GB")} recorded actions`}
          </span>
        }
      />

      {/*
        THE STATEMENT, FIRST AND UNMISSABLE. See the header — it is a promise to the colleagues whose
        work is listed below, not a caption. `aria-labelledby` rather than `aria-label` so a screen
        reader announces the same words the eye reads.
      */}
      <section
        aria-labelledby="provenance-notice-heading"
        className="rounded-lg border border-purple-200 bg-purple-100 px-4 py-3.5"
      >
        <h2
          id="provenance-notice-heading"
          className="flex items-center gap-2 font-display text-sm font-semibold text-purple-700"
        >
          <Eye aria-hidden="true" className="h-4 w-4 shrink-0" />
          What this screen is
        </h2>
        <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-700">{PROVENANCE_NOTICE}</p>
      </section>

      {/*
        How far back the record goes. Stated because an empty console is ambiguous without it: a studio
        whose log began on Tuesday looks exactly like a studio where nothing has happened.
      */}
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="panel px-4 py-3">
          <dt className="text-xs font-medium text-ink-500">The record begins</dt>
          <dd className="mt-1 text-sm font-semibold text-ink-900">
            {oldest ? (
              <time dateTime={oldest.createdAt.toISOString()}>{formatDay(oldest.createdAt)}</time>
            ) : (
              "Nothing has been recorded yet"
            )}
          </dd>
        </div>
        <div className="panel px-4 py-3">
          <dt className="text-xs font-medium text-ink-500">Stored versions</dt>
          <dd className="mt-1 text-sm font-semibold tabular-nums text-ink-900">
            {revisionCount.toLocaleString("en-GB")}
          </dd>
        </div>
        <div className="panel px-4 py-3">
          <dt className="text-xs font-medium text-ink-500">People with recorded work</dt>
          <dd className="mt-1 text-sm font-semibold tabular-nums text-ink-900">
            {peopleRecorded.toLocaleString("en-GB")}
          </dd>
        </div>
      </dl>

      {entryCount === 0 ? (
        <HelpText>
          Nothing has been recorded in this studio yet, so every tab below will be empty. The history is
          written as people work — the first save, sign-in or publication will appear here as it happens.
        </HelpText>
      ) : null}

      <ProvenanceConsole />
    </div>
  );
}
