import "server-only";

/**
 * The moment a Server Component page is answering — read ONCE, by the page that asks.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE CLOCK IS READ HERE AND NOT IN THE PAGE. React's purity rule (`react-hooks/purity`) refuses
 * `Date.now()` in a component body: a component may be rendered more than once and must draw the same
 * thing each time, and a clock read during render makes that untrue. The rule cannot tell a Server
 * Component — rendered once, for one request — from a client one, and the pages that call this ARE
 * Server Components, so there is no second render for the first to disagree with. What the rule
 * protects still matters, though: the page reads the clock once, through this, and works out every
 * time-dependent answer on it ("3 days left", "link expired") against that one instant, rather than
 * reading the clock again for every row.
 *
 * ⚠ `server-only`, so a client component cannot reach for it. In the browser a clock read during
 * render IS the hazard the rule describes; the answer there is a lazy `useState(() => Date.now())`
 * shown only once hydrated (components/studio/SaveBar.tsx), never this.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function requestTime(): number {
  return Date.now();
}
