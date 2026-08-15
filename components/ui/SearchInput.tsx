"use client";

/**
 * SearchInput — a search box with a magnifier and a clear button.
 *
 * ⚠ A SEARCH BOX WITH NO LABEL HAS NO ACCESSIBLE NAME BUT ITS PLACEHOLDER. `type="search"` gives the
 * input `role="searchbox"`, and a role is not a name: the placeholder is the fallback of last
 * resort, it disappears the moment a character is typed, and several browsers stop exposing it at
 * that point — so a reader who tabs back to a filled box is told nothing at all. This component
 * therefore REQUIRES `label`. `showLabel` decides only whether eyes see it; the accessible name is
 * the same string either way, which is also what makes it speakable by voice control.
 *
 * THE LABEL DOES NOT WRAP. There is a `<button>` inside this control, and a `<label>` wrapped around
 * a button forwards stray clicks to it and folds its name into the input's — the same trap that
 * splits `Field` from `FieldBlock` (see Field.tsx). `htmlFor` + `id`, as FieldBlock does.
 *
 * ESCAPE CLEARS, BUT ONLY WHEN THERE IS SOMETHING TO CLEAR. With an empty box the key is left to
 * bubble, so a search inside a dialog or a nav sheet still closes it on the second press rather than
 * trapping the reader in a box that eats their only way out.
 *
 * FOCUS RETURNS TO THE INPUT AFTER CLEARING. The clear button unmounts as it is pressed — without
 * the restore, focus falls to `<body>` and the next Tab starts from the top of the document.
 */

import { useId, useRef, type ComponentPropsWithRef, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SearchInputProps
  extends Omit<
    ComponentPropsWithRef<"input">,
    "type" | "value" | "onChange" | "children" | "className"
  > {
  /** Required. The accessible name — "Search publications", not "Search". */
  label: string;
  /** Controlled, because a search box drives a debounced fetch and the caller owns the timing. */
  value: string;
  onValueChange: (next: string) => void;
  /** Show the label above the box. Off by default; the name exists either way. */
  showLabel?: boolean;
  /** The clear button's accessible name. Say what is being cleared when a page has two boxes. */
  clearLabel?: string;
  /** ⚠ Goes to the outer wrapper, not the input — this is a composite control. */
  className?: string;
  /** For the input itself. */
  inputClassName?: string;
}

export function SearchInput({
  label,
  value,
  onValueChange,
  showLabel = false,
  clearLabel = "Clear search",
  className,
  inputClassName,
  id,
  ref,
  onKeyDown,
  placeholder,
  ...rest
}: SearchInputProps) {
  const uid = useId();
  const inputId = id ?? `${uid}search`;
  const innerRef = useRef<HTMLInputElement | null>(null);

  const attachRef = (node: HTMLInputElement | null) => {
    innerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  const clear = () => {
    onValueChange("");
    innerRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.key !== "Escape" || value.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    clear();
  };

  return (
    <div className={cn("block", className)}>
      <label htmlFor={inputId} className={cn("field-label block", showLabel ? "mb-1.5" : "sr-only")}>
        {label}
      </label>

      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300"
        />

        <input
          id={inputId}
          ref={attachRef}
          type="search"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className={cn(
            "field-input pl-10",
            value.length > 0 ? "pr-12" : undefined,
            // WebKit paints its own cancel button on a search input; ours is beside it otherwise,
            // and two clear buttons in one box is a bug report waiting to be filed.
            "[&::-webkit-search-cancel-button]:appearance-none",
            inputClassName
          )}
          {...rest}
        />

        {value.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            aria-label={clearLabel}
            className="absolute right-1 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-ink-500 transition hover:bg-surface-100 hover:text-ink-900"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
