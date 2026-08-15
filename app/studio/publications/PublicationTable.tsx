"use client";

/**
 * The publications table.
 *
 * A client component because `DataTable`'s columns carry `render` functions and its row menu carries
 * `onSelect` callbacks, neither of which can cross from a Server Component.
 *
 * THE AUTHOR LINE IS SHOWN UNDER EVERY TITLE, truncated to one line. It is the field readers quote and
 * the field most often wrong after an import, so it belongs where an editor scanning the list will see
 * it rather than two clicks away.
 *
 * THE "OUR PEOPLE" COUNT IS A SEPARATE COLUMN FROM THE AUTHOR LINE, and that separation is the point:
 * the line is what gets printed, the count is how many of those authors have a profile here. A
 * publication with six authors and no links is perfectly correct; one with six authors and six links is
 * unusual. Nothing here can be derived from the other.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ContentStatus } from "@prisma/client";
import {
  BookMarked,
  ExternalLink,
  EyeOff,
  FileText,
  Link2,
  PencilLine,
  Plus,
  SearchX,
  Star,
  Trash2
} from "lucide-react";

import { asApiClientError, del, patch } from "@/lib/client/fetcher";
import { STATUS_LABELS } from "@/lib/content";
import { Badge } from "@/components/ui/Badge";
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

export interface PublicationRow {
  id: string;
  title: string;
  slug: string;
  /** Already worded by the page, from its own label map. */
  kindLabel: string;
  year: number;
  /** The authoritative printed author line. */
  authorLine: string;
  /** The one-line venue from `publicationDisplayVenue()`, or null when there is nothing to say. */
  venueLabel: string | null;
  areaTitle: string | null;
  /** How many authors have a profile at the Centre. NOT how many authors there are. */
  linkedAuthorCount: number;
  hasDoi: boolean;
  hasPdf: boolean;
  isFeatured: boolean;
  status: ContentStatus;
  updatedLabel: string;
}

export interface PublicationTableProps {
  rows: readonly PublicationRow[];
  totalItems: number;
  filtered: boolean;
  canDelete: boolean;
  canPublish: boolean;
}

const RETENTION_DAYS = 30;

