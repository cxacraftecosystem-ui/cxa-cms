import type { Metadata } from "next";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { canManageResearch } from "@/lib/permissions";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { ImportWorkbench } from "./ImportWorkbench";

/**
 * Importing publications — the shell.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageResearch)` IS THE FIRST STATEMENT, and it throws rather than rendering
 * (contract §1.8). The same predicate guards both import endpoints.
 *
 * NOTHING IS CREATED WITHOUT THE READER SEEING IT FIRST. The screen is two steps and cannot be
 * collapsed into one: the paste is parsed and shown as a table of what WOULD be created and what looks
 * like something already here, and only the ticked rows are then imported. An import that ran straight
 * from a paste would silently double every record whose DOI had been typed in by hand last year.
 *
 * THE REPORT IS PER ROW. "12 imported" is not a report — it cannot be checked, and it says nothing
 * about the thirteenth. Every row comes back as created, skipped or failed, with its own sentence.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Import publications"
};

export default async function StudioPublicationImportPage() {
  await requireStudioCapability(
    canManageResearch,
    "Importing publications needs researcher access or higher. An administrator can raise yours."
  );

  return (
    <div className="mx-auto w-full max-w-[76rem]">
      <StudioPageHeader
        title="Import publications"
        description="Paste BibTeX from a reference manager, or a list of DOIs, and check what will be added before anything is created. Everything that arrives this way is created as a draft, so nothing appears on the public site until you publish it."
        back={{ href: "/studio/publications", label: "Publications" }}
        breadcrumb={[
          { label: "Publications", href: "/studio/publications" },
          { label: "Import" }
        ]}
      />

      <ImportWorkbench />
    </div>
  );
}
