"use client";

/**
 * NavigationEditor — the menus: the site header, the footer, and the small utility bar.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE WHOLE MENU SYSTEM IS SAVED IN ONE REQUEST, AND THAT IS DELIBERATE.
 *
 * `PUT /api/studio/navigation` carries all three locations, and the server replaces them inside one
 * transaction. A per-item endpoint would mean a failed drag could leave two items claiming one position,
 * or a child pointing at a parent that no longer exists — and unlike `PageSection`, `NavigationItem` has
 * no unique index on (location, position) to catch it. Sending the tree whole means the menus are never
 * half-written: either the save landed or nothing moved.
 *
 * TWO LEVELS, AND NO MORE. A third level in a header menu is a level nobody finds, and it is precisely
 * the level a CMS lets an administrator create by accident (lib/navigation.ts says the same). The shape
 * here cannot express one: a child has no children.
 *
 * DRAGGING REORDERS; BUTTONS CHANGE LEVEL. Dragging moves an item among its own siblings, and that is
 * all it does — cross-level dragging is the single most error-prone gesture in a tree editor, and a drop
 * whose meaning the reader cannot predict is worse than no drop at all. Making an item a submenu entry,
 * or lifting one back out, is an explicit button with a named action. Both routes are keyboard-operable:
 * every row carries Move up, Move down, Indent and Outdent, and every move is announced.
 *
 * ⚠ A REFUSAL IS SAID IN BOTH CHANNELS: printed on the row that refused, AND announced through the
 * status region. Three of these buttons can decline — an item with entries of its own cannot go under
 * another, a full submenu cannot take one more, a full menu cannot take one back out. Delivered only
 * into the `sr-only` live region, as they were, a sighted administrator pressed the button and watched
 * nothing whatsoever happen, which reads as a broken control rather than as a rule. The sentence is set
 * ONCE in each place: the visible copy is ordinary markup, not a second live region, or a screen reader
 * would hear it twice.
 *
 * ⚠ IT WARNS ABOUT LINKS THAT GO NOWHERE, IN TWO PLACES AND FOR TWO DIFFERENT REASONS.
 *
 *   • A SUMMARY at the top, checked against the published pages this screen was handed. It is visible
 *     without opening a single row, which is what makes it get fixed — a warning you have to go looking
 *     for is a warning nobody sees.
 *   • A LIVE CHECK inside the row being edited, from `LinkDestinationField`, which searches the site's
 *     own pages and says "there is no page at /abuot" as the address is typed.
 *
 * Addresses inside a section the CODE owns — `/news/something`, `/people/someone` — are NOT flagged.
 * Those belong to records rather than to pages and cannot be verified from here, so the screen says
 * "not checked" instead of guessing. A confident wrong answer is worse than an honest gap.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NOTHING IS SAVED AUTOMATICALLY. A half-finished menu autosaved is a header with a broken link in it on
 * the live site four seconds later, and unlike an article a menu is on every page at once.
 *
 * ⚠ DISCARD GOES BACK TO THE LAST SAVE, NEVER TO THE `navigation` PROP. The prop is the tree this screen
 * was opened with, and it stays that tree for the life of the mount: nothing here re-reads the server, and
 * nothing needs to. Rewinding to it after a save would put back the menus the reader had already replaced
 * across the whole site, leave the bar calling them unsaved, and hand them a Save that silently undoes
 * their own published change. `saved` is what the server last accepted, which is what SaveBar's
 * confirmation actually promises — "everything you have changed since the last save".
 */

import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  CornerDownRight,
  CornerLeftUp,
  ExternalLink,
  EyeOff,
  GripVertical,
  Link2Off,
  Plus,
  Trash2
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { apiFetch } from "@/lib/client/fetcher";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { SaveBar } from "@/components/studio/SaveBar";
import { useAutosave } from "@/components/studio/useAutosave";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";
import { LinkDestinationField } from "@/components/studio/fields/LinkField";

/** One address, one transaction, all three menus. See the header. */
const NAVIGATION_ENDPOINT = "/api/studio/navigation";

export const NAV_LOCATIONS = ["header", "footer", "utility"] as const;
export type NavLocation = (typeof NAV_LOCATIONS)[number];

