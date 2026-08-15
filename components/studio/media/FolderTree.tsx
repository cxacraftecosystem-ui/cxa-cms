"use client";

/**
 * FolderTree — the media library's filing cabinet: pick a folder, and create, rename, move or delete
 * one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS A REAL ARIA TREE, WITH THE KEYBOARD CONTRACT THAT COMES WITH THAT NAME. `role="tree"`, a
 * `role="treeitem"` per folder, nested `role="group"` lists, and ROVING FOCUS: exactly one item is in
 * the tab order at a time and the arrow keys move focus between them. Down and Up walk the visible
 * items, Right opens a closed folder or steps into an open one, Left closes an open folder or jumps to
 * its parent, Home and End go to the ends, Enter and Space choose.
 *
 * ⚠ THE TREEITEM IS THE FOCUSABLE ELEMENT, NOT A BUTTON INSIDE IT — the one place in this product
 * where an interactive element is not a `<button>`. The ARIA tree pattern requires a treeitem to
 * CONTAIN its own `role="group"` of children, and a `<button>` cannot contain a `<ul>`; splitting them
 * would mean the thing carrying `aria-expanded` is not the thing the arrow keys move between, which is
 * how a tree ends up announcing a state that belongs to a different node. The rule the contract is
 * protecting against — a `<div onClick>` that no keyboard can reach and no screen reader announces —
 * does not apply: every item here is focusable, has a role, a level, a selected state and a full key
 * map.
 *
 * THE PER-FOLDER ACTIONS ARE IN A TOOLBAR, NOT IN EACH ROW. A menu button inside a treeitem is an
 * interactive element inside a focusable composite item: Tab and the arrow keys then disagree about
 * what is focused, and a screen reader reads the button's name as part of the folder's. One toolbar
 * acting on the CHOSEN folder is fewer controls, fewer tab stops, and it always says which folder it
 * is about to act on.
 *
 * DELETING IS ONLY OFFERED FOR AN EMPTY FOLDER, AND THE COUNT IS WHY. "Delete" on a folder holding
 * twelve photographs is refused with "12 files are filed here" rather than silently cascading — the
 * schema's `onDelete: Cascade` on the parent link means a folder delete that was allowed to proceed
 * would take its sub-folders with it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `folders === null` MEANS LOADING; `[]` means the library has no folders yet, which is a normal and
 * perfectly usable state — everything simply sits in "Not in a folder".
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Images,
  Pencil,
  Trash2,
  TriangleAlert
} from "lucide-react";

import { asApiClientError, del, patch, post } from "@/lib/client/fetcher";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { MEDIA_ENDPOINTS, NO_FOLDER, type MediaFolderNode } from "./MediaGrid";

interface TreeNode {
  folder: MediaFolderNode;
  children: TreeNode[];
  /** 1-based, for `aria-level`. */
  level: number;
}

export interface FolderTreeProps {
  /** `null` while loading. `[]` is a library with no folders — a normal state, not an error. */
  folders: readonly MediaFolderNode[] | null;
  /** `""` for everything, `NO_FOLDER` for files in no folder, otherwise a folder id. */
  value: string;
  onChange: (value: string) => void;
  /**
   * Whether this reader may change the filing. A false renders the tree with NO controls at all —
   * never a row of disabled buttons (contract §1.8).
   */
  canEdit: boolean;
  /** Called after a successful create, rename, move or delete so the caller can re-read the list. */
  onFoldersChanged: () => void | Promise<void>;
  /** How many assets there are altogether, for the "All media" row. */
  totalCount?: number | null;
  /** How many are in no folder at all. */
  unfiledCount?: number | null;
  className?: string;
}

/** Children sorted by name, ties broken by the unique path, so the order is total and never reshuffles. */
function sortNodes(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => {
    const byName = a.folder.name.localeCompare(b.folder.name);
    return byName !== 0 ? byName : a.folder.path.localeCompare(b.folder.path);
  });
  for (const node of nodes) sortNodes(node.children);
  return nodes;
}

