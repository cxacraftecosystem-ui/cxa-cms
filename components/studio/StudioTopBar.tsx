"use client";

/**
 * StudioTopBar — where you are, how to get somewhere else, and who you are.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE BREADCRUMB IS DERIVED, NOT DECLARED. It comes from `resolveActiveHref()` over the same tree the
 * sidebar renders, so the crumb and the highlighted link can never disagree about which screen the
 * reader is on. There is no per-route breadcrumb table to keep in step.
 *
 * CTRL/CMD+K IS A HAND-OFF, AND IT ALWAYS DOES SOMETHING. The trigger dispatches the cancelable
 * `STUDIO_SEARCH_EVENT` on `window`. A richer command palette mounted anywhere in the studio may
 * claim it with `preventDefault()`; if nothing claims it, this bar opens its own jump-to panel — built
 * from `visibleStudioNav()`, so a screen the reader may not open cannot be offered here after being
 * hidden from the sidebar. A shortcut that looks live and does nothing is worse than no shortcut.
 *
 * SIGNING OUT IS A `POST`, THEN A FULL PAGE LOAD. Not a router push: the session cookies have just
 * changed, and every Server Component rendered above this one was rendered for somebody who is no
 * longer signed in. If the request FAILS the reader stays exactly where they are and is told so — a
 * screen that navigates to the login page while the cookies are still valid would bounce straight back
 * to the studio and look like the sign-out button is broken.
 *
 * NO ENTRANCE ANIMATION ON ANYTHING HERE. The studio is calm and dense: a bar that fades in is a bar
 * an administrator waits for.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDown, CircleUserRound, ExternalLink, LogOut, Menu, Search, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { resolveActiveHref } from "@/lib/navigation";
import { ROLE_LABELS } from "@/lib/permissions";
import type { SessionUser } from "@/lib/auth/current-user";
import { asApiClientError, post } from "@/lib/client/fetcher";
import { AccessibilityMenu } from "@/components/ui/AccessibilityMenu";
import { Button, LinkButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Popover } from "@/components/ui/Popover";
import { SearchInput } from "@/components/ui/SearchInput";
import { useToast } from "@/components/ui/ToastProvider";
import {
  STUDIO_HOME,
  STUDIO_SEARCH_EVENT,
  findStudioNavEntry,
  flatStudioNav,
  studioNavHrefs,
  type StudioNavSection
} from "@/components/studio/StudioNav";

export interface StudioTopBarProps {
  user: SessionUser;
  /** Already filtered by `visibleStudioNav(user)` in the shell. */
  sections: StudioNavSection[];
  /** Whether the below-`lg` slide-over is open — drives the trigger's `aria-expanded`. */
  navOpen: boolean;
  onOpenNav: () => void;
  /** The shell owns this ref so it can put focus back here when the slide-over closes. */
  navTriggerRef: RefObject<HTMLButtonElement | null>;
  /** The slide-over's DOM id. Only referenced while the sheet is mounted (contract §11). */
  navSheetId: string;
}

interface Crumb {
  label: string;
  /** Absent on the last crumb: the page you are already on is not a link to itself. */
  href?: string;
}