/** What each menu IS, in the words an administrator uses, and where it appears. */
const LOCATION_META: Record<NavLocation, { label: string; description: string; max: number }> = {
  header: {
    label: "Header menu",
    description:
      "The main menu across the top of every page. An item with entries underneath it opens a small panel when a visitor hovers or taps it.",
    // Past this the header wraps onto two lines on a laptop, which reads as a fault rather than a menu.
    max: 8
  },
  footer: {
    label: "Footer",
    description:
      "The links at the foot of every page. Entries underneath an item are shown as a plain list, not a panel.",
    max: 12
  },
  utility: {
    label: "Utility bar",
    description:
      "The small strip above the header — an intranet link, a language switch, a portal. Keep it to two or three.",
    max: 6
  }
};

/** How many entries one item may have underneath it. A submenu longer than this is a page, not a menu. */
const MAX_CHILDREN = 12;

const LABEL_MAX = 60;

export interface NavItemDraft {
  /**
   * Stable for the life of the row. The stored id where there is one, a generated key for a row added in
   * this session — React then reuses the row's DOM when it moves, so focus follows the item that moved.
   */
  key: string;
  label: string;
  href: string;
  isExternal: boolean;
  isVisible: boolean;
  /** Always empty for a child: the shape cannot express a third level. */
  children: NavItemDraft[];
}

export type NavigationDraft = Record<NavLocation, NavItemDraft[]>;

/** The body sent to the server. Positions are the array order; ids are not sent — see the header. */
interface NavItemInput {
  label: string;
  href: string;
  isExternal: boolean;
  isVisible: boolean;
  children: Omit<NavItemInput, "children">[];
}

interface NavigationPayload {
  locations: Record<NavLocation, NavItemInput[]>;
}

/**
 * Addresses the CODE owns rather than a `Page` row: bespoke route files under `app/(site)`.
 *
 * A menu link to one of these is correct even though no page row matches it. Kept in step with the
 * directory listing in contract §12 by hand — there is no runtime way to enumerate a Next route tree, and
 * a wrong entry here can only ever produce a false alarm on this screen, never a broken link on the site.
 */
const CODE_OWNED_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/about",
  "/research",
  "/projects",
  "/publications",
  "/people",
  "/gallery",
  "/events",
  "/news",
  "/craft-explorer",
  "/contact",
  "/search"
]);

/**
 * First path segments whose CHILDREN are database-backed detail routes — `/research/heritage-ai`,
 * `/people/a-sharma`, `/news/tag/textiles`.
 *
 * Verifying those would mean a query per collection, which is not the "cheap to detect" this check is
 * allowed to be. They are skipped rather than guessed at, and the screen says so.
 */
const UNCHECKABLE_SECTIONS: ReadonlySet<string> = new Set([
  "research",
  "projects",
  "publications",
  "people",
  "gallery",
  "events",
  "news",
  "craft-explorer",
  "search"
]);

type LinkVerdict = "internal-ok" | "internal-missing" | "internal-unchecked" | "external" | "other" | "empty";

