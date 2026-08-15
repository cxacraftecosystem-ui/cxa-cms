"use client";

/**
 * AccessManager — the list of addresses that may sign in to the studio at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN IS FOR, IN ONE SENTENCE: an address that is not on this list cannot sign in, by any
 * method. Proving who you are (a password, Google, Microsoft, Yahoo) and being allowed in are two
 * different questions, and this list answers the second one.
 *
 * FOUR THINGS THIS SCREEN DOES THAT A PLAIN CRUD TABLE WOULD NOT, each because of a specific failure:
 *
 *  1. IT SAYS WHETHER EACH ENTRY HAS EVER BEEN USED, and marks an unused one. An access list nobody can
 *     prune is one that only ever grows, and "added eight months ago, never signed in" is the single
 *     most useful fact on the screen: it is either somebody who left before they started, or a typo in
 *     an address, and neither will ever announce itself.
 *
 *  2. IT ASKS WHY. The reason is an ordinary text box and it is not decoration — a list with no reasons
 *     is a list nobody dares prune, because every entry might be load-bearing. The screen says so where
 *     the box is, and it says so again when a reason is cleared.
 *
 *  3. ⚠ IT SAYS THAT REVOKING DOES NOT SIGN ANYBODY OUT, AND OFFERS TO DO BOTH. The list is consulted
 *     when somebody signs IN; a browser already signed in keeps working until its session expires, which
 *     can be days. A "Revoke" button that implied an immediate effect it does not have would be worse
 *     than one that explains itself, so the sentence sits beside the control and a tick box next to it
 *     ends their sessions in the same action.
 *
 *  4. REVOKING IS A FLAG AND DELETING IS SEPARATE. A revoked entry still records who was allowed in and
 *     who allowed them; deleting destroys that, so it is danger-toned and asks for the address to be
 *     typed (`requireTyping`). The difference is stated on screen rather than left for somebody to
 *     discover.
 *
 * WHERE A CONTROL IS UNAVAILABLE, THE REASON IS ON SCREEN. This is the same deliberate departure from
 * "a failing check renders nothing" that the users screen makes, and for the same reason: a master admin
 * who cannot find the Revoke control concludes the CMS is broken and files a bug. So the control is
 * ABSENT — never disabled — and a sentence says why:
 *
 *   • You cannot revoke or delete YOUR OWN address. Somebody has to be able to undo a mistake here.
 *   • You cannot remove the LAST entry granting master administrator access, or lower its level. If it
 *     went, nobody could ever add anybody to this list again, including the person who would undo it.
 *
 * Both refusals are enforced by the route handlers, inside the transaction that writes — hiding a
 * control here is a courtesy, not the boundary (contract §1.7).
 *
 * ⚠ THE LEVEL OF ACCESS ON AN ENTRY ONLY AFFECTS AN ACCOUNT THAT DOES NOT EXIST YET. It is what a first
 * sign-in creates the account with; it deliberately does not follow later changes, because re-reading it
 * would silently undo a promotion or demotion made on the Users screen. The screen says which of the two
 * cases each entry is in, so nobody expects a role change here to take effect on somebody who has
 * already signed in.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Ban,
  CircleCheck,
  CircleSlash,
  Clock,
  KeyRound,
  RotateCcw,
  SearchX,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  UserPlus
} from "lucide-react";
import type { AuthProvider, Role } from "@prisma/client";

import { asApiClientError, buildQuery, del, patch, post } from "@/lib/client/fetcher";
import { useDebouncedValue, useResource } from "@/lib/client/useResource";
import { ROLES_DESCENDING, ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Pagination } from "@/components/ui/Pagination";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";

/** Every address this screen calls, in one place, so the route handlers have one list to satisfy. */
const ACCESS_ENDPOINTS = {
  list: (query: string) => `/api/studio/access${query}`,
  create: "/api/studio/access",
  detail: (id: string) => `/api/studio/access/${encodeURIComponent(id)}`
} as const;

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 250;
const NOTE_MAX = 1000;

/**
 * The sign-in methods, in a fixed order.
 *
 * ⚠ DUPLICATED FROM `app/api/studio/access/route.ts`, AND IT HAS TO BE. The labels also live in
 * `providerConfig()` in lib/auth/oauth.ts, which is `server-only` — that module reads client ids and
 * secrets from the environment, so making it importable by the browser to share four words would be a
 * poor trade. If a provider is ever added, change all three.
 */
const AUTH_PROVIDERS: readonly AuthProvider[] = ["PASSWORD", "GOOGLE", "MICROSOFT", "YAHOO"];

