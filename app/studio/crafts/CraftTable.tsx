"use client";

/**
 * The craft archive table.
 *
 * A client component because `DataTable`'s columns carry `render` functions and its row menu carries
 * `onSelect` callbacks, neither of which can cross from a Server Component.
 *
 * THE LOCAL NAME IS RENDERED WITH ITS OWN `lang`. It is the same rule as on the public site and it
 * matters here too: a screen reader reading Devanagari with an English voice produces sounds that are
 * not words in either language. When no language has been recorded the name is still shown — hiding it
 * would be worse — but the row carries a quiet note, because an unlabelled script is a real problem
 * somebody has to fix.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ContentStatus } from "@prisma/client";
import {
  Box,
  ExternalLink,
  EyeOff,
  Layers,
  PencilLine,
  Plus,
  SearchX,
  Star,
  Trash2,
  TriangleAlert
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

export interface CraftRow {
  id: string;
  name: string;
  slug: string;
  localName: string | null;
  /** A language tag such as "hi". Null means nobody has recorded which language the name is in. */
  localNameLang: string | null;
  /** "c. 1500", "c. 3000 BCE", or null. Formatted on the server. */
  originLabel: string | null;
  regionName: string | null;
  regionLevel: string | null;
  schoolName: string | null;
  materialCount: number;
  techniqueCount: number;
  mediaCount: number;
  hasModel: boolean;
  isFeatured: boolean;
  status: ContentStatus;
  updatedLabel: string;
}

export interface CraftTableProps {
  rows: readonly CraftRow[];
  totalItems: number;
  filtered: boolean;
  canDelete: boolean;
  canPublish: boolean;
}

const RETENTION_DAYS = 30;

