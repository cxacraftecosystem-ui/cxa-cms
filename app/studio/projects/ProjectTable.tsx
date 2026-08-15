"use client";

/**
 * The projects table.
 *
 * A client component because `DataTable`'s columns carry `render` functions and its row menu carries
 * `onSelect` callbacks, neither of which can cross from a Server Component. `page.tsx` owns the
 * permission check, the query and the filters; this owns the table.
 *
 * TWO STATES PER ROW, AND THEY ARE NOT THE SAME THING. "Stage" is where the WORK stands — proposed,
 * active, completed, on hold. "Status" is whether the PAGE is on the public site. A completed project
 * can be a draft and an active one can be archived, so both columns are always shown and each is
 * labelled with the word an editor would use.
 *
 * PROGRESS OF 0 READS "Not tracked", never "0%". Zero hides the bar entirely on the public site, so a
 * row saying "0%" would describe something the reader will not find when they look at the page.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ContentStatus, ProjectStatus } from "@prisma/client";
import {
  CircleCheckBig,
  CirclePause,
  CirclePlay,
  ExternalLink,
  EyeOff,
  FlaskConical,
  Lightbulb,
  PencilLine,
  Plus,
  SearchX,
  Trash2,
  type LucideIcon
} from "lucide-react";

import { asApiClientError, del, patch } from "@/lib/client/fetcher";
import { STATUS_LABELS } from "@/lib/content";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
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

export interface ProjectRow {
  id: string;
  title: string;
  slug: string;
  state: ProjectStatus;
  status: ContentStatus;
  /** 0–100. Zero means "not tracked" — see the header. */
  progress: number;
  /** "2021–2024", "2021 onwards", "No dates". Built on the server. */
  yearsLabel: string;
  areaTitle: string | null;
  fundingBody: string | null;
  /** The currency and the amount as typed, or null. Never reformatted. */
  fundingLabel: string | null;
  memberCount: number;
  milestoneCount: number;
  updatedLabel: string;
}

export interface ProjectTableProps {
  rows: readonly ProjectRow[];
  totalItems: number;
  filtered: boolean;
  canDelete: boolean;
  canPublish: boolean;
}

/**
 * The stage as a word, a glyph and a tone — in that order of importance. Colour never carries the
 * meaning alone (contract §11).
 *
 * ⚠ Kept in step with `app/(site)/projects/page.tsx` and
 * `components/sections/ProjectShowcaseSection.tsx`. One project cannot be "Active" here and "In
 * progress" there.
 */
const STAGE: Record<ProjectStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  PROPOSED: { label: "Proposed", tone: "neutral", icon: Lightbulb },
  ACTIVE: { label: "Active", tone: "info", icon: CirclePlay },
  COMPLETED: { label: "Completed", tone: "success", icon: CircleCheckBig },
  ON_HOLD: { label: "On hold", tone: "warn", icon: CirclePause }
};

const RETENTION_DAYS = 30;

