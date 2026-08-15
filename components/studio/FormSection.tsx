/**
 * FormSection — a titled group of fields. The visual unit every studio editor is composed from.
 *
 * An editor screen is a stack of these and nothing else: "Basics", "Dates and publication", "Search
 * engine listing", "Danger zone". The grouping is not decoration — a form of thirty fields with no
 * groups is a form nobody can find anything in, and each group's description is where the studio
 * explains a decision in plain words before asking the reader to make it.
 *
 * NO `"use client"`. It is a layout shell with no state, so it renders inside a Server Component page
 * as happily as inside a client editor.
 *
 * ⚠ `headingLevel` IS NOT DECORATION. The section renders a real heading, and heading order is a
 * document-wide property a component cannot know locally (see Heading.tsx). On a studio page whose
 * `<h1>` comes from `StudioPageHeader`, these are `<h2>`s — the default. A FormSection nested inside
 * another one is an `<h3>`. Levels never skip and never duplicate a rank they should sit under
 * (contract §11).
 *
 * ⚠ AND IT AFFECTS WHAT YOU PUT INSIDE. `EmptyState` renders its own heading too, so an EmptyState
 * dropped into a FormSection must be told `headingLevel={3}` — otherwise the panel's title and "No
 * images yet" read as peers in the document outline (contract §14).
 *
 * THE `danger` TONE IS FOR ONE THING: the group at the foot of an editor holding Delete. It is
 * separated and tone-marked for the same reason a destructive menu entry is — so the reader's eye
 * cannot mistake it for the rest of the form. It does NOT make its contents behave differently; the
 * confirmation is `DeleteButton`'s job.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Heading, type SubHeadingLevel } from "@/components/ui/Heading";

export type FormSectionTone = "default" | "danger";

/** Complete literal class strings — a name assembled by concatenation is purged (contract §5). */
const TONE_CLASS: Record<FormSectionTone, string> = {
  // `.panel` is the house recipe (rounded-lg + border-line-200 + bg-card + shadow-sm). Never a bare
  // `border`, which is preflight's literal gray-200 and does not invert (contract §3).
  default: "panel",
  danger: "rounded-lg border border-error-200 bg-card shadow-sm"
};

const TITLE_CLASS: Record<FormSectionTone, string> = {
  default: "font-display text-base font-semibold text-ink-900",
  danger: "font-display text-base font-semibold text-error-600"
};

/**
 * One column or two. Two is for short, paired fields (a start date beside an end date); anything the
 * reader has to read before answering stays full width. Stacks to one column below `sm` because two
 * 160px-wide fields side by side on a phone are two fields nobody can use.
 */
const COLUMNS_CLASS: Record<1 | 2, string> = {
  1: "space-y-5",
  2: "grid gap-x-5 gap-y-5 sm:grid-cols-2"
};

export interface FormSectionProps {
  /** Sentence case, no full stop. "Dates and publication", not "DATES".  */
  title: string;
  /** One or two plain sentences saying what this group is for, and what happens if it is left empty. */
  description?: ReactNode;
  /** See the header before leaving this at the default. */
  headingLevel?: SubHeadingLevel;
  /** A control belonging to the whole group — "Add a milestone". Sits opposite the title. */
  actions?: ReactNode;
  tone?: FormSectionTone;
  columns?: 1 | 2;
  /** An action row at the foot, inside the panel and separated from the fields. */
  footer?: ReactNode;
  /**
   * An anchor target, so a validation summary can link to the group holding the failing field. Every
   * anchor inherits `scroll-margin-top: var(--nav-clearance)` from globals.css — do not restate it.
   */
  id?: string;
  className?: string;
  children: ReactNode;
}

export function FormSection({
  title,
  description,
  headingLevel = 2,
  actions,
  tone = "default",
  columns = 1,
  footer,
  id,
  className,
  children
}: FormSectionProps) {
  // The heading names the region, rather than an `aria-label` repeating the same string. One source
  // of the name means the two can never disagree.
  const headingId = id ? `${id}-title` : undefined;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(TONE_CLASS[tone], className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line-200 px-5 py-4">
        <div className="min-w-0 flex-1">
          <Heading level={headingLevel} id={headingId} className={TITLE_CLASS[tone]}>
            {title}
          </Heading>
          {description ? (
            // `prose-measure` caps the line length at 68ch. A description that runs the full width of
            // a 1400px studio window is a description nobody reads to the end of.
            <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-500">{description}</p>
          ) : null}
        </div>

        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      <div className={cn("px-5 py-5", COLUMNS_CLASS[columns])}>{children}</div>

      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-200 bg-surface-50 px-5 py-3">
          {footer}
        </div>
      ) : null}
    </section>
  );
}
