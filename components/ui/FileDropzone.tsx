"use client";

/**
 * FileDropzone — a drop target and a real `<input type="file">`, which are not alternatives to each
 * other: drag-and-drop is unavailable to anyone driving the page from the keyboard, and a lone input
 * is a poor target for a hand holding twelve photographs.
 *
 * ⚠ A DRAG OVER THE WINDOW MUST BE SWALLOWED. Drop a file anywhere outside this zone and the browser
 * NAVIGATES to it — the studio page is replaced by a JPEG, and every unsaved edit on it is gone. The
 * window-level `dragover`/`drop` listeners exist solely to `preventDefault()` that, and they are why
 * this component is worth having rather than reimplementing per screen.
 *
 * ⚠ THE LABEL IS THE CONTROL, AND IT IS FOCUSABLE. A `<label>` is not in the tab order and does not
 * respond to Enter, so it carries `tabIndex`, `role="button"` and a key handler; the input behind it
 * is `sr-only` AND `tabIndex={-1}` so the pair is one tab stop rather than two. There is no `onClick`
 * handler — the label's own `htmlFor` already opens the picker, and adding one opens it twice.
 *
 * THE RULES ARE STATED BEFORE ANYTHING IS DROPPED, not reported after. A reader who learns the size
 * cap by watching a 400 MB video fail has been told too late.
 *
 * IT DOES NOT ENFORCE THOSE RULES. Validation lives in `uploadFiles`, which can report a reason per
 * file and name the ones that failed; a second check here would be a second thing to keep in step,
 * and the two would eventually disagree. The exception is `multiple={false}`, where the extra files
 * cannot be passed on at all — so the zone says out loud which one it kept (contract §6).
 */

import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { TriangleAlert, UploadCloud } from "lucide-react";

import { ACCEPTED_CONTENT_TYPES, ACCEPTED_TYPES_SUMMARY, MAX_UPLOAD_BYTES } from "@/lib/client/upload";
import { cn, formatBytes } from "@/lib/utils";

export interface FileDropzoneProps {
  /** Called with everything the reader chose. May be called with one file or forty. */
  onFiles: (files: File[]) => void;
  /** Content types for the picker's filter. Defaults to the upload allow-list, so the two agree. */
  accept?: readonly string[];
  /** The same rule in words, shown before anything is dropped. */
  acceptSummary?: string;
  /** Stated in the rules line. Enforcement is `uploadFiles`'s job — see the header. */
  maxBytes?: number;
  multiple?: boolean;
  /**
   * For a state, never for a permission. A reader who may not upload should not see this component at
   * all (contract §1.8); this is for "storage is not configured" or "a batch is already running".
   */
  disabled?: boolean;
  /** Why it is disabled, as a sentence. A dimmed box with no explanation is a dead end. */
  disabledReason?: string;
  /** The heading inside the zone. */
  title?: string;
  className?: string;
}

/** True only for a drag actually carrying files — dragging selected text should not light the zone up. */
function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function FileDropzone({
  onFiles,
  accept = ACCEPTED_CONTENT_TYPES,
  acceptSummary = ACCEPTED_TYPES_SUMMARY,
  maxBytes = MAX_UPLOAD_BYTES,
  multiple = true,
  disabled = false,
  disabledReason,
  title = "Add files",
  className
}: FileDropzoneProps) {
  const inputId = useId();
  const rulesId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Drag events fire again for every child element the pointer crosses, so a plain boolean flickers
   * as the pointer moves over the icon and the text inside the zone. Counting enters against leaves
   * is what makes the highlight steady.
   */
  const depth = useRef(0);

  useEffect(() => {
    // Typed as `Event`, not `DragEvent`: the React `DragEvent` type is imported above and shadows the
    // DOM one, and `preventDefault` is all this needs.
    const swallow = (event: Event) => {
      event.preventDefault();
    };
    // `dragover` as well as `drop`: without preventing the default on dragover the window never fires
    // a drop event at all, and the navigation happens anyway.
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const deliver = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (!multiple && files.length > 1) {
        const kept = files[0];
        if (!kept) return;
        setNotice(
          `Only one file can be added here. ${kept.name} was kept and ${files.length - 1} other ${files.length - 1 === 1 ? "file was" : "files were"} ignored.`
        );
        onFiles([kept]);
        return;
      }
      setNotice(null);
      onFiles(files);
    },
    [multiple, onFiles]
  );

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !carriesFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !carriesFiles(event)) return;
    // Both lines are required for a valid drop target: without preventDefault the drop never fires,
    // and without the dropEffect some browsers show a "move" cursor over a copy operation.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    deliver(Array.from(event.dataTransfer.files));
  };

  const onLabelKeyDown = (event: KeyboardEvent<HTMLLabelElement>) => {
    if (disabled) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    // Space would otherwise scroll the page out from under the reader.
    event.preventDefault();
    inputRef.current?.click();
  };

  const rules = `${acceptSummary}. Up to ${formatBytes(maxBytes)} per file.`;

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "rounded-lg border-2 border-dashed p-6 text-center transition",
        dragging ? "border-purple-600 bg-purple-50" : "border-line-200 bg-surface-50",
        disabled && "opacity-60",
        className
      )}
    >
      <UploadCloud
        aria-hidden="true"
        className={cn("mx-auto h-7 w-7", dragging ? "text-purple-700" : "text-ink-300")}
      />

      <p className="mt-3 text-sm font-medium text-ink-900">{title}</p>
      <p className="mt-1 text-sm text-ink-500">
        {multiple ? "Drag files here, or" : "Drag a file here, or"}
      </p>

      <label
        htmlFor={inputId}
        // `role="button"` plus a tab stop plus the key handler is what makes a label operable without
        // a pointer. It contains only text: a label wrapping a real control would forward stray
        // clicks into it and fold its own text into that control's accessible name (contract §10).
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-describedby={rulesId}
        onKeyDown={onLabelKeyDown}
        className={cn("file-trigger mt-3", disabled && "pointer-events-none")}
      >
        {multiple ? "Choose files" : "Choose a file"}
      </label>

      <input
        id={inputId}
        ref={inputRef}
        type="file"
        // Focusable inputs behind a focusable label make two tab stops for one control; the label is
        // the one that is visible, so the input steps out of the tab order.
        tabIndex={-1}
        className="sr-only"
        accept={accept.join(",")}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []);
          // Clearing the value is load-bearing: without it, choosing the SAME file again fires no
          // change event and the second attempt silently does nothing.
          event.target.value = "";
          deliver(chosen);
        }}
      />

      <p id={rulesId} className="mt-3 text-xs text-ink-500">
        {rules}
      </p>

      {disabled && disabledReason ? (
        <p className="mt-2 text-xs font-medium text-ink-700">{disabledReason}</p>
      ) : null}

      {notice ? (
        // `role="status"` rather than a toast: it is a consequence of the drop the reader just made,
        // and it belongs beside the thing they dropped on. The amber-100/amber-800 PAIR is deliberate
        // — the status ramps are literal hex and do not invert, so a light chip with dark ink reads
        // the same in both themes where bare amber text on a dark canvas would not. The icon carries
        // the same signal as the colour (contract §11).
        <p
          role="status"
          className="mt-2 inline-flex items-start gap-1.5 rounded-md bg-amber-100 px-2.5 py-1.5 text-left text-xs font-medium text-amber-800"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{notice}</span>
        </p>
      ) : null}
    </div>
  );
}