/** "recycle-bin" → "Recycle bin". An opaque database id becomes a phrase instead of a wall of hex. */
function humaniseSegment(segment: string): string {
  const cleaned = segment.trim();
  if (cleaned.length === 0) return "This screen";
  // A cuid is 25ish characters of unbroken lower-case and digits. Printing it in a breadcrumb tells a
  // reader nothing and pushes everything else off a narrow bar.
  if (cleaned.length > 14 && !cleaned.includes("-")) return "This record";
  const words = cleaned.replace(/-/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function buildTrail(pathname: string, sections: StudioNavSection[]): Crumb[] {
  const activeBase = resolveActiveHref(pathname, studioNavHrefs(sections));
  const match = findStudioNavEntry(sections, activeBase);
  const onDashboard = pathname === STUDIO_HOME.href;

  const trail: Crumb[] = [
    { label: STUDIO_HOME.label, href: onDashboard ? undefined : STUDIO_HOME.href }
  ];
  if (onDashboard) return trail;

  if (match && match.entry.href !== STUDIO_HOME.href) {
    // A group is not a destination — it has no screen of its own, so it is a plain crumb.
    if (match.group) trail.push({ label: match.group });
    trail.push({ label: match.entry.label });
    return trail;
  }

  // A studio path that is in no group the reader can see. `/studio` is the only base that matched, so
  // naming the address is more use than claiming this is the dashboard.
  const segments = pathname.split("/").filter(Boolean);
  trail.push({ label: humaniseSegment(segments[segments.length - 1] ?? "") });
  return trail;
}

/** Two letters from a name, for the avatar plate. Never more: three is unreadable at 32px. */
function initialsOf(name: string, email: string): string {
  const source = name.trim().length > 0 ? name.trim() : email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "?";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

export function StudioTopBar({
  user,
  sections,
  navOpen,
  onOpenNav,
  navTriggerRef,
  navSheetId
}: StudioTopBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();

  const [jumpOpen, setJumpOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Starts at the PC spelling and is corrected on the client, because reading `navigator` during
  // render would make the server and the browser disagree and React would discard the whole tree.
  const [shortcutLabel, setShortcutLabel] = useState("Ctrl K");

  const jumpInputRef = useRef<HTMLInputElement | null>(null);
  const userTriggerRef = useRef<HTMLButtonElement | null>(null);
  const userPanelRef = useRef<HTMLDivElement | null>(null);
  const signOutRef = useRef<HTMLButtonElement | null>(null);

  const trail = buildTrail(pathname, sections);
  const destinations = useMemo(() => flatStudioNav(sections), [sections]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return destinations;
    return destinations.filter(({ entry, group }) =>
      `${entry.label} ${entry.description} ${group ?? ""}`.toLowerCase().includes(needle)
    );
  }, [destinations, query]);

  useEffect(() => {
    const platform = window.navigator.userAgent;
    if (/Mac|iPhone|iPad|iPod/i.test(platform)) setShortcutLabel("⌘ K");
  }, []);

  const openSearch = useCallback(() => {
    // `dispatchEvent` returns FALSE when a listener called `preventDefault()`. So a false answer means
    // something else in the studio owns this shortcut and has already opened its own palette.
    const claimed = !window.dispatchEvent(new CustomEvent(STUDIO_SEARCH_EVENT, { cancelable: true }));
    if (claimed) return;
    setQuery("");
    setJumpOpen(true);
  }, []);

  useEffect(() => {
    if (jumpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "k" && event.key !== "K") return;
      if (!event.metaKey && !event.ctrlKey) return;
      // Firefox and Chrome both bind Ctrl+K to their own address-bar search; without this the browser
      // takes the keystroke and the studio never sees it.
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [jumpOpen, openSearch]);

  // Popover does not move focus itself (a picker that swallows the keyboard is worse than the control
  // it replaces), so the menu does it here. On the FIRST open the portal target takes one extra
  // commit, which is why this waits a frame rather than reading the ref straight away.
  useEffect(() => {
    if (!userMenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      signOutRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [userMenuOpen]);

  const closeUserMenu = useCallback(() => {
    // Read while the panel is still mounted. Focus only goes back to the trigger if it was INSIDE the
    // menu; after a click elsewhere on the page, yanking it back would move the reader away from what
    // they just chose.
    const panel = userPanelRef.current;
    const active = document.activeElement;
    const inside = panel !== null && active instanceof Node && panel.contains(active);
    setUserMenuOpen(false);
    if (inside) userTriggerRef.current?.focus({ preventScroll: true });
  }, []);

  const goTo = (href: string) => {
    setJumpOpen(false);
    router.push(href);
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await post("/api/auth/logout");
      // Deliberately NOT `setSigningOut(false)`: the button must stay busy for the whole navigation,
      // and this component is about to be replaced by a fresh server render anyway.
      window.location.assign("/studio/login");
    } catch (thrown) {
      const error = asApiClientError(thrown);
      setSigningOut(false);
      // `message` is the server's sentence verbatim — lib/api.ts guarantees it is ready to render.
      toast({ title: "You are still signed in", description: error.message, tone: "error" });
    }
  };

  return (
    <header
      // Rung 50 on the ladder: the studio top bar, and page chrome must not exceed it (contract §6).
      // Sticky rather than fixed, so it inherits the padding the scroll lock puts on <body> and does
      // not have to re-pay the scrollbar gutter itself.
      className="sticky top-0 z-50 flex h-16 items-center gap-2 border-b border-line-200 bg-card/90 px-3 backdrop-blur-md sm:px-5"
    >
      <button
        ref={navTriggerRef}
        type="button"
        onClick={onOpenNav}
        aria-expanded={navOpen}
        // Only while the sheet is in the document. An `aria-controls` pointing at a missing id is
        // worse than none at all (contract §11).
        aria-controls={navOpen ? navSheetId : undefined}
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-700 transition hover:bg-surface-100 hover:text-ink-900 lg:hidden"
      >
        <Menu aria-hidden="true" className="h-5 w-5" />
        <span className="sr-only">Open the studio menu</span>
      </button>

      <nav aria-label="Where you are" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          {trail.map((crumb, index) => {
            const last = index === trail.length - 1;
            return (
              <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
                {index > 0 ? (
                  <span aria-hidden="true" className="shrink-0 text-ink-300">
                    /
                  </span>
                ) : null}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="truncate text-ink-500 transition hover:text-ink-900"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    aria-current={last ? "page" : undefined}
                    className={cn(
                      "truncate",
                      last ? "font-medium text-ink-900" : "text-ink-500",
                      // A middle crumb naming a group is not a place — it is context. Hidden on a
                      // phone, where the screen's own name is the only crumb worth the width.
                      !last && index > 0 ? "hidden sm:inline" : undefined
                    )}
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <button
        type="button"
        onClick={openSearch}
        className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md border border-line-200 bg-surface-50 px-2.5 text-sm text-ink-500 transition hover:border-purple-300 hover:text-ink-700 md:px-3"
      >
        <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="hidden md:inline">Go to a section</span>
        {/* The same words, so the accessible name never changes with the width. */}
        <span className="sr-only md:hidden">Go to a section</span>
        <kbd
          aria-hidden="true"
          className="ml-4 hidden rounded border border-line-200 bg-card px-1.5 py-0.5 text-[0.6875rem] font-medium tabular-nums text-ink-500 lg:inline-block"
        >
          {shortcutLabel}
        </kbd>
      </button>

      {/* A new tab, and it says so out loud: a reader whose focus lands in a new tab with no warning
          has lost their place and their Back button with it. */}
      <LinkButton
        href="/"
        newTab
        variant="ghost"
        icon={ExternalLink}
        className="hidden shrink-0 sm:inline-flex"
      >
        View site
      </LinkButton>

      <AccessibilityMenu align="end" side="bottom" className="shrink-0" />

      <button
        ref={userTriggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={userMenuOpen}
        onClick={() => (userMenuOpen ? closeUserMenu() : setUserMenuOpen(true))}
        className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md px-1.5 text-sm text-ink-700 transition hover:bg-surface-100 hover:text-ink-900"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-purple-700 text-[0.6875rem] font-semibold text-white"
        >
          {initialsOf(user.name, user.email)}
        </span>
        <span className="hidden max-w-[10rem] truncate font-medium xl:inline">{user.name}</span>
        {/* The same name, hidden from eyes only, at the widths where the visible copy is not rendered.
            Split this way so the accessible name is "Ada Lovelace — your account" at EVERY width: a
            control whose spoken name changes with the viewport is a control voice input cannot reach. */}
        <span className="sr-only xl:hidden">{user.name}</span>
        <span className="sr-only"> — your account</span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
      </button>

      <Popover
        open={userMenuOpen}
        onClose={closeUserMenu}
        anchorRef={userTriggerRef}
        panelRef={userPanelRef}
        align="end"
        side="bottom"
        role="dialog"
        label="Your account"
        width={288}
        // `!p-0` and not `p-0`: Popover's own `p-1.5` is a utility too, and `cn()` is a plain join, so
        // CSS source order decides — Tailwind emits `p-1.5` after `p-0` and would win (contract §5).
        // The rows below carry their own padding so the dividers can reach both edges.
        className="!p-0"
      >
        <div className="border-b border-line-200 px-4 py-3">
          <p className="truncate text-sm font-semibold text-ink-900">{user.name}</p>
          <p className="mt-0.5 truncate text-xs text-ink-500">{user.email}</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-500">
            {ROLE_LABELS[user.role]} — this is what decides which sections you can open.
          </p>
        </div>

        <div className="flex items-start gap-2 border-b border-line-200 px-4 py-3">
          <ShieldCheck
            aria-hidden="true"
            className={cn("mt-0.5 h-4 w-4 shrink-0", user.twoFactorEnabled ? "text-success-600" : "text-ink-300")}
          />
          {/* Icon AND word: colour never carries the meaning on its own (contract §11). */}
          <p className="text-xs leading-relaxed text-ink-500">
            {/*
              ⚠ THIS USED TO SAY "An administrator can help you turn it on", WHICH WAS FALSE AND SENT
              PEOPLE TO ASK FOR SOMETHING NOBODY CAN DO. `app/api/studio/users/[id]/two-factor/route.ts`
              exports DELETE only — an administrator can switch somebody's second factor OFF and has no
              way at all to switch it on, because arming it requires the secret to be scanned by the
              person themselves. Sending them to their own account screen is the only true answer.
            */}
            {user.twoFactorEnabled
              ? "Two-step sign-in is on for this account."
              : "Two-step sign-in is off. You can switch it on from your account screen."}
          </p>
        </div>

        <div className="p-2">
          {/*
            The way to the account screen. Until this existed, /studio/account had no link anywhere in
            the product and was reachable only by typing the address — so changing your own password
            was a feature only somebody who had read the source could find. It sits directly above
            Sign out because those are the two things this menu is for.
          */}
          <LinkButton
            href="/studio/account"
            variant="ghost"
            icon={CircleUserRound}
            fullWidth
            className="justify-start"
            onClick={() => setUserMenuOpen(false)}
          >
            Your account
          </LinkButton>

          <Button
            ref={signOutRef}
            variant="ghost"
            icon={LogOut}
            fullWidth
            isLoading={signingOut}
            loadingLabel="signing out"
            onClick={signOut}
            className="justify-start"
          >
            Sign out
          </Button>
        </div>
      </Popover>

      <Dialog
        open={jumpOpen}
        onClose={() => setJumpOpen(false)}
        title="Go to a section"
        description="Type a few letters, then press Enter to open the first match."
        size="sm"
        initialFocusRef={jumpInputRef}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const first = matches[0];
            if (first) goTo(first.entry.href);
          }}
        >
          <SearchInput
            ref={jumpInputRef}
            label="Search the studio menu"
            value={query}
            onValueChange={setQuery}
            placeholder="Publications, media, settings…"
            clearLabel="Clear what you have typed"
          />
        </form>

        {matches.length === 0 ? (
          <p className="mt-4 text-sm leading-relaxed text-ink-500">
            Nothing in your menu matches that. Try a shorter word, or clear the box to see everything
            you can open.
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {matches.map(({ entry, group }) => {
              const Icon = entry.icon;
              return (
                <li key={entry.href}>
                  {/* A real <Link>, so it can be middle-clicked, copied and read as a link. The click
                      handler only closes the panel — it does not do the navigating. */}
                  <Link
                    href={entry.href}
                    onClick={() => setJumpOpen(false)}
                    className="flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition hover:bg-surface-100"
                  >
                    <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-purple-700" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink-900">
                        {entry.label}
                        {group ? (
                          <span className="ml-2 text-xs font-normal text-ink-500">{group}</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                        {entry.description}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
    </header>
  );
}
