"use client";

/**
 * UserManager — who can sign in to this studio, and what each of them is allowed to change.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY DECISION ON THIS SCREEN IS TAKEN BY A PREDICATE FROM `lib/permissions.ts`, NEVER BY A ROLE
 * COMPARISON WRITTEN HERE. `canAssignRole(actor, target, next)` decides which roles a picker offers;
 * `canManageUser(actor, target)` decides whether deactivating is offered at all. They are the SAME
 * functions the route handlers call, which is the whole point — a second rank test that disagrees with the
 * first is how a "professor may edit anyone below" rule silently stops matching (contract §1.7). Hiding a
 * control here is a courtesy; the handler refusing it is the boundary.
 *
 * THE ROLE PICKER CARRIES `ROLE_DESCRIPTIONS`, SO A CHOICE IS NEVER A GUESS. Six tiers whose names are
 * "Researcher" and "Editor" tell an administrator nothing about which one may publish; the sentence beside
 * each one does.
 *
 * ⚠ WHERE AN ACTION IS UNAVAILABLE, THE REASON IS ON SCREEN. This is the one place the studio deliberately
 * departs from "a failing check renders nothing": an administrator who cannot find the Deactivate control
 * on their own account concludes the CMS is broken and files a bug. So the control is absent and a sentence
 * says why it is absent — which is not a disabled button, and not an ungated one either.
 *
 *   • You cannot deactivate yourself. An administrator who switches off their own account while being the
 *     only one locks everybody out of the CMS with no way back in through the application at all.
 *   • You cannot demote yourself while you are the ONLY active administrator. `canAssignRole` permits
 *     self-demotion on purpose — the ladder is not the thing that stops this — so the guard is a COUNT,
 *     handed down by the server, and the sentence says to promote somebody else first.
 *   • THE SAME AGAIN, SEPARATELY, FOR MASTER ADMINISTRATORS. An installation with administrators but no
 *     master admin still looks perfectly healthy — pages publish, settings save — and has quietly lost the
 *     ability to put anybody new on the studio access list, so no colleague can ever be added again. That is
 *     a slower and worse lockout than the administrator one precisely because nothing appears to be wrong,
 *     which is why the warning says what is lost rather than merely that something is.
 *
 * WHAT THIS SCREEN IS FOR, AND WHAT IT IS NOT FOR. It manages people who already have an account. Whose
 * email address may HAVE one is the studio access list, a master-administrator screen, and the difference is
 * stated at the top rather than left for somebody to discover — an administrator who cannot work out why an
 * invited colleague still cannot sign in is looking at the wrong screen.
 *
 * ⚠ THE LINKED SIGN-IN METHODS ARE SHOWN BECAUSE AN AUDIT NEEDS THEM. "Two-step verification: on" beside a
 * linked Google account that opens the same door without it is a screen that misleads the person checking.
 * So the table and the detail view both name every way into an account — a password, and each provider — and
 * a provider may be unlinked. The one refusal is the important one: the LAST way into an account that has no
 * password cannot be removed, because that account could then never be entered again by anybody at all. The
 * server refuses it and says which rule refused; this screen refuses it first, and says the same thing.
 *
 * ⚠ NOTHING ON THIS SCREEN CAN READ A SECOND-FACTOR SECRET, and there is no request that would return one.
 * An administrator sees WHETHER two-step verification is on, and can switch it off for somebody who has lost
 * their phone — which is an act recorded in the audit log. `twoFactorSecret` is encrypted at rest precisely
 * so that a database read is not an account takeover, and a studio screen that decrypted it would hand back
 * everything that buys.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  CircleCheck,
  CircleSlash,
  KeyRound,
  LogOut,
  Mail,
  SearchX,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  Unlink,
  UserPlus,
  Users
} from "lucide-react";
import type { AuthProvider, Role } from "@prisma/client";

import { apiFetch, asApiClientError, buildQuery, patch, post } from "@/lib/client/fetcher";
import { useDebouncedValue, useResource } from "@/lib/client/useResource";
import {
  ROLES_DESCENDING,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  canAssignRole,
  canManageStudioAccess,
  canManageUser,
  canManageUsers,
  isMasterAdmin,
  type PermissionSubject
} from "@/lib/permissions";
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
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";

/** Every address this screen calls, in one place, so the route handlers have one list to satisfy. */
const USER_ENDPOINTS = {
  list: (query: string) => `/api/studio/users${query}`,
  create: "/api/studio/users",
  detail: (id: string) => `/api/studio/users/${encodeURIComponent(id)}`,
  revokeSessions: (id: string) => `/api/studio/users/${encodeURIComponent(id)}/sessions`,
  passwordReset: (id: string) => `/api/studio/users/${encodeURIComponent(id)}/password-reset`,
  disableTwoFactor: (id: string) => `/api/studio/users/${encodeURIComponent(id)}/two-factor`
} as const;

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 250;

/**
 * Every way into an account, as a person reads it.
 *
 * A TOTAL `Record<AuthProvider, …>`, so adding a provider to the Prisma enum is a compile error here rather
 * than a blank chip on the screen. lib/auth/oauth.ts holds the same names for the sign-in page and cannot be
 * imported: it is `server-only`, and it reads the environment to decide which providers are configured —
 * which is the wrong question here, because an account stays linked to a provider after the credentials for
 * it are removed, and that is exactly when somebody wants to see the link.
 */
const METHOD_LABELS: Record<AuthProvider, string> = {
  PASSWORD: "Password",
  GOOGLE: "Google",
  MICROSOFT: "Microsoft",
  YAHOO: "Yahoo"
};

/** One linked external identity, as the server hands it over. Never a token, never a provider secret. */
export interface LinkedSignIn {
  id: string;
  provider: AuthProvider;
  /** The address the provider asserted at link time. For display only — the account is found by `sub`. */
  email: string;
  /** ISO 8601. */
  createdAt: string;
  lastUsedAt: string;
}

export interface StudioUserRow {
  id: string;
  name: string;
  email: string;
  title: string | null;
  role: Role;
  isActive: boolean;
  /** Per-user grants. They only ever WIDEN a role, never narrow it (lib/permissions.ts). */
  canPublish: boolean;
  canManageMedia: boolean;
  twoFactorEnabled: boolean;
  /**
   * How many single-use recovery codes are left. A COUNT, never the codes: they are stored as bcrypt
   * hashes and were shown to their owner exactly once.
   */
  recoveryCodesLeft: number;
  /** ISO 8601, or null for somebody who has never signed in. */
  lastLoginAt: string | null;
  failedLogins: number;
  /** Set by the sign-in throttle. Read-only here. */
  lockedUntil: string | null;
  /** How many live sessions the account has — how many devices are signed in. */
  activeSessions: number;
  createdAt: string;