const PROVIDER_LABELS: Record<AuthProvider, string> = {
  PASSWORD: "Password",
  GOOGLE: "Google",
  MICROSOFT: "Microsoft",
  YAHOO: "Yahoo"
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface ActorRef {
  id: string;
  name: string;
  email: string;
}

export interface StudioAccessRow {
  id: string;
  /** Stored lower-cased. It is the identity of the entry, and it cannot be edited — see the panel. */
  email: string;
  name: string | null;
  /** The level a FIRST sign-in creates the account with. See the header. */
  grantedRole: Role;
  note: string | null;
  /** Empty means "any method this installation has set up". */
  allowedProviders: AuthProvider[];
  /** ISO 8601 throughout: JSON has no date type. */
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  lastSignInAt: string | null;
  lastProvider: AuthProvider | null;
  signInCount: number;
  addedBy: ActorRef | null;
  revokedBy: ActorRef | null;
  /** Whether anybody has ever signed in against this entry. The prunability question. */
  used: boolean;
  /** Whether an account exists for the address, and how many devices are signed in on it. */
  hasAccount: boolean;
  accountIsActive: boolean;
  activeSessions: number;
}

export interface AccessListResponse {
  items: StudioAccessRow[];
  total: number;
  page: number;
  pageSize: number;
  truncated: boolean;
  counts: {
    all: number;
    active: number;
    revoked: number;
    /** Still allowed in, and never used. The set worth pruning. */
    unused: number;
    /** Unrevoked entries granting master administrator access. The last one cannot be removed. */
    masterAdmins: number;
  };
}

type AccessFilter = "all" | "active" | "revoked" | "unused";

interface Filters {
  q: string;
  filter: AccessFilter;
  page: number;
}

const DEFAULT_FILTERS: Filters = { q: "", filter: "all", page: 1 };

function isFilter(value: string): value is AccessFilter {
  return value === "all" || value === "active" || value === "revoked" || value === "unused";
}

function isRole(value: string): value is Role {
  return (ROLES_DESCENDING as readonly string[]).includes(value);
}

/** Read the filters out of the address bar, in the browser. A Server Component cannot call this. */
function readFilters(params: { get: (name: string) => string | null }): Filters {
  const filter = params.get("filter") ?? "";
  const page = Number.parseInt(params.get("page") ?? "", 10);
  return {
    q: params.get("q") ?? "",
    filter: isFilter(filter) ? filter : "all",
    page: Number.isFinite(page) && page > 0 ? page : 1
  };
}

/** "3 days ago". Never a bare date, because "how long ago" is the question being asked of this column. */
function relative(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return formatDistanceToNow(date, { addSuffix: true });
}

/** The exact instant in a NAMED zone, for a title attribute that has to settle an argument. */
function exact(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  const head = items.slice(0, -1).join(", ");
  return `${head} and ${items[items.length - 1] ?? ""}`;
}

function methodSummary(allowed: readonly AuthProvider[]): string {
  if (allowed.length === 0) return "Any method";
  return andList(allowed.map((provider) => PROVIDER_LABELS[provider]));
}

function sameProviders(a: readonly AuthProvider[], b: readonly AuthProvider[]): boolean {
  if (a.length !== b.length) return false;
  const left = AUTH_PROVIDERS.filter((provider) => a.includes(provider));
  const right = AUTH_PROVIDERS.filter((provider) => b.includes(provider));
  return left.every((provider, index) => provider === right[index]);
}

/** What to call the person in a sentence: their name if the entry has one, otherwise the address. */
function personLabel(row: { name: string | null; email: string }): string {
  return row.name && row.name.length > 0 ? row.name : row.email;
}

const HEAD =
  "border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface AccessManagerProps {
  /** The signed-in master admin's address, already normalised on the server. */
  currentUserEmail: string;
  currentUserName: string;
  /** Whether the reader's own address is on the list. It can legitimately be missing — see below. */
  ownEntryExists: boolean;
  ownEntryRevoked: boolean;
  /** The OAuth providers this installation has actually configured. Names only, never the secrets. */
  configuredMethods: readonly AuthProvider[];
}