export function PublicationTable({
  rows,
  totalItems,
  filtered,
  canDelete,
  canPublish
}: PublicationTableProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [flashRowId, setFlashRowId] = useState<string | null>(null);

  const askAndDelete = useCallback(
    async (targets: readonly PublicationRow[]) => {
      if (targets.length === 0) return;
      const first = targets[0];
      if (!first) return;
      const single = targets.length === 1;

      const agreed = await confirm({
        title: single
          ? `Delete publication “${first.title}”?`
          : `Delete ${targets.length} publications?`,
        body: (
          <>
            <p>
              {single ? "It" : "They"} will move to the recycle bin, where an administrator can restore{" "}
              {single ? "it" : "them"} for {RETENTION_DAYS} days.{" "}
              {single ? "It disappears" : "They disappear"} from the public site straight away.
            </p>
            <p className="mt-2">
              Anyone who has cited the page will get a “page not found”. If the work is simply superseded,
              taking it off the site as an archived record keeps the address working for a redirect later.
            </p>
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
          await del(`/api/studio/publications/${encodeURIComponent(row.id)}`);
          deleted += 1;
        } catch (thrown) {
          failures.push({ title: row.title, reason: asApiClientError(thrown).message });
        }
      }

      if (deleted > 0) {
        toast({
          tone: "success",
          title:
            deleted === 1
              ? "1 publication is in the recycle bin"
              : `${deleted} publications are in the recycle bin`,
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
              ? "One publication was not deleted"
              : `${failures.length} publications were not deleted`,
          description: `${named}.${more}`
        });
      }

      router.refresh();
    },
    [confirm, router, toast]
  );

  const archive = useCallback(
    async (row: PublicationRow) => {
      const agreed = await confirm({
        title: `Take “${row.title}” off the public site?`,
        body: (
          <p>
            It stays in the studio as an archived record and can be published again at any time. Anyone
            following a citation to it will see a “page not found”, so this is worth doing only when the
            record itself is wrong.
          </p>
        ),
        confirmLabel: "Take it off the site",
        cancelLabel: "Leave it published"
      });
      if (!agreed) return;

      try {
        await patch(`/api/studio/publications/${encodeURIComponent(row.id)}`, {
          status: "ARCHIVED"
        });
        setFlashRowId(row.id);
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

  const columns: readonly DataTableColumn<PublicationRow>[] = [
    {
      key: "title",
      header: "Title and authors",
      sortable: true,
      render: (row) => (
        <span className="block min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link href={`/studio/publications/${row.id}`} className={DATA_TABLE_PRIMARY_LINK_CLASS}>
              {row.title}
            </Link>
            {row.isFeatured ? (
              // A glyph AND a name: colour and shape never carry meaning alone (contract §11).
              <Star aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-purple-700" />
            ) : null}
            {row.isFeatured ? <span className="sr-only">Featured</span> : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-500">{row.authorLine}</span>
        </span>
      )
    },
    {
      key: "kind",
      header: "Type",
      width: 150,
      sortable: true,
      resizable: false,
      render: (row) => (
        <Badge tone="neutral" size="sm">
          {row.kindLabel}
        </Badge>
      )
    },
    {
      key: "year",
      header: "Year",
      width: 90,
      align: "end",
      sortable: true,
      resizable: false,
      defaultDirection: "desc",
      render: (row) => <span className="text-xs tabular-nums text-ink-700">{row.year}</span>
    },
    {
      key: "venue",
      header: "Published in",
      width: 220,
      hideBelow: "md",
      render: (row) =>
        row.venueLabel ? (
          <span className="block truncate text-xs text-ink-700">{row.venueLabel}</span>
        ) : (
          <span className="text-xs text-ink-500">Not recorded</span>
        )
    },
    {
      key: "area",
      header: "Research area",
      width: 170,
      hideBelow: "lg",
      render: (row) =>
        row.areaTitle ? (
          <span className="block truncate text-xs text-ink-700">{row.areaTitle}</span>
        ) : (
          <span className="text-xs text-ink-500">Not filed</span>
        )
    },
    {
      key: "people",
      header: "Our people",
      headerLabel: "Authors who have a profile at the Centre",
      width: 120,
      align: "end",
      hideBelow: "lg",
      render: (row) => (
        <span className="text-xs tabular-nums text-ink-700">
          {row.linkedAuthorCount === 0 ? "None linked" : row.linkedAuthorCount}
        </span>
      )
    },
    {
      key: "attachments",
      header: "Has",
      headerLabel: "What is attached to it",
      width: 110,
      resizable: false,
      render: (row) => (
        <span className="flex items-center gap-2 text-ink-500">
          {row.hasDoi ? (
            <span className="inline-flex items-center gap-1 text-xs">
              <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
              DOI
            </span>
          ) : null}
          {row.hasPdf ? (
            <span className="inline-flex items-center gap-1 text-xs">
              <FileText aria-hidden="true" className="h-3.5 w-3.5" />
              PDF
            </span>
          ) : null}
          {!row.hasDoi && !row.hasPdf ? <span className="text-xs">Neither</span> : null}
        </span>
      )
    },
    {
      key: "status",
      header: "On the site",
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
      label="Publications"
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
      sort={{ defaultKey: "year", defaultDirection: "desc" }}
      rowActions={(row) => (
        <RowActions
          subject={row.title}
          actions={[
            {
              id: "edit",
              label: "Open this publication",
              icon: PencilLine,
              onSelect: () => router.push(`/studio/publications/${row.id}`)
            },
            {
              id: "view",
              label: "Open on the public site",
              icon: ExternalLink,
              disabled: row.status !== "PUBLISHED",
              description:
                row.status === "PUBLISHED"
                  ? undefined
                  : `${STATUS_LABELS[row.status]} — it is not on the public site yet.`,
              onSelect: () =>
                window.open(`/publications/${row.slug}`, "_blank", "noopener,noreferrer")
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
          headingLevel={2}
          icon={filtered ? SearchX : BookMarked}
          title={filtered ? "Nothing matches these filters" : "No publications have been added yet"}
          description={
            filtered
              ? "Clear the filters above to see everything. The search box looks at the title and the abstract only — use the author filter for one of the Centre's own people."
              : "Publications can be added one at a time, or imported in bulk by pasting BibTeX or a list of DOIs."
          }
          action={
            filtered ? null : (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <LinkButton href="/studio/publications/new" icon={Plus}>
                  New publication
                </LinkButton>
                <LinkButton href="/studio/publications/import" variant="secondary">
                  Import from BibTeX or DOIs
                </LinkButton>
              </div>
            )
          }
        />
      }
    />
  );
}
