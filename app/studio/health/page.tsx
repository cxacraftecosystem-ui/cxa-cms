import type { Metadata } from "next";
import {
  ArrowRight,
  CircleCheck,
  CircleHelp,
  Download,
  Info,
  ListChecks,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon
} from "lucide-react";

import { requireStudioUser } from "@/lib/auth/current-user";
import {
  HEALTH_SEVERITIES,
  buildHealthReport,
  type HealthFinding,
  type HealthSeverity
} from "@/lib/health";
import { canManageSettings } from "@/lib/permissions";
import { Badge } from "@/components/ui/Badge";
import { LinkButton, buttonClasses } from "@/components/ui/Button";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
// The single declared home of the Centre's time zone — see its header. "Checked at" has to be in the
// Centre's hours, not the reader's, or two people comparing notes disagree about when the report was run.
import { formatCentreDate, formatCentreTimeWithZone } from "@/components/site/EventDateBlock";

/**
 * THE CONTENT HEALTH REPORT — one screen answering "is anything wrong with our site?".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CHECKS LIVE IN lib/health.ts AND THE WORDS LIVE HERE. That file decides what is wrong and why it
 * matters; this one decides how it reads. The split is what lets the report be written for somebody who
 * does not know what a slug is: nothing on this screen prints a column name, a status enum or a record
 * identifier.
 *
 * `requireStudioUser()` GUARDS THE PAGE AND EACH FINDING GUARDS ITSELF. There is no single capability
 * that means "may see the health of the site" — the findings span the media library, the pages, the
 * people, the publications and the calendar, and each one links to a screen with its own rule. So the
 * page needs only a signed-in reader, and every finding carries the predicate of the screen it points at
 * (see `HealthFinding.can`). A reader who cannot act on a finding does not see it greyed out; they do not
 * see it, and the screen says once that nothing here is theirs (contract §1.8).
 *
 * ⚠ `requireStudioUser`, NOT `requireUser` — a page, not a route handler. The handler pair throws an
 * `ApiError`, which inside a Server Component becomes an unhandled server error and a 500 telling an
 * editor the site is broken when in fact their session merely ended (contract §1.9).
 *
 * WHEN EVERYTHING IS IN ORDER IT SAYS SO, and it says WHAT WAS LOOKED AT. An empty page with a heading on
 * it is indistinguishable from a page that failed to load, and "no problems found" with no idea of the
 * scope is a sentence nobody can weigh.
 *
 * NO MOTION AT ALL, DELIBERATELY. The studio is calm and dense (contract §0), and there is nothing here
 * whose meaning is a transition — every signal is a word, a glyph and a tone together, which is also what
 * makes the screen legible in print and to a reader who cannot separate amber from red (contract §11).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * HOW IT IS REACHED: this file declares no link to itself, because no studio screen does. It is listed
 * once in `components/studio/StudioNav.ts` — group "Records", `can: canAccessStudio` — and the sidebar,
 * the Ctrl/Cmd+K jump-to panel and the breadcrumbs all render from that one list. ⚠ A screen missing from
 * it is a screen nobody can open: this report and the whole-database export below are offered nowhere
 * else in the studio, so the entry is not decoration.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Content health"
};

/**
 * The glyph for each severity. A second signal beside the word, never the only one.
 *
 * `Record<HealthSeverity, …>` so adding a severity to lib/health.ts is a compile error here rather than a
 * blank square in a heading.
 */
const SEVERITY_ICONS: Record<HealthSeverity, LucideIcon> = {
  urgent: TriangleAlert,
  important: Info,
  tidy: ListChecks
};

/**
 * What the export contains, in the words of somebody deciding whether to press the button.
 *
 * ⚠ A SUMMARY OF THE LIST IN app/api/studio/export/route.ts, WHICH IS THE AUTHORITY. That file carries
 * the exhaustive list of tables and the reason for every exclusion, and repeats it inside the file it
 * produces. This copy exists because a reader deciding whether to download a file full of personal data
 * needs the answer before they press, not inside the result. Change one and change the other.
 */
const EXPORT_INCLUDES =
  "Every page and block, the media and file records, people, research areas, projects, publications, news, events and their registrations, the craft archive, the gallery, partners, menus, announcements, settings, redirects, contact enquiries and the visit figures.";

const EXPORT_EXCLUDES =
  "No user accounts, no passwords, no sign-in sessions, no linked Google or Microsoft identities, no studio access list, no audit log and no revision history. An export carrying those would be a way into the studio rather than a copy of its contents.";

