"use client";

/**
 * PagesTable — the interactive half of the Pages list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL, when the rows are read from the database next door.
 *
 * `DataTable`, `FilterToolbar` and `RowActions` are all `"use client"`, and every one of them takes
 * FUNCTIONS — `getRowId`, a column's `render`, an action's `onSelect`. A function cannot cross the
 * server/client boundary, so a Server Component cannot configure them. The split is therefore the same
 * one `app/studio/media` uses: the page reads Prisma and decides what is true, this component decides
 * what happens when somebody presses something.
 *
 * THE ROWS ARE NEVER `null` HERE, and that is not a violation of contract §9. `null` means "a fetch is
 * in flight"; this screen has no fetch — the filters are in the URL, so narrowing the list is a
 * NAVIGATION and Next keeps the previous rows on screen until the new ones are ready. The `null` state
 * belongs to screens that fetch (the media library), and inventing one here would mean blanking a
 * working table on every keystroke.
 *
 * SYSTEM PAGES CANNOT BE DELETED, AND THE ROW SAYS SO RATHER THAN GOING QUIET. `Page.isSystem` marks
 * the pages whose route the code itself renders and whose address the site's own navigation links to;
 * deleting one turns a menu entry into a "page not found". So the Delete entry is ABSENT on those rows
 * (contract §1.8 — never a disabled control) and a badge beside the title explains why, because an
 * administrator who cannot find Delete needs a reason, not a mystery.
 *
 * TIMES AND LIVENESS ARE DECIDED ON THE SERVER AND ARRIVE AS STRINGS. "Is this page public right now"
 * is `isLive()` compared against a clock, and "12 June 2026, 09:14" is a clock plus a time zone — both
 * differ between the server pass and the browser, which is a hydration mismatch React resolves by
 * keeping whichever it likes. So the page computes them once and hands down the answer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, FileStack, Pencil, SearchX, ShieldCheck, Trash2 } from "lucide-react";
import type { ContentStatus } from "@prisma/client";

import { asApiClientError, del } from "@/lib/client/fetcher";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/ToastProvider";
import {
  DATA_TABLE_PRIMARY_LINK_CLASS,
  DataTable,
  type DataTableColumn
} from "@/components/studio/DataTable";
import { FilterToolbar } from "@/components/studio/FilterToolbar";
import { RowActions, type RowAction } from "@/components/studio/RowActions";

/**
 * One row, exactly as the server sends it.
 *
 * Every date is a pre-formatted STRING rather than an ISO instant, and `isLive` is a boolean rather
 * than the three columns it is derived from — see the header. `lastEditedBy` is `null` when no revision
 * has ever been written for the page, which is a real state (a page created by the seed script) and is
 * printed as words rather than as an empty cell.
 */
export interface StudioPageRow {
  id: string;
  title: string;
  /** The stored slug: `""` is the homepage. */
  slug: string;
  /** The public path, `"/"` for the homepage. */
  path: string;
  navLabel: string | null;
  status: ContentStatus;
  /** True when an anonymous visitor can reach it right now, resolved at read time on the server. */
  isLive: boolean;
  isSystem: boolean;
  sectionCount: number;
  /** "12 June 2026, 09:14" in the Centre's zone. */
  updatedLabel: string;
  /** The name on the newest revision, or null when none has been recorded. */
  lastEditedBy: string | null;
}

export interface PagesTableProps {
  /** Filtered, sorted and paged by the server. */
  rows: readonly StudioPageRow[];
  /** How many pages match the filters altogether, for the range sentence. */
  total: number;
  page: number;
  pageSize: number;
  /** The site's own origin, so the address column can offer a real link. No trailing slash. */
  siteOrigin: string;
  /** True when the URL carries a search or a status, so the empty state can name the remedy. */
  filtersActive: boolean;
  /** Whether this reader may put a page in the recycle bin. Same predicate the handler enforces. */
  canDelete: boolean;
  /** The zone every date in this table is printed in, named once underneath it. */
  timeZoneLabel: string;
}

