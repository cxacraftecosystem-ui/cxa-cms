"use client";

/**
 * StudioDoorway — the keyboard route into the CMS. It renders nothing, anywhere, ever.
 *
 * Contract §0: no visible link points from the public site to the studio. There are three doors —
 * typing `/studio`, clicking the footer wordmark seven times (see SiteBrand), and this one:
 * `Ctrl+Shift+A`, or `Cmd+Shift+A` on a Mac. Mounted once by `app/(site)/layout.tsx`, so an editor
 * can reach the studio from any public page without the public ever seeing that it exists.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT:
 *
 *  1. **It never fires while the reader is typing.** A shortcut that swallows a keystroke in the
 *     middle of a sentence — in the contact form, in a search box, in a rich-text editor — is a bug,
 *     not a feature. Inputs, textareas, selects and anything `contenteditable` are all excluded, and
 *     the check walks up from the event target rather than looking at it alone, because the target of
 *     a keypress inside a contenteditable region is very often a descendant text node's element.
 *
 *  2. **`preventDefault()` is called ONLY when the shortcut actually fires.** Calling it on every
 *     `Ctrl+Shift+*` would quietly break whichever combinations the browser or an assistive tool has
 *     bound, for a page that has no idea it did so.
 *
 *  3. **Both `event.key` and `event.code` are accepted.** With Shift held, `key` is `"A"` on most
 *     layouts and `"a"` on some; on a non-Latin layout it is neither, and `code === "KeyA"` is the
 *     only thing that still identifies the physical key the shortcut was described with.
 *
 * The listener is bound to the WINDOW rather than the document body: focus is frequently inside a
 * fixed overlay, a portalled panel or nothing at all, and every one of those still bubbles to here.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Kept as a literal here and in SiteBrand; the two are separate files and share no constant. */
const STUDIO_PATH = "/studio";

/**
 * Is focus somewhere a keystroke belongs to the reader?
 *
 * `closest()` rather than a check on the target itself, so a keypress landing on a `<b>` inside a
 * contenteditable paragraph is still recognised as typing.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const interactive = target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"], [role="combobox"]'
  );
  return interactive !== null;
}

export function StudioDoorway() {
  const router = useRouter();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Cheapest checks first: the overwhelming majority of keystrokes on a public page fail the
      // very first one, and this handler is on the critical path of every one of them.
      if (!event.shiftKey) return;
      // Ctrl on Windows and Linux, Cmd on macOS. Either is accepted on either platform rather than
      // sniffing the user agent, which is both unreliable and wrong on an iPad with a keyboard.
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key !== "A" && event.key !== "a" && event.code !== "KeyA") return;
      if (isTypingTarget(event.target)) return;

      // Only now, when the shortcut has definitely matched.
      event.preventDefault();
      // `push`, not `replace`: Back must return the reader to the page they were reading. Middleware
      // handles the rest — an unauthenticated visitor who guesses the combination lands on the login
      // screen, which is the same thing typing the address gives them.
      router.push(STUDIO_PATH);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  // Nothing. No affordance, no marker, no comment in the DOM — a rendered hint would be a visible
  // link to the studio by another name (contract §0).
  return null;
}
