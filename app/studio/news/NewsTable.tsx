"use client";

/**
 * NewsTable — the interactive half of the newsroom list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT EACH ROW HAS TO SAY, AND WHY EACH OF IT IS THERE.
 *
 *   • THE COVER, as a thumbnail. An editor looking for "the one with the loom photograph" finds it by
 *     the picture, not by reading twenty-five headlines.
 *   • THE READING TIME, because it is the fact an author is most often surprised by. It is the STORED
 *     number, and a row that has none says so rather than printing a zero: recomputing it here would mean
 *     reading twenty-five whole article bodies to draw one list. The editor works it out live from what
 *     is actually written and stores it on every save, so a number that exists is a number that is right.
 *   • WHICH WRITING MODE the article is in. `Post.body` and `Post.mdx` are mutually exclusive, and an
 *     article in MDX opens a different editor — knowing that before clicking is worth one small word.
 *   • WHO WROTE IT, because "edit anyone's content" is a permission not everybody has, and a list that
 *     hides the author leaves an author guessing which rows are theirs.
 *
 * PERMISSION IS DECIDED PER ROW, ON THE SERVER. `canEditRecord(user, post.authorId)` is the predicate
 * the handlers enforce, so it is the predicate that decides whether this row offers an Edit at all — and
 * a row this reader may not act on shows no action rather than a disabled one (contract §1.8).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, Newspaper, Pencil, SearchX, Star, Trash2 } from "lucide-react";
import type { ContentStatus } from "@prisma/client";

import { asApiClientError, del } from "@/lib/client/fetcher";
import type { MediaLike } from "@/lib/media/url";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { MediaImage } from "@/components/ui/MediaImage";
import type { Picture } from "@/lib/media/screens";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/ToastProvider";
import {
  DATA_TABLE_PRIMARY_LINK_CLASS,
  DataTable,
  type DataTableColumn
} from "@/components/studio/DataTable";
import { FilterToolbar, type FilterToolbarOption } from "@/components/studio/FilterToolbar";
import { RowActions, type RowAction } from "@/components/studio/RowActions";

export interface StudioPostRow {
  id: string;
  title: string;
  subtitle: string | null;
  path: string;
  status: ContentStatus;
  /** Resolved at read time on the server — the status column alone would lie about a retired article. */
  isLive: boolean;
  isFeatured: boolean;
  categoryName: string | null;
  authorName: string | null;
  cover: MediaLike | null;
  /**
   * The cover resolved for every screen width, or null when nobody framed it.
   *
   * Resolved on the SERVER and handed down, not derived here: resolving needs the alternate assets a
   * framing names, and only the fetching query can get them.
   */
  picture: Picture | null;
  /** `Post.readingMinutes`. `null` when no save has worked one out yet — said in words, never as a 0. */
  readingMinutes: number | null;
  /** Which of the two mutually exclusive body fields this article uses. */
  writingMode: "formatted" | "mdx";
  /** Pre-formatted in the Centre's zone. `null` when it has never been published. */
  publishedLabel: string | null;
  updatedLabel: string;
  /** `canEditRecord(user, authorId)` — the same predicate the PATCH handler enforces. */
  canEdit: boolean;
  /** Deleting is stricter than editing, and taking a live article down is a publishing act. */
  canDelete: boolean;
}

export interface NewsTableProps {
  rows: readonly StudioPostRow[];
  total: number;
  page: number;
  pageSize: number;
  siteOrigin: string;
  filtersActive: boolean;
  /** For the category filter. Built on the server from the categories that exist. */
  categoryOptions: readonly FilterToolbarOption[];
  /** For the tag filter. Capped, and the cap is stated under the table when it bites. */
  tagOptions: readonly FilterToolbarOption[];
  tagsTruncated: boolean;
  timeZoneLabel: string;
}