/** What can be said about one address, given the published pages this screen was handed. */
function verdictFor(href: string, knownPaths: ReadonlySet<string>): LinkVerdict {
  const trimmed = href.trim();
  if (trimmed.length === 0) return "empty";
  if (/^https?:\/\//i.test(trimmed)) return "external";
  if (!trimmed.startsWith("/")) return "other";

  const base = trimmed.split("?")[0]?.split("#")[0] ?? "";
  if (base.length === 0) return "other";
  if (CODE_OWNED_ROUTES.has(base)) return "internal-ok";
  if (UNCHECKABLE_SECTIONS.has(base.split("/")[1] ?? "")) return "internal-unchecked";
  if (knownPaths.has(base)) return "internal-ok";
  return "internal-missing";
}

/** Every item in a location, flattened with its parent, for the warning summary. */
function flatten(items: readonly NavItemDraft[]): { item: NavItemDraft; parent: NavItemDraft | null }[] {
  const out: { item: NavItemDraft; parent: NavItemDraft | null }[] = [];
  for (const item of items) {
    out.push({ item, parent: null });
    for (const child of item.children) out.push({ item: child, parent: item });
  }
  return out;
}

function toInput(item: NavItemDraft): NavItemInput {
  return {
    label: item.label.trim(),
    href: item.href.trim(),
    isExternal: item.isExternal,
    isVisible: item.isVisible,
    children: item.children.map((child) => ({
      label: child.label.trim(),
      href: child.href.trim(),
      isExternal: child.isExternal,
      isVisible: child.isVisible
    }))
  };
}

export interface NavigationEditorProps {
  /** The stored menus, read on the server. It seeds the editor once and is never consulted again. */
  navigation: NavigationDraft;
  /**
   * The paths of every PUBLISHED page in the studio, with a leading slash.
   *
   * Handed down rather than looked up per link: a header with twenty entries would otherwise be twenty
   * requests on first paint, and the answer is one small query on the server.
   */
  livePagePaths: readonly string[];
}

export function NavigationEditor({ navigation, livePagePaths }: NavigationEditorProps) {
  const confirm = useConfirm();
  const uid = useId();

  const [draft, setDraft] = useState<NavigationDraft>(navigation);
  /** The menus as the server last accepted them — what Discard puts back. See the file header. */
  const [saved, setSaved] = useState<NavigationDraft>(navigation);
  const [location, setLocation] = useState<NavLocation>("header");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /**
   * The last refusal, and WHICH ROW it belongs to.
   *
   * Held against the row's key rather than as one message for the screen, so the sentence appears under
   * the button that was actually pressed. A banner at the top of a menu with twelve rows in it would
   * leave the reader working out which of them it is about.
   */
  const [refusal, setRefusal] = useState<{ key: string; message: string } | null>(null);

  /** The key generator for rows added in this session. A ref: nobody renders it. */
  const nextKey = useRef(0);
  const makeKey = useCallback(() => {
    nextKey.current += 1;
    return `${uid}-new-${nextKey.current}`;
  }, [uid]);

  const knownPaths = useMemo(() => new Set(livePagePaths), [livePagePaths]);

  const items = draft[location];
  const meta = LOCATION_META[location];

  const setItems = useCallback(
    (next: NavItemDraft[]) => {
      setDraft((current) => ({ ...current, [location]: next }));
      // Any change to the tree can only make a standing refusal out of date — the entries it complained
      // about have just moved, or the item it was full has just lost one. Clearing here rather than in
      // each caller means no mutation can leave a stale sentence on the screen.
      setRefusal(null);
    },
    [location]
  );

  /**
   * A refused action, in both channels at once. See the file header.
   *
   * One sentence, written to be read verbatim in both — a live region and a printed line saying
   * different things about the same press would be two accounts of one event.
   */
  const refuse = useCallback((key: string, message: string) => {
    setRefusal({ key, message });
    setAnnouncement(message);
  }, []);

  // ── Saving ─────────────────────────────────────────────────────────────────────────────────────

  const payload = useMemo<NavigationPayload>(
    () => ({
      locations: {
        header: draft.header.map(toInput),
        footer: draft.footer.map(toInput),
        utility: draft.utility.map(toInput)
      }
    }),
    [draft]
  );

  // `apiFetch` with an explicit method: `lib/client/fetcher.ts` exports `get`/`post`/`patch`/`del` and
  // deliberately no `put`, so a PUT is spelled out rather than a fifth helper being added for one caller.
  const save = useCallback(
    async (body: NavigationPayload) => {
      /**
       * The tree this request carries, taken BEFORE the round trip.
       *
       * `payload` is derived from `draft` in the same render, and `useAutosave` holds this callback and
       * the data it sends from that same render — so the draft as it stands here is exactly what the
       * server is about to be given. Reading it again afterwards would credit the server with anything
       * typed while the request was in flight, and the reader would lose it at the next Discard.
       */
      const sent = draft;
      await apiFetch<void>(NAVIGATION_ENDPOINT, { method: "PUT", body });
      setSaved(sent);
    },
    [draft]
  );

  /**
   * `enabled: false` runs NO automatic timer; `saveNow()` still works.
   *
   * A menu is on every page of the site at once, so a half-finished one saved four seconds after somebody
   * starts typing is a broken header everywhere. The hook is still used, for the dirty tracking and the
   * status vocabulary the bar renders — a second, hand-rolled "is this dirty" flag is how two pieces of
   * state start disagreeing about whether there is anything to save (`useAutosave`'s rule 2).
   */
  const autosave = useAutosave<NavigationPayload>({ data: payload, save, enabled: false });
  useLeaveGuard(autosave.isDirty);

  // ── Editing ────────────────────────────────────────────────────────────────────────────────────

  const addTopLevel = useCallback(() => {
    if (items.length >= meta.max) return;
    const key = makeKey();
    setItems([
      ...items,
      { key, label: "", href: "", isExternal: false, isVisible: true, children: [] }
    ]);
    setOpenKey(key);
    setAnnouncement(`A menu item was added to the end of the ${meta.label.toLowerCase()}.`);
  }, [items, makeKey, meta.label, meta.max, setItems]);

  const addChild = useCallback(
    (parentKey: string) => {
      const key = makeKey();
      setItems(
        items.map((item) =>
          item.key === parentKey && item.children.length < MAX_CHILDREN
            ? {
                ...item,
                children: [
                  ...item.children,
                  { key, label: "", href: "", isExternal: false, isVisible: true, children: [] }
                ]
              }
            : item
        )
      );
      setOpenKey(key);
      setAnnouncement("An entry was added underneath.");
    },
    [items, makeKey, setItems]
  );

  const update = useCallback(
    (key: string, partial: Partial<NavItemDraft>) => {
      setItems(
        items.map((item) =>
          item.key === key
            ? { ...item, ...partial }
            : {
                ...item,
                children: item.children.map((child) =>
                  child.key === key ? { ...child, ...partial } : child
                )
              }
        )
      );
    },
    [items, setItems]
  );

  const remove = useCallback(
    async (key: string) => {
      const entry = flatten(items).find((row) => row.item.key === key);
      if (!entry) return;

      const named = entry.item.label.trim();
      const childCount = entry.item.children.length;

      // Confirmed only when there is something to lose. Confirming the removal of a blank row somebody
      // has just added is friction with no benefit, and friction with no benefit is what teaches people
      // to click through confirmations without reading them.
      if (named.length > 0 || entry.item.href.trim().length > 0 || childCount > 0) {
        const agreed = await confirm({
          title: `Remove “${named.length > 0 ? named : "this menu item"}”?`,
          body: (
            <>
              <p>
                It is taken out of the {meta.label.toLowerCase()}. The page it points at is not affected in
                any way — only the link to it.
              </p>
              {childCount > 0 ? (
                <p className="mt-2">
                  The {childCount === 1 ? "1 entry" : `${childCount} entries`} underneath it{" "}
                  {childCount === 1 ? "goes" : "go"} with it.
                </p>
              ) : null}
              <p className="mt-2">Nothing changes on the site until you save.</p>
            </>
          ),
          confirmLabel: "Remove it"
        });
        if (!agreed) return;
      }

      setItems(
        items
          .filter((item) => item.key !== key)
          .map((item) => ({ ...item, children: item.children.filter((child) => child.key !== key) }))
      );
      setOpenKey((current) => (current === key ? null : current));
      setAnnouncement("Menu item removed.");
    },
    [confirm, items, meta.label, setItems]
  );

  const moveTop = useCallback(
    (from: number, to: number) => {
      if (from === to || to < 0 || to >= items.length) return;
      setItems(arrayMove(items, from, to));
      setAnnouncement(`Moved from position ${from + 1} to position ${to + 1} of ${items.length}.`);
    },
    [items, setItems]
  );

  const moveChild = useCallback(
    (parentKey: string, from: number, to: number) => {
      setItems(
        items.map((item) => {
          if (item.key !== parentKey) return item;
          if (from === to || to < 0 || to >= item.children.length) return item;
          return { ...item, children: arrayMove(item.children, from, to) };
        })
      );
      setAnnouncement(`Moved from position ${from + 1} to position ${to + 1} underneath.`);
    },
    [items, setItems]
  );

  /**
   * Make a top-level item an entry underneath the one above it.
   *
   * REFUSED WHEN IT HAS ENTRIES OF ITS OWN, because the result would be three levels deep — which the
   * shape cannot hold and a visitor could not use. Both refusals are printed on the row and announced;
   * a button that declines in silence is a button an administrator reports as broken.
   */
  const indent = useCallback(
    (index: number) => {
      const item = items[index];
      const parent = items[index - 1];
      if (!item || !parent) return;

      if (item.children.length > 0) {
        refuse(
          item.key,
          "This item has entries underneath it, so it cannot go under another one — menus are only two levels deep. Move its entries out first."
        );
        return;
      }
      if (parent.children.length >= MAX_CHILDREN) {
        refuse(
          item.key,
          `“${parent.label || "The item above"}” already holds the most entries it can, so this cannot go underneath it.`
        );
        return;
      }

      setItems(
        items
          .filter((_unused, position) => position !== index)
          .map((candidate) =>
            candidate.key === parent.key
              ? { ...candidate, children: [...candidate.children, { ...item, children: [] }] }
              : candidate
          )
      );
      setAnnouncement(`Moved underneath “${parent.label || "the item above"}”.`);
    },
    [items, refuse, setItems]
  );

  /** Lift an entry back out to the top level, immediately after the item it was under. */
  const outdent = useCallback(
    (parentKey: string, childKey: string) => {
      const parentIndex = items.findIndex((item) => item.key === parentKey);
      const parent = items[parentIndex];
      if (!parent) return;
      const child = parent.children.find((entry) => entry.key === childKey);
      if (!child) return;
      if (items.length >= meta.max) {
        refuse(
          child.key,
          `The ${meta.label.toLowerCase()} already holds the most items it can, so nothing can be lifted out of a submenu. Remove one first.`
        );
        return;
      }

      const next = items.map((item) =>
        item.key === parentKey
          ? { ...item, children: item.children.filter((entry) => entry.key !== childKey) }
          : item
      );
      next.splice(parentIndex + 1, 0, { ...child, children: [] });
      setItems(next);
      setAnnouncement(`“${child.label || "The entry"}” is now a menu item of its own.`);
    },
    [items, meta.label, meta.max, refuse, setItems]
  );

  const sensors = useSensors(
    // A short press must still be a click, or the handle can never be focused with a trackpad.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // ── What is wrong ──────────────────────────────────────────────────────────────────────────────

  interface Problem {
    key: string;
    /** Which menu it is in, so the tab row can carry a count without a second pass over the tree. */
    location: NavLocation;
    sentence: string;
  }

  const problems = useMemo<Problem[]>(() => {
    const found: Problem[] = [];
    for (const loc of NAV_LOCATIONS) {
      for (const { item, parent } of flatten(draft[loc])) {
        const where = `${LOCATION_META[loc].label}${parent ? ` → under “${parent.label || "an item"}”` : ""}`;
        const name = item.label.trim().length > 0 ? `“${item.label.trim()}”` : "an item with no words on it";

        if (item.label.trim().length === 0) {
          found.push({
            key: `${item.key}-label`,
            location: loc,
            sentence: `${where}: there is a link with nothing written on it. It would be invisible on the site.`
          });
        }

        const verdict = verdictFor(item.href, knownPaths);
        if (verdict === "empty") {
          found.push({
            key: `${item.key}-href`,
            location: loc,
            sentence: `${where}: ${name} has no destination, so pressing it would do nothing.`
          });
        } else if (verdict === "internal-missing") {
          found.push({
            key: `${item.key}-missing`,
            location: loc,
            sentence: `${where}: ${name} points at ${item.href.trim()}, and there is no published page at that address. Anyone following it sees “page not found”.`
          });
        }

        // The flag and the address disagreeing is a real bug on the site: an internal link marked
        // external opens a new tab for no reason, and an external one that is not marked navigates away
        // with no warning and no `rel`.
        if (verdict === "external" && !item.isExternal) {
          found.push({
            key: `${item.key}-flag-on`,
            location: loc,
            sentence: `${where}: ${name} goes to another website but is not marked as one, so it will open in this tab with no warning.`
          });
        }
        if (
          (verdict === "internal-ok" || verdict === "internal-unchecked" || verdict === "internal-missing") &&
          item.isExternal
        ) {
          found.push({
            key: `${item.key}-flag-off`,
            location: loc,
            sentence: `${where}: ${name} points at a page on this site but is marked as another website, so it will open a new tab for no reason.`
          });
        }
      }
    }
    return found;
  }, [draft, knownPaths]);

  /** How many problems each menu has, so a reader on one tab knows another needs them. */
  const locationProblemCount = useMemo(() => {
    const counts: Record<NavLocation, number> = { header: 0, footer: 0, utility: 0 };
    for (const problem of problems) counts[problem.location] += 1;
    return counts;
  }, [problems]);

  return (
    <div className="mt-6 space-y-6">
      {/* Mounted in both states so the region is registered before its content ever changes. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      {problems.length > 0 ? (
        <div className="rounded-md border border-amber-800/25 bg-amber-100 px-3.5 py-3 text-amber-800">
          <p className="flex items-start gap-2 text-sm font-semibold">
            <Link2Off aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {problems.length === 1
                ? "1 thing in these menus needs attention"
                : `${problems.length} things in these menus need attention`}
            </span>
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-6 text-xs leading-relaxed">
            {problems.map((problem) => (
              <li key={problem.key}>{problem.sentence}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed">
            Links into research, projects, people, news, events, the gallery and the craft archive point at
            individual records rather than at pages, so they are not checked here. Open one once to be sure
            it works.
          </p>
        </div>
      ) : null}

      <Tabs
        label="Which menu"
        value={location}
        onChange={(next) => {
          // The tab list is built from `NAV_LOCATIONS`, so a value from it is always one of them; the
          // guard is what makes that provable to the type system rather than asserted.
          if (next === "header" || next === "footer" || next === "utility") setLocation(next);
          // A refusal belongs to a row in the menu being left behind.
          setRefusal(null);
        }}
        items={NAV_LOCATIONS.map((loc) => ({
          id: loc,
          label: LOCATION_META[loc].label,
          // A count, as text — never a coloured dot alone (contract §11).
          ...(locationProblemCount[loc] > 0 ? { count: locationProblemCount[loc] } : {})
        }))}
      />

      <FormSection
        title={meta.label}
        description={meta.description}
        actions={
          items.length < meta.max ? (
            <Button variant="secondary" size="sm" icon={Plus} onClick={addTopLevel}>
              Add a menu item
            </Button>
          ) : null
        }
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-xs leading-relaxed text-ink-500">
            Drag an item by its handle to move it among its neighbours, or use the arrows. Use{" "}
            <span className="font-medium text-ink-700">Make a submenu entry</span> to put an item
            underneath the one above it.
          </p>
          <p
            className={cn(
              "text-xs tabular-nums",
              items.length >= meta.max ? "text-amber-800" : "text-ink-500"
            )}
          >
            You can have up to {meta.max}; {items.length} added.
          </p>
        </div>

        {items.length === 0 ? (
          <div className="rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-8 text-center">
            <p className="text-sm text-ink-500">
              This menu is empty. A menu with nothing in it is left off the site entirely rather than
              rendered as a blank strip.
            </p>
            <Button variant="secondary" size="sm" icon={Plus} onClick={addTopLevel} className="mt-3">
              Add the first item
            </Button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            // Vertical only, and never outside the list: an item dragged sideways out of its own group is
            // a drag with nowhere to land.
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={(event: DragEndEvent) => {
              const { active, over } = event;
              if (!over || active.id === over.id) return;
              const from = items.findIndex((item) => item.key === String(active.id));
              const to = items.findIndex((item) => item.key === String(over.id));
              if (from === -1 || to === -1) return;
              moveTop(from, to);
            }}
          >
            <SortableContext items={items.map((item) => item.key)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {items.map((item, index) => (
                  <NavRow
                    key={item.key}
                    item={item}
                    index={index}
                    count={items.length}
                    depth={0}
                    open={openKey === item.key}
                    knownPaths={knownPaths}
                    // Only the row the refusal is about is told about it.
                    refusal={refusal?.key === item.key ? refusal.message : null}
                    onToggle={() => setOpenKey((current) => (current === item.key ? null : item.key))}
                    onUpdate={update}
                    onRemove={() => void remove(item.key)}
                    onMove={(direction) => moveTop(index, index + direction)}
                    onIndent={index > 0 ? () => indent(index) : undefined}
                    onAddChild={item.children.length < MAX_CHILDREN ? () => addChild(item.key) : undefined}
                  >
                    {item.children.length > 0 ? (
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                        onDragEnd={(event: DragEndEvent) => {
                          const { active, over } = event;
                          if (!over || active.id === over.id) return;
                          const from = item.children.findIndex(
                            (child) => child.key === String(active.id)
                          );
                          const to = item.children.findIndex((child) => child.key === String(over.id));
                          if (from === -1 || to === -1) return;
                          moveChild(item.key, from, to);
                        }}
                      >
                        <SortableContext
                          items={item.children.map((child) => child.key)}
                          strategy={verticalListSortingStrategy}
                        >
                          <ul className="mt-2 space-y-2 border-l border-line-200 pl-4">
                            {item.children.map((child, childIndex) => (
                              <NavRow
                                key={child.key}
                                item={child}
                                index={childIndex}
                                count={item.children.length}
                                depth={1}
                                open={openKey === child.key}
                                knownPaths={knownPaths}
                                refusal={refusal?.key === child.key ? refusal.message : null}
                                onToggle={() =>
                                  setOpenKey((current) => (current === child.key ? null : child.key))
                                }
                                onUpdate={update}
                                onRemove={() => void remove(child.key)}
                                onMove={(direction) =>
                                  moveChild(item.key, childIndex, childIndex + direction)
                                }
                                onOutdent={() => outdent(item.key, child.key)}
                              />
                            ))}
                          </ul>
                        </SortableContext>
                      </DndContext>
                    ) : null}
                  </NavRow>
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </FormSection>

      <SaveBar
        status={autosave.status}
        lastSavedAt={autosave.lastSavedAt}
        onSave={() => void autosave.saveNow()}
        onDiscard={() => {
          // The last save, not the menus this screen was opened with — see the file header.
          setDraft(saved);
          setOpenKey(null);
        }}
        error={autosave.error?.message ?? null}
        subject="the menus"
        saveLabel="Save the menus"
        note="Menus are not saved automatically: they appear on every page of the site, so a half-finished one would be a broken header everywhere. All three menus are saved together, in one go — either the change lands or nothing moves."
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// One row
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface NavRowProps {
  item: NavItemDraft;
  index: number;
  count: number;
  depth: 0 | 1;
  open: boolean;
  knownPaths: ReadonlySet<string>;
  /**
   * The sentence explaining why this row's last button press did nothing, or null.
   *
   * Rendered as ordinary markup: the same sentence has already gone into the screen's one live region,
   * and a second region here would announce it twice (see the file header).
   */
  refusal: string | null;
  onToggle: () => void;
  onUpdate: (key: string, partial: Partial<NavItemDraft>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onIndent?: () => void;
  onOutdent?: () => void;
  onAddChild?: () => void;
  children?: ReactNode;
}

function NavRow({
  item,
  index,
  count,
  depth,
  open,
  knownPaths,
  refusal,
  onToggle,
  onUpdate,
  onRemove,
  onMove,
  onIndent,
  onOutdent,
  onAddChild,
  children
}: NavRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.key });

  const bodyId = `${item.key}-body`;
  const position = `${index + 1} of ${count}`;
  const verdict = verdictFor(item.href, knownPaths);
  const label = item.label.trim();

  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <div
        className={cn(
          "rounded-md border bg-card",
          verdict === "internal-missing" || verdict === "empty" || label.length === 0
            ? "border-amber-800/40"
            : "border-line-200",
          // The lift is two signals and only one is motion: the shadow moves, the NAMED ring does not.
          isDragging && "relative z-10 shadow-panel ring-2 ring-purple-600/30"
        )}
      >
        <div className="flex items-center gap-1 px-1.5 py-1.5">
          <button
            type="button"
            ref={setActivatorNodeRef}
            aria-label={`Drag to reorder ${label.length > 0 ? label : "this menu item"}, ${position}`}
            // `touch-none` stops a phone scrolling the page instead of starting the drag.
            className="inline-flex h-8 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-ink-300 transition hover:text-ink-700 focus-visible:ring-2 focus-visible:ring-purple-600/30"
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden="true" className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            // Only while the panel is in the document: an `aria-controls` pointing at a missing id is
            // worse than not pointing at all (contract §11).
            aria-controls={open ? bodyId : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left transition hover:bg-surface-100"
          >
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-sm",
                  label.length > 0 ? "text-ink-900" : "text-amber-800"
                )}
              >
                {label.length > 0 ? label : "Nothing written on this one yet"}
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] text-ink-500">
                <span className="truncate font-mono">
                  {item.href.trim().length > 0 ? item.href.trim() : "no destination"}
                </span>
                {item.isExternal ? (
                  <span className="inline-flex items-center gap-0.5">
                    <ExternalLink aria-hidden="true" className="h-3 w-3" />
                    another website
                  </span>
                ) : null}
                {!item.isVisible ? (
                  <span className="inline-flex items-center gap-0.5 text-ink-700">
                    <EyeOff aria-hidden="true" className="h-3 w-3" />
                    hidden
                  </span>
                ) : null}
                {verdict === "internal-missing" ? (
                  <span className="inline-flex items-center gap-0.5 text-amber-800">
                    <Link2Off aria-hidden="true" className="h-3 w-3" />
                    no page at this address
                  </span>
                ) : null}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn("h-4 w-4 shrink-0 text-ink-500 transition-transform", open && "rotate-180")}
            />
          </button>

          <div className="flex shrink-0 items-center">
            <RowIconButton
              label={`Move ${label.length > 0 ? label : "this item"} up`}
              unavailable={index === 0}
              onClick={() => onMove(-1)}
            >
              <ChevronDown aria-hidden="true" className="h-4 w-4 rotate-180" />
            </RowIconButton>
            <RowIconButton
              label={`Move ${label.length > 0 ? label : "this item"} down`}
              unavailable={index === count - 1}
              onClick={() => onMove(1)}
            >
              <ChevronDown aria-hidden="true" className="h-4 w-4" />
            </RowIconButton>

            {onIndent ? (
              <RowIconButton
                label={`Make ${label.length > 0 ? label : "this item"} a submenu entry of the item above`}
                unavailable={false}
                onClick={onIndent}
              >
                <CornerDownRight aria-hidden="true" className="h-4 w-4" />
              </RowIconButton>
            ) : null}

            {onOutdent ? (
              <RowIconButton
                label={`Lift ${label.length > 0 ? label : "this entry"} out to a menu item of its own`}
                unavailable={false}
                onClick={onOutdent}
              >
                <CornerLeftUp aria-hidden="true" className="h-4 w-4" />
              </RowIconButton>
            ) : null}

            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${label.length > 0 ? label : `menu item ${position}`}`}
              className="inline-flex h-8 w-8 items-center justify-center rounded text-ink-500 transition hover:bg-error-100 hover:text-error-600 focus-visible:ring-2 focus-visible:ring-error-600/30"
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/*
          Directly under the buttons that refused, and inside the row's own card so it is plainly about
          THIS item. It stays until the next change to the menu, because a message that cleared itself
          after a moment is one an administrator who looked away has no way to get back.
        */}
        {refusal ? (
          <div className="px-1.5 pb-1.5">
            <HelpText tone="warn">{refusal}</HelpText>
          </div>
        ) : null}

        {open ? (
          <div id={bodyId} className="space-y-4 border-t border-line-200 px-3 py-4">
            <Field
              label="Words on the menu"
              required
              help="What a visitor reads. Two or three words — a menu is scanned, not read."
              maxLength={LABEL_MAX}
              value={item.label}
              error={item.label.trim().length === 0 ? "A menu item needs words on it." : null}
            >
              <Input
                value={item.label}
                onChange={(event) => onUpdate(item.key, { label: event.target.value })}
                placeholder="Publications"
              />
            </Field>

            {/*
              `LinkDestinationField` is the one control that both SEARCHES the site's own pages and says
              when an address resolves to nothing, as it is typed. Reimplementing either half here would
              give the studio two opinions about what a valid destination is.
            */}
            <LinkDestinationField
              label="Where it goes"
              value={item.href}
              onChange={(href) =>
                onUpdate(item.key, {
                  href,
                  // The flag follows the address unless the reader has deliberately set it the other way:
                  // typing an https:// address and forgetting the tick is by far the commonest mistake
                  // here, and it is the one with a visible consequence.
                  isExternal: /^https?:\/\//i.test(href.trim())
                })
              }
              onPageChosen={(page) =>
                onUpdate(item.key, {
                  href: page.path,
                  isExternal: false,
                  // Only fills an EMPTY label. Overwriting words somebody has already chosen would undo
                  // a decision they made on purpose.
                  ...(item.label.trim().length === 0 ? { label: page.title } : {})
                })
              }
            />

            <Checkbox
              checked={item.isExternal}
              onCheckedChange={(checked) => onUpdate(item.key, { isExternal: checked })}
              label="This goes to another website"
              description="Opens in a new tab, and a visitor using a screen reader is told so before they follow it. Leave it off for anything on this site."
            />

            <Checkbox
              checked={item.isVisible}
              onCheckedChange={(checked) => onUpdate(item.key, { isVisible: checked })}
              label="Show this on the site"
              description="Turn it off to keep the item here but take it off the menu — for something being prepared, or a link that is temporarily wrong."
            />

            {depth === 0 && onAddChild ? (
              <Button variant="secondary" size="sm" icon={Plus} onClick={onAddChild}>
                Add an entry underneath this one
              </Button>
            ) : null}

            {depth === 0 && !onAddChild ? (
              <HelpText tone="warn">
                This item already holds the most entries a submenu can. A longer list is a page, not a
                menu.
              </HelpText>
            ) : null}
          </div>
        ) : null}
      </div>

      {children}
    </li>
  );
}

/**
 * One small row control.
 *
 * `aria-disabled` and a no-op at the ends rather than `disabled`: browsers blur a control the instant it
 * becomes disabled, so moving a row to the top with the keyboard would drop focus to the document body
 * and the next press would start from the top of the page.
 */
function RowIconButton({
  label,
  unavailable,
  onClick,
  children
}: {
  label: string;
  unavailable: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (unavailable) return;
        onClick();
      }}
      className={cn(
        "inline-flex h-8 w-7 items-center justify-center rounded transition focus-visible:ring-2 focus-visible:ring-purple-600/30",
        unavailable
          ? "cursor-default text-ink-300 opacity-50"
          : "text-ink-500 hover:bg-surface-100 hover:text-ink-900"
      )}
    >
      {children}
    </button>
  );
}
