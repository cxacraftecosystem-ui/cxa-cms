import type { Metadata } from "next";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { storageConfigured } from "@/lib/env";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { FileManager } from "./FileManager";

/**
 * The file store — documents, datasets, slide decks and archives: anything downloaded rather than read
 * on the page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageMedia)` IS THE FIRST STATEMENT, and it is the same predicate the
 * `/api/studio/files/*` handlers call and the same one `StudioNav` hides the sidebar entry with. It
 * THROWS rather than rendering: a failing permission check renders nothing at all, never a screen of
 * disabled controls (contract §1.8).
 *
 * THE SCREEN ITSELF IS A CLIENT COMPONENT, and that is forced rather than chosen. Uploading a dataset
 * means a signed PUT from the BROWSER STRAIGHT TO STORAGE — the bytes never pass through this
 * application, because both a Server Action (a 1 MB body by default) and a form post to the application
 * (a few megabytes on most platforms) would refuse a corpus long before storage would. So this page does
 * the two things only a server can do — check the permission, and read the categories that already exist
 * — and hands them down.
 *
 * ⚠ NOTHING ELSE IS HANDED DOWN, DELIBERATELY. The filters, the page size and the first page of rows all
 * live on the browser side, because every export of a `"use client"` module is a client reference and a
 * Server Component cannot call one (MediaGrid.tsx's header sets out the trap). Parsing the query string
 * here as well would mean two parsers and two page-size constants to keep in step, and the first
 * disagreement between them shows up as a first page that is a different length from the second.
 *
 * NO `loading.tsx` FOR THIS SEGMENT, and none may be added: it would flush the response headers as
 * `200 OK` before the body is decided, turning the `notFound()` in `[id]` beneath it into a soft-404
 * (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Files"
};

/**
 * How many distinct categories the filter and the suggestion list offer.
 *
 * A category is free text on the file rather than a table, so the list is whatever editors have typed.
 * The cap is STATED ON SCREEN when it bites — a shortened list is otherwise indistinguishable from a
 * complete one, and somebody would conclude their category had been lost (contract §1.6).
 */
const CATEGORY_LIMIT = 40;

export default async function StudioFilesPage() {
  await requireStudioCapability(
    canManageMedia,
    "The file store needs media manager access or higher. An administrator can raise yours."
  );

  const [categoryRows, total, withoutBytes] = await prisma.$transaction([
    // The recycle bin is filtered out everywhere: a soft-deleted file belongs to /studio/recycle-bin, and
    // listing its category here would offer a filter that matches nothing.
    prisma.fileAsset.findMany({
      where: { deletedAt: null, NOT: { category: null } },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
      // One more than the cap, so "there are more than this" is a fact rather than a guess.
      take: CATEGORY_LIMIT + 1
    }),
    prisma.fileAsset.count({ where: { deletedAt: null } }),
    // A catalogue entry with no version is a real state — the row was created and the upload never
    // finished — and it is worth saying out loud, because the public download route answers a specific
    // 404 for it that nobody would otherwise connect to this screen.
    prisma.fileAsset.count({ where: { deletedAt: null, versions: { none: {} } } })
  ]);

  const categories = categoryRows
    .map((row) => row.category)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return (
    <div className="mx-auto w-full max-w-[100rem] space-y-6">
      <StudioPageHeader
        title="Files"
        description="Documents, datasets, slide decks and archives. Replacing a file keeps the old one: a new version is issued and the earlier bytes stay reachable, so a citation of “version 2 of the corpus” does not quietly start resolving to version 3."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 file" : `${total} files`}
            {withoutBytes > 0
              ? `, ${withoutBytes} with nothing uploaded yet`
              : ""}
          </span>
        }
      />

      <FileManager
        categories={categories.slice(0, CATEGORY_LIMIT)}
        categoriesTruncated={categories.length > CATEGORY_LIMIT}
        storageReady={storageConfigured()}
      />
    </div>
  );
}
