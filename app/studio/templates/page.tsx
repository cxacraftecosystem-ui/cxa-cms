import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect as navigate } from "next/navigation";
import { TriangleAlert, WandSparkles } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import {
  findPageTemplate,
  mergePageTemplates,
  readStoredBlocks,
  storedTemplateFromRow,
  templateBlockPreviews,
  templateSections,
  visiblePageTemplates,
  type PageTemplateListResponse,
  type RemovedPageTemplate,
  type ResolvedPageTemplate
} from "@/lib/page-templates";
import { canManageStructure } from "@/lib/permissions";
import { reindexPage } from "@/lib/studio/crud";
import { slugify } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { TemplateManager } from "@/components/studio/templates/TemplateManager";
/**
 * ⚠ THE GLYPH MAPS ARE NOT `sectionIcon()` FROM components/studio/builder/SectionCard.tsx, which holds
 * the same block map. That module is `"use client"`, and every export of a client module becomes a client
 * reference in the server graph — calling one from this Server Component would throw at request time.
 * `templateIcons.ts` carries no directive at all, which is what lets this screen, the editor screen and
 * the glyph picker read one list, so the picker can never offer a mark this screen cannot draw.
 */
import { blockIcon, templateIcon } from "@/components/studio/templates/templateIcons";

/**
 * PAGE TEMPLATES — a new page that already has a shape.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN IS FOR. `/studio/pages/new` asks for a title and an address and leaves the reader in
 * front of an empty builder and a palette of thirty blocks. That is the right screen for somebody who
 * knows what they are making. This one is for everybody else: it says what a call for applications is
 * made of, in order, and creates it in one press.
 *
 * PLAIN FORMS POSTING TO A SERVER ACTION, exactly as `/studio/redirects` does and for the same reasons.
 * There is nothing to keep between keystrokes here — one text box and a button per card — so the whole
 * screen works with no JavaScript at all, and the permission check runs on the server for every
 * submission rather than only where the render decided what to draw.
 *
 * ⚠ THE PAGE AND ALL OF ITS BLOCKS ARE WRITTEN IN ONE TRANSACTION. `PageSection.pageId` is a foreign key,
 * so the blocks cannot exist before the page does; creating them in a second request is what produces a
 * half-made page when one of those requests fails, and a half-made page from a template is worse than no
 * template — the reader believes they have an application page and is missing the form.
 *
 * ⚠ THE NEW PAGE IS ALWAYS A DRAFT, whatever else happens. A template is a starting point full of prompt
 * text ("Add a headline"), and a template that could publish would put those words on the public site.
 *
 * ⚠ NO `assertSameOrigin()`, AND NOTHING IS MISSING. That helper takes a `Request`, which a Server Action
 * does not have; Next's own Server Action handling compares the request's `Origin` against its `Host` and
 * refuses a cross-origin POST before the function body runs, which is the same guarantee for the same
 * attack. Everything else the contract asks of a mutation is here: Zod validation, and one
 * `mutateWithHistory()` that writes the row, its revision and its audit entry together.
 *
 * ERRORS COME BACK AS A CODE IN THE QUERY STRING, NEVER AS A SENTENCE. `?problem=title_missing` is looked
 * up in the table below; `?problem=<free text>` would let anybody craft a link that shows an administrator
 * a message this application never wrote.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE LIST IS THE BUILT-INS AND THE `PageTemplate` TABLE, MERGED. `mergePageTemplates()` in
 * lib/page-templates.ts owns the three rules — a row replaces the built-in whose key it shares, a row with
 * a new key is an additional template, `isHidden` retires either — and this screen only reads them.
 *
 * ⚠ THE MERGE IS DONE TWICE PER SUBMISSION, ONCE IN THE RENDER AND ONCE IN THE ACTION, AND THAT IS NOT A
 * DUPLICATION TO REMOVE. The render decides what to draw; the action decides what a form field is allowed
 * to have named. They are separated by however long the reader spent typing a title, during which a
 * colleague may have retired the very template being submitted — so the action re-reads rather than
 * trusting the id it was handed. That is the same reason the permission check is repeated there.
 *
 * THE SECOND HALF OF THE SCREEN — writing, editing, copying and retiring the templates themselves — is
 * `TemplateManager`, a client component. Choosing a template still works with no JavaScript; managing
 * them needs it, because each action wants a confirmation and a busy state on its own row.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Page templates"
};

/** The longest a page title may be. The same number as `pageBodySchema` in the pages route handlers. */
const TITLE_MAX = 160;

