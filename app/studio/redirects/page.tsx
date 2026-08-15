import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect as navigate } from "next/navigation";
import { ArrowRight, ArrowRightLeft, Link2Off, Plus, Search, Trash2, TriangleAlert } from "lucide-react";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canManageStructure } from "@/lib/permissions";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { siteUrl } from "@/lib/env";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";

/**
 * Redirects — "this page has moved", so a link printed in a paper keeps working.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageStructure)` IS THE FIRST STATEMENT of the page AND OF EVERY ACTION below.
 * The page's check decides what is rendered; the actions' checks are the boundary that actually matters —
 * a form can be submitted by anything, and a guard that only hides a control is not a guard (contract
 * §1.7).
 *
 * THIS SCREEN USES SERVER ACTIONS AND PLAIN FORMS, NOT A FETCH LOOP, and that is a deliberate fit rather
 * than a shortcut. A redirect is three fields and a button: there is no filtering to keep, no autosave to
 * schedule, no selection to preserve. Plain forms mean the whole screen works with no JavaScript at all,
 * the permission check runs on the server for every submission, and every write still goes through
 * `mutateWithHistory()` — the row, its audit entry and (where relevant) its revision in ONE transaction.
 *
 * ⚠ THREE THINGS ARE REFUSED, AND EACH ONE IS A FAILURE THE BROWSER REPORTS AS SOMETHING ELSE:
 *
 *   1. A SOURCE THAT IS NOT A PATH. `https://example.com/old` in the source column matches nothing: the
 *      site can only answer for its own addresses. A row like that looks saved and does nothing.
 *   2. A REDIRECT TO ITSELF. `/old` → `/old` is an infinite loop, which every browser reports as
 *      ERR_TOO_MANY_REDIRECTS — a page that appears completely broken for a reason nothing on screen
 *      explains. (`findPageRedirect` in lib/pages.ts refuses one at read time too and logs it; this stops
 *      it being created in the first place.)
 *   3. A CHAIN THAT COMES BACK ROUND. `/a` → `/b` → `/a` is the same infinite loop written across two
 *      rows, and it is the one nobody spots by eye. Every save follows the whole chain before it commits.
 *
 * A CHAIN THAT DOES *NOT* LOOP IS ALLOWED, AND REPORTED. `/a` → `/b` → `/c` works, but every hop is
 * another round trip for the reader, and search engines follow only a few before giving up — so the
 * screen names the chains and suggests pointing the first hop straight at the last.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ERRORS COME BACK AS A CODE IN THE QUERY STRING, NEVER AS A SENTENCE. `?problem=loop` is looked up in the
 * table below; `?problem=<free text>` would let anybody craft a link that shows an administrator a message
 * this application never wrote.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Redirects"
};

/**
 * How many rows are listed at once.
 *
 * Stated on screen when it bites: a list that quietly stops is indistinguishable from a place with only
 * that many records (contract §1.6). The search box is the way past it.
 */
const LIST_LIMIT = 200;

/** How far a chain is followed before it is called a loop. Ten hops is far beyond anything useful. */
const MAX_HOPS = 10;

const SOURCE_MAX = 500;
const DESTINATION_MAX = 500;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Normalising and checking
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The stored form of a source: exactly one leading slash, no trailing slash, no doubled slashes.
 *
 * `findPageRedirect()` accepts both `/old-page` and `old-page` for historical reasons, preferring the
 * leading-slash form. Writing only that form means the two shapes never both exist for one address, so a
 * reader can never be looking at a redirect that is plainly saved and plainly not working.
 */
function normaliseSource(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (trimmed.length === 0) return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/** The destination as it will be stored. An external address keeps its scheme; anything else is a path. */
function normaliseDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("#") || trimmed.startsWith("?")) return trimmed;
  return normaliseSource(trimmed);
}

