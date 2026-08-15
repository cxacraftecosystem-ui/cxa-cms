/**
 * EmptyState — "there is nothing here", said plainly, with a way out.
 *
 * ⚠ IT RENDERS ITS OWN HEADING, so `headingLevel` is not decoration. Dropped into a panel that
 * already has an `<h2>`, a default `<h2>` here produces two siblings at the same level and the
 * document outline says the panel's title and "No publications yet" are peers. Heading levels never
 * skip and never duplicate a rank they should sit under (contract §11) — pass 3 inside a section
 * that owns an `<h2>`.
 *
 * THE BODY SAYS WHY, NOT JUST WHAT. "No publications yet" and "No publications match these filters"
 * are different facts with different remedies, and the second one must offer to clear the filters —
 * a list that quietly stops is indistinguishable from a place with no records (contract §1.6). The
 * `action` slot is where that offer goes.
 *
 * The icon is `aria-hidden`: it is a mood, not information. Everything a reader needs is in the
 * heading and the body.
 */

import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Heading } from "@/components/ui/Heading";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface EmptyStateProps {
  /** Defaults to an empty tray. Pick the one that matches the list — a `SearchX` for no results. */
  icon?: LucideIcon;
  /** One short sentence naming what is absent. Sentence case, no full stop. */
  title: string;
  /** Why it is absent and what would change it. */
  description?: ReactNode;
  /** A Button or LinkButton. Omit it when there is genuinely nothing the reader can do. */
  action?: ReactNode;
  /** The rank of the rendered heading. Default 2. See the header before leaving it at the default. */
  headingLevel?: HeadingLevel;
  className?: string;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  headingLevel = 2,
  className
}: EmptyStateProps) {

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-line-200 bg-surface-50 px-6 py-12 text-center",
        className
      )}
    >
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-surface-200 text-ink-500">
        <Icon aria-hidden="true" className="h-5 w-5" />
      </span>

      <Heading
        level={headingLevel}
        className="mt-4 font-display text-base font-semibold text-ink-900"
      >
        {title}
      </Heading>

      {description ? (
        <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-500">{description}</p>
      ) : null}

      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