export function AccessManager({
  currentUserEmail,
  currentUserName,
  ownEntryExists,
  ownEntryRevoked,
  configuredMethods
}: AccessManagerProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [filters, setFilters] = useState<Filters>(() => readFilters(searchParams));
  const [activeId, setActiveId] = useState<string | null>(() => searchParams.get("entry"));

  const query = buildQuery({
    q: filters.q.trim(),
    filter: filters.filter === "all" ? undefined : filters.filter,
    page: filters.page > 1 ? filters.page : undefined,
    pageSize: PAGE_SIZE
  });
  // The composed PATH is debounced, not the text box, so a typed search and a clicked filter share one
  // timer instead of racing each other (useResource.ts).
  const debouncedPath = useDebouncedValue(ACCESS_ENDPOINTS.list(query), DEBOUNCE_MS);
  const list = useResource<AccessListResponse>(debouncedPath);

  const rows = list.data?.items ?? null;
  const total = list.data?.total ?? 0;
  const counts = list.data?.counts ?? null;

  /**
   * Which methods can actually be used, for the warning beside the restriction boxes.
   *
   * A password always works. An OAuth provider only works once its client id and secret are set, and an
   * entry restricted to a provider nobody has configured is an entry nobody can use — which looks
   * exactly like a broken sign-in from the other side.
   */
  const availableMethods = useMemo(() => {
    const set = new Set<AuthProvider>(["PASSWORD"]);
    for (const provider of configuredMethods) set.add(provider);
    return set;
  }, [configuredMethods]);

  const mirror = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q.trim().length > 0) params.set("q", filters.q.trim());
    if (filters.filter !== "all") params.set("filter", filters.filter);
    if (filters.page > 1) params.set("page", String(filters.page));
    if (activeId !== null) params.set("entry", activeId);
    const search = params.toString();
    return search.length > 0 ? `?${search}` : "";
  }, [filters, activeId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = `${pathname}${mirror}`;
    if (`${window.location.pathname}${window.location.search}` === next) return;
    // `replaceState`, not `router.replace`: a router navigation on every keystroke would re-run the
    // server component for data this screen is already fetching.
    window.history.replaceState(null, "", next);
  }, [pathname, mirror]);

  const selected = useMemo(
    () => (rows ?? []).find((row) => row.id === activeId) ?? null,
    [rows, activeId]
  );

  const report = useCallback(
    (thrown: unknown, title: string) => {
      // The server's `message` is already a plain sentence ready to render (lib/api.ts guarantees it),
      // and on this screen it is the sentence naming which rule refused the change.
      toast({ tone: "error", title, description: asApiClientError(thrown).message });
    },
    [toast]
  );

  const narrowed = filters.q.trim().length > 0 || filters.filter !== "all";

  return (
    <div className="space-y-5">
      {/*
        The reader's own entry, when it is missing. Not hypothetical: an account that predates this list
        is admitted by the grace path in lib/auth/access.ts, which writes a warning to the server log
        that nobody reads. Saying it here is what turns it into something a person can fix.
      */}
      {!ownEntryExists ? (
        <HelpText tone="warn">
          Your own address, {currentUserEmail}, is not on this list. You are signed in because your
          account already existed when the list was introduced, which is allowed once and recorded in the
          server log each time. Add yourself so the list is a complete answer to who may sign in.
        </HelpText>
      ) : ownEntryRevoked ? (
        <HelpText tone="warn">
          Your own entry on this list has been revoked. You are signed in now, but the next time you sign
          in you will be refused. Restore your entry, or ask another master administrator to.
        </HelpText>
      ) : null}

      <AddPersonForm
        availableMethods={availableMethods}
        onAdded={async (id) => {
          // Back to the unfiltered first page, so a new entry cannot be added into a view that hides it.
          setFilters({ ...DEFAULT_FILTERS });
          await list.refresh();
          setActiveId(id);
        }}
        onFailed={(thrown) => report(thrown, "Nobody has been added")}
      />

      {/* ── Filters ───────────────────────────────────────────────────────────────────────────── */}
      <section aria-label="Filters" className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <SearchInput
            label="Search the access list by address or name"
            placeholder="Search addresses"
            value={filters.q}
            onValueChange={(value) => setFilters((current) => ({ ...current, q: value, page: 1 }))}
            className="sm:min-w-[16rem] sm:flex-1"
          />

          {/* `Field` (a real `<label>`) is right here: the control is a NATIVE `<select>`. */}
          <Field label="Show" className="sm:w-56">
            <Select
              value={filters.filter}
              options={[
                { value: "all", label: "Everybody on the list" },
                { value: "active", label: "Can sign in" },
                { value: "revoked", label: "Revoked" },
                { value: "unused", label: "Never used" }
              ]}
              onChange={(event) => {
                const next = event.target.value;
                setFilters((current) => ({
                  ...current,
                  filter: isFilter(next) ? next : "all",
                  page: 1
                }));
              }}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-xs text-ink-500">
            {narrowed
              ? "A filter is set, so this is not the whole list."
              : "No filter is set, so this is everybody who may sign in and everybody who once could."}
          </p>
          {narrowed ? (
            <Button size="sm" variant="ghost" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
              Clear the filters
            </Button>
          ) : null}
        </div>
      </section>

      {/*
        ⚠ THE UNUSED NUDGE. The one thing that makes this list prunable: an address added months ago that
        has never signed in is either somebody who never arrived or a typo, and neither announces itself.
      */}
      {counts !== null && counts.unused > 0 && filters.filter !== "unused" ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-amber-800/25 bg-amber-100 px-3.5 py-3">
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-amber-800">
            <Clock aria-hidden="true" className="mr-1.5 inline h-4 w-4 align-[-0.2em]" />
            {counts.unused === 1
              ? "One address on this list has never been used to sign in."
              : `${counts.unused} of the ${counts.active} addresses that may sign in have never been used.`}{" "}
            Each one is somebody who never arrived, somebody who has since left, or a typed address that
            was never quite right — and none of them will say so on their own.
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setFilters({ ...DEFAULT_FILTERS, filter: "unused" })}
          >
            Show only those
          </Button>
        </div>
      ) : null}

      {list.error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-error-200 bg-error-100 px-3 py-2.5 text-sm text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{list.error.message}</span>
        </p>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-4">
          {rows === null ? (
            <div className="space-y-2 rounded-md border border-line-200 bg-card p-4">
              <span role="status" className="sr-only">
                Loading the access list…
              </span>
              <div aria-hidden="true" className="space-y-2">
                {[0, 1, 2, 3, 4].map((row) => (
                  <div key={row} className="skeleton h-9 w-full" />
                ))}
              </div>
            </div>
          ) : rows.length === 0 ? (
            narrowed ? (
              <EmptyState
                icon={SearchX}
                headingLevel={2}
                title="Nothing matches this filter"
                description="No address on the list fits what you have asked for. Clear the filter to see the whole list again."
                action={
                  <Button variant="secondary" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
                    Clear the filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={KeyRound}
                headingLevel={2}
                title="Nobody is on the access list yet"
                description="Until an address is added here, nobody can sign in to the studio — including with Google, Microsoft or Yahoo. Add the people who will look after the site, and say why each of them is here."
              />
            )
          ) : (
            <div className="overflow-x-auto rounded-md border border-line-200 bg-card">
              <table aria-label="Addresses that may sign in" className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th scope="col" className={HEAD}>
                      Address
                    </th>
                    <th scope="col" className={cn(HEAD, "hidden md:table-cell")}>
                      Will be created as
                    </th>
                    <th scope="col" className={cn(HEAD, "hidden lg:table-cell")}>
                      Sign-in methods
                    </th>
                    <th scope="col" className={cn(HEAD, "hidden xl:table-cell")}>
                      Added
                    </th>
                    <th scope="col" className={HEAD}>
                      Used
                    </th>
                    <th scope="col" className={HEAD}>
                      State
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className={cn(
                        "group border-b border-line-200 transition-colors last:border-b-0 hover:bg-surface-50",
                        row.id === activeId && "bg-purple-50"
                      )}
                    >
                      <td className="min-w-0 px-3 py-2.5 align-middle">
                        <button
                          type="button"
                          onClick={() => setActiveId(row.id)}
                          aria-pressed={row.id === activeId}
                          className="block min-w-0 max-w-full truncate rounded text-left font-medium text-ink-900 underline-offset-4 transition-colors hover:text-purple-700 hover:underline group-hover:text-purple-700"
                        >
                          {personLabel(row)}
                          {row.email === currentUserEmail ? (
                            <span className="ml-1.5 text-xs font-normal text-ink-500">(you)</span>
                          ) : null}
                        </button>
                        {row.name && row.name.length > 0 ? (
                          <span className="mt-0.5 block truncate text-xs text-ink-500">{row.email}</span>
                        ) : null}
                      </td>

                      <td className="hidden px-3 py-2.5 align-middle md:table-cell">
                        <Badge tone={row.grantedRole === "MASTER_ADMIN" ? "info" : "neutral"} size="sm">
                          {ROLE_LABELS[row.grantedRole]}
                        </Badge>
                      </td>

                      <td className="hidden px-3 py-2.5 align-middle text-ink-700 lg:table-cell">
                        {methodSummary(row.allowedProviders)}
                      </td>

                      <td className="hidden px-3 py-2.5 align-middle text-ink-700 xl:table-cell">
                        <span title={exact(row.createdAt)}>{relative(row.createdAt)}</span>
                        <span className="mt-0.5 block truncate text-xs text-ink-500">
                          {row.addedBy ? `by ${row.addedBy.name}` : "by somebody since removed"}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        {row.used ? (
                          <>
                            <span className="block text-ink-700" title={exact(row.lastSignInAt)}>
                              {relative(row.lastSignInAt)}
                            </span>
                            <span className="mt-0.5 block text-xs text-ink-500">
                              {row.lastProvider ? `${PROVIDER_LABELS[row.lastProvider]}, ` : ""}
                              {row.signInCount === 1 ? "once" : `${row.signInCount} times`}
                            </span>
                          </>
                        ) : (
                          // Icon AND word, never colour alone (contract §11).
                          <Badge tone="warn" size="sm" icon={Clock}>
                            Never used
                          </Badge>
                        )}
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        {row.revokedAt === null ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-600">
                            <CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
                            Can sign in
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-500"
                            title={exact(row.revokedAt)}
                          >
                            <CircleSlash aria-hidden="true" className="h-3.5 w-3.5" />
                            Revoked
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Pagination
            page={filters.page}
            pageSize={list.data?.pageSize ?? PAGE_SIZE}
            totalItems={total}
            itemNoun={{ singular: "address", plural: "addresses" }}
            label="Access list"
            onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
          />
        </div>

        <aside className="min-w-0">
          <div className="xl:sticky xl:top-4">
            {selected === null ? (
              <FormSection
                title="One address at a time"
                description="Choose an address on the left to change what it grants, revoke it, restore it, or remove it from the list."
              >
                <p className="text-sm text-ink-500">Nothing is selected.</p>
              </FormSection>
            ) : (
              <AccessPanel
                // REMOUNTED PER ENTRY, so one address's draft can never be saved onto another.
                key={selected.id}
                grant={selected}
                isOwnEntry={selected.email === currentUserEmail}
                currentUserName={currentUserName}
                masterAdminGrants={counts?.masterAdmins ?? 0}
                availableMethods={availableMethods}
                confirm={confirm}
                onChanged={() => void list.refresh()}
                onRemoved={() => {
                  setActiveId(null);
                  void list.refresh();
                }}
                onFailed={report}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Adding somebody
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface CreateResponse {
  grant: { id: string };
  message?: string;
}

function AddPersonForm({
  availableMethods,
  onAdded,
  onFailed
}: {
  availableMethods: ReadonlySet<AuthProvider>;
  onAdded: (id: string) => Promise<void>;
  onFailed: (thrown: unknown) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("AUTHOR");
  const [note, setNote] = useState("");
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [saving, setSaving] = useState(false);

  const submit = useCallback(async () => {
    setSaving(true);
    try {
      const created = await post<CreateResponse>(ACCESS_ENDPOINTS.create, {
        email: email.trim(),
        name: name.trim(),
        role,
        note: note.trim(),
        allowedProviders: providers
      });
      setEmail("");
      setName("");
      setRole("AUTHOR");
      setNote("");
      setProviders([]);
      setOpen(false);
      toast({
        tone: "success",
        title: "Added to the access list",
        ...(created.message ? { description: created.message } : {})
      });
      await onAdded(created.grant.id);
    } catch (thrown) {
      onFailed(thrown);
    } finally {
      setSaving(false);
    }
  }, [email, name, note, onAdded, onFailed, providers, role, toast]);

  if (!open) {
    return (
      <div>
        <Button variant="secondary" icon={UserPlus} onClick={() => setOpen(true)}>
          Add somebody to the list
        </Button>
      </div>
    );
  }

  return (
    <FormSection
      title="Add somebody to the access list"
      description="This lets one address sign in. It does not create an account or send anything — the account is made the first time they sign in, whichever method they use."
      actions={
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      }
      footer={
        <Button
          onClick={() => void submit()}
          isLoading={saving}
          loadingLabel="adding"
          disabled={email.trim().length === 0}
        >
          Add to the list
        </Button>
      }
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Their email address"
          required
          help="Exactly the address they will sign in with. Capitals do not matter; a typo does — an address that is one letter out simply never signs in, and nothing on this screen can tell that apart from somebody who has not got round to it."
        >
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field
          label="Their name"
          help="Optional, and worth filling in: it is what this list reads as before they have ever signed in."
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </Field>
      </div>

      <Field label="What their account will be created as" help={ROLE_DESCRIPTIONS[role]}>
        <Select
          value={role}
          options={ROLES_DESCENDING.map((candidate) => ({
            value: candidate,
            label: ROLE_LABELS[candidate]
          }))}
          onChange={(event) => {
            const next = event.target.value;
            if (isRole(next)) setRole(next);
          }}
        />
      </Field>

      {role === "MASTER_ADMIN" ? (
        <HelpText tone="warn">
          A master administrator decides who may sign in at all — they can add anybody to this list,
          including themselves. Give it only to somebody who should be able to open the door for others.
          The account itself is created one level lower, as an administrator, and a master administrator
          raises it afterwards, so there is always a person and a date behind that step.
        </HelpText>
      ) : null}

      <Field
        label="Why they have access"
        help="A short reason: what they are here to do, and until when if it is temporary. A list with no reasons is a list nobody dares prune, because every entry might be load-bearing."
        maxLength={NOTE_MAX}
        value={note}
      >
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
      </Field>

      <MethodPicker
        chosen={providers}
        onChange={setProviders}
        availableMethods={availableMethods}
      />
    </FormSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The sign-in method restriction
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which methods this address may use.
 *
 * NOTHING TICKED MEANS "ANY METHOD THIS INSTALLATION HAS SET UP", which is the sensible default and is
 * what `StudioAccess.allowedProviders` stores as an empty array. Ticking one or more is an explicit
 * narrowing — an administrator who wrote "Google only" meant it, and a password must not be an unnoticed
 * second door — so the sentence under the boxes says which of the two states the reader is in.
 *
 * A `<fieldset>` and `<legend>` rather than a `Field`: `Field` is a `<label>`, and a label wrapping
 * several controls folds every one of their names into one accessible name and forwards stray clicks to
 * the first of them (contract §10).
 */
function MethodPicker({
  chosen,
  onChange,
  availableMethods
}: {
  chosen: readonly AuthProvider[];
  onChange: (next: AuthProvider[]) => void;
  availableMethods: ReadonlySet<AuthProvider>;
}) {
  const unusable = chosen.filter((provider) => !availableMethods.has(provider));

  const toggle = (provider: AuthProvider, ticked: boolean) => {
    const next = new Set(chosen);
    if (ticked) next.add(provider);
    else next.delete(provider);
    onChange(AUTH_PROVIDERS.filter((entry) => next.has(entry)));
  };

  return (
    <fieldset className="min-w-0">
      <legend className="field-label">Sign-in methods they may use</legend>
      <p className="mt-1 text-xs leading-relaxed text-ink-500">
        {chosen.length === 0
          ? "Nothing is ticked, so any method this installation has set up will work for this address."
          : `Only ${andList(chosen.map((provider) => PROVIDER_LABELS[provider]))} will work. Every other method is refused, with the same message a stranger sees.`}
      </p>

      <div className="mt-1">
        {AUTH_PROVIDERS.map((provider) => {
          const configured = availableMethods.has(provider);
          return (
            <Checkbox
              key={provider}
              label={PROVIDER_LABELS[provider]}
              checked={chosen.includes(provider)}
              onCheckedChange={(ticked) => toggle(provider, ticked)}
              description={
                provider === "PASSWORD"
                  ? "A password on an account in this studio. Always available."
                  : configured
                    ? "Set up on this installation."
                    : "Not set up on this installation, so nobody can use it yet."
              }
            />
          );
        })}
      </div>

      {unusable.length > 0 ? (
        <HelpText tone="warn" className="mt-2">
          {unusable.length === chosen.length
            ? "None of the methods you have ticked is set up on this installation, so nobody could use this address to sign in at all."
            : `${andList(unusable.map((provider) => PROVIDER_LABELS[provider]))} ${unusable.length === 1 ? "is" : "are"} not set up on this installation, so ${unusable.length === 1 ? "it" : "they"} cannot be used yet.`}
        </HelpText>
      ) : null}
    </fieldset>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One entry
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface PatchResponse {
  changed?: boolean;
  message?: string;
}

interface DeleteResponse {
  message?: string;
}

interface AccessPanelProps {
  grant: StudioAccessRow;
  isOwnEntry: boolean;
  currentUserName: string;
  /** How many unrevoked master-admin entries exist. The last one cannot be removed or lowered. */
  masterAdminGrants: number;
  availableMethods: ReadonlySet<AuthProvider>;
  confirm: ReturnType<typeof useConfirm>;
  onChanged: () => void;
  onRemoved: () => void;
  onFailed: (thrown: unknown, title: string) => void;
}

function AccessPanel({
  grant,
  isOwnEntry,
  currentUserName,
  masterAdminGrants,
  availableMethods,
  confirm,
  onChanged,
  onRemoved,
  onFailed
}: AccessPanelProps) {
  const { toast } = useToast();

  const [name, setName] = useState(grant.name ?? "");
  const [role, setRole] = useState<Role>(grant.grantedRole);
  const [note, setNote] = useState(grant.note ?? "");
  const [providers, setProviders] = useState<AuthProvider[]>([...grant.allowedProviders]);
  /** Ticked by the reader beside the revoke and delete controls. See the header, point 3. */
  const [signOutToo, setSignOutToo] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const revoked = grant.revokedAt !== null;

  /**
   * The last entry granting master administrator access.
   *
   * A COUNT, not a permission — every reader of this screen already holds the capability. It is the only
   * thing standing between one click and an installation nobody can ever add anybody to again.
   */
  const isLastMasterAdmin = grant.grantedRole === "MASTER_ADMIN" && !revoked && masterAdminGrants <= 1;

  const dirty =
    name.trim() !== (grant.name ?? "") ||
    role !== grant.grantedRole ||
    note.trim() !== (grant.note ?? "") ||
    !sameProviders(providers, grant.allowedProviders);

  const run = useCallback(
    async (key: string, work: () => Promise<string | null>, success: string, failure: string) => {
      setBusy(key);
      try {
        const description = await work();
        onChanged();
        toast({ tone: "success", title: success, ...(description ? { description } : {}) });
      } catch (thrown) {
        onFailed(thrown, failure);
      } finally {
        setBusy(null);
      }
    },
    [onChanged, onFailed, toast]
  );

  const save = useCallback(async () => {
    await run(
      "save",
      async () => {
        const answer = await patch<PatchResponse>(ACCESS_ENDPOINTS.detail(grant.id), {
          name: name.trim(),
          role,
          note: note.trim(),
          allowedProviders: providers
        });
        return answer.message ?? null;
      },
      "The entry has been saved",
      "The entry has not been saved"
    );
  }, [grant.id, name, note, providers, role, run]);

  const setRevoked = useCallback(
    async (next: boolean) => {
      const alsoSignOut = next && signOutToo;

      const agreed = await confirm({
        title: next
          ? `Revoke access for ${personLabel(grant)}?`
          : `Let ${personLabel(grant)} sign in again?`,
        body: next ? (
          <>
            <p>
              They will be refused the next time they try to sign in, by any method. The entry stays on
              this list marked revoked, so the record of who allowed them in survives.
            </p>
            <p className="mt-2">
              {alsoSignOut
                ? "Every device they are signed in on will also be signed out now, so they are out immediately."
                : "Anything they already have open keeps working until its session expires, which can be days. Cancel and tick the sign-out box if they need to be out now."}
            </p>
          </>
        ) : (
          <p>
            They will be able to sign in again, and their account will be created as{" "}
            {ROLE_LABELS[grant.grantedRole].toLowerCase()} if they have never signed in before.
          </p>
        ),
        confirmLabel: next ? "Revoke access" : "Restore access",
        cancelLabel: "Leave it as it is",
        tone: "danger"
      });
      if (!agreed) return;

      await run(
        "revoke",
        async () => {
          const answer = await patch<PatchResponse>(ACCESS_ENDPOINTS.detail(grant.id), {
            revoked: next,
            ...(alsoSignOut ? { revokeSessions: true } : {})
          });
          // The tick box is a one-off instruction rather than a setting. Left ticked, the next action on
          // this entry would silently sign somebody out again.
          setSignOutToo(false);
          return answer.message ?? null;
        },
        next ? `${personLabel(grant)} can no longer sign in` : `${personLabel(grant)} can sign in again`,
        next ? "The access has not been revoked" : "The access has not been restored"
      );
    },
    [confirm, grant, run, signOutToo]
  );

  const remove = useCallback(async () => {
    const agreed = await confirm({
      title: `Delete ${grant.email} from the access list?`,
      body: (
        <>
          <p>
            This destroys the record: who added them, when, why, and when they last signed in all go with
            it. Revoking keeps all of that and stops them signing in just the same.
          </p>
          <p className="mt-2">
            {grant.used
              ? "Their account and everything they wrote are untouched — switch the account off on the Users screen if they should no longer have one."
              : "Nobody ever signed in with this address, so no account or content is affected."}
          </p>
          <p className="mt-2">
            {signOutToo
              ? "Every device signed in on this address will also be signed out now."
              : "Deleting the entry does not sign anybody out. Cancel and tick the sign-out box first if they need to be out now."}
          </p>
        </>
      ),
      confirmLabel: "Delete the record",
      cancelLabel: "Keep it",
      tone: "danger",
      // ⚠ The address, typed in full. This is the one action on the screen with no undo.
      requireTyping: grant.email
    });
    if (!agreed) return;

    setBusy("delete");
    try {
      const answer = await del<DeleteResponse>(
        `${ACCESS_ENDPOINTS.detail(grant.id)}${buildQuery({ revokeSessions: signOutToo })}`
      );
      toast({
        tone: "success",
        title: `${grant.email} has been removed from the access list`,
        ...(answer?.message ? { description: answer.message } : {})
      });
      onRemoved();
    } catch (thrown) {
      onFailed(thrown, "The record has not been deleted");
    } finally {
      setBusy(null);
    }
  }, [confirm, grant, onFailed, onRemoved, signOutToo, toast]);

  return (
    <div className="space-y-5">
      <FormSection
        title={personLabel(grant)}
        description={grant.name && grant.name.length > 0 ? grant.email : undefined}
        actions={
          revoked ? (
            <Badge tone="neutral" size="sm" icon={CircleSlash}>
              Revoked
            </Badge>
          ) : (
            <Badge tone="success" size="sm" icon={CircleCheck}>
              Can sign in
            </Badge>
          )
        }
        footer={
          <Button onClick={() => void save()} isLoading={busy === "save"} loadingLabel="saving" disabled={!dirty}>
            Save the changes
          </Button>
        }
      >
        {/* ── What is known about this entry ─────────────────────────────────────────────────── */}
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Added</dt>
          <dd className="text-ink-700" title={exact(grant.createdAt)}>
            {relative(grant.createdAt)}
            {grant.addedBy ? ` by ${grant.addedBy.name}` : ", by somebody whose account has since gone"}
          </dd>

          <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Last used</dt>
          <dd className={grant.used ? "text-ink-700" : "text-amber-800"} title={exact(grant.lastSignInAt)}>
            {grant.used ? (
              <>
                {relative(grant.lastSignInAt)}
                {grant.lastProvider ? `, with ${PROVIDER_LABELS[grant.lastProvider]}` : ""}
                {` — ${grant.signInCount === 1 ? "once in total" : `${grant.signInCount} times in total`}`}
              </>
            ) : (
              // ⚠ The most useful sentence on the screen. See the header, point 1. The age is part of it:
              // "never used" means nothing without "and it was added eight months ago".
              <>Never. It was added {relative(grant.createdAt)} and has never been used to sign in.</>
            )}
          </dd>

          {revoked ? (
            <>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Revoked</dt>
              <dd className="text-ink-700" title={exact(grant.revokedAt)}>
                {relative(grant.revokedAt)}
                {grant.revokedBy ? ` by ${grant.revokedBy.name}` : ""}
              </dd>
            </>
          ) : null}

          <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Account</dt>
          <dd className="text-ink-700">
            {grant.hasAccount
              ? `${grant.accountIsActive ? "An active account" : "A switched-off account"} exists for this address${
                  grant.activeSessions > 0
                    ? `, signed in on ${grant.activeSessions === 1 ? "1 device" : `${grant.activeSessions} devices`}`
                    : ", with nothing signed in"
                }.`
              : "No account exists yet. One is created the first time they sign in."}
          </dd>
        </dl>

        {/* ── The editable half ───────────────────────────────────────────────────────────────── */}
        <Field
          label="Their name"
          help="What this list calls them. It does not change the name on their account."
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </Field>

        {isLastMasterAdmin ? (
          // The control is ABSENT and the reason is on screen — not a disabled picker (contract §1.8).
          <div>
            <p className="field-label">What their account will be created as</p>
            <p className="mt-1 text-sm text-ink-900">{ROLE_LABELS[grant.grantedRole]}</p>
            <HelpText tone="warn" className="mt-2">
              This is the only entry on the list granting master administrator access, so its level cannot
              be lowered here. If it were, nobody could add anybody to this list again — including whoever
              had to undo it. Add a second master administrator first.
            </HelpText>
          </div>
        ) : (
          <Field
            label="What their account will be created as"
            help={
              grant.used
                ? `${ROLE_DESCRIPTIONS[role]} They have already signed in, so this no longer affects them — their own account keeps the access it has, and that is changed on the Users screen.`
                : ROLE_DESCRIPTIONS[role]
            }
          >
            <Select
              value={role}
              options={ROLES_DESCENDING.map((candidate) => ({
                value: candidate,
                label: ROLE_LABELS[candidate]
              }))}
              onChange={(event) => {
                const next = event.target.value;
                if (isRole(next)) setRole(next);
              }}
            />
          </Field>
        )}

        <Field
          label="Why they have access"
          help="Whoever reads this list in a year's time will have no other way to know. An entry with no reason is one nobody dares remove."
          maxLength={NOTE_MAX}
          value={note}
        >
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
        </Field>

        <MethodPicker chosen={providers} onChange={setProviders} availableMethods={availableMethods} />

        <HelpText>
          The address itself cannot be changed. Editing it would move this standing grant — and its record
          of who added it and when it was last used — onto a different person. Remove this entry and add
          the new address instead, so the log holds two decisions rather than one edit.
        </HelpText>
      </FormSection>

      {/* ── Revoking, restoring and removing ──────────────────────────────────────────────────── */}
      <FormSection
        tone="danger"
        title="Revoking and removing"
        description="Revoking stops somebody signing in and keeps the record. Deleting destroys the record. They are separate actions because only one of them can be undone."
      >
        {isOwnEntry ? (
          <HelpText tone="warn">
            This is your own address. You cannot revoke or delete it: somebody has to be able to undo a
            mistake on this list, and an account that has just removed its own permission to sign in
            cannot — there is no way back in through the site itself. Ask another master administrator if
            your access should end.
          </HelpText>
        ) : (
          <>
            {/*
              ⚠ THE SENTENCE THAT MAKES THE BUTTON HONEST, and the tick box that makes it optional.
              Revoking is checked at sign-in; a live session is not affected by it.
            */}
            <HelpText tone="warn">
              Revoking takes effect the next time they try to sign in. A browser they are already signed in
              on keeps working until its session expires, which can be days.
            </HelpText>

            {grant.hasAccount ? (
              <Checkbox
                label="Sign them out of every device as well"
                checked={signOutToo}
                onCheckedChange={setSignOutToo}
                description={
                  grant.activeSessions > 0
                    ? `${grant.activeSessions === 1 ? "1 device is" : `${grant.activeSessions} devices are`} signed in on this address right now. Ticking this ends those sessions in the same action, so they are out immediately.`
                    : "Nothing appears to be signed in on this address at the moment. Ticking this ends anything that is, in the same action."
                }
              />
            ) : (
              <p className="text-xs leading-relaxed text-ink-500">
                No account exists for this address, so there is nothing to sign out.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {revoked ? (
                <Button
                  variant="secondary"
                  icon={RotateCcw}
                  isLoading={busy === "revoke"}
                  loadingLabel="restoring"
                  onClick={() => void setRevoked(false)}
                >
                  Restore their access
                </Button>
              ) : isLastMasterAdmin ? null : (
                <Button
                  variant="danger"
                  icon={Ban}
                  isLoading={busy === "revoke"}
                  loadingLabel="revoking"
                  onClick={() => void setRevoked(true)}
                >
                  Revoke their access
                </Button>
              )}

              {isLastMasterAdmin ? null : (
                <Button
                  variant="danger"
                  icon={Trash2}
                  isLoading={busy === "delete"}
                  loadingLabel="deleting"
                  onClick={() => void remove()}
                >
                  Delete the record
                </Button>
              )}
            </div>

            {isLastMasterAdmin ? (
              <HelpText tone="warn" icon={ShieldAlert}>
                This is the only entry on the list granting master administrator access, so it cannot be
                revoked or deleted. If it were, nobody could add anybody to this list again, and the studio
                would be closed to everyone whose address is not already on it. Add a second master
                administrator, let them sign in, and this becomes possible.
              </HelpText>
            ) : null}
          </>
        )}
      </FormSection>

      <p className="text-xs leading-relaxed text-ink-500">
        Every change on this screen is written to the audit log against this address, with your name —{" "}
        {currentUserName} — on it. It is the only record of who opened the door.
      </p>
    </div>
  );
}
