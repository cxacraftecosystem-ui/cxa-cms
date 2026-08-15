import type { Metadata } from "next";
import type { ContentStatus, Prisma } from "@prisma/client";
import { Plus } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import {
  PERSON_KIND_GROUPS,
  PERSON_KIND_ORDER
} from "@/components/site/PersonCard";
import { FilterToolbar } from "@/components/studio/FilterToolbar";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { PeopleBoard, type PersonRow } from "./PeopleBoard";

/**
 * People — the roster, grouped the way the public site groups it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageContent)` IS THE FIRST STATEMENT — people are an EDITOR-level table, not
 * a researcher one, because a profile speaks for a person (lib/permissions.ts). It throws rather than
 * rendering (contract §1.8).
 *
 * THE GROUPS AND THEIR ORDER COME FROM `components/site/PersonCard.tsx`, which is the vocabulary the
 * whole product shares. That module deliberately carries no `"use client"` so both halves can read it;
 * a second copy of the group order here would eventually put alumni above faculty on one screen only.
 *
 * ⚠ THERE IS NO PAGINATION, AND THAT IS A CONSEQUENCE OF THE DRAG ORDERING. Ordering inside a group is
 * only meaningful when the whole group is on screen: a page boundary cutting through "Students" would
 * let a reader drag row 20 above row 19 while rows 21 to 60 sat on another page, and the saved order
 * would be a fact about a page rather than about the group. So the roster is read up to a cap, and when
 * the cap bites the board says so AND stands the ordering down (contract §1.6).
 *
 * ⚠ FOR THE SAME REASON, A SEARCH OR A STATUS FILTER TURNS ORDERING OFF. A filtered group is a partial
 * group. A KIND filter does not, because one whole group is still one whole group.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "People"
};

/**
 * How many profiles the board will show.
 *
 * Generous enough for any real Centre's roster, and stated on screen when it bites — a list that
 * quietly stopped at 400 would look like a Centre with exactly 400 people.
 */
const PEOPLE_LIMIT = 400;

const STATUSES: readonly ContentStatus[] = ["DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"];

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function StudioPeoplePage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canManageContent,
    "People need editor access or higher. An administrator can raise yours."
  );

  const raw = await searchParams;
  const query = one(raw.q).trim();
  const statusValue = one(raw.status);
  const status = (STATUSES as readonly string[]).includes(statusValue)
    ? (statusValue as ContentStatus)
    : null;
  const kindValue = one(raw.kind);
  const kind = (PERSON_KIND_ORDER as readonly string[]).includes(kindValue)
    ? (kindValue as (typeof PERSON_KIND_ORDER)[number])
    : null;

  const where: Prisma.PersonWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(query.length > 0
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { designation: { contains: query, mode: "insensitive" } },
            { department: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
            { slug: { contains: query, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const rows = await prisma.person.findMany({
    where,
    // `sortOrder` then `name`, so the order is TOTAL and stable. Grouping by kind happens in the board,
    // from the shared order array, rather than in SQL — a migration that adds a `PersonKind` value in
    // the middle of the enum would otherwise silently reorder every group.
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    take: PEOPLE_LIMIT + 1,
    select: {
      id: true,
      name: true,
      slug: true,
      kind: true,
      designation: true,
      department: true,
      isVisible: true,
      sortOrder: true,
      status: true,
      photo: {
        select: {
          objectKey: true,
          altText: true,
          width: true,
          height: true,
          blurDataUrl: true,
          variants: {
            select: { label: true, format: true, objectKey: true, width: true },
            orderBy: { width: "asc" }
          }
        }
      },
      _count: {
        select: {
          projects: true,
          publications: true
        }
      }
    }
  });

  const truncated = rows.length > PEOPLE_LIMIT;
  const people: PersonRow[] = rows.slice(0, PEOPLE_LIMIT).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    designation: row.designation,
    department: row.department,
    isVisible: row.isVisible,
    sortOrder: row.sortOrder,
    status: row.status,
    projectCount: row._count.projects,
    publicationCount: row._count.publications,
    photo: row.photo
  }));

  const narrowed = query.length > 0 || status !== null;
  // Ordering needs a WHOLE group in front of the reader. See the header.
  const canReorder = !narrowed && !truncated;

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="People"
        description="Everybody shown on the public site: faculty, scientists, research assistants, students, staff, visitors and alumni. Drag a name to change the order they appear in within their group."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {people.length === 1 ? "1 profile" : `${people.length} profiles`}
          </span>
        }
        actions={
          <LinkButton href="/studio/people/new" icon={Plus}>
            New profile
          </LinkButton>
        }
      >
        <FilterToolbar
          search={{
            label: "Search people",
            placeholder: "Name, job title, department or email address"
          }}
          status={{ statuses: STATUSES }}
          selects={[
            {
              key: "kind",
              label: "Group",
              options: PERSON_KIND_ORDER.map((value) => ({
                value,
                label: PERSON_KIND_GROUPS[value]
              }))
            }
          ]}
        />

        {truncated ? (
          <HelpText tone="warn" className="mt-3">
            There are more than {PEOPLE_LIMIT} profiles, so only the first {PEOPLE_LIMIT} are shown here
            and the order cannot be changed while that is true. Use the search box or the group filter to
            work with a smaller number.
          </HelpText>
        ) : null}
      </StudioPageHeader>

      <PeopleBoard
        people={people}
        filtered={narrowed || kind !== null}
        canReorder={canReorder}
        // Why it is off, in the words that name the remedy. An absent explanation makes a missing drag
        // handle look like a fault.
        reorderStandDownReason={
          canReorder
            ? null
            : truncated
              ? `The order can only be changed when a whole group is on screen, and there are more than ${PEOPLE_LIMIT} profiles.`
              : "The order can only be changed when a whole group is on screen. Clear the search and the status filter to change it — filtering by group is fine."
        }
        canDelete={canManageContent(user)}
        canPublish={canPublish(user)}
      />
    </div>
  );
}
