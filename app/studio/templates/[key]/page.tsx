import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import {
  findPageTemplate,
  mergePageTemplates,
  storedTemplateFromRow,
  templateBlockPreviews,
  type ResolvedPageTemplate
} from "@/lib/page-templates";
import { canManageStructure } from "@/lib/permissions";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { CustomiseBuiltIn } from "@/components/studio/templates/CustomiseBuiltIn";
import { TemplateEditor } from "@/components/studio/templates/TemplateEditor";
import { blockIcon, templateIcon } from "@/components/studio/templates/templateIcons";

/**
 * One page template: what a page made from it starts as.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ADDRESS IS THE TEMPLATE'S KEY, NOT A ROW ID — `/studio/templates/exhibition`. A key is the thing
 * that is stable across the two kinds of template: an arrangement that ships with the software has no row
 * and therefore no id, and a customisation of one has an id that changes if it is ever removed and
 * written again. The key is also what the create-a-page form carries, so the two screens speak the same
 * vocabulary and a link between them cannot be built from the wrong half.
 *
 * ⚠ TWO SCREENS LIVE HERE, AND WHICH ONE IS DRAWN IS DECIDED BY WHETHER THERE IS A ROW.
 *
 *   • A `PageTemplate` row — the editor. Everything about it can be changed.
 *   • A built-in with nothing shadowing it — a read-only account of the arrangement, and one button.
 *     There is nothing to edit: it is declared in lib/page-templates.ts, which is a file in this
 *     repository. "Customise" writes a row holding its key, which then stands in its place everywhere —
 *     and lands the reader on the editor for it.
 *
 * A DISABLED EDITOR WOULD HAVE BEEN THE WRONG ANSWER. A form full of boxes that refuse to be typed in
 * says "you are not allowed", which is false — anybody who can reach this screen may customise the
 * template. The refusal is not about permission, it is about where the words live, and a screen that says
 * so in a sentence is worth more than one that mimes it (contract §1.8 for the permission case, which
 * this is not).
 *
 * `requireStudioCapability`, NOT `requireCapability`. Inside a Server Component the route-handler pair
 * throws an `ApiError` that nothing catches, which becomes a 500 telling an editor the server is broken
 * (contract §1.9). This one calls Next's `forbidden()` and renders a real 403.
 *
 * NO `loading.tsx` FOR THIS SEGMENT, and none may be added: it would flush the response headers as
 * `200 OK` before the `notFound()` below is decided, turning a missing template into a soft-404
 * (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Page template"
};

async function readTemplate(key: string): Promise<ResolvedPageTemplate | null> {
  const rows = await prisma.pageTemplate.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
  });
  return findPageTemplate(mergePageTemplates(rows.map(storedTemplateFromRow)), key);
}

export default async function StudioTemplateEditorPage({
  params
}: {
  params: Promise<{ key: string }>;
}) {
  await requireStudioCapability(
    canManageStructure,
    "Page templates need editor access or higher, because every colleague who makes a page is offered them. An administrator can raise yours."
  );

  const { key } = await params;
  // A key travels in a URL, so it arrives encoded. Decoding can throw on a malformed escape — which is
  // a 404, not a 500: nothing named by an unreadable address exists.
  let decoded = key;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    notFound();
  }

  const template = await readTemplate(decoded);
  if (!template) notFound();

  const crumb = [
    { label: "Page templates", href: "/studio/templates" },
    { label: template.name }
  ];

  if (template.rowId === null) {
    return (
      <div className="mx-auto w-full max-w-[64rem] space-y-6">
        <StudioPageHeader
          title={template.name}
          description="One of the arrangements built into this software. It cannot be edited here — customise it to make a version of your own, which stands in its place everywhere from the moment it is saved."
          breadcrumb={crumb}
          back={{ href: "/studio/templates", label: "Page templates" }}
          meta={
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-500">
              <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
              Ships with the software
            </span>
          }
        />

        <BuiltInAccount template={template} />

        <CustomiseBuiltIn templateKey={template.id} templateName={template.name} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[64rem] space-y-6">
      <StudioPageHeader
        title={template.name}
        description="What a page made from this template starts as: the words a colleague reads when choosing it, and the blocks it puts on the page, in order."
        breadcrumb={crumb}
        back={{ href: "/studio/templates", label: "Page templates" }}
      />

      {template.problems.length > 0 ? (
        <div className="space-y-1.5">
          {template.problems.map((problem) => (
            <HelpText key={problem} tone="warn">
              {problem}
            </HelpText>
          ))}
        </div>
      ) : null}

      <TemplateEditor
        // Remounted when the stored row changes, so a save followed by a navigation back into this
        // screen reseeds every box from the server's answer rather than from a stale first render.
        key={`${template.rowId}-${template.updatedAt ?? ""}`}
        template={template}
        rowId={template.rowId}
      />
    </div>
  );
}

/**
 * A built-in, read out.
 *
 * The same three things the chooser shows — the glyph, the description, the ordered blocks with the
 * reason each one is there — because somebody who arrived here wanting to change it needs to see what
 * they would be starting from before they decide to.
 */
function BuiltInAccount({ template }: { template: ResolvedPageTemplate }) {
  const previews = templateBlockPreviews(template);
  const TemplateIcon = templateIcon(template.icon);

  return (
    <section aria-labelledby="built-in-heading" className="panel">
      <div className="flex items-start gap-3.5 border-b border-line-200 px-5 py-4">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-purple-100 text-purple-700"
        >
          <TemplateIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="built-in-heading" className="font-display text-base font-semibold text-ink-900">
            What it makes
          </h2>
          <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-500">
            {template.description}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
            The title box is pre-filled with &ldquo;{template.suggestedTitle}&rdquo;.
          </p>
        </div>
      </div>

      <div className="px-5 py-5">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {previews.length === 1 ? "The one block it adds" : `The ${previews.length} blocks it adds`}
        </p>

        {/* An ordered list, because the order IS the template. */}
        <ol className="mt-2.5 space-y-2.5">
          {previews.map((block, index) => {
            const BlockIcon = blockIcon(block.icon);
            return (
              <li key={block.key} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line-200 bg-surface-50 text-ink-500"
                >
                  <BlockIcon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-900">
                    {index + 1}. {block.label}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                    <span className="font-medium text-ink-700">{block.blockName}</span> — {block.purpose}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