export function CraftTable({
  rows,
  totalItems,
  filtered,
  canDelete,
  canPublish
}: CraftTableProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [flashRowId, setFlashRowId] = useState<string | null>(null);

  const askAndDelete = useCallback(
    async (targets: readonly CraftRow[]) => {
      if (targets.length === 0) return;
      const first = targets[0];
      if (!first) return;
      const single = targets.length === 1;
      const photographs = targets.reduce((sum, row) => sum + row.mediaCount, 0);

      const agreed = await confirm({
        title: single ? `Delete craft record “${first.name}”?` : `Delete ${targets.length} craft records?`,
        body: (
          <>
            <p>
              {single ? "It" : "They"} will move to the recycle bin, where an administrator can restore{" "}
              {single ? "it" : "them"} for {RETENTION_DAYS} days.{" "}
              {single ? "It disappears" : "They disappear"} from the craft explorer straight away.
            </p>
            {photographs > 0 ? (
              <p className="mt-2">
                The{" "}
                {photographs === 1 ? "photograph" : `${photographs} photographs and scans`} stay in the
                media library and can be used elsewhere. Only their place in this record goes.
              </p>
            ) : null}
          </>
        ),
        confirmLabel: "Move to recycle bin",
        cancelLabel: "Keep them",
        tone: "danger"
      });
      if (!agreed) return;

      const failures: { name: string; reason: string }[] = [];
      let deleted = 0;

      for (const row of targets) {
        try {
          await del(`/api/studio/crafts/${encodeURIComponent(row.id)}`);
          deleted += 1;
        } catch (thrown) {
          failures.push({ name: row.name, reason: asApiClientError(thrown).message });
        }
      }

      if (deleted > 0) {
        toast({
          tone: "success",
          title:
            deleted === 1
              ? "1 craft record is in the recycle bin"
              : `${deleted} craft records are in the recycle bin`,
          description: `An administrator can restore them for the next ${RETENTION_DAYS} days.`
        });
      }
      if (failures.length > 0) {
        const named = failures
          .slice(0, 3)
          .map((entry) => `${entry.name} — ${entry.reason}`)
          .join("; ");
        const more = failures.length > 3 ? ` ${failures.length - 3} more also failed.` : "";
        toast({
          tone: "error",
          title:
            failures.length === 1
              ? "One craft record was not deleted"
              : `${failures.length} craft records were not deleted`,
          description: `${named}.${more}`
        });
      }

      router.refresh();
    },
    [confirm, router, toast]
  );

  const archive = useCallback(
    async (row: CraftRow) => {
      const agreed = await confirm({
        title: `Take “${row.name}” out of the craft explorer?`,
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
        await patch(`/api/studio/crafts/${encodeURIComponent(row.id)}`, { status: "ARCHIVED" });
        setFlashRowId(row.id);
        window.setTimeout(() => setFlashRowId(null), 1200);
        toast({ tone: "success", title: `“${row.name}” is no longer on the public site` });
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

  const columns: readonly DataTableColumn<CraftRow>[] = [
    {
      key: "name",
      header: "Craft",
      sortable: true,
      render: (row) => (
        <span className="block min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link href={`/studio/crafts/${row.id}`} className={DATA_TABLE_PRIMARY_LINK_CLASS}>
              {row.name}
            </Link>
            {row.isFeatured ? (
              <>
                <Star aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-purple-700" />
                <span className="sr-only">Featured</span>
              </>
            ) : null}
          </span>

          {row.localName ? (
            <span className="mt-0.5 flex items-center gap-1.5">
              {/*
                `lang` on the element itself, so a screen reader switches voice for these words. Without
                it Devanagari is read with an English voice and comes out as noise.
              */}
              <span lang={row.localNameLang ?? undefined} className="truncate text-xs text-ink-700">
                {row.localName}
              </span>
              {row.localNameLang === null ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-[0.6875rem] text-amber-800"
                  title="No language has been recorded for this name"
                >
                  <TriangleAlert aria-hidden="true" className="h-3 w-3" />
                  no language set
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      )
    },
    {
      key: "origin",
      header: "Origin",
      width: 130,
      sortable: true,
      resizable: false,
      render: (row) =>
        row.originLabel ? (
          <span className="text-xs tabular-nums text-ink-700">{row.originLabel}</span>
        ) : (
          <span className="text-xs text-ink-500">Not recorded</span>
        )
    },
    {
      key: "region",
      header: "Region",
      width: 180,
      hideBelow: "md",
      render: (row) =>
        row.regionName ? (
          <span className="block min-w-0">
            <span className="block truncate text-xs text-ink-700">{row.regionName}</span>
            {row.regionLevel ? (
              <span className="block text-[0.6875rem] text-ink-500">
                {row.regionLevel.toLowerCase()}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-xs text-ink-500">Not recorded</span>
        )
    },
    {
      key: "school",
      header: "School",
      width: 160,
      hideBelow: "lg",
      render: (row) =>
        row.schoolName ? (
          <span className="block truncate text-xs text-ink-700">{row.schoolName}</span>
        ) : (
          <span className="text-xs text-ink-500">Not recorded</span>
        )
    },
    {
      key: "described",
      header: "Recorded",
      headerLabel: "How much has been recorded",
      width: 190,
      hideBelow: "lg",
      render: (row) => (
        <span className="text-xs text-ink-700">
          {row.materialCount === 1 ? "1 material" : `${row.materialCount} materials`}
          <span aria-hidden="true"> · </span>
          {row.techniqueCount === 1 ? "1 technique" : `${row.techniqueCount} techniques`}
        </span>
      )
    },
    {
      key: "media",
      header: "Pictures",
      width: 130,
      align: "end",
      resizable: false,
      render: (row) => (
        <span className="flex items-center justify-end gap-2">
          <span className="text-xs tabular-nums text-ink-700">{row.mediaCount}</span>
          {row.hasModel ? (
            // A glyph and a word: colour and shape never carry meaning alone (contract §11).
            <Badge tone="info" size="sm" icon={Box}>
              3D
            </Badge>
          ) : null}
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
      getRowLabel={(row) => row.name}
      label="Craft records"
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
      sort={{ defaultKey: "name", defaultDirection: "asc" }}
      rowActions={(row) => (
        <RowActions
          subject={row.name}
          actions={[
            {
              id: "edit",
              label: "Open this craft record",
              icon: PencilLine,
              onSelect: () => router.push(`/studio/crafts/${row.id}`)
            },
            {
              id: "view",
              label: "Open on the public site",
              icon: ExternalLink,
              disabled: row.status !== "PUBLISHED",
              description:
                row.status === "PUBLISHED"
                  ? undefined
                  : `${STATUS_LABELS[row.status]} — it is not in the craft explorer yet.`,
              onSelect: () =>
                window.open(`/craft-explorer/${row.slug}`, "_blank", "noopener,noreferrer")
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
          icon={filtered ? SearchX : Layers}
          title={filtered ? "Nothing matches these filters" : "No craft records have been added yet"}
          description={
            filtered
              ? "Clear the filters above to see everything. A search looks at the name, the local name and the summary."
              : "A craft record holds where a craft comes from, what it is made of, how it is made, and the photographs that document it. Regions and schools are set up separately, and a record can be written before either of them exists."
          }
          action={
            filtered ? null : (
              <LinkButton href="/studio/crafts/new" icon={Plus}>
                New craft record
              </LinkButton>
            )
          }
        />
      }
    />
  );
}