export function NewsTable({
  rows,
  total,
  page,
  pageSize,
  siteOrigin,
  filtersActive,
  categoryOptions,
  tagOptions,
  tagsTruncated,
  timeZoneLabel
}: NewsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const confirm = useConfirm();
  const { toast } = useToast();

  const remove = useCallback(
    async (row: StudioPostRow) => {
      const agreed = await confirm({
        title: `Delete the article “${row.title}”?`,
        body: (
          <>
            <p>
              It moves to the recycle bin, where an administrator can restore it for 30 days.{" "}
              {row.isLive
                ? "It disappears from the public site straight away, so anyone following a link to it will see a “page not found”."
                : "It is not published, so nothing on the public site changes."}
            </p>
            <p className="mt-2">
              The cover photograph stays in the media library, and any article that names this one as
              related simply stops showing it.
            </p>
          </>
        ),
        confirmLabel: "Move to recycle bin",
        cancelLabel: "Keep it",
        tone: "danger"
      });
      if (!agreed) return;

      try {
        await del<void>(`/api/studio/news/${encodeURIComponent(row.id)}`);
        toast({
          tone: "success",
          title: `“${row.title}” is in the recycle bin`,
          description: "An administrator can restore it for the next 30 days."
        });
        router.refresh();
      } catch (thrown) {
        toast({
          tone: "error",
          title: "It has not been deleted",
          description: asApiClientError(thrown).message
        });
      }
    },
    [confirm, router, toast]
  );

  const columns: readonly DataTableColumn<StudioPostRow>[] = [
    {
      key: "cover",
      header: "",
      headerLabel: "Cover picture",
      width: 76,
      resizable: false,
      render: (row) => (
        // Decorative here: the headline in the next cell is the row's name, and announcing the
        // photograph as well would read every row twice.
        <MediaImage
          media={row.cover}
          picture={row.picture}
          alt=""
          aspect="16 / 10"
          rounded="sm"
          sizes="56px"
          targetWidth={320}
          className="w-14"
        />
      )
    },
    {
      key: "title",
      header: "Article",
      sortable: true,
      render: (row) => (
        <span className="block min-w-0">
          <Link href={`/studio/news/${encodeURIComponent(row.id)}`} className={DATA_TABLE_PRIMARY_LINK_CLASS}>
            {row.title}
          </Link>
          {row.isFeatured ? (
            <Badge tone="info" size="sm" icon={Star} className="ml-2 align-middle">
              Featured
            </Badge>
          ) : null}
          {row.writingMode === "mdx" ? (
            // Said out loud: this article opens a different editor, and finding that out by clicking is
            // a small surprise nobody needs.
            <Badge tone="neutral" size="sm" className="ml-2 align-middle">
              Written in MDX
            </Badge>
          ) : null}
          <span className="mt-0.5 block truncate text-xs text-ink-500">
            {row.readingMinutes === null
              ? "Reading time not worked out yet"
              : `${row.readingMinutes} ${row.readingMinutes === 1 ? "minute" : "minutes"} to read`}
            {row.subtitle ? ` · ${row.subtitle}` : ""}
          </span>
        </span>
      )
    },
    {
      key: "category",
      header: "Category",
      hideBelow: "md",
      render: (row) =>
        row.categoryName ? (
          <span className="text-ink-700">{row.categoryName}</span>
        ) : (
          // Not a blank cell: "no category" is a real state with a real consequence — the article will
          // not appear on any category page.
          <span className="text-xs text-ink-500">Not filed</span>
        )
    },
    {
      key: "author",
      header: "Author",
      hideBelow: "lg",
      render: (row) => (
        <span className="truncate text-ink-700">
          {row.authorName ?? "No author recorded"}
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
      key: "published",
      header: "Published",
      sortable: true,
      defaultDirection: "desc",
      hideBelow: "sm",
      render: (row) => (
        <span className="block min-w-0">
          <span className="block text-xs text-ink-700">{row.publishedLabel ?? "Not yet"}</span>
          <span className="mt-0.5 block text-xs text-ink-500">Edited {row.updatedLabel}</span>
        </span>
      )
    }
  ];

  const rowActions = (row: StudioPostRow): React.ReactNode => {
    const actions: RowAction[] = [
      {
        id: "open",
        label: "Open this article",
        icon: Pencil,
        // Reading is not editing: everybody who can reach this list may open the editor, but only
        // somebody who may edit this record is offered it as an action.
        show: row.canEdit,
        onSelect: () => router.push(`/studio/news/${encodeURIComponent(row.id)}`)
      },
      {
        id: "view",
        label: "Read it on the site",
        icon: ExternalLink,
        disabled: !row.isLive,
        description: row.isLive ? undefined : "It is not published, so there is nothing public to open.",
        onSelect: () => window.open(`${siteOrigin}${row.path}`, "_blank", "noreferrer")
      },
      {
        id: "delete",
        label: "Move to recycle bin",
        icon: Trash2,
        tone: "danger",
        show: row.canDelete,
        onSelect: () => void remove(row)
      }
    ];

    return <RowActions subject={row.title} actions={actions} />;
  };

  const query = params.toString();
  const baseHref = query.length > 0 ? `${pathname}?${query}` : pathname;

  return (
    <div className="space-y-4">
      <FilterToolbar
        search={{ label: "Search news by headline", placeholder: "Headline, standfirst or address" }}
        status={{}}
        selects={[
          // "none" is a reserved word rather than an empty value: `buildQuery` drops the empty string, so
          // "articles with no category" and "every article" would be spelled the same way in the URL
          // (see lib/client/fetcher.ts).
          {
            key: "category",
            label: "Category",
            options: [{ value: "none", label: "Not filed in any category" }, ...categoryOptions]
          },
          { key: "tag", label: "Tag", options: tagOptions }
        ]}
      />

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
        rowActions={rowActions}
        label="News articles"
        sort={{ defaultKey: "published", defaultDirection: "desc" }}
        totalItems={total}
        capNote={
          tagsTruncated
            ? "The tag filter above lists only the most used tags. Use the Taxonomy screen to see all of them."
            : null
        }
        empty={
          filtersActive ? (
            <EmptyState
              icon={SearchX}
              title="No articles match these filters"
              description="Clear the search box, or choose “Any status” and “Any category” above, to see everything again."
              headingLevel={2}
            />
          ) : (
            <EmptyState
              icon={Newspaper}
              title="There are no news articles yet"
              description="The newsroom is where announcements, reports and stories go. Write the first one and it will appear on the site's news page once it is published."
              headingLevel={2}
              action={
                <LinkButton href="/studio/news/new" icon={Newspaper}>
                  New article
                </LinkButton>
              }
            />
          )
        }
      />

      {rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={total}
            baseHref={baseHref}
            label="News articles"
            itemNoun={{ singular: "article", plural: "articles" }}
          />
          <p className="text-xs text-ink-500">
            Dates are shown in {timeZoneLabel}. A reading time appears once the article has been saved at
            least once — it is worked out from what is actually written.
          </p>
        </div>
      ) : null}
    </div>
  );
}