export default async function StudioHealthPage() {
  // Any signed-in reader. Every finding is gated by its own predicate below — see the file header.
  const user = await requireStudioUser();

  const report = await buildHealthReport();
  const mine = report.findings.filter((entry) => entry.can(user));

  const groups = HEALTH_SEVERITIES.map((severity) => ({
    meta: severity,
    findings: mine.filter((entry) => entry.severity === severity.key)
  })).filter((group) => group.findings.length > 0);

  const checkedAt = `${formatCentreTimeWithZone(report.generatedAt)} on ${formatCentreDate(report.generatedAt)}`;

  // The worst thing this reader can see decides the chip's tone. Never the only signal: the chip states
  // the number in words beside it (contract §11).
  const anyUrgent = mine.some((entry) => entry.severity === "urgent");

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-8">
      <StudioPageHeader
        title="Content health"
        description="Everything this software can tell you about the state of the site without knowing the work: what is missing, what contradicts itself, and what has been left half-finished. Every line says why it matters and takes you to the screen that fixes it."
        meta={
          <Badge
            tone={mine.length === 0 ? "success" : anyUrgent ? "error" : "warn"}
            icon={mine.length === 0 ? CircleCheck : TriangleAlert}
          >
            {mine.length === 0
              ? "Nothing to fix"
              : mine.length === 1
                ? "1 thing to look at"
                : `${mine.length} things to look at`}
          </Badge>
        }
      />

      {mine.length === 0 ? (
        /*
          Said plainly, in sentences, rather than as an empty panel with an illustration in it — and it
          names the scope, because "no problems found" with no idea of what was examined is a sentence
          nobody can weigh.
        */
        <section
          aria-labelledby="all-clear-heading"
          className="panel px-5 py-5"
        >
          <h2
            id="all-clear-heading"
            className="flex items-start gap-2.5 font-display text-base font-semibold text-ink-900"
          >
            <CircleCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-success-600" />
            <span>
              {report.findings.length === 0
                ? "Everything this report can check is in order"
                : "Nothing here is yours to act on"}
            </span>
          </h2>

          <p className="prose-measure mt-2.5 text-sm leading-relaxed text-ink-700">
            {report.findings.length === 0 ? (
              <>
                All {report.checksRun} checks passed. No image is missing its description, no published
                page is empty or without a description for search engines, no link inside the site points
                at a page that is not published, nothing is waiting on a date that has already gone, and
                nothing has been left as a draft for months.
              </>
            ) : (
              <>
                {report.checksRun} checks ran and some of them found something, but none of it is on a
                screen your account can change. Whoever looks after the pages, the media library or the
                publications will see it on their own copy of this screen.
              </>
            )}
          </p>
        </section>
      ) : null}

      {groups.map((group) => {
        const Icon = SEVERITY_ICONS[group.meta.key];
        const headingId = `severity-${group.meta.key}`;

        return (
          <section key={group.meta.key} aria-labelledby={headingId}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2
                id={headingId}
                className="flex items-center gap-2 font-display text-lg font-semibold text-ink-900"
              >
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
                {group.meta.label}
              </h2>
              <Badge tone={group.meta.tone} size="sm">
                {group.findings.length === 1 ? "1 finding" : `${group.findings.length} findings`}
              </Badge>
            </div>

            <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-500">
              {group.meta.description}
            </p>

            <ul className="mt-3 space-y-2.5">
              {group.findings.map((entry) => (
                <li key={entry.id}>
                  <FindingRow finding={entry} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {/*
        Caps that bit during this run. A check that quietly stopped looking is indistinguishable from a
        check that found nothing (contract §1.6), so the sentence is on the screen rather than in a log.
      */}
      {report.limitsReached.length > 0 ? (
        <div className="space-y-2">
          {report.limitsReached.map((sentence) => (
            <HelpText key={sentence} tone="warn">
              {sentence}
            </HelpText>
          ))}
        </div>
      ) : null}

      <section aria-labelledby="not-checked-heading" className="panel px-5 py-5">
        <h2
          id="not-checked-heading"
          className="flex items-center gap-2 font-display text-base font-semibold text-ink-900"
        >
          <CircleHelp aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
          What this report does not look at
        </h2>
        <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-500">
          A clear report above does not mean the site is perfect. These are the things nothing here
          examines, so that a clean screen is never read as more of a guarantee than it is.
        </p>

        <ul className="mt-3 space-y-2.5">
          {report.notChecked.map((sentence) => (
            <li key={sentence} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-line-200"
              />
              <span className="prose-measure text-sm leading-relaxed text-ink-700">{sentence}</span>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          {report.checksRun} checks ran. Checked at {checkedAt}. This page works it out fresh every time
          it is opened, so refreshing is all it takes to see whether something has been fixed — there is
          nothing stored and nothing to wait for.
        </p>
      </section>

      {/*
        THE ESCAPE HATCH, and it is on this screen deliberately: an institution asking "is anything wrong
        with our site" is the same institution that should be able to walk away with everything in it. A
        failing permission check renders nothing at all (contract §1.8).
      */}
      {canManageSettings(user) ? (
        <section aria-labelledby="export-heading" className="panel px-5 py-5">
          <h2
            id="export-heading"
            className="flex items-center gap-2 font-display text-base font-semibold text-ink-900"
          >
            <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
            Take a copy of everything
          </h2>
          <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-500">
            One file holding every record this site is made of, so the Centre is never dependent on this
            software to keep its own work. It is plain JSON: readable by anything, and no part of it needs
            this application to make sense of it.
          </p>

          <dl className="mt-3.5 space-y-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
                What is in the file
              </dt>
              <dd className="prose-measure mt-1 text-sm leading-relaxed text-ink-700">
                {EXPORT_INCLUDES}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
                What is deliberately left out
              </dt>
              <dd className="prose-measure mt-1 text-sm leading-relaxed text-ink-700">
                {EXPORT_EXCLUDES}
              </dd>
            </div>
          </dl>

          <HelpText tone="warn" className="mt-3.5">
            The file contains personal data — the names, email addresses and messages of everyone who has
            written through a contact form or registered for an event. Keep it somewhere only staff can
            reach, and do not email it. Photographs and documents are not inside it: each media record
            names its own file in storage, and those have to be copied separately.
          </HelpText>

          <div className="mt-4">
            {/*
              A plain `<a download>`, not a `LinkButton`: the target answers a JSON file, and routing a
              download through the client router would have it try to render one as a page. `download`
              makes the browser save it and never leave this screen.
            */}
            <a
              href="/api/studio/export"
              download
              className={buttonClasses({ variant: "secondary" })}
            >
              <Download aria-hidden="true" className="h-4 w-4 shrink-0" />
              Download everything as one JSON file
            </a>
          </div>

          <p className="mt-2.5 text-xs leading-relaxed text-ink-500">
            Large sites take a few moments to assemble. Each table in the file states how many rows the
            database holds and how many are in the file, so a copy that had to stop short says so about
            itself rather than looking complete.
          </p>
        </section>
      ) : null}
    </div>
  );
}

/**
 * One finding: what is wrong, why it matters, which ones, and the way to fix it.
 *
 * NOT A LINK AROUND THE WHOLE ROW, unlike the dashboard's attention list. The row holds named examples
 * that a reader will want to select and copy, and a block-level link makes text selection a drag gesture
 * that navigates. The action is a button-shaped link at the end instead, and it NAMES ITS DESTINATION —
 * "Open Pages", never "Fix".
 */
function FindingRow({ finding }: { finding: HealthFinding }) {
  const Icon = SEVERITY_ICONS[finding.severity];

  return (
    <div className="panel flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:gap-4">
      <span
        aria-hidden="true"
        className={
          finding.severity === "urgent"
            ? "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-error-100 text-error-600"
            : finding.severity === "important"
              ? "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-800"
              : "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-100 text-ink-500"
        }
      >
        <Icon className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink-900">{finding.title}</p>
        <p className="prose-measure mt-1 text-sm leading-relaxed text-ink-500">{finding.why}</p>

        {finding.examples.length > 0 ? (
          <>
            <ul className="mt-2 space-y-1">
              {finding.examples.map((example) => (
                <li key={example} className="break-words text-xs leading-relaxed text-ink-700">
                  {example}
                </li>
              ))}
            </ul>

            {/*
              The cap, in words, every time it bites. A list of four that stopped at four is
              indistinguishable from four being all there were (contract §1.6).
            */}
            {finding.moreThanNamed > 0 ? (
              <p className="mt-1.5 text-xs text-ink-500">
                {finding.moreThanNamed === 1
                  ? `and 1 more — ${finding.fixLabel.toLowerCase()} to see all of them`
                  : `and ${finding.moreThanNamed} more — ${finding.fixLabel.toLowerCase()} to see all of them`}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="shrink-0 sm:pt-0.5">
        {/* A `LinkButton`, because every one of these destinations is a studio screen: it goes somewhere,
            so it is a link and can be middle-clicked, opened in a new tab and read as a link. */}
        <LinkButton href={finding.href} variant="secondary" size="sm" icon={ArrowRight} iconPosition="end">
          {finding.fixLabel}
        </LinkButton>
      </div>
    </div>
  );
}