export function ProjectTable({
  rows,
  totalItems,
  filtered,
  canDelete,
  canPublish
}: ProjectTableProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [flashRowId, setFlashRowId] = useState<string | null>(null);

  const askAndDelete = useCallback(
    async (targets: readonly ProjectRow[]) => {
      if (targets.length === 0) return;
      const first = targets[0];
      if (!first) return;
      const single = targets.length === 1;

      const agreed = await confirm({
        title: single ? `Delete project “${first.title}”?` : `Delete ${targets.length} projects?`,
        body: (
          <>
            <p>
              {single ? "It" : "They"} will move to the recycle bin, where an administrator can restore{" "}
              {single ? "it" : "them"} for {RETENTION_DAYS} days. {single ? "It disappears" : "They disappear"}{" "}
              from the public site straight away.
            </p>
            <p className="mt-2">
              The people, publications, files and photographs attached to{" "}
              {single ? "it" : "them"} are not deleted — only the link between them and the project goes.
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

      // One at a time, so a failure can be attributed to a named project.
      for (const row of targets) {
        try {
          await del(`/api/studio/projects/${encodeURIComponent(row.id)}`);
          deleted += 1;
        } catch (thrown) {
          failures.push({ title: row.title, reason: asApiClientError(thrown).message });
        }
      }

      if (deleted > 0) {
        toast({
          tone: "success",
          title: deleted === 1 ? "1 project is in the recycle bin" : `${deleted} projects are in the recycle bin`,
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
              ? "One project was not deleted"
              : `${failures.length} projects were not deleted`,
          description: `${named}.${more}`
        });
      }

      router.refresh();
    },
    [confirm, router, toast]
  );

  /**
   * Take a project off the public site.
   *
   * Publishing is deliberately NOT offered from the list: a project publishes with checks that live in
   * the editor, and a one-click publish from a table is how those checks get skipped.
   */
  const archive = useCallback(
    async (row: ProjectRow) => {
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
        await patch(`/api/studio/projects/${encodeURIComponent(row.id)}`, { status: "ARCHIVED" });
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

  const columns: readonly DataTableColumn<ProjectRow>[] = [
    {
      key: "title",
      header: "Project",
      sortable: true,
      render: (row) => (
        <span className="block min-w-0">
          <Link href={`/studio/projects/${row.id}`} className={DATA_TABLE_PRIMARY_LINK_CLASS}>
            {row.title}
          </Link>
          <span className="mt-0.5 block truncate text-xs text-ink-500">
            {row.areaTitle ?? "Not filed under a research area"}
          </span>
        </span>
      )
    },
    {
      key: "stage",
      header: "Stage",
      width: 140,
      sortable: true,
      resizable: false,
      render: (row) => {
        const stage = STAGE[row.state];
        return (
          <Badge tone={stage.tone} size="sm" icon={stage.icon}>
            {stage.label}
          </Badge>
        );
      }
    },
    {
      key: "years",
      header: "Dates",
      // The column shows a RANGE and the sort is on the START date, so the key is named for what the
      // database is asked for rather than for what the cell shows.
      sortKey: "started",
      sortable: true,
      defaultDirection: "desc",
      width: 130,
      hideBelow: "md",
      render: (row) => <span className="text-xs tabular-nums text-ink-700">{row.yearsLabel}</span>
    },
    {
      key: "funding",
      header: "Funding",
      width: 190,
      hideBelow: "lg",
      render: (row) =>
        row.fundingBody || row.fundingLabel ? (
          <span className="block min-w-0">
            {row.fundingBody ? (
              <span className="block truncate text-xs text-ink-700">{row.fundingBody}</span>
            ) : null}
            {row.fundingLabel ? (
              <span className="block truncate text-xs text-ink-500">{row.fundingLabel}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-xs text-ink-500">Not recorded</span>
        )
    },
    {
      key: "progress",
      header: "Progress",
      width: 110,
      align: "end",
      sortable: true,
      resizable: false,
      defaultDirection: "desc",
      render: (row) =>
        row.progress > 0 ? (
          <span className="text-xs tabular-nums text-ink-700">{row.progress}%</span>
        ) : (
          // Zero hides the bar on the public site, so "0%" would describe something nobody will see.
          <span className="text-xs text-ink-500">Not tracked</span>
        )
    },
    {
      key: "team",
      header: "Team",
      width: 110,
      align: "end",
      hideBelow: "lg",
      render: (row) => (
        <span className="text-xs tabular-nums text-ink-700">
          {row.memberCount === 1 ? "1 person" : `${row.memberCount} people`}
        </span>
      )
    },
    {
      key: "status",
      header: "On the site",
      width: 130,
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
      label="Projects"
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
      sort={{ defaultKey: "updated", defaultDirection: "desc" }}
      rowActions={(row) => (
        <RowActions
          subject={row.title}
          actions={[
            {
              id: "edit",
              label: "Open this project",
              icon: PencilLine,
              onSelect: () => router.push(`/studio/projects/${row.id}`)
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
              onSelect: () => window.open(`/projects/${row.slug}`, "_blank", "noopener,noreferrer")
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
          icon={filtered ? SearchX : FlaskConical}
          title={filtered ? "Nothing matches these filters" : "No projects have been added yet"}
          description={
            filtered
              ? "Clear the filters above to see everything. A search looks at the title, the tagline, the summary and the funder."
              : "A project is a piece of funded or in-house research, with its team, its milestones and what it has produced. It is usually worth setting up the research areas first, so a project has somewhere to be filed."
          }
          action={
            filtered ? null : (
              <LinkButton href="/studio/projects/new" icon={Plus}>
                New project
              </LinkButton>
            )
          }
        />
      }
    />
  );
}