export function PagesTable({
  rows,
  total,
  page,
  pageSize,
  siteOrigin,
  filtersActive,
  canDelete,
  timeZoneLabel
}: PagesTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const confirm = useConfirm();
  const { toast } = useToast();

  /**
   * Delete lives in the row menu rather than as a `DeleteButton`, so the wording discipline that
   * component owns is repeated here by hand: the question NAMES the page, says where it goes, and says
   * how long it can be got back. "Are you sure?" asks a reader to weigh something without telling them
   * what is on either side of the scales.
   */
  const remove = useCallback(
    async (row: StudioPageRow) => {
      const agreed = await confirm({
        title: `Delete the page “${row.title}”?`,
        body: (
          <>
            <p>
              It moves to the recycle bin, where an administrator can restore it for 30 days. It
              disappears from the public site straight away, so anyone following a link to{" "}
              <span className="break-all font-medium text-ink-900">{row.path}</span> will see a “page
              not found”.
            </p>
            <p className="mt-2">
              The {row.sectionCount === 1 ? "block" : "blocks"} on it{" "}
              {row.sectionCount === 1 ? "goes" : "go"} with it. Menu entries pointing at this address
              are left alone — check the Navigation screen afterwards.
            </p>
          </>
        ),
        confirmLabel: "Move to recycle bin",
        cancelLabel: "Keep it",
        tone: "danger"
      });
      if (!agreed) return;

      try {
        await del<void>(`/api/studio/pages/${encodeURIComponent(row.id)}`);
        toast({
          tone: "success",
          title: `“${row.title}” is in the recycle bin`,
          description: "An administrator can restore it for the next 30 days."
        });
        // The list is server-rendered, so the row goes when the server says it has gone. An optimistic
        // removal here would have to be undone if the request failed, and a row that flickers back is
        // worse than a row that waits half a second.
        router.refresh();
      } catch (thrown) {
        // `message` from lib/api.ts is already a plain sentence ready to render (contract §9).
        toast({
          tone: "error",
          title: "It has not been deleted",
          description: asApiClientError(thrown).message
        });
      }
    },
    [confirm, router, toast]
  );

  const columns: readonly DataTableColumn<StudioPageRow>[] = [
    {
      key: "title",
      header: "Page",
      sortable: true,
      render: (row) => (
        <span className="block min-w-0">
          {/* ONE link per row (DataTable rule 2). The row's hover fill is what makes the whole row
              read as a target without being one. */}
          <Link href={`/studio/pages/${encodeURIComponent(row.id)}`} className={DATA_TABLE_PRIMARY_LINK_CLASS}>
            {row.title}
          </Link>
          {row.isSystem ? (
            <Badge tone="info" size="sm" icon={ShieldCheck} className="ml-2 align-middle">
              Built in
            </Badge>
          ) : null}
          {row.navLabel && row.navLabel !== row.title ? (
            <span className="mt-0.5 block truncate text-xs text-ink-500">
              Shown in menus as “{row.navLabel}”
            </span>
          ) : null}
        </span>
      )
    },
    {
      key: "slug",
      header: "Address",
      sortable: true,
      render: (row) =>
        row.isLive ? (
          // Only a live page gets a link: an address that answers "page not found" is worse than a
          // plain string, because the reader cannot tell whether the studio or the site is at fault.
          <a
            href={`${siteOrigin}${row.path}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 break-all font-mono text-xs text-purple-700 underline-offset-4 hover:underline"
          >
            <span className="min-w-0">{row.path}</span>
            <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span className="sr-only"> — opens the live page in a new tab</span>
          </a>
        ) : (
          <span className="block min-w-0">
            <span className="break-all font-mono text-xs text-ink-500">{row.path}</span>
            <span className="mt-0.5 block text-[0.6875rem] text-ink-500">Not public yet</span>
          </span>
        )
    },
    {
      key: "status",
      header: "Publication",
      sortable: true,
      resizable: false,
      render: (row) => <StatusBadge status={row.status} size="sm" />
    },
    {
      key: "sections",
      header: "Blocks",
      align: "end",
      hideBelow: "md",
      resizable: false,
      render: (row) => (
        <span className="tabular-nums text-ink-700">
          {row.sectionCount}
          <span className="sr-only"> {row.sectionCount === 1 ? "block" : "blocks"} on this page</span>
        </span>
      )
    },
    {
      key: "updated",
      header: "Last edited",
      sortable: true,
      defaultDirection: "desc",
      hideBelow: "sm",
      render: (row) => (
        <span className="block min-w-0">
          <span className="block text-xs text-ink-700">{row.updatedLabel}</span>
          <span className="mt-0.5 block truncate text-xs text-ink-500">
            {row.lastEditedBy ?? "Nobody recorded — this page predates the version history"}
          </span>
        </span>
      )
    }
  ];

  const rowActions = (row: StudioPageRow): React.ReactNode => {
    const actions: RowAction[] = [
      {
        id: "open",
        label: "Open this page",
        icon: Pencil,
        onSelect: () => router.push(`/studio/pages/${encodeURIComponent(row.id)}`)
      },
      {
        id: "view",
        label: "View it on the site",
        icon: ExternalLink,
        // Not a permission — the page simply is not public, so there is nothing to look at.
        disabled: !row.isLive,
        description: row.isLive ? undefined : "It is not published, so there is nothing public to open.",
        onSelect: () => window.open(`${siteOrigin}${row.path}`, "_blank", "noreferrer")
      },
      {
        id: "delete",
        label: "Move to recycle bin",
        icon: Trash2,
        tone: "danger",
        // Two separate reasons to be absent, and both are permissions in the §1.8 sense: this reader
        // may not delete, or this page may not be deleted by anybody.
        show: canDelete && !row.isSystem,
        onSelect: () => void remove(row)
      }
    ];

    return <RowActions subject={row.title} actions={actions} />;
  };

  /** The current address with its filters, so the page links keep whatever is narrowing the list. */
  const query = params.toString();
  const baseHref = query.length > 0 ? `${pathname}?${query}` : pathname;

  return (
    <div className="space-y-4">
      <FilterToolbar
        search={{
          label: "Search pages by title or address",
          placeholder: "Title, or part of the address"
        }}
        status={{}}
      />

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
        rowActions={rowActions}
        label="Pages"
        sort={{ defaultKey: "updated", defaultDirection: "desc" }}
        totalItems={total}
        empty={
          filtersActive ? (
            <EmptyState
              icon={SearchX}
              title="No pages match these filters"
              description="Clear the search box or choose “Any status” above to see everything again."
              headingLevel={2}
            />
          ) : (
            <EmptyState
              icon={FileStack}
              title="There are no pages yet"
              description="A page is a web address with a stack of blocks on it — the about page, a research overview, a landing page for a programme. Make the first one and the site's menus will have somewhere to point."
              headingLevel={2}
              action={
                <LinkButton href="/studio/pages/new" icon={FileStack}>
                  New page
                </LinkButton>
              }
            />
          )
        }
      />

      {/* Absent when there is nothing to page through: the empty state above already says what is going
          on, and a footnote about time zones under it would be a second, weaker statement. */}
      {rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={total}
            baseHref={baseHref}
            label="Pages"
            itemNoun={{ singular: "page", plural: "pages" }}
          />
          {/* The zone is named once, where the dates are. A bare "09:14" in a list two colleagues are
              comparing is a time they will disagree about. */}
          <p className="text-xs text-ink-500">Dates are shown in {timeZoneLabel}.</p>
        </div>
      ) : null}
    </div>
  );
}