/**
 * Build the tree from the flat list.
 *
 * A folder whose parent is missing from the list (deleted in another tab, or filtered out) is treated
 * as a ROOT rather than dropped. A row that quietly disappears is indistinguishable from a folder that
 * was never there, and the assets inside it would then be unreachable through this panel.
 */
function buildTree(folders: readonly MediaFolderNode[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const folder of folders) nodes.set(folder.id, { folder, children: [], level: 1 });

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.folder.parentId;
    const parent = parentId === null ? undefined : nodes.get(parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const setLevels = (list: TreeNode[], level: number) => {
    for (const node of list) {
      node.level = level;
      setLevels(node.children, level + 1);
    }
  };
  setLevels(roots, 1);

  return sortNodes(roots);
}

/** Every id from `startId` downwards. A folder may not be moved into its own descendant. */
function descendantIds(nodes: readonly TreeNode[], startId: string): Set<string> {
  const found = new Set<string>();
  const walk = (list: readonly TreeNode[], collecting: boolean) => {
    for (const node of list) {
      const inside = collecting || node.folder.id === startId;
      if (inside) found.add(node.folder.id);
      walk(node.children, inside);
    }
  };
  walk(nodes, false);
  return found;
}

/** The visible rows, in the order the arrow keys walk them. */
function flatten(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      out.push(node);
      if (expanded.has(node.folder.id) && node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

type PendingDialog =
  | { kind: "create"; parentId: string | null; parentName: string }
  | { kind: "rename"; folder: MediaFolderNode }
  | { kind: "move"; folder: MediaFolderNode }
  | null;

export function FolderTree({
  folders,
  value,
  onChange,
  canEdit,
  onFoldersChanged,
  totalCount,
  unfiledCount,
  className
}: FolderTreeProps) {
  const confirm = useConfirm();

  const tree = useMemo(() => buildTree(folders ?? []), [folders]);
  const byId = useMemo(() => {
    const map = new Map<string, MediaFolderNode>();
    for (const folder of folders ?? []) map.set(folder.id, folder);
    return map;
  }, [folders]);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** Which row owns the single tab stop. Null until the tree has been entered. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PendingDialog>(null);
  const [draftName, setDraftName] = useState("");
  const [draftParent, setDraftParent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const nameRef = useRef<HTMLInputElement | null>(null);

  const visible = useMemo(() => flatten(tree, expanded), [tree, expanded]);

  /**
   * Open the ancestors of the chosen folder.
   *
   * Without this a deep link (`?folder=…`) selects a folder nested three levels down and the panel
   * shows a collapsed root with no indication of where the selection is.
   */
  useEffect(() => {
    const selected = byId.get(value);
    if (!selected) return;
    setExpanded((current) => {
      const next = new Set(current);
      let parentId = selected.parentId;
      let guard = 0;
      // The guard is not paranoia: `parentId` comes from the database, and a cycle introduced by a
      // bad restore would otherwise spin here for ever with no error on screen.
      while (parentId !== null && guard < 64) {
        next.add(parentId);
        parentId = byId.get(parentId)?.parentId ?? null;
        guard += 1;
      }
      return next.size === current.size ? current : next;
    });
  }, [value, byId]);

  const focusItem = useCallback((id: string) => {
    setFocusedId(id);
    itemRefs.current.get(id)?.focus();
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onItemKeyDown = (node: TreeNode) => (event: KeyboardEvent<HTMLLIElement>) => {
    const index = visible.findIndex((entry) => entry.folder.id === node.folder.id);
    const isOpen = expanded.has(node.folder.id);
    const hasChildren = node.children.length > 0;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = visible[index + 1];
        if (next) focusItem(next.folder.id);
        return;
      }
      case "ArrowUp": {
        event.preventDefault();
        const previous = visible[index - 1];
        if (previous) focusItem(previous.folder.id);
        return;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (hasChildren && !isOpen) {
          toggle(node.folder.id);
          return;
        }
        // Already open: Right steps INTO the folder, which is the first child.
        const first = node.children[0];
        if (first) focusItem(first.folder.id);
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (hasChildren && isOpen) {
          toggle(node.folder.id);
          return;
        }
        const parentId = node.folder.parentId;
        if (parentId !== null && byId.has(parentId)) focusItem(parentId);
        return;
      }
      case "Home": {
        event.preventDefault();
        const first = visible[0];
        if (first) focusItem(first.folder.id);
        return;
      }
      case "End": {
        event.preventDefault();
        const last = visible[visible.length - 1];
        if (last) focusItem(last.folder.id);
        return;
      }
      case "Enter":
      case " ": {
        // Space would otherwise scroll the panel out from under the reader.
        event.preventDefault();
        onChange(node.folder.id);
        return;
      }
      default:
        return;
    }
  };

  const openCreate = (parentId: string | null) => {
    const parentName = parentId === null ? "the top level" : (byId.get(parentId)?.name ?? "the top level");
    setDraftName("");
    setError(null);
    setDialog({ kind: "create", parentId, parentName });
  };

  const openRename = (folder: MediaFolderNode) => {
    setDraftName(folder.name);
    setError(null);
    setDialog({ kind: "rename", folder });
  };

  const openMove = (folder: MediaFolderNode) => {
    setDraftParent(folder.parentId ?? "");
    setError(null);
    setDialog({ kind: "move", folder });
  };

  const closeDialog = () => {
    setDialog(null);
    setError(null);
    setBusy(false);
  };

  const runDialog = async () => {
    if (!dialog || busy) return;
    const trimmed = draftName.trim();

    if (dialog.kind !== "move" && trimmed.length === 0) {
      setError("Give the folder a name.");
      nameRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (dialog.kind === "create") {
        await post<MediaFolderNode>(MEDIA_ENDPOINTS.folders, {
          name: trimmed,
          // Explicit null rather than an omitted key: this is a nullable column, and Zod's
          // `.default()` fires for a MISSING key and never for an explicit null (contract §14).
          parentId: dialog.parentId
        });
      } else if (dialog.kind === "rename") {
        await patch<MediaFolderNode>(MEDIA_ENDPOINTS.folder(dialog.folder.id), { name: trimmed });
      } else {
        await patch<MediaFolderNode>(MEDIA_ENDPOINTS.folder(dialog.folder.id), {
          parentId: draftParent.length > 0 ? draftParent : null
        });
      }
      await onFoldersChanged();
      closeDialog();
    } catch (thrown) {
      // The server's `message` is already a plain sentence (lib/api.ts guarantees it), so it is shown
      // verbatim rather than reworded into something less specific.
      setError(asApiClientError(thrown).message);
      setBusy(false);
    }
  };

  const removeFolder = async (folder: MediaFolderNode) => {
    const node = visible.find((entry) => entry.folder.id === folder.id);
    const childCount = node?.children.length ?? 0;

    // Refused on the client AND in the handler. This message exists so the reader is told the reason
    // and the number, rather than pressing a button that answers 409.
    if (folder.assetCount > 0 || childCount > 0) {
      const parts: string[] = [];
      if (folder.assetCount > 0) {
        parts.push(
          folder.assetCount === 1 ? "1 file is filed here" : `${folder.assetCount} files are filed here`
        );
      }
      if (childCount > 0) {
        parts.push(childCount === 1 ? "it has 1 folder inside it" : `it has ${childCount} folders inside it`);
      }
      setError(
        `“${folder.name}” cannot be deleted because ${parts.join(" and ")}. Move or delete the contents first.`
      );
      return;
    }

    const agreed = await confirm({
      title: `Delete the folder “${folder.name}”?`,
      body: "The folder is empty, so nothing is lost. It can be created again at any time.",
      confirmLabel: "Delete folder"
    });
    if (!agreed) return;

    setBusy(true);
    setError(null);
    try {
      await del(MEDIA_ENDPOINTS.folder(folder.id));
      // The chosen folder has just gone. Fall back to the whole library rather than leaving a filter
      // pointing at nothing, which would render an empty grid with no visible reason.
      if (value === folder.id) onChange("");
      await onFoldersChanged();
    } catch (thrown) {
      setError(asApiClientError(thrown).message);
    } finally {
      setBusy(false);
    }
  };

  const selectedFolder = byId.get(value) ?? null;

  /** Folders a move may target: everything except the folder itself and everything under it. */
  const moveTargets = useMemo(() => {
    if (!dialog || dialog.kind !== "move") return [];
    const forbidden = descendantIds(tree, dialog.folder.id);
    return (folders ?? [])
      .filter((folder) => !forbidden.has(folder.id))
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((folder) => ({ value: folder.id, label: folder.path }));
  }, [dialog, folders, tree]);

  const renderNodes = (nodes: readonly TreeNode[], isRoot: boolean) => (
    <ul
      role={isRoot ? "tree" : "group"}
      aria-label={isRoot ? "Folders" : undefined}
      className={isRoot ? "space-y-0.5" : "mt-0.5 space-y-0.5 border-l border-line-200 pl-2"}
    >
      {nodes.map((node) => {
        const { folder } = node;
        const isOpen = expanded.has(folder.id);
        const hasChildren = node.children.length > 0;
        const selected = value === folder.id;
        // Exactly one row is in the tab order: the focused one, or the selected one, or the first.
        const tabbable =
          focusedId === folder.id ||
          (focusedId === null && (selected || visible[0]?.folder.id === folder.id));

        return (
          <li
            key={folder.id}
            ref={(element) => {
              if (element) itemRefs.current.set(folder.id, element);
              else itemRefs.current.delete(folder.id);
            }}
            role="treeitem"
            aria-level={node.level}
            aria-selected={selected}
            aria-expanded={hasChildren ? isOpen : undefined}
            tabIndex={tabbable ? 0 : -1}
            onKeyDown={onItemKeyDown(node)}
            onFocus={() => setFocusedId(folder.id)}
            className="outline-none"
          >
            <span
              className={cn(
                "flex items-center gap-1 rounded-md pr-2 text-sm transition-colors",
                selected ? "bg-purple-100 text-purple-700" : "text-ink-700 hover:bg-surface-100"
              )}
            >
              {hasChildren ? (
                <button
                  type="button"
                  // A separate control from the row so a reader can open a folder without filtering
                  // the grid by it. `tabIndex={-1}` keeps the tree to one tab stop; the arrow keys
                  // reach the same behaviour.
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={() => toggle(folder.id)}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-500 transition-colors hover:text-purple-700"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : (
                <span aria-hidden="true" className="inline-block h-6 w-6 shrink-0" />
              )}

              <button
                type="button"
                tabIndex={-1}
                onClick={() => {
                  setFocusedId(folder.id);
                  onChange(folder.id);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
              >
                {isOpen ? (
                  <FolderOpen aria-hidden="true" className="h-4 w-4 shrink-0" />
                ) : (
                  <Folder aria-hidden="true" className="h-4 w-4 shrink-0" />
                )}
                <span className="truncate">{folder.name}</span>
              </button>

              <span className="shrink-0 text-xs tabular-nums text-ink-500">{folder.assetCount}</span>
            </span>

            {hasChildren && isOpen ? renderNodes(node.children, false) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="field-label">Folders</h2>
        {canEdit ? (
          <Button size="sm" variant="ghost" icon={FolderPlus} onClick={() => openCreate(null)}>
            New folder
          </Button>
        ) : null}
      </div>

      {/* Not folders, but the two filters a reader reaches for most. Kept outside the tree so the
          arrow keys walk real folders only and nothing in the tree is a pretend node. */}
      <div className="mt-2 space-y-0.5">
        <button
          type="button"
          onClick={() => onChange("")}
          aria-current={value === "" ? "true" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            value === "" ? "bg-purple-100 font-medium text-purple-700" : "text-ink-700 hover:bg-surface-100"
          )}
        >
          <Images aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">All media</span>
          {typeof totalCount === "number" ? (
            <span className="shrink-0 text-xs tabular-nums text-ink-500">{totalCount}</span>
          ) : null}
        </button>

        <button
          type="button"
          onClick={() => onChange(NO_FOLDER)}
          aria-current={value === NO_FOLDER ? "true" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            value === NO_FOLDER
              ? "bg-purple-100 font-medium text-purple-700"
              : "text-ink-700 hover:bg-surface-100"
          )}
        >
          <Folder aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Not in a folder</span>
          {typeof unfiledCount === "number" ? (
            <span className="shrink-0 text-xs tabular-nums text-ink-500">{unfiledCount}</span>
          ) : null}
        </button>
      </div>

      <div className="mt-2">
        {folders === null ? (
          // `null` is loading. `[]` says something quite different and is handled below.
          <div>
            <span role="status" className="sr-only">
              Loading folders…
            </span>
            <div aria-hidden="true" className="space-y-1.5">
              <div className="skeleton h-6 w-full" />
              <div className="skeleton h-6 w-4/5" />
              <div className="skeleton h-6 w-3/5" />
            </div>
          </div>
        ) : tree.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-200 px-3 py-3 text-xs leading-relaxed text-ink-500">
            There are no folders yet. Everything is listed under “All media”, which works perfectly
            well — folders are only there to help you find things once the library grows.
          </p>
        ) : (
          renderNodes(tree, true)
        )}
      </div>

      {canEdit && selectedFolder ? (
        <div className="mt-3 border-t border-line-200 pt-3">
          <p className="text-xs leading-relaxed text-ink-500">
            Acting on <span className="font-medium text-ink-700">{selectedFolder.path}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              icon={FolderPlus}
              onClick={() => openCreate(selectedFolder.id)}
            >
              Add inside
            </Button>
            <Button size="sm" variant="ghost" icon={Pencil} onClick={() => openRename(selectedFolder)}>
              Rename
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={FolderInput}
              onClick={() => openMove(selectedFolder)}
            >
              Move
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={Trash2}
              isLoading={busy && dialog === null}
              loadingLabel="deleting"
              onClick={() => void removeFolder(selectedFolder)}
            >
              Delete
            </Button>
          </div>
        </div>
      ) : null}

      {error && dialog === null ? (
        <p
          role="status"
          className="mt-3 flex items-start gap-1.5 rounded-md border border-amber-800/25 bg-amber-100 px-2.5 py-2 text-xs leading-relaxed text-amber-800"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <Dialog
        open={dialog !== null}
        onClose={closeDialog}
        title={
          dialog?.kind === "create"
            ? "New folder"
            : dialog?.kind === "rename"
              ? `Rename “${dialog.folder.name}”`
              : dialog?.kind === "move"
                ? `Move “${dialog.folder.name}”`
                : ""
        }
        description={
          dialog?.kind === "create"
            ? `It will be created inside ${dialog.parentName}.`
            : dialog?.kind === "move"
              ? "Choose where this folder should sit. Everything inside it moves with it."
              : undefined
        }
        size="sm"
        footer={
          <>
            <button
              type="button"
              data-dialog-cancel
              onClick={closeDialog}
              className="field-button-secondary"
            >
              Cancel
            </button>
            <Button isLoading={busy} loadingLabel="saving" onClick={() => void runDialog()}>
              {dialog?.kind === "create" ? "Create folder" : "Save"}
            </Button>
          </>
        }
      >
        {dialog?.kind === "move" ? (
          // `Field` (a real `<label>`) is right here and only here: the control is a NATIVE `<select>`,
          // so there is no button inside for a stray click to be forwarded to (Field.tsx).
          <Field
            label="Sits inside"
            help="Leave it on “The top level” to move the folder out of every other folder."
          >
            <Select
              value={draftParent}
              onChange={(event) => setDraftParent(event.target.value)}
              placeholder="The top level"
              options={moveTargets}
            />
          </Field>
        ) : (
          <Field
            label="Folder name"
            required
            maxLength={80}
            value={draftName}
            error={error}
            help="Something you will recognise in a list — “Convocation 2026”, “Bagru fieldwork”."
          >
            <Input
              ref={nameRef}
              data-autofocus
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void runDialog();
              }}
            />
          </Field>
        )}

        {dialog?.kind === "move" && error ? (
          <p className="mt-3 flex items-start gap-1.5 text-sm text-error-600">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