/** True when a source is a usable site path. */
function isUsableSource(source: string): boolean {
  if (!source.startsWith("/")) return false;
  // A scheme or an authority in the source column means somebody pasted a whole URL. It can never match.
  if (/^\/\//.test(source)) return false;
  if (source.includes("://")) return false;
  return source.length <= SOURCE_MAX;
}

/**
 * Follow the chain from `destination`, using every OTHER redirect, and say whether it comes back to
 * `source`.
 *
 * The map excludes the row being saved, and `destination` is the row's own new destination — so the walk
 * asks exactly the question that matters: "if I commit this, can a reader end up back where they started?"
 */
function chainReturnsTo(
  others: ReadonlyMap<string, string>,
  source: string,
  destination: string
): boolean {
  let current = destination;
  const seen = new Set<string>([source]);

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (current === source) return true;
    if (seen.has(current)) return false; // a loop that does not involve this row; not ours to refuse
    seen.add(current);
    const next = others.get(current);
    if (next === undefined) return false;
    current = next;
  }
  // Ten hops without settling is itself a loop for every practical purpose.
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Outcomes, as codes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PROBLEMS: Record<string, string> = {
  source_not_path: "The old address has to be a path on this site, beginning with a slash — “/old-page”, not a whole web address. Nothing was saved.",
  source_missing: "The old address was empty. Nothing was saved.",
  destination_missing: "The new address was empty. A redirect with nowhere to go would send readers to a blank page, so nothing was saved.",
  same: "The old and the new address are the same. That is an endless loop, which a browser reports as “too many redirects” — the page looks completely broken. Nothing was saved.",
  loop: "Saving that would make a chain that comes back to where it started, which a browser reports as “too many redirects”. Follow the chain from the new address and point it somewhere that settles. Nothing was saved.",
  source_exists: "There is already a redirect for that old address. Change the existing one rather than adding a second — two rows for one address is a coin toss over which one wins.",
  not_found: "That redirect no longer exists. Somebody may have removed it while this page was open.",
  too_long: "One of the addresses is longer than this can store. Nothing was saved."
};

const NOTICES: Record<string, string> = {
  created: "The redirect has been added. Anyone following the old address is sent to the new one from now on.",
  saved: "The redirect has been changed.",
  deleted: "The redirect has been removed. The old address will answer “page not found” again."
};

/** `?problem=` and `?notice=` are read against these tables and nothing else. See the file header. */
function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The actions
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Who is doing this, for the audit entry.
 *
 * `clientIp()`/`userAgent()` in lib/api.ts take a `Request`, which a Server Action does not have — so the
 * same two headers are read from `headers()` here. `x-forwarded-for` carries a list; the FIRST entry is
 * the client, everything after it is a proxy.
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
  navigate(`/studio/redirects${search.length > 0 ? `?${search}` : ""}`);
}

async function saveRedirect(formData: FormData): Promise<void> {
  "use server";

  // THE BOUNDARY. Not the render above — a form can be submitted by anything that can make a POST.
  const user = await requireStudioCapability(
    canManageStructure,
    "Changing redirects needs editor access or higher."
  );

  const id = String(formData.get("id") ?? "").trim();
  const source = normaliseSource(String(formData.get("source") ?? ""));
  const destination = normaliseDestination(String(formData.get("destination") ?? ""));
  const permanent = formData.get("permanent") === "on";

  if (source.length === 0) backWith({ problem: "source_missing" });
  if (!isUsableSource(source)) backWith({ problem: "source_not_path" });
  if (destination.length === 0) backWith({ problem: "destination_missing" });
  if (destination.length > DESTINATION_MAX) backWith({ problem: "too_long" });
  if (destination === source) backWith({ problem: "same" });

  const existing = await prisma.redirect.findMany({
    select: { id: true, source: true, destination: true }
  });

  const bySource = new Map<string, string>();
  for (const row of existing) {
    // The row being saved is excluded: its OLD destination must not be what the loop check follows.
    if (id.length > 0 && row.id === id) continue;
    bySource.set(normaliseSource(row.source), normaliseDestination(row.destination));
  }

  if (chainReturnsTo(bySource, source, destination)) backWith({ problem: "loop" });

  const clash = existing.find(
    (row) => normaliseSource(row.source) === source && (id.length === 0 || row.id !== id)
  );
  if (clash) backWith({ problem: "source_exists" });

  const context = await auditContext({ id: user.id, email: user.email });

  if (id.length === 0) {
    await mutateWithHistory(
      context,
      {
        action: "CREATE",
        entityType: "Redirect",
        entityLabel: `${source} → ${destination}`,
        // A redirect is not versioned content, so a revision of it would only be a second copy of the
        // audit entry.
        revise: false
      },
      async (tx) => tx.redirect.create({ data: { source, destination, permanent } })
    );
    backWith({ notice: "created" });
  }

  const before = await prisma.redirect.findUnique({ where: { id } });
  if (!before) backWith({ problem: "not_found" });

  await mutateWithHistory(
    context,
    {
      action: "UPDATE",
      entityType: "Redirect",
      entityLabel: `${source} → ${destination}`,
      revise: false,
      before
    },
    async (tx) => tx.redirect.update({ where: { id }, data: { source, destination, permanent } })
  );
  backWith({ notice: "saved" });
}

