"use client";

/**
 * The research-areas table.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE FROM `page.tsx`. `DataTable` takes columns whose `render` is a function
 * and a row menu whose entries carry `onSelect`, and a function cannot be handed from a Server
 * Component to a client one. The page does the permission check and the query; this owns the table.
 * Every list screen in the research group is split the same way.
 *
 * THE ROWS ARRIVE COMPLETE, SO THERE IS NO LOADING STATE HERE. `rows` is never null: the page is a
 * Server Component and the data is in the first paint. The `null` / `[]` distinction (contract §9)
 * still matters wherever a screen fetches for itself — it simply cannot arise on this one.
 *
 * DELETING ASKS, AND THE QUESTION SAYS WHERE THE AREA GOES. Soft delete only: the row moves to the
 * recycle bin and an administrator can restore it. The question also says what happens to the work
 * filed under it, because that is the part an editor has not thought about — the projects and
 * publications are NOT deleted, they simply stop being filed under anything.
 *
 * FAILURES ARE NAMED, NEVER COUNTED. "3 of 5 deleted" leaves the reader to work out which two
 * survived; the toast names them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ContentStatus } from "@prisma/client";
import { ExternalLink, EyeOff, Microscope, PencilLine, Plus, SearchX, Trash2 } from "lucide-react";

import { asApiClientError, del, patch } from "@/lib/client/fetcher";
import { STATUS_LABELS } from "@/lib/content";
import { LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/ToastProvider";
import {
  DATA_TABLE_PRIMARY_LINK_CLASS,
  DataTable,
  type DataTableColumn
} from "@/components/studio/DataTable";
import { RowActions } from "@/components/studio/RowActions";

/** One row, already flattened and already formatted by the page. */
export interface ResearchAreaRow {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  icon: string | null;
  /** A literal hex or `oklch(…)` string, used ONLY by the research graph. */
  accentColor: string | null;
  sortOrder: number;
  status: ContentStatus;
  projectCount: number;
  publicationCount: number;
  /** Formatted on the server — see the page's header for why. */
  updatedLabel: string;
}

export interface ResearchAreaTableProps {
  rows: readonly ResearchAreaRow[];
  totalItems: number;
  /**
   * True when a search or a status is narrowing the list. "Nothing matches these filters" and
   * "nothing has been added yet" are different situations with different remedies, and an empty table
   * that does not say which one it is reads as a fault.
   */
  filtered: boolean;
  canDelete: boolean;
  canPublish: boolean;
}

/** How long the recycle bin keeps a deleted row. Stated in the question, never implied. */
const RETENTION_DAYS = 30;