  /**
   * Whether a password is set — never the password, and never its hash.
   *
   * ⚠ OPTIONAL, AND `undefined` MEANS "THIS ANSWER DID NOT SAY", which is not the same as `false`. The detail
   * endpoint always supplies it; a list answer may not. So every reader goes through `signInMethods()`, which
   * returns null for "not known" rather than quietly reporting an account with no way in.
   */
  hasPassword?: boolean;
  /** The linked providers, on the same terms as `hasPassword`. */
  oauthAccounts?: LinkedSignIn[];
}

export interface UserListResponse {
  items: StudioUserRow[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * The two lockout counts, when the answer carries them.
   *
   * Optional because they are a courtesy: the guard that matters is taken inside the writing transaction on
   * the server (`app/api/studio/users/[id]/route.ts`). When a count is absent this screen does not guess —
   * it simply does not show the warning, and the server still refuses.
   */
  activeAdministrators?: number;
  activeMasterAdmins?: number;
}

/** What `GET /api/studio/users/{id}` answers. The authoritative view of one account's sign-in methods. */
interface UserDetailResponse {
  user: StudioUserRow;
  activeAdministrators: number;
  activeMasterAdmins: number;
}

/**
 * Every way into this account, in reading order — or null when the answer did not say.
 *
 * NULL AND `[]` MEAN DIFFERENT THINGS and the screen renders them differently: null is "not known here", `[]`
 * is "this account cannot be signed into at all", which is the true and useful state of somebody who was
 * invited and never set a password. Collapsing the two would print that alarming sentence over an account
 * that is perfectly fine.
 */
function signInMethods(row: Pick<StudioUserRow, "hasPassword" | "oauthAccounts">): string[] | null {
  if (row.hasPassword === undefined || row.oauthAccounts === undefined) return null;
  return [
    ...(row.hasPassword ? [METHOD_LABELS.PASSWORD] : []),
    ...row.oauthAccounts.map((account) => METHOD_LABELS[account.provider])
  ];
}

/**
 * The badge tone for a level of access, FROM THE PREDICATES.
 *
 * The subject is notional — only the role is read — which is the same device `InviteForm` uses to ask which
 * roles may be handed out. Writing `role === "MASTER_ADMIN"` here instead would be the second rank test
 * lib/permissions.ts exists to prevent, and it would stop matching the day a tier is added between them.
 */
function roleTone(role: Role): "brand" | "info" | "neutral" {
  const notional: PermissionSubject = { id: "role", role };
  if (isMasterAdmin(notional)) return "brand";
  if (canManageUsers(notional)) return "info";
  return "neutral";
}

interface UserFilters {
  q: string;
  role: Role | "";
  status: "active" | "inactive" | "";
  page: number;
}

const DEFAULT_FILTERS: UserFilters = { q: "", role: "", status: "", page: 1 };

function isRole(value: string): value is Role {
  return (ROLES_DESCENDING as readonly string[]).includes(value);
}

/**
 * Read the filters out of the address bar, in the BROWSER.
 *
 * Every export of a `"use client"` module is a client reference, so a Server Component cannot call this —
 * and duplicating it there would mean two parsers and two page-size constants drifting apart
 * (MediaGrid.tsx's header sets out the trap).
 */
function readFilters(params: { get: (name: string) => string | null }): UserFilters {
  const role = params.get("role") ?? "";
  const status = params.get("status") ?? "";
  const page = Number.parseInt(params.get("page") ?? "", 10);
  return {
    q: params.get("q") ?? "",
    role: isRole(role) ? role : "",
    status: status === "active" || status === "inactive" ? status : "",
    page: Number.isFinite(page) && page > 0 ? page : 1
  };
}

/** "3 days ago", or a plain statement for somebody who has never signed in. */
function relative(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return formatDistanceToNow(date, { addSuffix: true });
}

/** The exact instant in a NAMED zone, for a tooltip that has to settle an argument. */
function exact(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

export interface UserManagerProps {
  /** The signed-in administrator, as the predicates want them. Read from the row on the server. */
  currentUser: PermissionSubject & { id: string; name: string; role: Role };
  /**
   * How many ACTIVE administrators there are, as the Server Component last counted them.
   *
   * The guard against the last one demoting or locking themselves out is a count, not a permission —
   * `canAssignRole` deliberately permits self-demotion. See the header.
   *
   * ⚠ THE FIRST-PAINT VALUE, NOT THE AUTHORITY. The list answer carries the same count and is re-read after
   * every change, so it is preferred; this is what the screen has to go on until the first answer arrives.
   */
  activeAdministrators: number;
  /**
   * How many ACTIVE master administrators there are, when the server has said.
   *
   * ⚠ OPTIONAL ON PURPOSE, AND AN ABSENT COUNT DISARMS THE GUARD ENTIRELY. When neither source supplies it
   * the screen shows no master-administrator warning and offers no client-side refusal — the count inside
   * the writing transaction on the server is the guard either way, and a made-up number here would be worse
   * than none.
   *
   * ⚠ IT STAYED ABSENT FOR A LONG TIME AND NOBODY COULD SEE IT: `GET /api/studio/users` does not return
   * `activeMasterAdmins`, and the page did not count it either, so both sources were empty and the whole
   * master-administrator half of this screen was quietly dead. `app/studio/users/page.tsx` now counts it.
   * The list answer is still preferred the moment the route starts sending one — which it should, because
   * only the answer is re-read after a role change.
   */
  activeMasterAdmins?: number;
  /** True when a mail transport is configured, so an invitation can actually be delivered. */
  canSendEmail: boolean;
}

export function UserManager({
  currentUser,
  activeAdministrators,
  activeMasterAdmins,
  canSendEmail
}: UserManagerProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [filters, setFilters] = useState<UserFilters>(() => readFilters(searchParams));
  const [activeId, setActiveId] = useState<string | null>(() => searchParams.get("user"));
  /** A one-off link the server hands back when it cannot send mail. Shown once, then cleared. */
  const [handoverLink, setHandoverLink] = useState<{ label: string; url: string } | null>(null);

  const query = buildQuery({
    q: filters.q.trim(),
    role: filters.role,
    status: filters.status,
    page: filters.page > 1 ? filters.page : undefined,
    pageSize: PAGE_SIZE
  });
  const debouncedPath = useDebouncedValue(USER_ENDPOINTS.list(query), DEBOUNCE_MS);
  const list = useResource<UserListResponse>(debouncedPath);

  const rows = list.data?.items ?? null;
  const total = list.data?.total ?? 0;

  /**
   * The live count, preferring the list answer because it is re-read after every change.
   *
   * `null` is "nobody has told this screen", and every use of it below is written to do nothing at all in
   * that case rather than to assume a number. See the prop's own note.
   */
  const masterAdmins = list.data?.activeMasterAdmins ?? activeMasterAdmins ?? null;
  /**
   * The same for administrators — and this one is never null, because the Server Component always counts
   * them for the first paint.
   *
   * ⚠ THE LIST ANSWER IS PREFERRED BECAUSE IT IS RE-READ AFTER EVERY CHANGE, and reading only the prop was
   * a real fault rather than a nicety: the number was frozen at whatever it had been when the page was
   * first rendered. Promote a colleague to administrator and the "there is only one active administrator"
   * warning stayed on screen underneath the proof that there were now two, and your own role picker went on
   * refusing to lower your access, until somebody thought to reload the whole page.
   */
  const administrators = list.data?.activeAdministrators ?? activeAdministrators;
  /** Only a master administrator may open the access list, so only they are offered the link (§1.8). */
  const mayManageAccess = canManageStudioAccess(currentUser);

  const mirror = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q.trim().length > 0) params.set("q", filters.q.trim());
    if (filters.role.length > 0) params.set("role", filters.role);
    if (filters.status.length > 0) params.set("status", filters.status);
    if (filters.page > 1) params.set("page", String(filters.page));
    if (activeId !== null) params.set("user", activeId);
    const search = params.toString();
    return search.length > 0 ? `?${search}` : "";
  }, [filters, activeId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = `${pathname}${mirror}`;
    if (`${window.location.pathname}${window.location.search}` === next) return;
    // `replaceState`, not `router.replace`: a router navigation on every keystroke would re-run the server
    // component for data this screen is already fetching.
    window.history.replaceState(null, "", next);
  }, [pathname, mirror]);

  const narrow = useCallback((partial: Partial<UserFilters>) => {
    setFilters((current) => ({ ...current, ...partial, page: 1 }));
  }, []);

  const selected = useMemo(
    () => (rows ?? []).find((row) => row.id === activeId) ?? null,
    [rows, activeId]
  );

  const report = useCallback(
    (thrown: unknown, title: string) => {
      // The server's `message` is already a plain sentence ready to render (lib/api.ts guarantees it).
      toast({ tone: "error", title, description: asApiClientError(thrown).message });
    },
    [toast]
  );

  const narrowed = filters.q.trim().length > 0 || filters.role.length > 0 || filters.status.length > 0;

  return (
    <div className="space-y-5">
      {/*
        WHAT THIS SCREEN DECIDES, AND WHAT IT DOES NOT. Two lists, two questions, and confusing them is how
        somebody concludes an invitation is broken. The link is offered only to a reader who may follow it —
        an ungated link landing on a refusal is what contract §1.8 forbids — and the sentence itself is shown
        to every administrator, because knowing the other list exists is what stops the wrong search.
      */}
      <p className="prose-measure text-sm leading-relaxed text-ink-500">
        This screen manages people who already have an account and what each of them may change.{" "}
        {mayManageAccess ? (
          <>
            Who may <em>have</em> an account is the{" "}
            <Link
              href="/studio/access"
              className="font-medium text-purple-700 underline underline-offset-4 transition hover:text-purple-800"
            >
              studio access list
            </Link>
            : an email address that is not on it cannot sign in by any method, however it was invited.
          </>
        ) : (
          <>
            Who may <em>have</em> an account is a separate list that only a master administrator can change.
            An email address that is not on it cannot sign in by any method, however it was invited — so if
            somebody you invited still cannot get in, that is the list to ask about.
          </>
        )}
      </p>

      {handoverLink !== null ? (
        <div className="rounded-md border border-purple-200 bg-purple-50 px-3.5 py-3">
          <p className="text-sm font-semibold text-purple-700">{handoverLink.label}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-700">
            This installation cannot send email, so the link has to be passed on by hand. Send it to the
            person by a means you trust — it lets whoever holds it set a password on that account. It is
            shown here once and is not recorded anywhere you can read it again.
          </p>
          {/*
            A read-only text box rather than a copy button: it can be selected with the keyboard, works
            with a screen reader, and is not a control that silently does nothing when the clipboard
            permission is refused.
          */}
          <Input
            readOnly
            value={handoverLink.url}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-2 font-mono text-xs"
          />
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setHandoverLink(null)}
          >
            I have sent it — hide this
          </Button>
        </div>
      ) : null}

      <InviteForm
        currentUser={currentUser}
        canSendEmail={canSendEmail}
        onInvited={async (result) => {
          if (result.link) {
            setHandoverLink({ label: `Invitation link for ${result.email}`, url: result.link });
          }

          /**
           * ⚠ THE LIST IS NARROWED TO THE PERSON JUST INVITED, NOT MERELY RE-READ. THIS WAS THE BUG.
           *
           * Refreshing on its own is not enough, because the answer is ONE PAGE OF 25 ORDERED BY NAME
           * (`app/api/studio/users/route.ts` — `orderBy: [{ name }, { email }]`, `skip`/`take`), narrowed by
           * whatever is in the search box and the two pickers. An invitation sent while any of that was in
           * force writes a row the current answer cannot contain: invite Zoe from page 1 of a 40-account
           * Centre, or from a search for the address you have just discovered nobody holds, and the account
           * is created, the audit entry is written, the link comes back — and the administrator who created
           * it is looking at a table that does not have them in it.
           *
           * It got worse from there. `setActiveId` then pointed at a row that is not in `rows`, so
           * `selected` fell back to null and the panel on the right said "Nobody is selected" as well. Every
           * signal the screen had agreed that nothing had happened.
           *
           * Filtering to the address makes the new row the only row, on page 1, whatever the roster's size
           * and whatever was being looked at a moment ago. The "Some filters are set" line and the "Clear
           * all filters" button are already rendered directly above the table, so the way back to everybody
           * is on screen and needs no explaining.
           */
          setFilters({ ...DEFAULT_FILTERS, q: result.email });
          setActiveId(result.id);

          /**
           * BOTH REFRESHES, AND NEITHER IS REDUNDANT.
           *
           * `list.refresh()` covers the case where the line above did NOT change the path — an
           * administrator who searched for a colleague, found nobody and invited them from that same search
           * leaves `q` exactly as it was, and `useResource` re-fetches on a CHANGE of path. Without this the
           * screen would sit on the answer that predates the account it has just created, which is the very
           * failure this whole block is here to end.
           *
           * `router.refresh()` re-runs the Server Component, which owns three numbers this component cannot
           * recompute: the "N accounts" figure in the page header, and both lockout counts. All three were
           * read once at first paint, so without this the header went on contradicting the table and an
           * installation went on being told it had one administrator after its second was invited.
           */
          await list.refresh();
          router.refresh();
        }}
        onFailed={(thrown) => report(thrown, "Nobody has been invited")}
      />

      {/* ── Filters ───────────────────────────────────────────────────────────────────────── */}
      <section aria-label="Filters" className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <SearchInput
            label="Search people by name or email address"
            placeholder="Search people"
            value={filters.q}
            onValueChange={(value) => narrow({ q: value })}
            className="sm:min-w-[16rem] sm:flex-1"
          />

          {/* `Field` (a real `<label>`) is right for both: each control is a NATIVE `<select>`. */}
          <Field label="What they can do" className="sm:w-52">
            <Select
              value={filters.role}
              placeholder="Any level of access"
              options={ROLES_DESCENDING.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
              onChange={(event) => narrow({ role: (event.target.value as Role | "") || "" })}
            />
          </Field>

          <Field label="Account" className="sm:w-44">
            <Select
              value={filters.status}
              placeholder="Active and switched off"
              options={[
                { value: "active", label: "Active" },
                { value: "inactive", label: "Switched off" }
              ]}
              onChange={(event) => {
                const next = event.target.value;
                narrow({ status: next === "active" || next === "inactive" ? next : "" });
              }}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-xs text-ink-500">
            {narrowed
              ? "Some filters are set, so this is not everybody."
              : "No filters are set, so everybody is listed."}
          </p>
          {narrowed ? (
            <Button size="sm" variant="ghost" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
              Clear all filters
            </Button>
          ) : null}
        </div>
      </section>

      {administrators <= 1 ? (
        <HelpText tone="warn">
          There is only one active administrator on this installation. If that account is lost — a forgotten
          password with no way to send email, a device with the second factor on it — nobody can manage
          users, settings, navigation or the recycle bin, and there is no way back in through the site
          itself. Make a second administrator.
        </HelpText>
      ) : null}

      {/*
        The twin warning, and it names what is lost. Nothing on the site would appear broken with one master
        administrator or none, which is precisely why this needs saying out loud.
      */}
      {masterAdmins !== null && masterAdmins <= 1 ? (
        <HelpText tone="warn">
          There is only one master administrator on this installation. If that account is lost, everything on
          the site goes on working — pages publish, settings save — but nobody can ever add another colleague
          to the studio access list again, and no account can be raised to master administrator from inside
          the studio. Make a second one.
        </HelpText>
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

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="min-w-0 space-y-4">
          {rows === null ? (
            <div className="space-y-2 rounded-md border border-line-200 bg-card p-4">
              <span role="status" className="sr-only">
                Loading the list of people…
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
                title="Nobody matches these filters"
                description="Nothing fits all of what you have asked for. Clear the filters to see everybody again."
                action={
                  <Button variant="secondary" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
                    Clear the filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Users}
                headingLevel={2}
                title="Nobody else can sign in yet"
                description="Invite the people who will look after the site. Give each of them the least access that lets them do their work — it can always be raised."
              />
            )
          ) : (
            <div className="overflow-x-auto rounded-md border border-line-200 bg-card">
              <table aria-label="People who can sign in" className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th scope="col" className={HEAD}>
                      Person
                    </th>
                    <th scope="col" className={cn(HEAD, "hidden md:table-cell")}>
                      What they can do
                    </th>
                    <th scope="col" className={cn(HEAD, "hidden lg:table-cell")}>
                      Last signed in
                    </th>
                    <th scope="col" className={HEAD}>
                      Account
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
                          {row.name}
                          {row.id === currentUser.id ? (
                            <span className="ml-1.5 text-xs font-normal text-ink-500">(you)</span>
                          ) : null}
                        </button>
                        <span className="mt-0.5 block truncate text-xs text-ink-500">{row.email}</span>
                      </td>

                      <td className="hidden px-3 py-2.5 align-middle md:table-cell">
                        <Badge tone={roleTone(row.role)} size="sm">
                          {ROLE_LABELS[row.role]}
                        </Badge>
                        {row.canPublish || row.canManageMedia ? (
                          <span className="mt-1 block text-[0.6875rem] text-ink-500">
                            plus {[row.canPublish ? "publishing" : null, row.canManageMedia ? "media" : null]
                              .filter((entry): entry is string => entry !== null)
                              .join(" and ")}
                          </span>
                        ) : null}
                      </td>

                      <td className="hidden px-3 py-2.5 align-middle text-ink-700 lg:table-cell">
                        <span title={exact(row.lastLoginAt)}>{relative(row.lastLoginAt)}</span>
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        {/* Icon AND word, never colour alone (contract §11). */}
                        <span className="flex flex-col gap-1">
                          {row.isActive ? (
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-600">
                              <CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-500">
                              <CircleSlash aria-hidden="true" className="h-3.5 w-3.5" />
                              Switched off
                            </span>
                          )}
                          {row.twoFactorEnabled ? (
                            <span className="inline-flex items-center gap-1.5 text-[0.6875rem] text-success-600">
                              <ShieldCheck aria-hidden="true" className="h-3 w-3" />
                              Two-step on
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-[0.6875rem] text-amber-800">
                              <ShieldOff aria-hidden="true" className="h-3 w-3" />
                              Two-step off
                            </span>
                          )}
                          {/*
                            HOW THIS ACCOUNT IS ENTERED. Rendered only when the answer said — an absent line
                            means "not stated here", and the detail view on the right always names them.
                          */}
                          <SignInSummary row={row} />
                        </span>
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
            itemNoun={{ singular: "person", plural: "people" }}
            label="People"
            onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
          />
        </div>

        <aside className="min-w-0">
          <div className="xl:sticky xl:top-4">
            {selected === null ? (
              <FormSection
                title="One person at a time"
                description="Choose a name on the left to change what they can do, switch their account off, or help them back in."
              >
                <p className="text-sm text-ink-500">Nobody is selected.</p>
              </FormSection>
            ) : (
              <UserPanel
                key={selected.id}
                user={selected}
                currentUser={currentUser}
                activeAdministrators={administrators}
                activeMasterAdmins={masterAdmins}
                canSendEmail={canSendEmail}
                onClose={() => setActiveId(null)}
                // Both halves again, for the reason set out beside the invitation: a role change or a
                // switched-off account moves an account in or out of a lockout count, and that count is
                // rendered by the Server Component.
                onChanged={() => {
                  void list.refresh();
                  router.refresh();
                }}
                onHandoverLink={setHandoverLink}
                onFailed={report}
                confirm={confirm}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

const HEAD =
  "border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500";

/**
 * "Password, Google" — the ways into one account, on one line in the table.
 *
 * IN THE ACCOUNT COLUMN RATHER THAN A COLUMN OF ITS OWN. A column would be empty for every row whenever the
 * list answer does not carry the methods, and an empty column reads as data that failed to load; a line that
 * is simply absent does not make that claim. It sits beside the two-step line because the two answer one
 * question together — how hard is this account to get into.
 *
 * An account with NO method is called out rather than left blank: it is a real state (invited, never claimed)
 * and the words say which, because "nothing here" is indistinguishable from a bug.
 */
function SignInSummary({ row }: { row: StudioUserRow }) {
  const methods = signInMethods(row);
  if (methods === null) return null;

  if (methods.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[0.6875rem] text-amber-800">
        <TriangleAlert aria-hidden="true" className="h-3 w-3" />
        No way to sign in yet
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-[0.6875rem] text-ink-500">
      <KeyRound aria-hidden="true" className="h-3 w-3" />
      {methods.join(", ")}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Inviting
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface InviteResult {
  id: string;
  email: string;
  /** Present only when the server could not send an email. See the note beside it on screen. */
  link?: string;
}

/** What the create endpoint answers. `email` is optional because the form already knows it. */
interface InviteResponse {
  id: string;
  email?: string;
  link?: string;
}

function InviteForm({
  currentUser,
  canSendEmail,
  onInvited,
  onFailed
}: {
  currentUser: PermissionSubject & { id: string; role: Role };
  canSendEmail: boolean;
  onInvited: (result: InviteResult) => Promise<void>;
  onFailed: (thrown: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("VIEWER");
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false);

  /**
   * The roles this administrator may hand out, from the predicate itself.
   *
   * The target is a NOTIONAL new account at the lowest tier, which is what an invitation creates. Writing
   * the list by hand would be the second rank test lib/permissions.ts exists to prevent.
   */
  const offerable = ROLES_DESCENDING.filter((candidate) =>
    canAssignRole(currentUser, { id: "new", role: "VIEWER" }, candidate)
  );

  const submit = useCallback(async () => {
    setSending(true);
    try {
      const typedEmail = email.trim();
      const created = await post<InviteResponse>(USER_ENDPOINTS.create, {
        name: name.trim(),
        email: typedEmail,
        role
      });
      setName("");
      setEmail("");
      setRole("VIEWER");
      setOpen(false);
      // The address the form typed is the fallback: the response is only asked for the id and the link.
      await onInvited({ id: created.id, email: created.email ?? typedEmail, ...(created.link ? { link: created.link } : {}) });
    } catch (thrown) {
      onFailed(thrown);
    } finally {
      setSending(false);
    }
  }, [email, name, onFailed, onInvited, role]);

  if (!open) {
    return (
      <div>
        <Button variant="secondary" icon={UserPlus} onClick={() => setOpen(true)}>
          Invite somebody
        </Button>
      </div>
    );
  }

  return (
    <FormSection
      title="Invite somebody"
      description="They receive a link that lets them set their own password. Nobody here ever types somebody else's password."
      actions={
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      }
      footer={
        <Button
          onClick={() => void submit()}
          isLoading={sending}
          loadingLabel="inviting"
          disabled={name.trim().length === 0 || email.trim().length === 0}
        >
          Send the invitation
        </Button>
      }
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Their name" required help="As they would write it themselves.">
          <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </Field>

        <Field
          label="Their email address"
          required
          help="This is what they sign in with, so it has to be an address they actually read."
        >
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </div>

      {/*
        `Field` (a real `<label>`) is correct here: the control is a NATIVE `<select>`, so there is no
        button inside for a stray click to be forwarded to (Field.tsx).
      */}
      <Field label="What they can do" help={ROLE_DESCRIPTIONS[role]}>
        <Select
          value={role}
          options={offerable.map((candidate) => ({
            value: candidate,
            label: ROLE_LABELS[candidate]
          }))}
          onChange={(event) => {
            const next = event.target.value;
            if (isRole(next)) setRole(next);
          }}
        />
      </Field>

      <HelpText>
        Give the least access that lets them do their work. It can be raised in a moment, and a tier
        somebody does not need is a tier they can make a mistake at.
      </HelpText>

      {!canSendEmail ? (
        <HelpText tone="warn">
          This installation cannot send email, so no invitation will be delivered. A one-off link will be
          shown here instead, once, for you to pass on by a means you trust.
        </HelpText>
      ) : null}
    </FormSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One person
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface UserPanelProps {
  user: StudioUserRow;
  currentUser: PermissionSubject & { id: string; name: string; role: Role };
  activeAdministrators: number;
  /** `null` when no answer has carried the count. Nothing is assumed from it — see `UserManagerProps`. */
  activeMasterAdmins: number | null;
  canSendEmail: boolean;
  onClose: () => void;
  onChanged: () => void;
  onHandoverLink: (link: { label: string; url: string }) => void;
  onFailed: (thrown: unknown, title: string) => void;
  confirm: ReturnType<typeof useConfirm>;
}

/** REMOUNTED PER PERSON by a `key` on the caller, so one account's draft can never be saved onto another. */
function UserPanel({
  user,
  currentUser,
  activeAdministrators,
  activeMasterAdmins,
  canSendEmail,
  onClose,
  onChanged,
  onHandoverLink,
  onFailed,
  confirm
}: UserPanelProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * THE AUTHORITATIVE VIEW OF ONE ACCOUNT'S SIGN-IN METHODS.
   *
   * Fetched rather than taken from the table row, because the list answer is not required to carry them and a
   * detail panel that showed "no linked accounts" when it simply had not asked would be the most misleading
   * thing on the screen. The row is used until the answer arrives, so nothing flickers, and the fetch is
   * per-selection — the panel is remounted by a `key` on the caller.
   */
  const detail = useResource<UserDetailResponse>(USER_ENDPOINTS.detail(user.id));
  /**
   * Lifted out because it is the only part of `detail` a callback needs.
   *
   * `useResource` returns a fresh object every render while `refresh` itself is memoised on the path, so
   * depending on the object would rebuild the callback on every render for no reason — and the exhaustive-deps
   * rule cannot see that `detail.refresh` alone is stable.
   */
  const refreshDetail = detail.refresh;
  const account = detail.data?.user ?? user;
  const methods = signInMethods(account);
  const linkedAccounts = account.oauthAccounts ?? [];

  const isSelf = user.id === currentUser.id;
  /** The whole guard against locking everybody out, in one boolean. See the file header. */
  const isLastAdministrator = isSelf && user.role === "ADMINISTRATOR" && activeAdministrators <= 1;
  /**
   * The same for the tier above, and SEPARATELY — a master administrator does not hold the role
   * `ADMINISTRATOR`, so the count above never saw them. `activeMasterAdmins === null` means nobody has told
   * this screen the number, and in that case it claims nothing and leaves the refusal to the server.
   */
  const isLastMasterAdmin =
    isSelf &&
    user.role === "MASTER_ADMIN" &&
    activeMasterAdmins !== null &&
    activeMasterAdmins <= 1;
  /** Either lockout. Both are "you are the only one left at your own level", and both refuse the same way. */
  const isLastOfOwnTier = isLastAdministrator || isLastMasterAdmin;

  const offerableRoles = ROLES_DESCENDING.filter((candidate) =>
    canAssignRole(currentUser, { id: user.id, role: user.role }, candidate)
  );
  const mayManage = canManageUser(currentUser, { id: user.id, role: user.role });

  const run = useCallback(
    async (key: string, work: () => Promise<void>, success: string, failure: string) => {
      setBusy(key);
      try {
        await work();
        onChanged();
        toast({ tone: "success", title: success });
      } catch (thrown) {
        onFailed(thrown, failure);
      } finally {
        setBusy(null);
      }
    },
    [onChanged, onFailed, toast]
  );

  const changeRole = useCallback(
    async (next: Role) => {
      if (next === user.role) return;
      if (isLastOfOwnTier && next !== user.role) {
        // Refused here as well as on the server. The reason is already on screen beside the picker; this is
        // the belt to those braces. The two sentences differ because the two losses differ: one shuts
        // everybody out of the studio's controls, the other quietly ends the ability to admit anybody.
        toast({
          tone: "warn",
          title: "Your own access has not been changed",
          description: isLastMasterAdmin
            ? "You are the only master administrator. Make somebody else one first — otherwise nobody could ever add another colleague to the studio access list."
            : "You are the only administrator. Make somebody else one first, then lower your own access."
        });
        return;
      }

      const agreed = await confirm({
        title: isSelf
          ? `Lower your own access to ${ROLE_LABELS[next].toLowerCase()}?`
          : `Change ${user.name} to ${ROLE_LABELS[next].toLowerCase()}?`,
        body: (
          <>
            <p>{ROLE_DESCRIPTIONS[next]}</p>
            <p className="mt-2">
              It takes effect immediately, on their next action — not the next time they sign in.
              {isSelf ? " You may lose access to parts of this studio straight away." : ""}
            </p>
          </>
        ),
        confirmLabel: `Set to ${ROLE_LABELS[next].toLowerCase()}`,
        cancelLabel: "Leave it as it is",
        tone: "danger"
      });
      if (!agreed) return;

      await run(
        "role",
        async () => {
          await patch(USER_ENDPOINTS.detail(user.id), { role: next });
        },
        `${isSelf ? "Your access" : `${user.name}'s access`} is now ${ROLE_LABELS[next].toLowerCase()}`,
        "The access level has not been changed"
      );
    },
    [confirm, isLastMasterAdmin, isLastOfOwnTier, isSelf, run, toast, user.id, user.name, user.role]
  );

  const setActive = useCallback(
    async (active: boolean) => {
      const agreed = await confirm({
        title: active ? `Switch ${user.name}'s account back on?` : `Switch off ${user.name}'s account?`,
        body: active ? (
          <p>They will be able to sign in again, with the access level they had before.</p>
        ) : (
          <>
            <p>
              They will not be able to sign in, and every device they are signed in on is signed out at
              once — the account is re-checked on every action, not only at sign-in.
            </p>
            <p className="mt-2">
              Nothing they have written is affected. Switching the account back on later restores their
              access exactly as it was.
            </p>
          </>
        ),
        confirmLabel: active ? "Switch it back on" : "Switch it off",
        cancelLabel: "Leave it alone",
        tone: "danger"
      });
      if (!agreed) return;

      await run(
        "active",
        async () => {
          await patch(USER_ENDPOINTS.detail(user.id), { isActive: active });
        },
        active ? `${user.name} can sign in again` : `${user.name}'s account is switched off`,
        "The account has not been changed"
      );
    },
    [confirm, run, user.id, user.name]
  );

  const signOutEverywhere = useCallback(async () => {
    const agreed = await confirm({
      title: `Sign ${isSelf ? "yourself" : user.name} out of every device?`,
      body: (
        <>
          <p>
            Every session is ended, on every computer and phone. {isSelf ? "You" : "They"} will have to sign
            in again with {isSelf ? "your" : "their"} password.
          </p>
          <p className="mt-2">
            This is what to do when a laptop is lost or a session may have been taken over.
            {user.activeSessions > 0
              ? ` There ${user.activeSessions === 1 ? "is 1 device" : `are ${user.activeSessions} devices`} signed in now.`
              : " No devices appear to be signed in at the moment."}
          </p>
        </>
      ),
      confirmLabel: "Sign out everywhere",
      cancelLabel: "Leave the sessions alone",
      tone: "danger"
    });
    if (!agreed) return;

    await run(
      "sessions",
      async () => {
        await apiFetch<void>(USER_ENDPOINTS.revokeSessions(user.id), { method: "DELETE" });
      },
      `${isSelf ? "You have" : `${user.name} has`} been signed out everywhere`,
      "The sessions have not been ended"
    );
  }, [confirm, isSelf, run, user.activeSessions, user.id, user.name]);

  const resetPassword = useCallback(async () => {
    const agreed = await confirm({
      title: `Send ${user.name} a way to set a new password?`,
      body: (
        <>
          <p>
            {canSendEmail
              ? `A link is emailed to ${user.email}. Their current password keeps working until they use it.`
              : `This installation cannot send email, so a one-off link is shown to you once, here, to pass on by a means you trust. Their current password keeps working until it is used.`}
          </p>
          <p className="mt-2">
            Nobody in this studio can see or set somebody else&rsquo;s password. This is the only way to
            help them back in.
          </p>
        </>
      ),
      confirmLabel: canSendEmail ? "Send the link" : "Make a link",
      cancelLabel: "Not now",
      tone: "default"
    });
    if (!agreed) return;

    await run(
      "password",
      async () => {
        const result = await post<{ link?: string; emailed?: boolean }>(
          USER_ENDPOINTS.passwordReset(user.id)
        );
        if (result.link) {
          onHandoverLink({ label: `Password link for ${user.email}`, url: result.link });
        }
      },
      canSendEmail ? `A link has been sent to ${user.email}` : "A one-off link has been made",
      "No link has been made"
    );
  }, [canSendEmail, confirm, onHandoverLink, run, user.email, user.id, user.name]);

  const disableTwoFactor = useCallback(async () => {
    const agreed = await confirm({
      title: `Switch off two-step verification for ${user.name}?`,
      body: (
        <>
          <p>
            Their account will need only a password again, until they set two-step verification up on a new
            device. Any recovery codes they still hold stop working.
          </p>
          <p className="mt-2">
            Do this when somebody has genuinely lost the device with their codes on it — and satisfy
            yourself that the person asking is really them, because this removes the control that exists to
            stop somebody else getting in. It is recorded in the audit log with your name on it.
          </p>
        </>
      ),
      confirmLabel: "Switch it off",
      cancelLabel: "Leave it on",
      tone: "danger",
      // The name typed in full: this weakens somebody else's account, and there is no undo beyond asking
      // them to enrol again.
      requireTyping: user.name
    });
    if (!agreed) return;

    await run(
      "two-factor",
      async () => {
        await apiFetch<void>(USER_ENDPOINTS.disableTwoFactor(user.id), { method: "DELETE" });
      },
      `Two-step verification is off for ${user.name}`,
      "Two-step verification has not been changed"
    );
  }, [confirm, run, user.id, user.name]);

  /**
   * Is this the LAST way into the account?
   *
   * Only ever true when the answer is KNOWN. `hasPassword === undefined` means the sign-in methods have not
   * arrived, and the controls that depend on this are not rendered until they have — so "unknown" never
   * becomes either "safe to remove" or an unexplained refusal.
   */
  const isOnlyWayIn = account.hasPassword === false && linkedAccounts.length <= 1;

  const unlinkProvider = useCallback(
    async (linked: LinkedSignIn) => {
      const label = METHOD_LABELS[linked.provider];

      if (account.hasPassword === false && linkedAccounts.length <= 1) {
        /**
         * ⚠ THE RULE THAT REFUSES, AND IT NAMES ITSELF. The server refuses this too, with the same reason —
         * this copy exists so the answer is immediate and so the sentence appears where the button was
         * pressed. Removing the only door to an account with no password leaves a row that exists, is active
         * and holds a level of access, and that nobody at any level could ever sign in to again.
         */
        toast({
          tone: "warn",
          title: "Nothing has been unlinked",
          description: `${label} is the only way into ${user.name}'s account, because it has no password set. Issue a password link first, under “Help them back in”, and the ${label} link can be removed once it has been used.`
        });
        return;
      }

      const agreed = await confirm({
        title: `Remove the ${label} sign-in from ${user.name}'s account?`,
        body: (
          <>
            <p>
              {label} will no longer open this account. Everything else about it is unchanged, and anybody
              already signed in on it stays signed in until their session ends.
            </p>
            <p className="mt-2">
              They can link {label} again themselves by signing in with it — provided their email address is
              still on the studio access list for that method.
            </p>
          </>
        ),
        confirmLabel: `Remove the ${label} sign-in`,
        cancelLabel: "Leave it linked",
        tone: "danger"
      });
      if (!agreed) return;

      await run(
        `unlink-${linked.provider}`,
        async () => {
          await post(USER_ENDPOINTS.detail(user.id), {
            action: "unlink-provider",
            provider: linked.provider
          });
          // The panel's own answer is what shows the methods, so it is re-read as well as the list.
          await refreshDetail();
        },
        `${label} can no longer be used to sign in to ${user.name}'s account`,
        "Nothing has been unlinked"
      );
    },
    [account.hasPassword, confirm, linkedAccounts.length, refreshDetail, run, toast, user.id, user.name]
  );

  return (
    <div className="space-y-6">
      <FormSection
        title={user.name}
        description={user.title ?? user.email}
        actions={
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        }
      >
        <dl className="space-y-1.5 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-500">Email</dt>
            <dd className="break-all text-ink-900">{user.email}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-500">Last signed in</dt>
            <dd className="text-ink-900" title={exact(user.lastLoginAt)}>
              {relative(user.lastLoginAt)}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-500">Devices signed in</dt>
            <dd className="tabular-nums text-ink-900">{user.activeSessions}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-500">Account added</dt>
            <dd className="text-ink-900">{exact(user.createdAt)}</dd>
          </div>
        </dl>

        {user.lockedUntil !== null ? (
          <HelpText tone="warn">
            Signing in is paused for this account until {exact(user.lockedUntil)} after{" "}
            {user.failedLogins} failed attempts. It clears itself — there is nothing to do here unless they
            have genuinely forgotten the password.
          </HelpText>
        ) : null}
      </FormSection>

      <FormSection
        title="What they can do"
        description="One level of access, plus two extras that only ever widen it."
      >
        {offerableRoles.length === 0 ? (
          /*
            THE REASON, ON SCREEN — see the file header. An administrator who simply cannot find the picker
            concludes the studio is broken.
          */
          <HelpText>
            You cannot change this person&rsquo;s access, because they are at the same level as you or
            above it. Only somebody with more access than they have can change it.
          </HelpText>
        ) : (
          <>
            <Field label="Level of access" help={ROLE_DESCRIPTIONS[user.role]}>
              <Select
                value={user.role}
                options={offerableRoles.map((candidate) => ({
                  value: candidate,
                  label: ROLE_LABELS[candidate]
                }))}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isRole(next)) void changeRole(next);
                }}
              />
            </Field>

            {isLastAdministrator ? (
              <HelpText tone="warn">
                You are the only active administrator, so your own access cannot be lowered from here. If it
                were, nobody could manage users, settings, navigation or the recycle bin, and there would be
                no way back in through the site. Make somebody else an administrator first.
              </HelpText>
            ) : isLastMasterAdmin ? (
              <HelpText tone="warn">
                You are the only master administrator, so your own access cannot be lowered from here.
                Nothing on the site would break if it were — pages would still publish and settings would
                still save — but nobody could ever add another colleague to the studio access list again, and
                no account could be raised back to master administrator from inside the studio. Make somebody
                else a master administrator first.
              </HelpText>
            ) : null}
          </>
        )}

        <Checkbox
          checked={user.canPublish}
          disabled={busy === "grant-publish" || offerableRoles.length === 0}
          onCheckedChange={(checked) =>
            void run(
              "grant-publish",
              async () => {
                await patch(USER_ENDPOINTS.detail(user.id), { canPublish: checked });
              },
              checked
                ? `${user.name} can publish now`
                : `${user.name} can no longer publish beyond their level`,
              "That extra has not been changed"
            )
          }
          label="Also allow publishing"
          description="Lets them put things on the public site without giving them an editor's access to everybody else's work. It widens what they can do; it never narrows it."
        />

        <Checkbox
          checked={user.canManageMedia}
          disabled={busy === "grant-media" || offerableRoles.length === 0}
          onCheckedChange={(checked) =>
            void run(
              "grant-media",
              async () => {
                await patch(USER_ENDPOINTS.detail(user.id), { canManageMedia: checked });
              },
              checked
                ? `${user.name} can look after the media library now`
                : `${user.name} no longer has media access beyond their level`,
              "That extra has not been changed"
            )
          }
          label="Also allow the media library and file store"
          description="Lets them upload, describe and file photographs and documents."
        />
      </FormSection>

      {/*
        HOW THIS ACCOUNT IS ENTERED — above two-step verification, because the two are read together and this
        is the half that is easy to miss. An account can be entered with a password, with a linked provider,
        or with both, and an administrator investigating one needs all of them named.
      */}
      <FormSection
        title="How they sign in"
        description="Every way into this account. A provider link opens it just as a password does, so both are listed."
      >
        {methods === null ? (
          detail.error ? (
            <HelpText tone="error">{detail.error.message}</HelpText>
          ) : (
            <p className="text-sm text-ink-500" role="status">
              Reading the sign-in methods for this account&hellip;
            </p>
          )
        ) : (
          <>
            <ul className="space-y-2.5 text-sm">
              <li className="flex items-start gap-2">
                {account.hasPassword ? (
                  <>
                    <KeyRound aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
                    <span className="text-ink-900">
                      Password.{" "}
                      <span className="text-ink-500">
                        Set by them. Nobody in this studio can read it or choose it.
                      </span>
                    </span>
                  </>
                ) : (
                  <>
                    <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
                    <span className="text-ink-900">
                      No password.{" "}
                      <span className="text-ink-500">
                        {linkedAccounts.length > 0
                          ? "This account is entered only through the linked methods below."
                          : "They were invited and have not set one yet, so nothing can sign in to this account."}
                      </span>
                    </span>
                  </>
                )}
              </li>

              {linkedAccounts.map((linked) => (
                <li
                  key={linked.id}
                  className="flex flex-wrap items-start justify-between gap-2 border-t border-line-200 pt-2.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink-900">
                      {METHOD_LABELS[linked.provider]}
                    </span>
                    {/*
                      The address the PROVIDER asserted, which is not necessarily the account's own email —
                      that difference is the whole reason to print it. The account is found by the provider's
                      subject identifier, never by this address.
                    */}
                    <span className="mt-0.5 block break-all text-xs text-ink-500">
                      {linked.email} &middot;{" "}
                      <span title={exact(linked.lastUsedAt)}>last used {relative(linked.lastUsedAt)}</span>
                      {" "}&middot; linked {relative(linked.createdAt)}
                    </span>
                  </span>

                  {isSelf || mayManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Unlink}
                      isLoading={busy === `unlink-${linked.provider}`}
                      loadingLabel="removing"
                      onClick={() => void unlinkProvider(linked)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>

            {linkedAccounts.length === 0 ? (
              <HelpText>
                No provider is linked to this account. A link is made by the person themselves, by choosing
                Continue with Google, Microsoft or Yahoo on the sign-in page — it cannot be added for them
                from here, because it needs them to prove the provider account is theirs.
              </HelpText>
            ) : null}

            {/*
              THE REASON THE CONTROL WILL REFUSE, BEFORE IT IS PRESSED. See the file header: this screen states
              why an action is unavailable rather than hiding it without explanation.
            */}
            {isOnlyWayIn ? (
              <HelpText tone="warn">
                This is the only way into the account, because it has no password. It cannot be removed — an
                account with no password and no linked provider exists, stays active and keeps its level of
                access, and nobody at any level could ever sign in to it again. Issue a password link under
                &ldquo;Help them back in&rdquo; first.
              </HelpText>
            ) : null}

            {!isSelf && !mayManage ? (
              <HelpText>
                You cannot change how this person signs in, because they are at the same level of access as
                you or above it.
              </HelpText>
            ) : null}
          </>
        )}
      </FormSection>

      <FormSection
        title="Two-step verification"
        description="A code from an app on their phone, on top of the password."
      >
        <p className="flex items-start gap-2 text-sm">
          {user.twoFactorEnabled ? (
            <>
              <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
              <span className="text-ink-900">
                On.{" "}
                <span className="text-ink-500">
                  {user.recoveryCodesLeft === 0
                    ? "No recovery codes are left, so a lost phone means asking you for help."
                    : `${user.recoveryCodesLeft} recovery ${user.recoveryCodesLeft === 1 ? "code is" : "codes are"} left.`}
                </span>
              </span>
            </>
          ) : (
            <>
              <ShieldOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
              <span className="text-ink-900">
                Off. <span className="text-ink-500">A password on its own is all that protects this account.</span>
              </span>
            </>
          )}
        </p>

        {/*
          HONEST ABOUT WHAT THIS SCREEN CANNOT DO. There is nowhere in the data model to record "two-step
          verification is required of this person", so a switch here would be a switch that did nothing.
          Saying so is better than implying a control exists — and better than a fake one that an
          administrator would rely on.
        */}
        <HelpText>
          Only the person themselves can switch two-step verification ON, from their own account screen —
          setting it up needs the phone in their hand. This installation has nowhere to record that it is
          required, so requiring it is something to agree with people rather than something to switch on
          here. Nobody, at any level, can see or copy somebody else&rsquo;s codes.
        </HelpText>

        {user.twoFactorEnabled && !isSelf ? (
          <Button
            variant="danger"
            size="sm"
            icon={ShieldOff}
            isLoading={busy === "two-factor"}
            loadingLabel="switching off"
            onClick={() => void disableTwoFactor()}
          >
            Switch it off — they have lost their device
          </Button>
        ) : null}

        {user.twoFactorEnabled && isSelf ? (
          <HelpText>
            This is your own account. Switch your own two-step verification off from your account screen,
            where it asks for your password first.
          </HelpText>
        ) : null}
      </FormSection>

      <FormSection
        title="Help them back in"
        description="Nobody in this studio can read or set somebody else's password. These are the two things that can be done instead."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={canSendEmail ? Mail : KeyRound}
            isLoading={busy === "password"}
            loadingLabel="working"
            onClick={() => void resetPassword()}
          >
            {canSendEmail ? "Email a password link" : "Make a password link"}
          </Button>

          <Button
            variant="secondary"
            size="sm"
            icon={LogOut}
            isLoading={busy === "sessions"}
            loadingLabel="signing out"
            onClick={() => void signOutEverywhere()}
          >
            Sign out of every device
          </Button>
        </div>
      </FormSection>

      <FormSection
        title="Switch this account off"
        tone="danger"
        description="A switched-off account cannot sign in, and everything the person has written stays exactly where it is."
      >
        {isSelf ? (
          // The reason, on screen. See the file header: an absent control with no explanation reads as a bug.
          <HelpText tone="warn">
            You cannot switch off your own account. An administrator who did that while being the only one
            would lock everybody out of the studio, with no way back in through the site itself. Ask another
            administrator to do it if you are leaving.
          </HelpText>
        ) : !mayManage ? (
          <HelpText>
            You cannot switch this account off, because this person is at the same level of access as you or
            above it. Only somebody with more access than they have can do it.
          </HelpText>
        ) : user.isActive ? (
          <Button
            variant="danger"
            icon={CircleSlash}
            isLoading={busy === "active"}
            loadingLabel="switching off"
            onClick={() => void setActive(false)}
          >
            Switch off {user.name}&rsquo;s account
          </Button>
        ) : (
          <Button
            variant="secondary"
            icon={CircleCheck}
            isLoading={busy === "active"}
            loadingLabel="switching on"
            onClick={() => void setActive(true)}
          >
            Switch the account back on
          </Button>
        )}
      </FormSection>
    </div>
  );
}