async function deleteRedirect(formData: FormData): Promise<void> {
  "use server";

  const user = await requireStudioCapability(
    canManageStructure,
    "Changing redirects needs editor access or higher."
  );

  const id = String(formData.get("id") ?? "").trim();
  if (id.length === 0) backWith({ problem: "not_found" });

  const before = await prisma.redirect.findUnique({ where: { id } });
  if (!before) backWith({ problem: "not_found" });

  const context = await auditContext({ id: user.id, email: user.email });

  /**
   * A HARD DELETE, and it is the right one here.
   *
   * `Redirect` carries no `deletedAt`: it is routing configuration, not content, and there is nothing to
   * recover — the whole row is two addresses and a flag, both of which are in the audit entry this write
   * creates. The consequence is stated in the confirmation copy beside the button: the old address starts
   * answering "page not found" again.
   */
  await mutateWithHistory(
    context,
    {
      action: "DELETE",
      entityType: "Redirect",
      entityLabel: `${before.source} → ${before.destination}`,
      revise: false,
      before
    },
    async (tx) => tx.redirect.delete({ where: { id } })
  );
  backWith({ notice: "deleted" });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export default async function StudioRedirectsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStudioCapability(
    canManageStructure,
    "Redirects need editor access or higher. An administrator can raise yours."
  );

  const params = await searchParams;
  const q = first(params.q).trim();
  const problem = PROBLEMS[first(params.problem)] ?? null;
  const notice = NOTICES[first(params.notice)] ?? null;

  const where = q.length > 0
    ? {
        OR: [
          { source: { contains: q, mode: "insensitive" as const } },
          { destination: { contains: q, mode: "insensitive" as const } }
        ]
      }
    : {};

  const [rows, total, allRows] = await prisma.$transaction([
    prisma.redirect.findMany({
      where,
      orderBy: [{ hits: "desc" }, { source: "asc" }],
      take: LIST_LIMIT
    }),
    prisma.redirect.count({ where }),
    // The whole table, narrowly, for the chain check. It is two short strings per row; a table big enough
    // for this to matter is a table with a different problem.
    prisma.redirect.findMany({ select: { source: true, destination: true } })
  ]);

  /**
   * Chains: a redirect whose destination is itself the source of another one.
   *
   * Allowed, and worth naming. Every hop is another round trip for the reader, and a crawler follows only
   * a few before it gives up and drops the URL — which is the opposite of what a redirect is for.
   */
  const destinations = new Map<string, string>();
  for (const row of allRows) destinations.set(normaliseSource(row.source), normaliseDestination(row.destination));

  const chains: { source: string; hops: string[]; loops: boolean }[] = [];
  for (const row of allRows) {
    const source = normaliseSource(row.source);
    const hops: string[] = [];
    let current = normaliseDestination(row.destination);
    const seen = new Set<string>([source]);
    let loops = false;

    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const next = destinations.get(current);
      if (next === undefined) break;
      if (seen.has(current)) {
        loops = true;
        break;
      }
      seen.add(current);
      hops.push(current);
      current = next;
      if (current === source) {
        loops = true;
        break;
      }
    }

    if (hops.length > 0) chains.push({ source, hops: [...hops, current], loops });
  }

  const origin = siteUrl();

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Redirects"
        description="Send an old web address to a new one. Institutional addresses are quoted in papers, syllabuses and emails that outlive the page they point at, so a page that moves should keep answering its old address rather than showing “page not found”."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 redirect" : `${total} redirects`}
          </span>
        }
      />

      {/*
        `role="alert"` for a refusal — the reader has just tried to do something and been stopped, which is
        the one case that warrants interrupting them. `role="status"` for a success.
      */}
      {problem ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{problem}</span>
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="rounded-md border border-success-600/25 bg-success-100 px-3.5 py-3 text-sm leading-relaxed text-success-600"
        >
          {notice}
        </p>
      ) : null}

      {chains.length > 0 ? (
        <div className="rounded-md border border-amber-800/25 bg-amber-100 px-3.5 py-3 text-amber-800">
          <p className="flex items-start gap-2 text-sm font-semibold">
            <ArrowRightLeft aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {chains.length === 1
                ? "1 redirect passes through another one"
                : `${chains.length} redirects pass through another one`}
            </span>
          </p>
          <ul className="mt-1.5 space-y-1 pl-1 text-xs leading-relaxed">
            {chains.map((chain) => (
              <li key={chain.source} className="break-all font-mono">
                {chain.source} → {chain.hops.join(" → ")}
                {chain.loops ? (
                  <span className="ml-1.5 font-sans font-semibold">
                    — this comes back round, which a browser reports as “too many redirects”. Fix it.
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed">
            Each extra hop is another round trip for whoever followed the link, and a search engine follows
            only a few before it gives up on the address altogether. Point the first one straight at the
            last.
          </p>
        </div>
      ) : null}

      <FormSection
        title="Add a redirect"
        description="The old address is a path on this site. The new one can be another path, or a full address somewhere else."
      >
        {/*
          A plain uncontrolled form posting to a Server Action. No `onSubmit`, so nothing here depends on
          JavaScript and the §10 `new FormData(event.currentTarget)` trap cannot arise — React never
          touches the event.
        */}
        <form action={saveRedirect} className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            {/* `Field` (a real `<label>`) is right for both: each control is a plain `<input>`, so there
                is no button inside for a stray click to be forwarded to (Field.tsx). */}
            <Field
              label="Old address"
              required
              help="The path people already have, starting with a slash. Everything after your site's name — “/old-report”, or “/research/2019-roadmap”."
            >
              <Input
                name="source"
                required
                maxLength={SOURCE_MAX}
                placeholder="/old-report"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>

            <Field
              label="New address"
              required
              help="Where they should end up. A path on this site, or a full address beginning with https:// for somewhere else."
            >
              <Input
                name="destination"
                required
                maxLength={DESTINATION_MAX}
                placeholder="/publications/2019-roadmap"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
          </div>

          <Checkbox
            name="permanent"
            defaultChecked
            label="This move is permanent"
            description="A permanent redirect tells search engines to forget the old address and index the new one, and browsers remember it. Turn it off for a temporary move — a browser that has cached a permanent one will not check again for a long time."
          />

          <div>
            <Button type="submit" icon={Plus}>
              Add the redirect
            </Button>
          </div>
        </form>
      </FormSection>

      <FormSection
        title="Existing redirects"
        description="Change an address, or remove a redirect that is no longer needed."
        actions={
          // A GET form: the search is a place in the URL, so it can be shared and the Back button walks it.
          // No JavaScript involved at all.
          <form method="get" className="flex items-end gap-2">
            <Field label="Search" hideLabel>
              <Input
                name="q"
                type="search"
                defaultValue={q}
                placeholder="Search addresses"
                iconNode={<Search />}
                className="w-48"
              />
            </Field>
            <Button type="submit" variant="secondary" size="sm">
              Search
            </Button>
          </form>
        }
      >
        {rows.length === 0 ? (
          q.length > 0 ? (
            <EmptyState
              icon={Link2Off}
              headingLevel={3}
              title="No redirects match that search"
              description="Nothing here has that in its old or new address."
            />
          ) : (
            <EmptyState
              icon={ArrowRightLeft}
              headingLevel={3}
              title="There are no redirects yet"
              description="Add one when you move or rename a page, so the address people already have keeps working."
            />
          )
        ) : (
          <>
            <ul className="space-y-3">
              {rows.map((row) => (
                <li key={row.id} className="rounded-md border border-line-200 bg-surface-50 p-3">
                  {/*
                    One form per row, and a `<form>` cannot be a child of `<tr>` — which is why this list
                    is a stack of small cards rather than a table. The alternative, a table for scanning
                    plus a separate editor, would mean two places a destination could be changed from.
                  */}
                  <form action={saveRedirect} className="space-y-3">
                    <input type="hidden" name="id" value={row.id} />

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Old address" required>
                        <Input
                          name="source"
                          defaultValue={row.source}
                          required
                          maxLength={SOURCE_MAX}
                          autoComplete="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          className="font-mono text-xs"
                        />
                      </Field>

                      <Field label="New address" required>
                        <Input
                          name="destination"
                          defaultValue={row.destination}
                          required
                          maxLength={DESTINATION_MAX}
                          autoComplete="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          className="font-mono text-xs"
                        />
                      </Field>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                      <Checkbox
                        name="permanent"
                        defaultChecked={row.permanent}
                        label="Permanent"
                        className="!min-h-8 !py-0"
                      />

                      <p className="flex items-center gap-1.5 text-xs text-ink-500">
                        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                        <span className="break-all">
                          {origin}
                          {row.source}
                        </span>
                      </p>

                      <p className="text-xs tabular-nums text-ink-500">
                        followed {row.hits} {row.hits === 1 ? "time" : "times"}
                      </p>

                      <div className="flex items-center gap-2">
                        <Button type="submit" variant="secondary" size="sm">
                          Save
                        </Button>
                      </div>
                    </div>
                  </form>

                  {/*
                    A SEPARATE form, so Delete cannot be reached by pressing Enter in a text field of the
                    one above it — Enter submits the form the field is in, and a Delete sharing that form
                    would be one keystroke away from removing the row somebody was editing.
                  */}
                  <form action={deleteRedirect} className="mt-2 border-t border-line-200 pt-2">
                    <input type="hidden" name="id" value={row.id} />
                    <Button type="submit" variant="danger" size="sm" icon={Trash2}>
                      Remove this redirect
                    </Button>
                    <span className="ml-2 text-xs text-ink-500">
                      The old address answers “page not found” again straight away.
                    </span>
                  </form>
                </li>
              ))}
            </ul>

            {total > rows.length ? (
              <HelpText>
                Showing the {rows.length} most-followed redirects. There are {total} altogether — search
                above to reach the rest.
              </HelpText>
            ) : null}

            {/*
              HONEST ABOUT THE COUNTER. `findPageRedirect()` in lib/pages.ts deliberately does NOT increment
              `hits`: it runs inside a render, including a build-time prerender, and a counter incremented
              there would count deployments rather than readers. So a working redirect can legitimately
              read 0, and nobody should conclude from that number that nobody is following it.
            */}
            <HelpText>
              “Followed” is only counted where something records it on the way through. The page renderer
              deliberately does not write to the database while it renders, so a redirect that is working
              perfectly can still show 0 — treat a high number as evidence and a zero as no evidence
              either way.
            </HelpText>
          </>
        )}
      </FormSection>
    </div>
  );
}