export function ResearchAreaTable({
  rows,
  totalItems,
  filtered,
  canDelete,
  canPublish
}: ResearchAreaTableProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [flashRowId, setFlashRowId] = useState<string | null>(null);

  /**
   * Delete one or many, after asking. Returns nothing — every outcome is reported on screen.
   *
   * The requests run one after another rather than all at once: the failures have to be attributable
   * to a named row, and a burst of parallel writes against the audit log buys nothing on a list of
   * this size.
   */
  const askAndDelete = useCallback(
    async (targets: readonly ResearchAreaRow[]) => {
      if (targets.length === 0) return;
      const first = targets[0];
      if (!first) return;

      const single = targets.length === 1;
      const filed = targets.reduce(
        (sum, row) => sum + row.projectCount + row.publicationCount,
        0
      );

      const agreed = await confirm({
        title: single
          ? `Delete research area “${first.title}”?`
          : `Delete ${targets.length} research areas?`,
        body: (
          <>
            <p>
              {single ? "It" : "They"} will move to the recycle bin, where an administrator can restore{" "}
              {single ? "it" : "them"} for {RETENTION_DAYS} days. After that a clean-up job removes{" "}
              {single ? "it" : "them"} for good. {single ? "It disappears" : "They disappear"} from the
              public site straight away.
            </p>
            {filed > 0 ? (
              <p className="mt-2">
                {filed === 1
                  ? "One project or publication is filed under this area."
                  : `${filed} projects and publications are filed under ${single ? "this area" : "these areas"}.`}{" "}
                None of them is deleted — they simply stop being filed under anything, and disappear from
                the research diagram until you file them somewhere else.
              </p>
            ) : null}
          </>
        ),
        confirmLabel: "Move to recycle bin",
        cancelLabel: "Keep them",
        tone: "danger"
      });
      if (!agreed) return;

      const failures: { title: string; reason: string }[] = [];
      let deleted = 0;

      for (const row of targets) {
        try {
          await del(`/api/studio/research/${encodeURIComponent(row.id)}`);
          deleted += 1;
        } catch (thrown) {
          // `message` from lib/api.ts is already a plain sentence ready to render (contract §9).
          failures.push({ title: row.title, reason: asApiClientError(thrown).message });
        }
      }

      if (deleted > 0) {
        toast({
          tone: "success",
          title:
            deleted === 1
              ? "1 research area is in the recycle bin"
              : `${deleted} research areas are in the recycle bin`,
          description: `An administrator can restore them for the next ${RETENTION_DAYS} days.`
        });
      }
      if (failures.length > 0) {
        const named = failures
          .slice(0, 3)
          .map((entry) => `${entry.title} — ${entry.reason}`)
          .join("; ");
        const more = failures.length > 3 ? ` ${failures.length - 3} more also failed.` : "";
        toast({
          tone: "error",
          title:
            failures.length === 1
              ? "One research area was not deleted"
              : `${failures.length} research areas were not deleted`,
          description: `${named}.${more}`
        });
      }

      // The list is server-rendered, so the deleted rows only disappear once this page is asked again.
      router.refresh();
    },
    [confirm, router, toast]
  );

  /**
   * Take an area off the public site from the list.
   *
   * Archiving is offered here and PUBLISHING IS NOT, deliberately. Taking something down is safe and
   * reversible; putting it up has checks that live in the editor (an area with no summary publishes as
   * a bare heading), and a one-click publish from a list is the way those checks get skipped.
   */
  const archive = useCallback(
    async (row: ResearchAreaRow) => {
      const agreed = await confirm({
        title: `Take “${row.title}” off the public site?`,
        body: (
          <p>
            It stays in the studio as an archived record and can be published again at any time. Anyone
            following a link to it will see a “page not found”.
          </p>
        ),
        confirmLabel: "Take it off the site",
        cancelLabel: "Leave it published"
      });
      if (!agreed) return;

      try {
        await patch(`/api/studio/research/${encodeURIComponent(row.id)}`, { status: "ARCHIVED" });
        setFlashRowId(row.id);
        // Cleared after about a second: the `.flash-row` outline is the static half of the signal and a
        // permanent outline on one row stops meaning anything.
        window.setTimeout(() => setFlashRowId(null), 1200);
        toast({ tone: "success", title: `“${row.title}” is no longer on the public site` });
        router.refresh();
      } catch (thrown) {
        toast({
          tone: "error",
          title: "It is still published",
          description: asApiClientError(thrown).message
        });
      }
    },
    [confirm, router, toast]
  );

  const columns: readonly DataTableColumn<ResearchAreaRow>[] = [
    {
      key: "title",
      header: "Name",
      sortable: true,
      render: (row) => (
        <span className="block min-w-0">
          <Link href={`/studio/research/${row.id}`} className={DATA_TABLE_PRIMARY_LINK_CLASS}>
            {row.title}
          </Link>
          {/* The address, because it is what a citation records and what an editor checks. */}
          <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-ink-500">
            /research/{row.slug}
          </span>
        </span>
      )
    },
    {
      key: "accent",
      header: "Graph colour",
      headerLabel: "Colour used in the research diagram",
      width: 120,
      resizable: false,
      render: (row) =>
        row.accentColor ? (
          <span className="flex items-center gap-2">
            {/*
              An inline style, because the colour is data: a class name built from a value is purged
              (contract §5), and there is no fixed palette to pick a token from. The border is named so
              a pale colour still reads as a swatch rather than as nothing.
            */}
            <span
              aria-hidden="true"
              style={{ backgroundColor: row.accentColor }}
              className="h-4 w-4 shrink-0 rounded border border-line-200"
            />
            <span className="min-w-0 truncate font-mono text-[0.6875rem] text-ink-500">
              {row.accentColor}
            </span>
          </span>
        ) : (
          <span className="text-xs text-ink-500">Chosen for you</span>
        )
    },
    {
      key: "icon",
      header: "Icon",
      width: 130,
      hideBelow: "lg",
      render: (row) =>
        row.icon ? (
          <span className="truncate font-mono text-[0.6875rem] text-ink-500">{row.icon}</span>
        ) : (
          <span className="text-xs text-ink-500">None</span>
        )
    },
    {
      key: "filed",
      header: "Filed under it",
      width: 170,
      hideBelow: "md",
      render: (row) => (
        <span className="text-xs text-ink-700">
          {row.projectCount === 1 ? "1 project" : `${row.projectCount} projects`}
          <span aria-hidden="true"> · </span>
          {row.publicationCount === 1
            ? "1 publication"
            : `${row.publicationCount} publications`}
        </span>
      )
    },
    {
      key: "order",
      header: "Order",
      align: "end",
      width: 90,
      sortable: true,
      resizable: false,
      render: (row) => <span className="tabular-nums text-xs text-ink-700">{row.sortOrder}</span>
    },
    {
      key: "status",
      header: "Status",
      width: 130,
      sortable: true,
      resizable: false,
      render: (row) => <StatusBadge status={row.status} size="sm" />
    },
    {
      key: "updated",
      header: "Changed (UTC)",
      width: 150,
      sortable: true,
      defaultDirection: "desc",
      hideBelow: "lg",
      render: (row) => <span className="text-xs text-ink-500">{row.updatedLabel}</span>
    }
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={(row) => row.id}
      getRowLabel={(row) => row.title}
      label="Research areas"
      totalItems={totalItems}
      flashRowId={flashRowId}
      selectable={canDelete}
      bulkActions={
        canDelete
          ? [
              {
                id: "recycle",
                label: "Move to recycle bin",
                icon: Trash2,
                tone: "danger",
                onRun: (selected) => askAndDelete(selected)
              }
            ]
          : undefined
      }
      sort={{ defaultKey: "order", defaultDirection: "asc" }}
      rowActions={(row) => (
        <RowActions
          subject={row.title}
          actions={[
            {
              id: "edit",
              label: "Open this research area",
              icon: PencilLine,
              onSelect: () => router.push(`/studio/research/${row.id}`)
            },
            {
              id: "view",
              label: "Open on the public site",
              icon: ExternalLink,
              // Not a permission — it is simply not there to look at until it is published.
              disabled: row.status !== "PUBLISHED",
              description:
                row.status === "PUBLISHED"
                  ? undefined
                  : `${STATUS_LABELS[row.status]} — it is not on the public site yet.`,
              onSelect: () => window.open(`/research/${row.slug}`, "_blank", "noopener,noreferrer")
            },
            {
              id: "archive",
              label: "Take off the public site",
              icon: EyeOff,
              show: canPublish,
              disabled: row.status !== "PUBLISHED",
              onSelect: () => void archive(row)
            },
            {
              id: "delete",
              label: "Move to recycle bin",
              icon: Trash2,
              tone: "danger",
              show: canDelete,
              onSelect: () => void askAndDelete([row])
            }
          ]}
        />
      )}
      empty={
        <EmptyState
          // Inside a page whose `<h1>` is the header, so the empty state's own heading is an `<h2>`.
          headingLevel={2}
          icon={filtered ? SearchX : Microscope}
          title={
            filtered
              ? "Nothing matches these filters"
              : "No research areas have been added yet"
          }
          description={
            filtered
              ? "Clear the filters above to see everything. A search looks at the name, the summary and the web address."
              : "A research area is a theme the Centre works on. Projects and publications are filed under one, and the diagram on the research page is drawn from them, so these are usually the first thing to set up."
          }
          action={
            filtered ? null : (
              <LinkButton href="/studio/research/new" icon={Plus}>
                New research area
              </LinkButton>
            )
          }
        />
      }
    />
  );
}
