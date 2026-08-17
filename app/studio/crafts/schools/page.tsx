import type { Metadata } from "next";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch } from "@/lib/permissions";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { SchoolManager, type SchoolRowData } from "./SchoolManager";

/**
 * Schools and traditions — the list every craft's “School or tradition” picker reads from.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageResearch)` IS THE FIRST STATEMENT, and it throws rather than rendering
 * (contract §1.8) — the same predicate as the craft archive this screen belongs to and as
 * app/api/studio/crafts/schools/route.ts, so nobody is offered a screen whose saves would then refuse them
 * (contract §1.7).
 *
 * WHY THIS SCREEN EXISTS. `CraftSchool` had a model, a foreign key from `Craft`, a picker in the craft
 * editor and a printed name on the public craft page — and no write surface anywhere. Every craft therefore
 * read “No school recorded”, with no way to record one. This screen and the two routes beside it are the
 * whole of that gap; the regions screen next door closes the same gap one step further along, where regions
 * could at least be PLACED but not created.
 *
 * THE COUNT IS A FILTERED RELATION COUNT, IN ONE QUERY. “What would deleting this un-file” is the question
 * that makes the delete a decision rather than a gamble, and asking per row would be a round trip per school
 * for one small integer. Drafts are counted and recycled crafts are not — see `SchoolRowData.craftCount` for
 * why that combination is the honest one.
 *
 * NO CAP AND NO PAGINATION, deliberately: a Centre documents tens of named traditions, not thousands. If it
 * ever needs one it needs `listQuerySchema` from lib/studio/crud.ts rather than a hand-rolled page size, and
 * the cap would have to be stated on screen (contract §1.6).
 *
 * ⚠ THIS SEGMENT IS STATIC AND `[id]` IS DYNAMIC, so `/studio/crafts/schools` resolves here rather than to
 * the craft editor with `id="schools"` — the same routing fact the regions screen and the news taxonomy
 * screens rest on (contract §13b).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Schools and traditions"
};

export default async function StudioCraftSchoolsPage() {
  await requireStudioCapability(
    canManageResearch,
    "Recording schools and traditions needs researcher access or higher. An administrator can raise yours."
  );

  const rows = await prisma.craftSchool.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      // Drafts included, recycled excluded — this number is a promise about what a delete would un-file.
      _count: { select: { crafts: { where: { deletedAt: null } } } }
    }
  });

  const schools: SchoolRowData[] = rows.map((school) => ({
    id: school.id,
    name: school.name,
    slug: school.slug,
    description: school.description,
    craftCount: school._count.crafts
  }));

  const filed = schools.filter((school) => school.craftCount > 0).length;

  return (
    <div className="mx-auto w-full max-w-[72rem] space-y-6">
      <StudioPageHeader
        title="Schools and traditions"
        back={{ href: "/studio/crafts", label: "Craft archive" }}
        breadcrumb={[
          { label: "Craft archive", href: "/studio/crafts" },
          { label: "Schools and traditions" }
        ]}
        description="A named school, gharana, guild or workshop lineage that a craft belongs to. Every school recorded here is offered on every craft's “School or tradition” field, and narrows the public archive by ?school=… — so a craft can only name a school that exists here first. It is optional on a craft: many traditions have no named school, and leaving it empty is a real answer."
        meta={
          schools.length > 0 ? (
            <span className="text-xs tabular-nums text-ink-500">
              {filed} of {schools.length === 1 ? "1 school" : `${schools.length} schools`} in use
            </span>
          ) : null
        }
      />

      <SchoolManager schools={schools} />
    </div>
  );
}
