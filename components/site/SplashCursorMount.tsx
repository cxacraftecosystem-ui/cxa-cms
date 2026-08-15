"use client";

/**
 * SplashCursorMount — the deferred doorway to the fluid cursor trail.
 *
 * THE SIM IS NEVER IN THE FIRST-PAINT BUNDLE. `next/dynamic` fires its loader on RENDER (the trap
 * HeroSection's probe documents), so the component stays out of the tree until three things are
 * true: the browser has reached its FIRST IDLE moment (a decoration must never compete with
 * content for the main thread), the device has a FINE POINTER — a phone should not download a
 * cursor simulation it can never point with — and the reader has NOT asked for reduced motion.
 * That last gate used to live only inside SplashCursor, which renders null under reduction but
 * only after its chunk has already crossed the wire: a reader who will never see the trail was
 * still paying to download it. Now reduction gates the DOWNLOAD here too, and the copy inside
 * SplashCursor stays as the LIVE half (alongside a mouse unplugged mid-visit, tab visibility, the
 * purple bands) — the half that can actually tear a running canvas down.
 *
 * The ordering makes this gate airtight rather than best-effort: `useReducedMotionPreference()`
 * settles in a mount effect, and both admission paths (requestIdleCallback and the 1.5s fallback)
 * queue behind that effect by construction — so on a reduced-motion machine `reduce` is already
 * true by the time `admitted` can flip, and the loader never fires.
 *
 * Once admitted, the component stays mounted while reduction is off — the sim's own gates render
 * null when they must, and re-running the idle dance on every media-query flicker would re-request
 * nothing anyway (the chunk is cached) while adding a second copy of logic the sim already owns.
 * A mid-visit reduction flip unmounts the sim here AND inside it; flipping back remounts from the
 * HTTP cache.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";

const SplashCursor = dynamic(
  () => import("@/components/site/SplashCursor").then((mod) => mod.SplashCursor),
  { ssr: false }
);

export function SplashCursorMount() {
  const reduce = useReducedMotionPreference();
  const [admitted, setAdmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const query = window.matchMedia("(pointer: fine)");

    // Runs at first idle. No fine pointer yet? Wait for one to APPEAR (a tablet docking to a
    // keyboard) instead of polling — the media query announces it.
    const onChange = () => {
      if (!cancelled && query.matches) setAdmitted(true);
    };
    const onIdle = () => {
      if (cancelled) return;
      if (query.matches) {
        setAdmitted(true);
        return;
      }
      query.addEventListener("change", onChange);
    };

    // Safari still has no requestIdleCallback; 1.5s after hydration is a fair proxy for "idle".
    let idleHandle: number | null = null;
    let timerHandle: number | null = null;
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(onIdle);
    } else {
      timerHandle = window.setTimeout(onIdle, 1500);
    }

    return () => {
      cancelled = true;
      if (idleHandle !== null) window.cancelIdleCallback(idleHandle);
      if (timerHandle !== null) window.clearTimeout(timerHandle);
      // Safe when never added; necessary when onIdle installed it and nothing ever matched.
      query.removeEventListener("change", onChange);
    };
  }, []);

  // `reduce` is checked at RENDER, not folded into `admitted`: rendering `<SplashCursor />` is
  // what fires the dynamic loader, so returning null here is what keeps the fluid-sim chunk off a
  // reduced-motion reader's connection entirely — see the header for why the ordering guarantees
  // the check wins the race against admission.
  if (reduce || !admitted) return null;
  return <SplashCursor />;
}