/**
 * How many numbered addresses are tried before giving up.
 *
 * ⚠ A TWIN of the loop in app/api/studio/pages/[id]/duplicate/route.ts. The two cannot share a helper: a
 * `route.ts` may export nothing but its handlers, and a page cannot import from one. Both do the same
 * thing — take the address a title suggests and add `-2`, `-3` until one is free — and both fall back to
 * asking the reader for a different title rather than looping.
 */
const SLUG_ATTEMPTS = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Outcomes, as codes
// ─────────────────────────────────────────────────────────────────────────────

const PROBLEMS: Record<string, string> = {
  unknown_template:
    "That template is no longer being offered — a colleague may have retired or removed it while this screen was open. Choose one from the list below. Nothing was created.",
  empty_template:
    "That template has no blocks in it, so it would have made an empty page. Open it from the list of templates and give it some blocks, or start from a blank page instead. Nothing was created.",
  title_missing:
    "The page needs a title before it can be created. It becomes the heading at the top of the page and the name in every list. Nothing was created.",
  title_too_long: `Titles are kept to ${TITLE_MAX} characters or fewer. Shorten it and try again. Nothing was created.`,
  slug_unusable:
    "That title cannot be turned into a web address, because it has no letters or numbers in it. Give the page a title with some words in it. Nothing was created.",
  no_free_address:
    "There are already pages at every address this title suggests. Give it a slightly different title, or rename the page that has the address you want. Nothing was created.",
  create_failed:
    "The page could not be created. Nothing was saved — not the page and not any of its blocks. Try again, and if it happens twice the server log will say why."
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * The sentence for an outcome code, or null.
 *
 * ⚠ ASKED WITH `hasOwnProperty`, NOT `PROBLEMS[code]`. The table is a plain object literal, so a bare
 * index answers `?problem=toString` with a function off `Object.prototype` and `?problem=__proto__`
 * with an object. Both are truthy, so the `?? null` never fired, and React refuses to render either —
 * a crafted link turned this screen into a 500 with no message at all. Answering with codes rather
 * than sentences is only worth anything while this table is the ONLY thing that can speak.
 */
function problemFor(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(PROBLEMS, code) ? (PROBLEMS[code] ?? null) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many rows one read carries, and how many removed ones are listed.
 *
 * ⚠ THE SAME TWO NUMBERS AS `ROW_LIMIT`/`REMOVED_LIMIT` IN app/api/studio/templates/route.ts, and they
 * have to agree: the manager below is seeded with what this read produced and then refreshes itself from
 * that handler, so a different cap would make the list silently grow or shrink on its first refresh. They
 * cannot share a constant — a `route.ts` may export nothing but its handlers.
 */
const ROW_LIMIT = 100;
const REMOVED_LIMIT = 25;

/**
 * The whole templates picture, in one read.
 *
 * Called by the render AND by the Server Action, which is deliberate — see the file header: the action
 * must not trust an id that was decided when the page was drawn.
 */
async function readTemplateList(): Promise<PageTemplateListResponse> {
  const [rows, rowCount, removedRows, removedTotal] = await Promise.all([
    prisma.pageTemplate.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      take: ROW_LIMIT
    }),
    prisma.pageTemplate.count({ where: { deletedAt: null } }),
    prisma.pageTemplate.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      take: REMOVED_LIMIT,
      select: { id: true, key: true, name: true, blocks: true, deletedAt: true }
    }),
    prisma.pageTemplate.count({ where: { deletedAt: { not: null } } })
  ]);

  const removed: RemovedPageTemplate[] = removedRows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    blockCount: readStoredBlocks(row.blocks, row.name).blocks.length,
    // Non-null by the `where` above; the fallback exists because TypeScript cannot see that.
    deletedAt: (row.deletedAt ?? new Date()).toISOString()
  }));

  return {
    items: mergePageTemplates(rows.map(storedTemplateFromRow)),
    rowCount,
    truncated: rowCount > rows.length,
    limit: ROW_LIMIT,
    removed,
    removedTotal,
    removedTruncated: removedTotal > removed.length
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who is doing this, for the audit entry.
 *
 * `clientIp()`/`userAgent()` in lib/api.ts take a `Request`, which a Server Action does not have — so the
 * same two headers are read from `headers()` here. `x-forwarded-for` carries a list; the FIRST entry is
 * the client and everything after it is a proxy. The same helper as on /studio/redirects.
 */
async function auditContext(actor: { id: string; email: string }): Promise<AuditContext> {
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for");
  return {
    actor,
    ipAddress: forwarded?.split(",")[0]?.trim() ?? incoming.get("x-real-ip") ?? null,
    userAgent: incoming.get("user-agent")
  };
}

/** Back to this screen with an outcome code. Codes only — never a sentence from the query string. */
function backWith(params: Record<string, string>): never {
  const search = new URLSearchParams(params).toString();
  navigate(`/studio/templates${search.length > 0 ? `?${search}` : ""}`);
}

/**
 * The body of the form, validated.
 *
 * A schema rather than three hand-written checks so the refusal for each field is decided in one place —
 * and because a body that arrives from anything other than this screen's form is exactly what validation
 * is for.
 */
const createSchema = z.object({
  template: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(TITLE_MAX)
});

async function createFromTemplate(formData: FormData): Promise<void> {
  "use server";

  // THE BOUNDARY. Not the render below — a form can be submitted by anything that can make a POST.
  const user = await requireStudioCapability(
    canManageStructure,
    "Creating a page needs editor access or higher, because a page is a new address on the Centre's own domain."
  );

  const parsed = createSchema.safeParse({
    template: String(formData.get("template") ?? ""),
    title: String(formData.get("title") ?? "")
  });

  if (!parsed.success) {
    // The three failures are told apart so the sentence names what to do, rather than "invalid input".
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    if (field === "template") backWith({ problem: "unknown_template" });
    if (issue?.code === "too_big") backWith({ problem: "title_too_long" });
    backWith({ problem: "title_missing" });
  }

  /**
   * Resolved against the merged list, RE-READ NOW.
   *
   * A retired template is not one this action will act on either: `visiblePageTemplates()` is the same
   * filter the render used, so an id that has been switched off since the page was drawn comes back as
   * "unknown template" rather than quietly creating a page from an arrangement nobody is offering.
   */
  const list = await readTemplateList();
  const template = findPageTemplate(visiblePageTemplates(list.items), parsed.data.template);
  if (!template) backWith({ problem: "unknown_template" });

  // A template with no blocks would create a page with nothing on it, which is worse than the blank
  // builder the reader could have gone to instead. `templateProblems()` refuses this on save too; this
  // is the second of the two guards, because a template can be emptied between the two moments.
  if (template.blocks.length === 0) backWith({ problem: "empty_template" });

  const title = parsed.data.title;
  const base = slugify(title);
  if (base.length === 0) backWith({ problem: "slug_unusable" });

  /**
   * A free address derived from the title.
   *
   * The candidates are read in ONE query and the winner chosen in memory, rather than asking the database
   * fifty times. It is a CHECK and not a guarantee — two people creating "Annual report" in the same second
   * both pass it — which is why the unique index on `Page.slug` is the backstop and P2002 below is answered
   * as a refusal the reader can act on.
   */
  const taken = new Set(
    (
      await prisma.page.findMany({
        where: { slug: { startsWith: base } },
        select: { slug: true }
      })
    ).map((row) => row.slug)
  );

  let slug = "";
  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!taken.has(candidate)) {
      slug = candidate;
      break;
    }
  }
  if (slug.length === 0) backWith({ problem: "no_free_address" });

  const sections = templateSections(template);
  const context = await auditContext({ id: user.id, email: user.email });

  let createdId = "";
  try {
    const created = await mutateWithHistory<{ id: string }>(
      context,
      {
        action: "CREATE",
        entityType: "Page",
        entityLabel: title,
        summary: `Created from the “${template.name}” template`
      },
      async (tx) => {
        const page = await tx.page.create({
          // DRAFT, and no `publishedAt`. See the file header: a template is full of prompt text.
          data: { title, slug, status: "DRAFT" },
          // The whole row rather than the id alone: `mutateWithHistory` writes this as the first
          // revision, and a version history whose first entry holds nothing but an identifier gives an
          // editor nothing to compare a later change against.
          select: {
            id: true,
            title: true,
            slug: true,
            status: true,
            navLabel: true,
            seoTitle: true,
            seoDescription: true,
            seoNoIndex: true,
            sortOrder: true,
            createdAt: true
          }
        });

        // `position` is dense and 0-based from `templateSections`, and this page has no other blocks, so
        // there is nothing for `@@unique([pageId, position])` to collide with and no reorder to do.
        for (const block of sections) {
          await tx.pageSection.create({
            data: {
              pageId: page.id,
              type: block.type,
              position: block.position,
              label: block.label,
              // Parsed by `templateSections` against the block's own schema, so this cannot store a payload
              // the renderer would have to show as an error card. The cast is the same one the sections
              // route makes: a value that came out of Zod is JSON by construction, and TypeScript cannot
              // see that from `unknown`.
              data: block.data as Prisma.InputJsonValue,
              isVisible: true
            }
          });
        }

        // The page's searchable text is built from the words in its blocks, so it is indexed AFTER they
        // exist and inside the same transaction — an index that can disagree with the data eventually does.
        await reindexPage(tx, page.id);

        return page;
      }
    );
    createdId = created.id;
  } catch (thrown) {
    console.error("[templates] a page could not be created from a template", template.id, thrown);
    // ⚠ OUTSIDE the try, below: `navigate()` signals by throwing a marker Next recognises, and calling it
    // in here would hand that marker straight back to this catch.
  }

  if (createdId.length === 0) backWith({ problem: "create_failed" });

  // Straight into the builder. `/studio/pages/[id]` opens on the Content tab, which is the block builder,
  // so the reader lands on the arrangement they just chose rather than on a form about addresses.
  navigate(`/studio/pages/${createdId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────

export default async function StudioTemplatesPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStudioCapability(
    canManageStructure,
    "Templates need editor access or higher, because using one creates a page. An administrator can raise yours."
  );

  const params = await searchParams;
  const problem = problemFor(first(params.problem));

  const list = await readTemplateList();
  const offered = visiblePageTemplates(list.items);
  const retiredCount = list.items.length - offered.length;

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Page templates"
        description="Ready-made arrangements of blocks for the pages an institution needs most. Choosing one creates a new page with those blocks already in place, as a draft, and takes you straight to it."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {offered.length === 1 ? "1 template" : `${offered.length} templates`}
            {/* Said out loud rather than left as a smaller number: a count that quietly dropped by
                three is indistinguishable from three templates that were never there (§1.6). */}
            {retiredCount > 0
              ? `, and ${retiredCount === 1 ? "1 more" : `${retiredCount} more`} switched off`
              : ""}
          </span>
        }
      />

      {/* `role="alert"` for a refusal: the reader has just tried to do something and been stopped. */}
      {problem ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{problem}</span>
        </p>
      ) : null}

      <HelpText>
        Nothing is created until you choose &ldquo;Create this page&rdquo;. Every template makes a draft, so
        nothing appears on the public site until you publish it, and every block it adds can be reworded,
        reordered or deleted afterwards. The blocks arrive holding short prompts such as &ldquo;Add a
        headline&rdquo; — those are for you to replace, and the health check will remind you about any that
        are still there once the page is published.
      </HelpText>

      {offered.length === 0 ? (
        // Not an `EmptyState`: it renders its own `<h2>`, and this sits directly under the screen's
        // `<h1>` with nothing between them, so a second heading here would say the page has a section
        // called "No templates" (contract §14). And it is a state that can genuinely be reached — every
        // built-in can be switched off — so it must say what to do about it.
        <p className="rounded-lg border border-dashed border-line-200 bg-surface-50 px-6 py-10 text-center text-sm leading-relaxed text-ink-500">
          No templates are being offered at the moment: every one of them has been switched off. Switch
          one back on below, or start from a blank page on the Pages screen.
        </p>
      ) : (
        <ul className="grid gap-5 lg:grid-cols-2">
          {offered.map((template) => (
            <li key={template.id}>
              <TemplateCard template={template} />
            </li>
          ))}
        </ul>
      )}

      <HelpText>
        Looking for a page that is almost the same as one you already have? Copy the existing page from the
        Pages list instead — a copy keeps the words as well as the arrangement, and arrives as a draft with
        its own address.
      </HelpText>

      <TemplateManager initialData={list} />
    </div>
  );
}

/**
 * One template.
 *
 * A `<section>` with its own heading rather than a `FormSection`, because the heading here is the
 * template's NAME and the panel is a choice rather than a group of fields. The `<h2>` sits under the
 * screen's single `<h1>` from `StudioPageHeader`, and the block list's rows carry no heading at all —
 * they are a list, and giving each row a heading would put twenty-odd `<h3>`s in the outline of a page
 * whose real structure is a handful of choices.
 *
 * A template WRITTEN HERE is drawn exactly like one that ships with the software, and deliberately so:
 * to somebody choosing what sort of page to make, where the arrangement came from is not a fact they
 * need. The manager at the foot of the screen is where that distinction matters and is stated.
 */
function TemplateCard({ template }: { template: ResolvedPageTemplate }) {
  const previews = templateBlockPreviews(template);
  const TemplateIcon = templateIcon(template.icon);
  const titleFieldId = `template-title-${template.id}`;
  const headingId = `template-${template.id}-heading`;

  return (
    <section aria-labelledby={headingId} className="panel flex h-full flex-col">
      <div className="flex items-start gap-3.5 border-b border-line-200 px-5 py-4">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-purple-100 text-purple-700"
        >
          <TemplateIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="font-display text-base font-semibold text-ink-900">
            {template.name}
          </h2>
          {/* A template written here may have no description yet. Saying so beats an empty paragraph,
              which reads as a card that failed to load rather than as a template nobody has described. */}
          <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-500">
            {template.description.trim().length > 0
              ? template.description
              : "No description has been written for this template yet. What it makes is listed below."}
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-5 py-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {previews.length === 0
              ? "What it adds"
              : previews.length === 1
                ? "The one block it adds"
                : `The ${previews.length} blocks it adds`}
          </p>

          {/*
            ⚠ AN EMPTY LIST SAYS SO. A card whose blocks could not be read — the likeliest cause being a
            block type withdrawn by a newer version of this software, which `readStoredBlocks()` reports
            and this card does not print — otherwise drew the heading, an empty `<ol>` and a live
            "Create this page" button, which is a template that quietly stopped (contract §1.6). The
            press would then be refused with "that template has no blocks in it", which is the first the
            reader would have heard of it.
          */}
          {previews.length === 0 ? (
            <p className="mt-2.5 rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-4 text-sm leading-relaxed text-ink-500">
              This template has no blocks that this version of the site can use, so it would create an
              empty page. Open it from the list of templates at the foot of this screen to see why, or
              start from a blank page on the Pages screen.
            </p>
          ) : null}

          {/*
            An ordered list, because the order is the template: it is what goes at the top of the page and
            what comes after it. `<ol>` says that to a screen reader without a word of prose.
          */}
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
                      {/* The number is written out rather than left to the list's own marker: the marker
                          is not selectable text, and an administrator reading this to a colleague on the
                          telephone needs to be able to say "block four". */}
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

        {/*
          A plain uncontrolled form posting to a Server Action. No `onSubmit`, so nothing here depends on
          JavaScript and the §10 `new FormData(event.currentTarget)` trap cannot arise — React never
          touches the event.
        */}
        <form action={createFromTemplate} className="mt-auto space-y-3 border-t border-line-200 pt-4">
          <input type="hidden" name="template" value={template.id} />

          {/* `Field` (a real `<label>`) is right here: the control is a plain `<input>`, so there is no
              button inside for a stray click to be forwarded to (Field.tsx). */}
          <Field
            label="Title for the new page"
            htmlFor={titleFieldId}
            required
            maxLength={TITLE_MAX}
            help="The heading at the top of the page, and its name in every list. The web address is worked out from it and can be changed afterwards."
          >
            <Input
              id={titleFieldId}
              name="title"
              required
              maxLength={TITLE_MAX}
              defaultValue={template.suggestedTitle}
              autoComplete="off"
            />
          </Field>

          <Button type="submit" icon={WandSparkles}>
            Create this page
          </Button>
        </form>
      </div>
    </section>
  );
}
