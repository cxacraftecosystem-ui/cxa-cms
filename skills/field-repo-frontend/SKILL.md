---
name: field-repo-frontend
description: The definitive Design Prototype Workshop web reference — tokens, theming, the dynamic-island nav, the motion vocabulary, the scroll-linked walkthrough, the numbered dot→card reveal, every UI primitive, form/screen/data conventions, Android-parity rules, and an index of traps that have already shipped as bugs. Load before ANY frontend UI work in this repo.
---

# Design Prototype Workshop — frontend reference

> ## ⚠ READ THIS BOX FIRST — THIS FILE IS ABOUT A DIFFERENT REPOSITORY
>
> This document is the frontend reference for the **Design Prototype Workshop**
> (`D:\Portal_Development_Designer`) — a product with a Python backend, an Android app, an
> authenticated `(protected)` route group and a `frontend/` root. **It was copied into this
> repository's `skills/` folder and never adapted.** cxa-portal is a public Next.js site plus a
> `/studio` CMS, with a Prisma/PostgreSQL backend, no Android app and no auth-gated guide.
>
> **`docs/CONTRACT.md` is this project's own contract and is the authority.** Where the two disagree,
> `docs/CONTRACT.md` wins. Three independent motion auditors flagged this file, `skills/motion` and
> `skills/gsap` for describing paths that do not resolve here; the other two have since been rewritten
> against the real code and are safe. **This one has not been rewritten**, because most of it documents
> another product's screens and a rewrite would be invention rather than reading.
>
> **What still applies** — the parts that are a shared *design language* rather than a description of
> that product's screens: §1's non-negotiables 1, 2, 5, 8 and 10; §2's rule that faces are local
> variable woff2 loaded by `next/font/local` and never Google-hosted; the token ladders
> (`ink-*` / `line-200` / `surface-*` / `bg-0` / `card`, inverting under `data-theme="dark"`); the
> purple-700 `oklch(0.47 0.198 305)` single-action-colour rule; the z-index ladder in §6.4; the
> "state truncation on screen" rule; and §17's trap index read as a checklist of *classes* of bug.
>
> **What does NOT apply** — anything naming `frontend/`, `backend/app/core/deps.py`, the Android app,
> Android wording parity, `app/(protected)/`, the guide walkthrough, `DynamicIslandNav`,
> `navbar-menu.tsx`, `PageHeader`'s single back control, or the `e2e/*.spec.ts` assertions. None of
> those files exist here.
>
> **Vocabulary map — the names in this file that are wrong for this repo:**
>
> | This file says | In cxa-portal it is |
> |---|---|
> | `useAppReducedMotion()`, `useHeroReducedMotion()` | `useReducedMotionPreference()` — `components/motion/useReducedMotionPreference.ts`. One hook, not two. Plus `prefersLessMotionNow()` in `components/motion/gsap/runtime.ts` for the synchronous first-render read. |
> | `components/guide/guideMotion.ts`, `springy()`, `layoutSpring()` | `components/motion/variants.ts` (`staggerParent`, `riseItem`, `slideItem`, `fadeItem`, `scaleIn`, `swapVariants`, `press`) and `components/motion/constants.ts` (`SPRING_PRESS`, `SPRING_LAYOUT`, …). |
> | `frontend/components/guide/useGsapHeadline.ts` as GSAP's only consumer | GSAP owns **two** things through `components/motion/gsap/useGsapScope.ts` — the headline's overlapping timeline and the four narrative blocks' scrubbed motion. See `skills/gsap`. |
> | `frontend/tailwind.config.ts`, `frontend/app/globals.css`, `frontend/fonts/` | `tailwind.config.ts`, `app/globals.css`, `fonts/` at the repository root. Type slots are declared in `lib/typography/fonts.ts`. |
> | §2's two faces (Inter + Jakarta) | Still the defaults, but the family set is much larger now and `lib/typography/fonts.ts` is the register. ⚠ **An OFL face's licence must travel with it** — see `/credits`. |
> | "protected page" / "inside the app" | `/studio`. "Public pages" ≈ the `(site)` route group. |
> | Prisma `Decimal` arriving as a JSON string | Still true and still worth reading — this repo uses Prisma too. |
>
> ⚠ **One rule in §8 is inverted for this repo and matters.** On `(site)` routes reduced motion changes
> **durations, never the `initial` state** — the preference reads `false` during SSR and the first client
> render by design, so a branching `initial` flashes. Inside `/studio`, where nothing is prerendered for
> an anonymous reader, branching `initial` is fine. Do not copy either pattern across the boundary.

This file is the **contract** for the repository named above, not a summary. It exists so a change can
be made correctly without re-reading twenty components, and every number in it was read off that
project's code. Where a rule looks odd, the reason follows it — those reasons are almost always a bug
that shipped once.

**Sources of truth, in this order** *(as written for the Workshop repo — see the box above for the
cxa-portal equivalents)*. `frontend/tailwind.config.ts` + `frontend/app/globals.css` own the
visual language. **Android owns wording and information architecture**
(`D:\Portal_Development_Designer\android`). The backend owns permissions
(`backend/app/core/deps.py`); the frontend mirrors them and never invents one.

**How to use it.** Skim §1 always. Then read the section for what you are touching. §17 is an index of
traps — check it before "simplifying" anything that looks redundant.

---

## 1. Non-negotiables

1. **Purple-700 `oklch(0.47 0.198 305)` is the only action colour.** No second accent on a data
   screen, ever. Gold is marketing-only (hero + auth), ≤5% of a viewport.
2. **Never hardcode a neutral.** Every grey goes through the themed `ink-*` / `line-200` /
   `surface-50` / `bg-0` / `card` ladders, which invert under `data-theme="dark"`.
3. **Copy Android's words verbatim.** Feature names, tile labels, button wording, menu entries. A
   researcher moves between the two apps mid-workshop.
4. **Reduced motion needs BOTH paths.** CSS covers CSS; framer-motion writes inline styles and needs a
   JS branch. Use `useAppReducedMotion()` inside the app, `useHeroReducedMotion()` on public pages.
5. **A signal that only exists as motion is a signal reduced-motion readers never get.** Pair every
   pulse with a static state (a ring, a border, a word).
6. **One back control per page** — the round arrow in `PageHeader`. Never add a second.
7. **Mount app-wide providers once.** A nested `ConfirmProvider`/`ToastProvider`/
   `UnsavedChangesProvider` shadows the real one and opens behind it.
8. **Never invent a z-index.** Pick from the ladder in §6.4.
9. **Prisma `Decimal` arrives as a JSON string.** Type it `string | number | null`; `Number()` behind
   `Number.isFinite` to read, `String()` to seed an input. Typing one as `number` has emptied a
   dropdown twice.
10. **Truncation, caps and skipped work must be stated on screen.** A list that quietly stops is
    indistinguishable from a place with no records — the single most repeated bug class in this repo.

---

## 2. Type

Two **local** variable faces in `frontend/fonts/`, loaded by `next/font/local` in `app/layout.tsx`.
Never load Google-hosted fonts.

| Slot | Variable | Face | File | Weights |
|---|---|---|---|---|
| `font-sans` | `--font-inter` | Inter — body/UI | `inter-latin-var.woff2` | 100–900 |
| `font-display` | `--font-jakarta` | Plus Jakarta Sans — headings | `jakarta-latin-var.woff2` | 200–800 |
| `font-serif` | — | **alias of `font-display`** | — | — |

- Both `display: "swap"`.
- **`font-serif` is not a serif.** It is a legacy slot pointed at Jakarta. Never use it to mean serif.
- `fontSize`, `spacing`, `screens`, `letterSpacing`, `zIndex` are **stock Tailwind** — only
  `fontFamily`, `colors`, `borderRadius`, `boxShadow`, `transitionTimingFunction`, `keyframes` and
  `animation` are extended. `plugins: []`. No `tailwindcss-animate`.
- Breakpoints are stock: `sm` 640 · `md` 768 · `lg` 1024 · `xl` 1280 · `2xl` 1536.

---

## 3. Colour

### 3.1 Brand purple — literal OKLCH, hue locked at 305°, **never inverts**

| Rung | Value | Rung | Value |
|---|---|---|---|
| 50 | `oklch(0.977 0.013 305)` | 500 | `oklch(0.648 0.19 305)` |
| 100 | `oklch(0.946 0.03 305)` | 600 | `oklch(0.56 0.205 305)` |
| 200 | `oklch(0.9 0.058 305)` | **700** | **`oklch(0.47 0.198 305)` ← the action colour** |
| 300 | `oklch(0.828 0.1 305)` | 800 | `oklch(0.4 0.18 305)` |
| 400 | `oklch(0.738 0.15 305)` | 900 | `oklch(0.34 0.15 305)` |
| | | 950 | `oklch(0.255 0.108 305)` |

### 3.2 Gold — marketing surfaces ONLY (hero + auth)

`gold-100 oklch(0.95 0.045 90)` · `200 oklch(0.9 0.08 88)` · `300 oklch(0.85 0.11 86)` ·
`400 oklch(0.78 0.135 84)` · `500 oklch(0.7 0.145 80)` · `600 oklch(0.6 0.13 75)` ·
`700 oklch(0.5 0.11 70)`. Aliases `thread` = gold-500, `thread-soft` = gold-200.
gold-200/300 text on dark purple; **gold-700 is the only gold text allowed on light**. Gold never
replaces purple as the action colour and never appears on a data screen.

### 3.3 Themed neutrals — bare `R G B` custom properties in `:root`

Consumed as `rgb(var(--token) / <alpha-value>)`, so every alpha utility works and every value inverts.

| Token | Light | Dark |
|---|---|---|
| `--bg-0` (page canvas) | `247 246 251` #f7f6fb | `17 15 25` #110f19 |
| `--card` | `255 255 255` | `26 23 37` #1a1725 |
| `--surface-50` | `250 249 253` #faf9fd | `32 28 45` #201c2d |
| `--surface-100` | `243 241 250` | `38 33 53` |
| `--surface-200` | `233 230 245` | `46 40 64` |
| `--surface-300` | `220 215 238` | `58 51 80` |
| `--line-200` | `228 226 239` #e4e2ef | `52 46 71` #342e47 |
| `--ink-900` (headings) | `30 27 46` #1e1b2e | `242 240 249` |
| `--ink-700` (body) | `58 54 81` | `208 203 223` |
| `--ink-500` (muted) | `97 93 122` | `158 152 178` |
| `--ink-300` (placeholder) | `167 163 188` | `110 104 132` |

Also `--background: rgb(var(--bg-0))`, `--foreground: rgb(var(--ink-900))`, `--purple-700/900/950` as
raw CSS values (for handwritten CSS), and `--header-clearance: 5.5rem` (**declared, zero consumers —
do not assume it is wired up**).

**⚠ `bg-surface-100` / `-200` / `-300` do not compile.** The config exposes only `surface: { 50 }`. The
only way to reach those rungs is the legacy alias `bg-field-100` / `-200` / `-300`.

### 3.4 Legacy `field` scale — shifted by one stop, so the name lies

`field-50/100/200/300` → `surface-50/100/200/300`; `field-400` → purple-400; **`field-500` → purple-600;
`field-600` → purple-700 (the action colour); `field-700` → purple-800**; `field-900` → ink-900.
No `field-800`, no `field-950`. Prefer the real names in new code.

### 3.5 Semantic aliases and status colours

shadcn-shaped: `background` `foreground` `card` `popover` `border`=`input`=line-200 `ring`=purple-600
`accent`=purple-50 `accent-foreground`=purple-700 `primary`=purple-700 `primary-foreground`=#fff
`secondary`=ink-500 `secondary-foreground`=card `muted`=surface-50 `muted-foreground`=ink-500
`destructive`=#dc2626.

Ink aliases still in components: `text-ink`=900, `text-ink-body`=700, `text-ink-muted`=500,
`text-ink-soft`=300.

**Literal (non-inverting) status colours:** `amber-100 #fef3c7`, `amber-500 #f59e0b`,
`amber-800 #92400e`; `success-100 #dcfce7`, `success-600 #15803d`; `error-100 #fee2e2`,
`error-600 #dc2626`. Logo: `logo-cream #FAF9F5`, `logo-terracotta #CC785C`, `logo-ink #181715`.

**⚠ `amber` deep-merges with stock Tailwind amber** — only 100/500/800 are brand; `amber-50/200/…` are
stock and will not pair correctly. Inside a tinted card use `amber-100` + `amber-800`, never
`amber-50`/`amber-200`. **`success` and `error` have only 100 and 600** — `success-500` does not exist.

### 3.6 Two traps that bite every new component

- **`className="border"` alone** gives preflight's literal `#e5e7eb` (gray-200), which does not invert.
  Always `border border-line-200`.
- **`ring-2` / `ring-4` alone** uses preflight's **blue** `rgb(59 130 246 / 0.5)`. Always name the
  colour: `ring-purple-600/15`, `ring-offset-card`.

---

## 4. Radius, shadow, easing, gradients

**Radius (overrides stock):** `rounded-sm 8px` · `rounded-md 12px` · `rounded-lg 16px` ·
`rounded-xl 24px`. **Not** overridden: `rounded` = 0.25rem (4px, far tighter than `sm`),
`rounded-2xl` = 1rem (**numerically identical to `lg`**), `rounded-3xl` 1.5rem, `rounded-full`.
Reading a class name is not enough to know the visual radius.

**Shadows — all purple-tinted `rgba(46,16,101,…)`:**

| Utility | Value |
|---|---|
| `shadow-sm` / `shadow-soft` | `0 1px 2px rgba(46,16,101,0.06)` |
| `shadow-md` | `0 4px 16px rgba(46,16,101,0.08)` |
| `shadow-lg` / `shadow-panel` | `0 8px 32px rgba(46,16,101,0.12)` |
| `shadow-island` | `0 4px 16px rgba(46,16,101,0.12), 0 1px 2px rgba(46,16,101,0.06)` |
| `shadow-cta` / `shadow-glow` | `0 8px 24px oklch(0.47 0.198 305 / 0.28)` |
| `shadow-glow-soft` | `0 4px 16px oklch(0.47 0.198 305 / 0.16)` |

`shadow`, `shadow-xl`, `shadow-2xl`, `shadow-inner` are **stock black** — do not use them.

**Easing.** `ease-out` is **redefined** to `cubic-bezier(0.16, 1, 0.3, 1)` (the brand expo curve);
`ease-spring` = `cubic-bezier(0.34, 1.56, 0.64, 1)`. `ease-in`/`ease-in-out`/`ease-linear` are stock.
⚠ The literal keyword `ease-out` **inside handwritten CSS** is the CSS spec curve, not this one — the
two look identical in source and are different curves.

**Gradients — exactly three recipes.**

- `--grad-brand` → `.grad-brand`: `linear-gradient(135deg, oklch(0.47 0.198 305) 0%, oklch(0.34 0.15 305) 100%)`
- `--grad-mesh` → `.grad-mesh` (alias `.ambient-light`): three radial orbs — two purple + one faint
  amber; punchier in dark (0.24 / 0.08 / 0.2 vs 0.16 / 0.1 / 0.12)
- `--grad-gold` → `.text-gold-gradient`: hero headline spans and auth copy only

**Keyframes.** The only two in the config are `accordion-down` / `accordion-up` (`0.2s ease-out`), and
they are **dead scaffold** — no component uses them, no Radix accordion is installed,
`--radix-accordion-content-height` is never set. `globals.css` declares **one** project keyframe,
`fr-row-flash` (§10). A new CSS animation therefore has almost nothing to copy: add it to
`theme.extend.keyframes`/`animation`, or write `@keyframes` in `globals.css` beside `fr-row-flash`.

---

## 5. Theming and accessibility modes

Everything is driven by **attributes on `<html>`**, written by `applyPreferences()` and by its
pre-hydration twin `PREFERENCES_BOOT_SCRIPT` (the **first, blocking** child of `<body>`):

- `data-theme="light" | "dark"` — always present after boot
- `data-reduced-motion="true"`, `data-larger-text="true"`, `data-high-contrast="true"` — present only
  when on, removed when off

Storage key `localStorage["field_repo_preferences"]`; server sync `GET`/`PUT /preferences/me`;
`THEME_COLOR = { light: "#f7f6fb", dark: "#110f19" }`, **kept in step with `--bg-0` by hand**.

- **`darkMode: ["class", '[data-theme="dark"]']` → the custom selector wins.** `dark:` compiles to
  `:is([data-theme="dark"] *)`. **`class="dark"` on a container does nothing.**
- `dark:` is an **exception mechanism**, not the theming mechanism — 6 files, 55 occurrences, 11 of
  them in `ui/calendar.tsx`. Adding `dark:` for something a token already handles is a smell.
- `suppressHydrationWarning` on `<html>` is intentional (the boot script writes attributes React did
  not render). Removing it floods the console; removing the script flashes light theme on every load.
- The `<meta name="theme-color">` pair in `viewport` is only the pre-JS fallback; `applyPreferences()`
  strips its `media` and rewrites `content`.

**High contrast** re-points the low-contrast rungs — it never patches components:
light `--line-200`/`--surface-300` → `124 118 152`, `--ink-500` → `58 54 81`, `--ink-300` → `97 93 122`;
dark → `150 143 180`, `--ink-700` → `236 233 246`, `--ink-500` → `214 209 229`, `--ink-300` → `176 170 196`.
⚠ `[data-high-contrast]` ties `[data-theme="dark"]` on specificity, so an explicit
`[data-theme="dark"][data-high-contrast="true"]` block exists and must be kept in step — add a token to
one contrast block and you must add it to the other.

**Larger text:** `:root[data-larger-text="true"] { font-size: 112.5% }` (16px → 18px).

**Reduced motion — two sources, unioned, never subtracted.**

```css
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { … } }
:root[data-reduced-motion="true"] *, *::before, *::after { … }
```
Both zero `animation-duration` (0.01ms), `animation-delay`, `animation-iteration-count`,
`transition-duration`, `transition-delay`, and set `scroll-behavior: auto`.
- There is deliberately **no `="false"` rule** — the app toggle can only ADD reduction.
- **Zeroing `transition-delay` is load-bearing:** a zero-duration transition that still honours its
  delay is a staggered pop, not "no motion". Express stagger as `transition-delay` (covered) rather
  than JS timers (not covered).
- CSS cannot reach framer-motion. See §8.4.

**Focus ring (global).** `a, button, [role="button"], [tabindex], summary :focus-visible` →
`outline: 2px solid var(--purple-700); outline-offset: 2px; border-radius: 6px`. Under high contrast:
3px/3px, and extended to `input, select, textarea`.
⚠ Because the ring is drawn **outside** the border box, a card containing a full-bleed button must
**not** be `overflow-hidden` (see the guide step card, §9.6).

**Scrollbars.** 10px; track `rgb(var(--bg-0))`; thumb `rgb(var(--line-200))` with `border-radius: 9999px`
and a 2px `--bg-0` border; thumb hover purple-300. Firefox fallback is guarded by
`@supports not selector(::-webkit-scrollbar)` — setting `scrollbar-color` unguarded in Chromium would
disable the styled `::-webkit-scrollbar`.

---

## 6. Layout, the page frame, and the z-index ladder

### 6.1 Provider order

```
app/layout.tsx  (server)   html[suppressHydrationWarning] > body > BOOT SCRIPT
                           AuthProvider > ThemeProvider > ToastProvider > AdminViewProvider > children
app/(protected)/layout.tsx ConfirmProvider > [ AppUpdateWatcher, OfflineWatcher,
                                               UnsavedChangesProvider > AppShell > (OutboxBanner, children) ]
```
`ThemeProvider` must stay **inside** `AuthProvider` (its `/preferences/me` sync needs the user).
`UnsavedChangesProvider` must sit **above both** `PageHeader` (which owns the back control) and the
form — they are siblings. Signed-in-only dialogs live in the protected layout, not the root.

### 6.2 `AppShell`

`<div className="min-h-screen bg-bg-0">` → skip link → `<DynamicIslandNav />` →

```tsx
<motion.main id="main-content" tabIndex={-1} key={pathname}
  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.22, ease: "easeOut" }}
  className="mx-auto max-w-7xl px-4 pb-12 pt-24">
```

**`pt-24` (96px) IS the island clearance contract.** Never reduce it and never add your own top
padding for the nav. `key={pathname}` is what replays the 6px-rise fade on every navigation.

Four mutually exclusive branches, in order: route-locked → admin-view settling → admin-chrome hidden →
`children`. Do not write per-page lock panels; the shell renders both.

### 6.3 `PageHeader` / `BackButton`

```tsx
<PageHeader title="…" description="…" icon={<Icon className="h-5 w-5" aria-hidden />} actions={<>…</>} />
```
Root `mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between`; title
`display-title text-3xl md:text-4xl`; description `mt-2 max-w-3xl text-sm leading-6 text-ink-muted`;
icon chip `mt-1 grid h-10 w-10 place-items-center rounded-xl bg-field-200 text-field-600`; actions
`flex flex-wrap gap-2`. `back` defaults **true**; only a true root screen passes `back={false}`.
`PageHeader`'s `mb-6` + the shell's `pt-24` is the whole top-of-page spec.

`BackButton` calls `interceptLeave()` **before both** navigation branches, so an explicit `href` cannot
skip the unsaved-changes prompt. In a form call `useLeaveGuard(dirty, () => setShowUnsavedDialog(true))`
and add **no** back control of your own — `frontend/e2e/back-control.spec.ts` asserts exactly one arrow
on five routes, because the opposite shipped four times.

### 6.4 The z-index ladder — pick from it, never invent

| z | What |
|---|---|
| 10 | sticky in-page chrome (table heads) |
| 40 | bottom docks (`UploadTray`) **and the nav scrim** |
| 50 | the island nav — page chrome must not exceed it; legacy ad-hoc modals |
| 60 | skip link |
| 70 | `AnchoredPopover` when portalled to `<body>` (`FLOATING_Z`); 50 inside a dialog |
| 100 | `FieldDialog` default |
| 105 / 106 / 108 | `LateSubmissionDialog` / `OfflineDialog` / `AppUpdateDialog` |
| 110 | toast viewport |

Anything `position: fixed` and horizontally centred must also carry
`padding-right: calc(<its own> + var(--nav-scroll-gutter, 0px))` — see §7.6.

---

## 7. The dynamic island navigation

`frontend/components/DynamicIslandNav.tsx` + `frontend/components/ui/navbar-menu.tsx`.

### 7.1 The frame

```tsx
<div className="nav-island-frame pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center">
  <motion.header layout transition={spring} onMouseLeave={() => setActive(null)}
    className="pointer-events-auto flex items-center gap-1 rounded-full border border-line-200
               bg-card/85 shadow-island backdrop-blur-xl"
    /* + (compact ? "px-3 py-1.5" : "px-4 py-2") */ >
```
The wrapper is `pointer-events-none` so the empty space beside the pill does not eat page clicks; the
pill re-enables them. **`onMouseLeave` on this header is the only thing that closes a desktop
dropdown.** Expanded height ≈52px (bottom edge ≈64px); compact ≈48px (≈60px).

### 7.2 Collapse/expand — exact thresholds

```ts
const { scrollY } = useScroll();
useMotionValueEvent(scrollY, "change", (latest) => {
  const previous = scrollY.getPrevious() ?? 0;
  if (latest < 24) setCompact(false);            // always expanded in the top 24px
  else if (latest > previous + 2) setCompact(true);   // compact travelling down
  else if (latest < previous - 2) setCompact(false);  // expand on ANY upward scroll
});
```
The ±2px band is the only hysteresis — it stops sub-pixel jitter flapping the pill. The third branch is
why the full menu is always one flick away without scrolling back to the top.

### 7.3 The shared spring and the brand swoop

`const spring = { type: "spring" as const, stiffness: 260, damping: 30 }` drives the pill's `layout`
projection, the brand block and the sheet slide. The brand is keyed `compact ? "brand-compact" :
"brand-full"`, so React remounts it and `initial={{ x: -32, opacity: 0 }}` replays on every compact
flip. The desktop strip animates **width** `0 → "auto"` (`{ duration: 0.22, ease: "easeOut" }`) inside
`<AnimatePresence initial={false}>`, so the pill genuinely shrinks around it.

### 7.4 `NAV_ITEMS` — the single registry

`NAV_GROUPS = ["Record", "Browse", "Admin", "Account"]` fixes render order; `group: null` means a
standalone bar link (Dashboard, Walkthrough — "the two places a newcomer starts"); Account sits last.

Each entry: `{ href, label, icon, group, can(user), gate, adminSurface? }`. **`gate` names the backend
dependency in `app/core/deps.py` that `can` mirrors** — keep them in step. Labels are the exact Android
`EntryMode.actionTitle` strings.

**Add a destination by appending ONE object.** Never add JSX to the bar or the sheet. If the route is
gated, add the matching `ROUTE_GUARDS` row too — a nav entry is not a guard.

### 7.5 Permission gating

```ts
export function isNavItemVisible(item, user, adminMode) {
  if (!user || !item.can(user)) return false;              // entitlement FIRST
  if (item.adminSurface && isAdmin(user)) return adminMode; // admin view SECOND
  return true;
}
```
The order is load-bearing: reversing it would let admin view surface a destination the API 403s. A
failing `can` is **not rendered**, never rendered disabled. One `useMemo` produces `visibleItems` and
**both** renderers read it, so a hidden entry cannot reappear in the other menu. An empty group renders
no trigger.

Predicates (`lib/permissions.ts`): `canCreateRecords` RESEARCHER+(30) · `canManageCrafts` /
`canManageWorkshops` / `canManageUsers` PROFESSOR+(40) · `canDownloadDataset` PROFESSOR+ or the flag ·
`canReview` FIELD_CONTRIBUTOR+(20) or the flag · `isAdmin` ADMIN(50)|MASTER_ADMIN(60).

### 7.6 Scroll lock and the scrollbar gutter

On open: measure `window.innerWidth - document.documentElement.clientWidth`, record `window.scrollY`,
set `--nav-scroll-gutter` **then** add `nav-scroll-locked`. Cleanup reverses both and
`scrollTo(0, restoreTo)` as a safety net.

```css
html.nav-scroll-locked, html.nav-scroll-locked body { overflow: hidden; overscroll-behavior: none }
html.nav-scroll-locked body { padding-right: var(--nav-scroll-gutter, 0px) }
```
**On `<html>`, not only `<body>`** — iOS Safari ignores `overflow: hidden` on the body and keeps panning
the page under the open menu. `position: fixed` chrome cannot inherit body padding, so
`.nav-island-frame` and `.nav-sheet-overlay` re-pay the gutter themselves.
Verified by `frontend/e2e/nav-sheet-scroll.spec.ts`.

### 7.7 The sheet — three layers, and the scrim is a sibling

```
<AnimatePresence>
  <motion.div className="nav-sheet-overlay fixed inset-0 z-40" …>   {/* opacity layer, 0.18s */}
    <div aria-hidden onClick={closeSheet} style={{ touchAction: "none" }}
         className="absolute inset-0 bg-ink-900/20 backdrop-blur-sm" />   {/* SIBLING, not parent */}
    <motion.div role="dialog" aria-modal="true" aria-label="Navigation"
      className="nav-sheet relative mx-auto w-[min(680px,92vw)] rounded-xl border border-line-200
                 bg-card shadow-lg" … />
```
`touch-action: none` on the scrim stops a drag panning the page on iOS; **from an ancestor the same
declaration would cancel the scroll gesture inside the sheet**, which is why it is a sibling.
The scrim is `z-40`, **below** the island's `z-50`, on purpose: the pill (and its X) must stay lit and
clickable. The body is a **flat, ungrouped** two-column list of all `visibleItems` (root items first).

`.nav-sheet` CSS (`globals.css`, inside `@layer components`):
```css
--nav-sheet-top: 5rem; margin-top: var(--nav-sheet-top);
max-height: calc(100vh - var(--nav-sheet-top) - 1rem);    /* fallback */
max-height: calc(100dvh - var(--nav-sheet-top) - 1rem);   /* the real one */
overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
padding: 1.5rem; padding-bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px));
```
plus `@media (max-height: 560px) { --nav-sheet-top: 4.25rem; padding: 1rem; … }`.
**The doubled `max-height` is progressive enhancement, not a duplicate** — with `vh` alone the closing
items sit below the fold while the phone address bar shows, which is exactly when a thumb reaches for
the menu. 5rem/4.25rem are the island clearances.

### 7.8 Focus, Escape, and the keyboard route

The desktop dropdowns are **pointer-only by design** (`MenuItem`'s trigger is a `<motion.p>` — no
button, no tabindex, no `aria-expanded`). **The sheet is the keyboard route to every destination**, so
it carries a real trap:

- `closeSheet()` = `setSheetOpen(false)` + `menuButtonRef.current?.focus()` — dismissal always returns
  focus to the hamburger. Sheet **links** use bare `setSheetOpen(false)` (navigation replaces the page).
- On open, focus `panel.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')[0]`.
- Keydown is on **`window`**, not the panel, so Escape lands even if focus escaped. Tab wraps at both
  ends and treats `!panel.contains(activeElement)` as "at the far end".
- `useEffect(() => { setSheetOpen(false); setActive(null); }, [pathname])` is the reset net — and it
  deliberately does **not** steal focus.
- Skip link, first in tab order: `sr-only left-3 top-3 z-[60] … focus:not-sr-only focus:fixed` →
  `#main-content`.

### 7.9 Active-route resolution — longest base wins

```ts
for (const item of visibleItems) {
  const base = item.href.split("?")[0];
  if (pathname !== base && !pathname.startsWith(`${base}/`)) continue;
  if (!activeBase || base.length > activeBase.length) activeBase = base;
}
const isActivePath = (href) => href.split("?")[0] === activeBase;
```
A bare prefix test marks `/questionnaire` and `/questionnaire/consolidated` at once, and
`aria-current="page"` on two links tells a screen reader the reader is in two places. `/tools` and
`/tools?assign=1` both light up — same page, correct. Reuse this loop verbatim for breadcrumbs, tabs
and sidebars.

### 7.10 Admin view — a NARROWING switch, never widening

`useAdminView()` → `{ adminMode, adminView, canAdmin, adminViewResolved, setAdminView, toggleAdminView }`.
Storage `field_repo_admin_view:<user.id>` = `"on" | "off"`; absent → `isMasterAdmin(user)`.
`canAdmin` is recomputed from the server-issued role every render, and a non-admin's stored preference
is **deleted on read** — admin view is re-earned, not remembered. localStorage is try/catch-wrapped
because it **throws** when blocked, and an exception there would leave `adminViewResolved` false
forever (a stalled page on every admin route).

- `adminChromeVisible(user, adminMode)` = `!isAdmin(user) || adminMode` → **true for everyone without a
  toggle**. It answers only the admin-view half and must **always** be ANDed with the role check.
- Chrome that merely HIDES may ignore `adminViewResolved` (`adminMode` is false until it settles — the
  safe direction). Anything that would **LOCK** must hold the frame on `!adminViewResolved`.
- `ROUTE_GUARDS` never consults admin view: a preference must not lock an admin out of a URL the API
  would serve. `AppShell` computes `chrome` only when `blocked` is false, so a genuinely unentitled
  user always gets the honest permission copy.
- `AdminViewHidden` deliberately does **not** reuse the padlock / "access required" / "an admin can
  raise your access" copy — telling an admin they lack access they hold is the worse error.

---

## 8. The motion vocabulary

### 8.1 The springs, by job

| Spring | Value | Used for |
|---|---|---|
| island / shared | `{ stiffness: 260, damping: 30 }` | pill layout, brand swoop, sheet slide |
| `springy(reduce)` | `{ stiffness: 380, damping: 30, mass: 0.7 }` | every press/hover response in the guide |
| `layoutSpring(reduce)` | `{ stiffness: 260, damping: 32, mass: 0.9 }` | layout changes, accordion height |
| scroll smoothing | `useSpring(v, { stiffness: 140, damping: 30, mass: 0.4 })` | read-along spines |
| pointer wash | `useSpring(v, { stiffness: 110, damping: 24, mass: 0.6 })` | hero glow |
| popover | `{ stiffness: 520, damping: 38, mass: 0.6 }` | `AnchoredPopover` |
| toast | `{ stiffness: 420, damping: 34, mass: 0.7 }` | `Toast` |
| dropdown card | `{ mass: 0.5, damping: 11.5, stiffness: 100, restDelta: 0.001, restSpeed: 0.001 }` | `navbar-menu` |

### 8.2 Tweens

`EASE_OUT = [0.16, 1, 0.3, 1]` — the house cubic, identical to the `ease-out` token. Durations in use:
`0.22s` (nav width, main fade) · `0.18s` (scrim, accordion opacity) · `0.3s` (dropdown trigger) ·
`0.28s` in / `0.16s` out with `"easeIn"` (swap readout — the only named easing in the guide) ·
`0.5s` rise · `0.4s` slide · `0.62s` GSAP words.

### 8.3 The stagger factories (`components/guide/guideMotion.ts`)

```ts
staggerParent(reduce, stagger = 0.06) // show: { transition: { staggerChildren, delayChildren: 0.05 } }
riseItem(reduce, distance = 14)       // y → 0 over 0.5s, EASE_OUT
slideItem(reduce, distance = 12)      // x → 0 over 0.4s, EASE_OUT — for horizontal chip runs
swapVariants(reduce)                  // ±8px, in 0.28s EASE_OUT, out 0.16s "easeIn"
springy / layoutSpring                // as above
scrollToStep(id, reduce)              // scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" })
```
Stagger values in use: 0.08 · 0.06 (default) · 0.05 · 0.045 · 0.04 · 0.035 · 0.025 (chips inside a
block cascade faster than the blocks).

### 8.4 Reduced motion in JavaScript

```ts
useAppReducedMotion()   // components/guide/ — (useReducedMotion() ?? false) || preferences.reducedMotion
useHeroReducedMotion()  // components/hero/  — reads data-reduced-motion + MutationObserver
```
- **Inside the app** use `useAppReducedMotion()`. Never framer's `useReducedMotion()` directly: it sees
  only the OS half, so a user who flipped the Settings toggle still got the full scroll spring.
- **On public prerendered pages** (`components/hero/*`, `/`) use `useHeroReducedMotion()` — there is no
  `ThemeProvider` context there. It watches `attributeFilter: ["data-reduced-motion"]` so flipping the
  toggle takes effect without a reload.
- **Gate at the source.** Every `guideMotion` factory takes `reduce` and collapses to zero duration and
  zero displacement, so a new animation in that folder cannot ship without honouring the preference.
- ⚠ **There is no `MotionConfig reducedMotion="user"` anywhere in the app.** The island's spring, the
  brand swoop and the sheet slide still animate for a reduced-motion user. Components that do honour
  it read it themselves: `AnchoredPopover.useLessMotion()` (OS **and** attribute), the hero, the guide.
  `Toast.tsx` reads only `useReducedMotion()` — OS only, not the in-app toggle.
- ⚠ **Guide vs hero have OPPOSITE rules for `initial`.** `useAppReducedMotion()` reads false on the
  server and first client render by design, so the guide may branch on `reduce` inside `hidden`/
  `initial`. The hero may **not** — its rule is "reduced motion changes DURATIONS, never the `initial`
  state". Do not copy either pattern across.

---

## 9. The guided card walkthrough (`/guide`)

`app/(protected)/guide/page.tsx` + `components/guide/*`. Public entry point:
`components/hero/WalkthroughCallout.tsx`. Prose twin: `docs/WALKTHROUGH.md`.

Composition: `PageHeader` → `GuideHero` → `GuideJourney` → `GuideOutro`, four siblings, no wrapper.
Each band owns its spacing (`mt-10`, `mt-12`). The page reads `useAppReducedMotion()` for exactly one
reason: `onStart` must jump instantly, because smooth scrolling is motion too.

### 9.1 The scroll-linked spine — one value, three consumers

```ts
const { scrollYProgress } = useScroll({ target: listRef, offset: ["start 65%", "end 65%"] });
const smoothed = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.4 });
const progress = reduce ? scrollYProgress : smoothed;    // raw under reduce: tracks the scrollbar exactly
const nodeTop  = useTransform(progress, [0, 1], ["0%", "100%"]);
```
One MotionValue feeds the fill's `scaleY`, the travelling node's `top`, and the rail's ring — none of
them re-render React. **The 65% figures are measured, not chosen:** the fill reads 100% with the last
step's bottom edge still on screen (~58vh at 1280px, ~43vh at 360px), i.e. the spine completes while
you are looking at the last step. The identical instrument is reused on the public landing page
(`components/hero/HowItWorks.tsx:63`) with the same numbers, so both teach the same gesture.

### 9.2 Spine DOM

```tsx
<div aria-hidden className="pointer-events-none absolute inset-y-6 left-0 flex w-[var(--guide-rail)] justify-center">
  <div className="relative h-full w-0.5">
    <span className="absolute inset-0 rounded-full bg-line-200" />                        {/* track */}
    <motion.span style={{ scaleY: progress }} className="absolute inset-0 origin-top rounded-full bg-purple-700" />
    {reduce ? null : <motion.span style={{ top: nodeTop }}
      className="absolute -left-1 -mt-[5px] h-2.5 w-2.5 rounded-full bg-purple-700 ring-4 ring-purple-100" />}
```
The node is centred by **margins** (`-left-1` = (2−10)/2, `-mt-[5px]` = half of 10), never by a
translate class — see §9.6. `inset-y-6` lines the track's ends up with the first and last bubbles
(each `mt-6`).

### 9.3 `--guide-rail` — one owner of the horizontal axis

```tsx
<ol className="relative grid gap-4 [--guide-rail:2rem] sm:[--guide-rail:3rem]">
// card: grid grid-cols-[var(--guide-rail,2rem)_minmax(0,1fr)] gap-x-4
// bubble: a grid item in column 1 with justify-self-center
```
Track, fill, node and all ten bubbles share one centre line **by construction**. This replaced three
independent guesses reconciled by `-translate-x-1/2` — a three-way agreement that had to be re-derived
by hand every time a size or breakpoint moved, and had already broken. The `,2rem` fallback keeps a
card usable outside the `<ol>`.

### 9.4 Active-step detection — the middle 10% band

```tsx
<motion.li viewport={{ margin: "-45% 0px -45% 0px", amount: "some" }} onViewportEnter={onEnterView}>
```
Negative 45% margins shrink the intersection root to the middle 10% of the viewport; `amount: "some"`
fires the moment a reader would say "I'm on this step now", in both scroll directions. The **reveal**
uses different thresholds and therefore lives on a **different element** — `whileInView` +
`{ once: true, amount: 0.25 }` on the inner card `<div>`. Merging them breaks one or the other.

### 9.5 The rail (`lg` and up only)

`<aside className="hidden lg:block"> → <div className="sticky top-28"> → <div className="panel p-5">`.

- **Ring:** `RING_RADIUS = 34`, `RING_CIRCUMFERENCE = 2π·34 ≈ 213.63`, `viewBox="0 0 80 80"`, `cx/cy 40`,
  `strokeWidth 6`, `strokeLinecap="round"`, svg `h-20 w-20 -rotate-90` so the arc starts at twelve
  o'clock. `strokeDasharray = CIRC`, `strokeDashoffset = useTransform(progress, [0,1], [CIRC, 0])`.
  Track `className="stroke-line-200"` (themed, inverts); arc a **literal** `stroke="oklch(0.47 0.198 305)"`
  (brand purple does not invert).
- **Percent readout** is the only part that needs React: `useMotionValueEvent` + `Math.round(clamp)` +
  set only when the integer changed → ≤100 renders for the whole page, not one per frame.
- **Active readout:** `AnimatePresence mode="wait" initial={false}` + one keyed child + `swapVariants`.
- **Step list:** real `<motion.button>`s inside `<nav aria-label="Walkthrough steps"><ol>`, with
  `aria-current="step"`, `whileHover={{ x: 3 }}`, `whileTap={{ scale: 0.98 }}`. The active marker is a
  single `<motion.span layoutId="guide-rail-marker" className="absolute inset-y-1 left-0 w-[3px]
  rounded-full bg-purple-700" />` rendered **only** in the active row, so it slides between entries.
  Bubbles are filled purple for `index <= activeIndex`, `bg-surface-50 … ring-1 ring-line-200` after.

### 9.6 The card, its reveal, and its accordion

Reveal: `staggerParent(reduce)` + four `riseItem(reduce, 10)` children in DOM order — icon tile, label
row, summary, chevron: **the reading order, enforced in time**.

Accordion (one card open at a time; the first is open on arrival so the shape of a step is obvious):
```tsx
<AnimatePresence initial={false}>
  <motion.div key="detail" id={panelId}
    initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
    transition={reduce ? { duration: 0 } : { height: layoutSpring(false), opacity: { duration: 0.18 } }}
    className="overflow-hidden rounded-b-lg">
```
Three synchronised companions: `<motion.li layout={reduce ? false : "position"}>` so the page grows
instead of snapping; the bubble `animate={{ scale: expanded && !reduce ? 1.12 : 1 }}`; the chevron
`animate={{ rotate: expanded ? 180 : 0 }}` — both `springy(reduce)`.

⚠ **The card is deliberately NOT `overflow-hidden`.** Its toggle is a full-width button flush with the
card's edges and the global focus ring is an `outline` at `outline-offset: 2px` — clipping the card
would erase that ring on three sides. **Only the panel clips, and it clips itself.**

⚠ **`aria-controls` is conditional** (`expanded ? panelId : undefined`): `AnimatePresence` removes the
panel on collapse, and pointing at a missing id is worse than not pointing.

### 9.7 Pointer influence — one wash, and nothing on the cards

**There is no tilt, no parallax and no cursor spotlight on the step cards.** Despite the feature being
described as a "mouse-guided card walkthrough", the only pointer-position effect in the whole area is
the hero band's wash. Do not add tilt "back" — it was never there. The cards respond to the pointer
only through discrete springs (card `y: -2` / `scale: 0.995`; rail `x: 3` / `scale: 0.98`; outro tile
`y: -3` / `scale: 0.99`; hero CTA `y: -2` / `scale: 0.97`).

The wash (`GuideHero.tsx`):
```ts
const pointerX = useMotionValue(50), pointerY = useMotionValue(50);   // percentages, rest = centre
const sx = useSpring(pointerX, { stiffness: 110, damping: 24, mass: 0.6 }), sy = useSpring(pointerY, …);
const glow = useTransform([sx, sy], ([x, y]) =>
  `radial-gradient(30rem 26rem at ${x}% ${y}%, oklch(0.648 0.19 305 / 0.42), transparent 64%)`);
```
applied to `<motion.div aria-hidden className="pointer-events-none absolute inset-0 -z-10"
style={{ backgroundImage: glow }} />` inside a `surface-dark relative isolate overflow-hidden` section.
Handlers are installed **only when motion is allowed**; `onPointerLeave` resets to 50/50. With no
pointer — touch, keyboard, reduced motion — the band is a legitimate static gradient.

### 9.8 The one GSAP timeline

`useGsapHeadline(reduce)` splits the hero `<h2>` into per-word `inline-block` spans **once**
(`if (!node.dataset.split)`; the trailing space is a text node **outside** the span so the line still
breaks and copies as prose), loads GSAP by **dynamic `import("gsap")`** (~70 KB — it must not sit in
every protected page's bundle), and builds
`gsap.timeline({ defaults: { ease: "power3.out", duration: 0.62 } })` with
`fromTo(word, { yPercent: 108, opacity: 0, rotate: 1.5 }, { yPercent: 0, opacity: 1, rotate: 0 }, index === 0 ? 0 : "<0.28")`.

**Why GSAP here and framer everywhere else:** framer's `staggerChildren` is a fixed delay between
siblings that each run their own transition, so a word starts only after the previous delay elapsed.
This headline wants each word starting **while the previous is still moving** — a negative relative
offset, which is a timeline primitive. `"<0.28"` says it in one argument. **GSAP owns exactly this one
thing**; a second GSAP animation would mean two systems fighting over the same properties.

### 9.9 Navigation, deep links, and `steps.ts`

- `scrollToStep(id, reduce)` is the **only** scroll primitive. Every card has `scroll-mt-28`; the rail
  is `sticky top-28` — the same 7rem, both clearing the island. If the island moves, both move.
- Rail `jump(id)` = `setExpandedId(id); scrollToStep(id, reduce)` — open **and** travel.
- Deep link on mount: read `location.hash`, **validate it against `GUIDE_STEPS`**, `setExpandedId`,
  then `requestAnimationFrame(() => scrollToStep(hash, true))` — one frame so the expanded card has its
  final height, and `reduce` forced **true** because smooth-scrolling a freshly loaded page is not a
  transition the reader initiated.
- `GUIDE_STEPS` is ten hand-ordered objects in field order: `workshop, craft, artisan, product, process,
  tool, questionnaire, media, review, view-data`. Nine documented fields: `id` (stable anchor),
  `label` (**Android-parity name — never invented**), `action` (the tile's verb), `icon`, `href`,
  `summary`, `why`, `fields[]` (**the real form labels, in screen order, "(required)" marked**),
  `watch[]`. Renaming a form field obliges a rename here **and** in `docs/WALKTHROUGH.md`.
- `GUIDE_STEPS[0].id` is indexed **unguarded** twice — the array must never be empty.

### 9.10 Accessibility contract

Every interactive element is a real `<button type="button">` or `<Link>` — tab order is DOM order.
Structure carries position: `<section aria-label>` → `<ol>` → `<li id={step.id}>`, and the rail's `<ol>`
marks `aria-current="step"`.

**There is deliberately no `aria-live` on the rail.** The readout changes every time a card crosses the
band; announcing it would interrupt a screen-reader user ten times per page for information they
already have. `aria-hidden` on: the whole spine, every bubble, the ring `<svg>`, the `{percent}%`, the
chevron, icon tiles, bullet dots, the outro's "→".

---

## 10. The numbered dot → card reveal (map, and the shared hook)

The pattern for **"something over there was picked — bring the matching row here and say which one"**.
Two views of one selection sit side by side: a graphic on the left, a list of cards on the right.
Clicking a mark is obvious on the graphic and invisible in the list, so:

1. **Scroll, but only as far as necessary** — up if above, down if below, **not at all** if already
   comfortably visible. A list that lurches on every click loses the row the reader was reading.
2. **Flash once** — a single pulse **plus** a ring that lingers. The pulse says "this one, just now";
   the ring is what survives a reader who looked away, and it is the **only** half that survives
   `prefers-reduced-motion`.

### 10.1 `components/hooks/useRevealRow.ts`

```ts
const { registerRow, containerRef, reveal, flashKey } = useRevealRow();
// container: <div ref={containerRef as React.RefObject<HTMLDivElement>} className="… lg:overflow-y-auto …">
// row:       <div ref={registerRow(key)} data-flash={flashKey === key ? "true" : undefined} className="fr-flash-row …">
// trigger:   reveal(key)
```
- `FLASH_MS = 1400` — long enough to be seen after a smooth scroll, short enough not to read as a
  persistent selected state (the row has its own permanent selected styling).
- `EDGE_PADDING = 24` — the slack that decides "already visible", so a row peeking in by 3px still
  gets scrolled properly.
- **It measures the container at call time** (`scrollHeight > clientHeight + 1`) rather than reading a
  breakpoint in JS: the same component is an independent scroller on a wide screen and ordinary page
  flow on a phone, and a media query in JS would be a second source of truth for what CSS decides.
  Container branch → explicit `scrollTo` centring; otherwise → `scrollIntoView({ block: "nearest" })`.
- **`scrollIntoView` alone cannot serve the container case:** it scrolls *every* scrollable ancestor
  including the document, which drags the page out from under a map that was deliberately pinned.
- The scroll is deferred one `requestAnimationFrame`, and that is load-bearing: `reveal` is called from
  an effect in the same commit that may have inserted a panel **above** the rows, so measuring now
  measures the layout the row is about to leave. It also lets a freshly-expanded disclosure lay out.
- Re-arming clears `flashKey` first so the attribute goes false → true and the CSS animation restarts;
  without it, clicking the same dot twice pulses once.

### 10.2 The CSS half (`globals.css`, `@layer components` + one keyframe)

```css
.fr-flash-row[data-flash="true"] {
  outline: 2px solid var(--purple-700);   /* STATIC — survives reduced motion */
  outline-offset: 2px;
  animation: fr-row-flash 700ms ease-out 1;   /* ONE pulse, not a loop */
}
@keyframes fr-row-flash { 0% { background-color: oklch(0.47 0.198 305 / 0.22) }
                          60% { background-color: oklch(0.47 0.198 305 / 0.1) }
                          100% { background-color: transparent } }
```
`outline` rather than `box-shadow`/`border`: these rows already carry a conditional selected border and
a focus-visible ring, and an outline stacks with both without changing the box. Driven by a
**`data-flash` attribute**, not a class, so React can flip it without touching the className a dozen
conditional styles are composing.

### 10.3 Caller pattern (`app/(protected)/map/page.tsx`)

- The reveal must happen **after** the render that reflects the new selection, so a
  `pendingReveal: { key, nonce }` state is the signal and an effect does the work. **The nonce is what
  makes clicking the same pin twice flash twice.** Carry it in state, never a ref — a ref written in a
  handler and read by an effect is exactly what React's compiler lint refuses, and rightly: the render
  that shows the flash would not be scheduled by the write.
- **Two independently scrolling panes from `lg` up.** Both columns get
  `lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7.5rem)] lg:overflow-y-auto lg:overscroll-contain`
  (`overscroll-contain` stops a gesture reaching the end of one pane from lurching the page). Below
  `lg` neither rule applies — one column, the page scrolls; a nested same-axis scroller on a touch
  screen is a gesture nobody can aim.
- **Ordinals are the shared name for a row across both views.** Derived from the array order
  (`index + 1`), never from a layout pass — the map's pin layout reorders while resolving collisions,
  and a number that depended on it would change as pins were nudged. The list prints `3.` on the row;
  the map prints `3 · Jaipur` in the **hover label**, never inside the pin (the pin already carries a
  number — its record count — and two numbers on a 9px disc make both unreadable).
- Selecting also **opens the row's disclosure** when it has children: at NATION/STATE level the row a
  reader lands on IS the whole selection, so what they want next is what is inside it.
- **Drill-down** (choosing a child) parks the intent in state and lets an effect apply it once the
  response for the requested level has arrived — guarded on `data.level`, not the local `level`, which
  changes the instant the reader clicks while the points are still the previous level's.

### 10.4 Android parity (`android/.../ui/MapScreen.kt`)

A phone has one column, so the equivalent of two pinned panes is a **bounded list that scrolls inside
its own card** (`LIST_MAX_HEIGHT = 440.dp`, size modifier **before** `verticalScroll`): the map stays
put while a reader works through the places, and only when the list runs out does the gesture pass on.
A nested same-axis scroller is legal **because** the height is bounded — unbounded is measured with an
infinite budget and throws. Reveal uses `BringIntoViewRequester` (minimum-distance, same rule as
`block: "nearest"`), re-keyed on a nonce; the flash is an `Animatable` read from `drawBehind` (a repaint
of one row, not a recomposition per frame) plus a **static border** while flashing, held at a constant
under `LocalAppPreferences.current.reducedMotion`. `FLASH_MILLIS = 1400L` — the web's number to the ms.

---

## 11. UI primitives (`components/ui/*` and the shared display components)

### 11.1 The eleven-plus recipe classes (`@layer components`)

| Class | Renders |
|---|---|
| `.field-input` | `w-full rounded-md border border-line-200 bg-card px-3.5 py-2.5 text-sm text-ink-900 outline-none transition placeholder:text-ink-300 focus:border-purple-600 focus:ring-4 focus:ring-purple-600/15` |
| `.field-label` | `text-xs font-medium uppercase tracking-wide text-ink-500` |
| `.field-button` | `inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-purple-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-purple-800 hover:shadow-cta disabled:cursor-not-allowed disabled:bg-line-200 disabled:text-ink-500 disabled:shadow-none` |
| `.field-button-secondary` | same box, `border border-line-200 bg-card text-ink-900`, `hover:border-purple-300 hover:bg-purple-50`, `disabled:opacity-60` |
| `.field-danger` | `border border-red-200 bg-card text-error-600 hover:bg-error-100` (⚠ reaches outside the palette for `red-200`) |
| `.panel` | `rounded-lg border border-line-200 bg-card shadow-sm` |
| `.display-title` | `font-display font-bold tracking-tight text-ink-900` |
| `.surface-dark` | `rounded-lg bg-purple-950 text-white` |
| `.section-band` | `rounded-lg bg-surface-50` |
| `.eyebrow` | `text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-purple-700` |
| `.file-trigger` | dashed purple-300 upload trigger |
| `.fr-flash-row` | §10.2 |
| `.nav-sheet` / `.nav-sheet-overlay` / `.nav-island-frame` | §7 |

`@layer utilities`: `.grad-brand`, `.grad-mesh`, `.text-gold-gradient`, `.glass-card`, `.glass-dark`,
plus legacy aliases `.ambient-light`, `.text-gradient-violet`.

⚠ **`cn()` in `lib/utils.ts` is `classes.filter(Boolean).join(" ")`** — not `tailwind-merge`, and
neither `clsx` nor `tailwind-merge` is a dependency. Later classes do **not** win; CSS source order
decides. A `@layer components` class is always beaten by any utility (so `class="field-button w-full"`
works), but to beat another **utility** you need `!` (e.g. `!bg-transparent`).

⚠ **Content globs are `./app`, `./components`, `./lib` only, `.ts`/`.tsx`.** A class written elsewhere,
or built by string concatenation, is purged. Always write complete literal class strings.
⚠ `postcss.config.js` loads only `tailwindcss` + `autoprefixer` — **no nesting plugin**. Arbitrary CSS
nesting in `globals.css` will not compile; `@layer` blocks and plain at-rules do.

### 11.2 Which primitives are live, and which are dormant

**Dormant (zero call sites): `ui/input.tsx`, `ui/separator.tsx`, `ui/scroll-area.tsx`.**
`ui/button.tsx` has exactly one consumer, `app/login/page.tsx`. Everything else uses the `.field-*`
recipes. **Do not "standardise" a data screen onto `Button`/`Input`** — `Input`'s `rounded-lg` (16px)
and `ring-[3px] ring-ring/20` already disagree with `.field-input`'s `rounded-md` (12px) and
`focus:ring-4 focus:ring-purple-600/15`.

### 11.3 `Accordion`

**Unmounts its children when closed** — a behavioural contract, not an optimisation. `onOpenChange`
fires on **every** toggle, so a lazy loader must guard with a ref (a mount effect re-fetches on every
open), and any in-progress local state inside a panel is destroyed on collapse: hold it in the parent.

### 11.4 `AnchoredPopover` — the only out-of-flow positioner

`FLOATING_Z = 70` when portalled to `<body>`, 50 inside a dialog. `GUTTER 8`, `MIN_PANEL_HEIGHT 220`,
default offset 6, `CLOSE_ON_SCROLL_GRACE_MS 600`. Data attributes: `data-anchored-popover`,
`data-side`, `data-strategy`.

- It deliberately does **not** clear the last placement on close (`AnimatePresence` keeps the panel
  mounted for its exit, and a null placement falls back to top/left 0 — the panel jumped to the corner).
- **Do not add a `visibility: hidden` measuring guard.** A `visibility: hidden` element cannot take
  focus, and react-day-picker focuses a day in a mount effect — opening with the keyboard left focus
  behind on the input. The entrance already starts at `opacity: 0` and placement runs in a layout
  effect, so nothing unpositioned is painted.
- Escape is bound to **`window` with capture** and calls `stopPropagation`; `FieldDialog` listens on
  `document` in capture and registered first, so a picker inside a dialog would otherwise close the
  whole dialog. A module-level `popoverStack` ensures only the topmost popover reacts.
- The scroll listener uses `capture: true` (scroll does not bubble). Only **user** scroll/resize may
  CLOSE it; the `ResizeObserver` may only move it — running the close check on every reposition made
  the popover dismiss itself a few hundred ms after opening.
- Flipping requires **both** `height > roomBelow` **and** `roomAbove > roomBelow`.
- Inside a dialog it is `position: absolute` and offsets are corrected by the host's border widths
  minus its scroll offsets (offsets are measured from the padding box; `getBoundingClientRect` reports
  the border box).

### 11.5 `SearchableSelect` / `SearchableMultiSelect`

`SEARCH_THRESHOLD 8`, `RENDER_CAP 80`, `SUMMARY_NAMES 6`, `PANEL_MAX_WIDTH 520`,
`PANEL_CLASS "!overflow-hidden !p-0 flex flex-col"` (the `!`s beat `AnchoredPopover`'s own
`overflow-y-auto p-3` — see the `cn` note), list `max-h-72`, typeahead window 700ms.

- **Highlight is derived through `safeHighlight` every render, never trusted raw** — a stored index goes
  stale the instant the filter changes, and Enter would commit a row that is not on screen.
- **The 80-row cap pins already-selected options to the TOP.** Without it India (~100th of 246 dial
  codes) reopened the picker with no tick anywhere — the control lying about its own state. Filtering
  and select-all still see every match; only drawing is capped.
- **"Select all" acts on the FILTERED set** and says which (`Select 6 matching` vs `Select all 74`).
  Ctrl/Cmd+A was dropped: inside a text box that chord already means "select the text I typed".
- `containEvents` stops `keydown`/`input`/`change` propagation: a portal leaves the panel in the React
  tree, and every record form is `<form onInput={markDirty} onKeyDown={handleFormEnter}>` — typing in a
  filter armed the unsaved-changes prompt, and Enter hit `focusNextField`, whose `closest("form")` is
  null for a body-portalled node and fell back to the whole document.
- `useFilterBoxFocus` defers focus one rAF and only claims it from the trigger or from nothing — refs
  attach bottom-up, so inline focus ran while the ancestor panel ref was null; and options arriving
  over the network (1.8s on /tools) can grow a filter box seconds later.
- **Neither this nor `AnchoredPopover` traps focus, on purpose.** `useEdgeTab` intercepts only the two
  ends. A picker that swallows the keyboard is worse than the `<select>` it replaces.
- Single-select typeahead **changes the value** when closed; multi-select typeahead only **moves the
  highlight** — a multi-select must never tick a box from a keystroke aimed at finding one.

### 11.6 `Toast`

`DEFAULT_DURATION 5000`, `MAX_VISIBLE 3`, viewport `z-[110]`, bottom-right (clear of the island).

- Mounted **once** in `app/layout.tsx`. A nested provider renders a second `aria-live` region that
  screen readers announce twice.
- **The viewport renders even when empty** — assistive tech only announces mutations inside a region
  that already existed.
- The countdown **banks elapsed time in a ref** when paused; without it, hovering keeps a toast alive
  forever. It pauses on **focus** as well as hover so a keyboard user reaching Dismiss does not lose it.
- `aria-live="polite"` never interrupts → **a toast is the wrong home for anything the user must act
  on.** Use a dialog.

### 11.7 `Calendar` (react-day-picker) and the `.rdp-root` bridge

- **Put CSS variables on `className`, never on `classNames.root`.** The library composes
  `[classNames.root, props.className]` but builds `classNames` as `{...defaults, ...yours}` — overriding
  `root` drops `rdp-root` and with it `.rdp-root { position: relative }`, the containing block the
  absolutely positioned month nav needs.
- Selection paints the **button**, not the cell, so the 36px pill survives inside an edge-to-edge range
  band. `:hover` must be restated on `selected` or the neutral wash greys out the day under the pointer.
  `today`/`outside` must be guarded with `[&:not([data-selected])>button]:…` — either can also be a
  range endpoint and an unguarded rule ties on specificity.
- Tokens on `.rdp-root` in globals.css: `--rdp-accent-color: oklch(0.47 0.198 305)`,
  `--rdp-accent-background-color: oklch(0.977 0.013 305)`, `--rdp-today-color`, `--rdp-outside-opacity: 0.6`.
  ⚠ `calendar.tsx` sets that last one to `1` and globals wins at equal specificity; it is inert in
  practice. ⚠ globals references a `.cal-middle` class the component no longer emits (`range_middle`).

### 11.8 `GlassSurface` / `useLiquidGlass`

Requires a **translucent** background from the caller (the filter refracts what is behind; an opaque
fill paints over the result). **Glass must never be nested** — an ancestor with its own
`backdrop-filter` or `opacity < 1` becomes the backdrop root. Each instance builds its own canvas map
and SVG filter, so it belongs on cards and panels, **never on list rows or anything rendered in bulk**.
`color-interpolation-filters="sRGB"` is mandatory (linearRGB re-maps neutral grey 128 and injects a
constant phantom displacement). The shared `<defs>` host is a 0×0 SVG, not `display: none`, which would
break `feImage`. The classes toggled are `lg-active` / `lg-fallback`; the companion recipes are
`.glass-card` / `.glass-dark` (`.liquid-glass` does not exist).

### 11.9 The small display components

- **`StatusBadge`** — amber/success/error tones are **literal hex**, so PENDING/APPROVED/REJECTED do
  **not** re-tint in dark mode; only DRAFT and NEEDS_REVISION follow the theme. Adding a status needs
  entries in **both** the `tone` and `label` maps — omit the label and it silently falls through to
  `humanize()`; omit the tone and it silently paints DRAFT grey.
- **`EmptyState`** hardcodes an `<h2>` and the `Archive` icon with no props — dropping it into a section
  that already has an `<h2>` inserts a second level-2 heading.
- **`Pagination`** prints `Page 0 of 0` on an empty list deliberately. No `<nav>`, no `aria-label`, no
  `aria-current`, no live region: disabled Previous/Next are the only end-of-range cue.
- **`ResizableTh`** — its `overflow-hidden` is required by CSS: `resize: horizontal` has no effect on an
  element whose overflow is `visible`. Removing it kills column resizing across every list table.
- **`SearchInput`** sets `role="searchbox"` on a text input with **no label** — the accessible name is
  only the placeholder. The clear button *is* labelled.
- **`DashboardCard`** picks its icon from the **wording** (`newLabel === "Open" || "Manage"` →
  ArrowRight, else Plus) because a plus on a button that only navigates is a lie; Android draws the same
  distinction via `primaryIcon`.
- **`Markdown`** deliberately omits `rehype-raw`, so raw HTML in a transcript stays escaped. Transcripts
  and AI text are Markdown (bold speaker labels, `---` rules) — never raw text in a `<pre>`, never
  `dangerouslySetInnerHTML`.
- **`AudioPlayer`** re-reads duration inside `onTimeUpdate` because fresh WebM streams report
  `Infinity` until played through. ⚠ Its inline `--audio-range-fill` hardcodes `#e4e2ef` — the **light**
  value of `--line-200` — so the unplayed track does not invert. This is a known leak, not a pattern.
- **`min-w-0`** appears in `Field`, `Accordion`, `SearchableSelect`'s wrapper and the login buttons and
  is load-bearing every time: a grid/flex item defaults to `min-width: auto` and refuses to shrink below
  its content's intrinsic width, so a long option label widens the column and spills over the field
  beside it. **`truncate` cannot save it** — truncation clips inside a box that has already grown.

---

## 12. Forms and record editing

### 12.1 The shell

Every record form is **uncontrolled `FormData`** plus a fixed set of handlers:

```tsx
<form ref={formRef} key={editing?.id ?? "new"} onSubmit={submit}
      onInput={() => setDirty(true)} onKeyDown={handleFormEnter}
      className="panel mb-5 grid gap-4 p-4">
```

⚠ **`new FormData(event.currentTarget)` MUST be the first statement of `submit`, before any `await`.**
React nulls `event.currentTarget` across an await.

⚠ **Themed dropdowns are `<button>`s and fire no native input event**, so `onInput={markDirty}` never
sees them. Every `Select`/`Dropdown`/`ComboBox`/media picker must call `markDirty`/`onDirty` by hand.
The reverse trap also exists: `WorkshopSelect` wraps its ComboBox in `onInput={e => e.stopPropagation()}`
because its search box **is** a real text input — without the firewall, merely typing to filter armed
the unsaved-changes prompt, so a user who searched, picked nothing and pressed Escape could not leave.

### 12.2 The zero-size mirror-input pattern

Every themed control submits through an invisible twin so the browser still validates it.

- **`Select`'s mirror is `type="text"`, not `type="hidden"`** — hidden inputs are exempt from constraint
  validation, so a `required` Select would never block submission. It keeps `tabIndex={-1}` and
  `aria-hidden="true"`.
- **`DosDontsField`'s mirror must be a `<textarea>`** — an `<input>`'s value-sanitization algorithm
  strips CR/LF, which stored every multi-point Do's/Don'ts as one run-on string `splitNumbered` could
  never split back.
- `MultiNoteField` gets away with an `<input>` only because its mirror **is** `type="hidden"`.
- ⚠ **`lib/formNav.FOCUSABLE` excludes `[tabindex="-1"]` precisely so the Enter-walker never lands on
  these twins.** Removing that exclusion makes focus vanish and the form look broken. Textareas are
  excluded explicitly (Enter must still type a newline), not detected by size or name.

### 12.3 Labels: `Field` (a `<label>`) vs `FieldBlock` (a `<div>`)

**A `<label>` forwards a stray click to the first labelable control inside it.** Wrapping a
`MultiSelectDropdown` in `Field` slams the menu shut after ONE pick, so Confirm is never on screen long
enough to click (verified in the browser). And a wrapping `<label>` folds every named descendant into the
input's accessible name — `DateField` announced itself as "From Open calendar".

→ **Dropdowns, date fields and anything containing a button use `FieldBlock`, or a plain
`<div className="grid gap-1"><label htmlFor>…</label><Control id/></div>`.**
A `<label>` also cannot name a `<button>`, so `Field` + `Select` gives the trigger **no** accessible
name unless `aria-label` is passed explicitly.

⚠ `optionText()` **recurses** rather than testing `typeof children === "string"`. The string test failed
for the app's standard `{artisan.name} · {artisan.place}` label (an array), so three live dropdowns
offered raw CUIDs — two of them required artisan pickers, and on `/questionnaire` the artisan chosen
decides `artisanSetKey`, i.e. which interview a submission folds into. Do not simplify it back.

### 12.4 Dirty tracking and the leave guard

`useLeaveGuard(dirty, onBlocked)` registers an interceptor **through a ref inside an effect with no
dependency array** — a render can be discarded under concurrent rendering, and a ref written on a
discarded render would leave the interceptor reading state that never committed. Its cleanup
`register(null)` is what stops a saved-and-navigated form blocking the **next** page's back button.

⚠ Values **the app filled in** must not count as dirty. `ProcessForm` neutralises `workshopId` until
`workshop.touched` and `artisanId`/`productId` while they equal the carry-forward context; `acceptFix`
(automatic GPS) deliberately does **not** raise the flag — a blank new form announcing unsaved work
before anybody types trains researchers to click through the guard, which must still mean something an
hour later when there IS an interview in the form. `Use current GPS` and map pins DO raise it.

### 12.5 Location capture (`components/forms/LocationFields.tsx`)

The two-group split: **stated address** (where the subject is) vs **captured at** (the device fix). Read
that file's header before changing anything; the highlights:

- **An edit form NEVER auto-captures location.** `isEditForm = initial !== undefined`, so passing
  `initial={null}` still counts as an edit; **omitting `initial` is the only thing that switches
  auto-capture on.** An edit is as likely to be open on a desk in another state a week later, and
  stamping the editor's chair onto a Bagru record is the failure the file exists to end.
- **`OFFLINE_STATES` is derived by flattening `POSTAL_ZONES`**, not hand-copied. It exists because the
  state list came only from `GET /reference/address`: offline the list was empty, a **required** closed
  list had no members, native validation refused the submit, `saveOrQueue` was never reached, and the
  interview plus its photographs died with the tab. The 795 districts genuinely cannot be bundled, so
  the district **stands down from required** instead — *a field may only be mandatory where it is
  answerable.* Both `stateRequired` and `districtRequired` end in `&& options.length > 0`.
- **MapTiler's Indian hierarchy: `region` is the STATE, `subregion` is the DISTRICT.** `county` is the
  trap — it answers "Sanganer Tehsil" for Bagru: a real name at the wrong level, plausible enough to be
  saved. On sixteen real coordinates `subregion` was right fifteen times.
- **A blank geocoded pincode must be WRITTEN, not skipped.** `if (code)` is character-for-character the
  bug that put a Bagru PIN on a Dehradun record: ~95% of sampled rural Indian points return no postal
  code, so a stale value surviving was the usual outcome. "Use this place's address" means this place's,
  **including the parts that are empty.**
- **A geocoded district may only be written where the geocoded STATE stands.** "Bilaspur" is a district
  of Chhattisgarh *and* a different one of Himachal Pradesh; independent writes produced Rajasthan +
  Kachchh — a pair that exists nowhere.
- `explicitPending` (a ref) alongside `autofill.mode`: `watchPosition` re-reports about once a second,
  so without it a satellite update arriving mid-lookup silently aborts the pin's rural lookup.
- The offline replay compares coordinates **as strings** — an identity test, not a distance one, because
  "Remove pin" clears them and leaves the ref standing.
- The suggestion is cleared when the request **goes out**, not when it returns — the seconds in between
  are exactly when the last place's offer sits under this place's coordinates.
- Inside the location card use `amber-100`/`amber-800`; the suggestion chip's secondary button uses
  literal `border-purple-300 bg-white text-purple-800` rather than `field-button-secondary`, because
  that class is `bg-card` over `text-ink-900` and both invert while the fixed lavender chip does not.
- The provenance card is the **same plain card** as every other section — nothing else in the app has a
  dashed border, so "different" landed as "unfinished". Hierarchy is order and disclosure alone.

### 12.6 Workshop selection and the shared scope

- `useWorkshopSelection()` — the per-form picker. `confirmSubmission()` must be awaited **after**
  `new FormData(...)` and **before** `setSaving(true)`. `fetchCheck` caches only successful answers, and
  it **never blocks**: a researcher in the field must not lose work to a flaky pre-flight.
- `useWorkshopScope()` / `WorkshopScopeSelect` — the shared list-scoping vocabulary. **Empty means
  "all", by absence**; the reserved word `"none"` means "not linked to any workshop". Listing every id
  would silently exclude workshops created after page load. Same rule in `filters.types`: **empty means
  everything**, so "nothing ticked" and "everything ticked" cannot both exist and mean the same thing.
- `workshopOccurrenceDate` is **re-exported** from `forms/WorkshopSelect` into `FunnelFilters` and
  `WorkshopScopeSelect` rather than re-implemented, and every consumer re-sorts client-side rather than
  trusting the API's order — getting "which workshop is most recent" wrong picks the wrong default
  silently, and the form and the filter would then disagree about one list.
- ⚠ **`FunnelFilters` fires `onChange` exactly once after its lists load**, with the most recent
  workshop as the default, so a parent MUST wait for that call (`funnelReady`) or it double-fetches or
  renders against the wrong scope. Its documented failure mode is the one this repo keeps hitting:
  **a row predating the `workshopId` column is NULL and matches no workshop, so a list renders EMPTY
  over a full corpus** — indistinguishable from having no data. If it recurs, ask whether something is
  being created without a workshop, not whether the default is wrong. (`GET /workshops/unmapped` +
  `POST /workshops/unmapped/map` and the admin card on `/workshops` exist to close exactly that gap.)

### 12.7 Dates

- `parseDateInput` builds a **LOCAL** date from `yyyy-mm-dd` because `new Date("2026-07-20")` parses as
  UTC midnight — the previous day west of Greenwich.
- `DateRangeField.parseDate` does the **opposite** and reads UTC components, because the API stores
  start-of-day / 23:59:59.999 **UTC** while the picker reads local parts. Handing back `new Date(value)`
  meant merely opening a workshop and pressing Update re-saved the end date a day later, drifting again
  on each save (observed 12 → 13 → 14 Jul).
- react-day-picker's half-finished `{from, to: undefined}` after the first click is passed through
  **unchanged**. Filling `to` in looks tidier and breaks the interaction: a complete range makes every
  later click extend an endpoint, so a reader can never start a fresh range.

### 12.8 Regulated identity

- **Aadhaar:** post the mask (`"XXXX XXXX 9012"`) back **verbatim** — the API's
  `_drop_unchanged_masked_aadhaar` recognises it. **Never strip the Xs** (that turned the mask into
  "9012" and would have overwritten a real number). Block through `setCustomValidity` on the **visible**
  box, never the mirror, and enforce `required` through the same custom validity rather than the native
  attribute — with both set, which sentence the browser shows is up to the browser.
- **Pehchan:** **OMIT** the field entirely when masked. `validate_pehchan` does **not** recognise a
  mask — it normalises `"XXXX XXXX 3456"` to `"XXXXXXXX3456"` and stores it over the real card number,
  then refuses the next artisan who genuinely holds that card on the unique index.
- Answering "No" to Pehchan **clears** the number, not just disables the input: a disabled input is
  omitted from FormData, so a stale number would survive in React state and reappear on flip-back.
- `Artisan.aadhaarNumber` arrives **full** from `GET /artisans/{id}` and **masked** from the data
  browser, the .xlsx and the CSVs — one field name, two shapes. **Never render it in a list, card or
  export view.**
- `sanitizeCarryContext` is an **allowlist** with deliberately no field an Aadhaar or Pehchan could
  occupy: field laptops are shared, and regulated PII must never be copied between records or parked in
  localStorage.

### 12.9 Carry-forward context

`useCarryContext` resolves a carried prefill **once**. It treats "not visible to me" and "no signal"
differently: a `loaded` scope missing the id prunes silently, but an `unavailable` scope leaves the
offer standing — suppressing the prefill exactly when the network is down would disable the feature in
the conditions it was written for. **There is deliberately no dismiss-that-keeps-the-values** on
`CarryContextBanner`: hiding the banner while leaving the fields filled recreates the hazard it removes.
Call `carry.prune(node)` **before** `carry.remember(...)` when the researcher overrules an offer.

### 12.10 Media capture

- **Upload starts at attach time** (eager pre-upload), so "Discard" on a tile also aborts its transfer
  and deletes whatever reached storage. Never assume attached files are inert until save;
  `uploadMediaBatch` recognises already-staged files so no call site has to know.
- Ask **`pickAudioRecorderMimeType()`** — never hardcode `audio/webm`. Safari/iOS produces `audio/mp4`,
  and a wrong extension lies about the bytes and breaks both playback and transcription.
- The recording clock is a 250ms interval; the waveform bars are `<Waveform>`'s own rAF loop, which owns
  and tears down the AudioContext — do not add a second timer. `releaseStreamOnUnmount` defaults
  **false**: the recorder that opened the microphone owns the track lifetime.
- Under `prefers-reduced-motion` the Waveform has **no canvas at all** — a numeric percentage bar
  sampled every 250ms. Do not "fix" the missing bars.
- `Waveform`'s `PITCH_RAMP` is hardcoded sRGB hex, not tokens: canvas `fillStyle` support for `oklch()`
  is not universal and a rejected fillStyle silently keeps the previous colour.
- Object URLs are revoked in the effect cleanup that created them — building the list and the
  revocation in one effect is what keeps them paired.

### 12.11 Error surfacing — four treatments, chosen by meaning

1. **Field-level** — `setCustomValidity` on the visible control (validation bubbles).
2. **Panel banner immediately above the buttons** — `ReviewEditPanel` is a dozen boxes tall, so a
   top-pinned 422 looks like a button that did nothing.
3. **Page-level banner** under `PageHeader` — `mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2
   text-sm text-red-700`.
4. **Toast** — only for transient notices nobody must act on (`aria-live="polite"` never interrupts).

`readableError` exists because `apiFetch` builds `ApiError.message` with `String(detail)` and FastAPI's
422 detail is a **list** that stringifies to `"[object Object]"`. Use the exported `describeApiDetail`;
two private re-implementations already exist and a third must not.

### 12.12 Dialogs

`FieldDialog` is the one modal primitive (`zIndex` default 100, `data-field-dialog` /
`data-field-dialog-overlay` so `AnchoredPopover` can portal into it, `data-tone`).

- **`surfaceClassName` REPLACES `bg-card` + `TONE_RING[tone]`** — two competing `bg-*` utilities resolve
  by stylesheet order, not class-string order. Only `DuplicateArtisanDialog` overrides the surface,
  because its amber wash **is** the message.
- **Dialogs with three ways forward set `showClose={false}`.** An X would have to silently mean one of
  the three. Escape and the backdrop resolve to the option that loses nothing, and `initialFocusRef`
  points at that same button so a reflex Enter is never destructive.
- **Danger-tone confirm:** initial focus on **Cancel**, backdrop refuses to dismiss, role
  `alertdialog`. No reflex click or Enter can delete anything.
- Focus restoration uses a refcounted document `focusin` tracker, not `document.activeElement` at open
  time: a trigger very often disables itself in the same handler that opens the dialog ("Save artisan" →
  "Checking…") and the browser drops focus to `<body>`. Restoration happens on the next
  `requestAnimationFrame`, not synchronously.
- A **non-dismissable** dialog still calls `preventDefault()`/`stopPropagation()` on Escape, so the key
  cannot reach a parent dialog.
- `ConfirmProvider` answers a superseded request with `false` and resolves `false` on unmount, or an
  awaiting handler hangs on a promise nobody can settle.
- `LateSubmissionDialog` is `zIndex={105}` because `UnsavedChangesDialog` stays mounted while its own
  Save runs the submit that opens it — an equal z-index would cover "Submit anyway".
- ⚠ Every list page now uses the shared `CollabDialog`. The hand-rolled overlay that used to sit
  inline in `crafts/page.tsx` (`fixed inset-0 z-50 bg-black/40` — no trap, no Escape, no focus
  restoration, no scroll lock) is gone. **Reuse the component, never that markup.**

### 12.13 The visual anatomy of a form screen, top to bottom

`PageHeader` (back arrow + icon chip + title + description + actions) → error banner → carry-forward
banner → `<form className="panel mb-5 grid gap-4 p-4">` → a `grid gap-3 md:grid-cols-2 lg:grid-cols-4`
of `Field`s → full-width sections (`MultiNoteField`, pickers) → `LocationFields` → existing media (edit
only) → `MediaCaptureField` → `SaveButton`. Status is a locked `StatusBadge` chip below professor.

---

## 13. Screen patterns

**Page frame:** `PageHeader` → banners → `panel`. A list screen is a panel-wrapped table using
`ResizableTh`, `StatusBadge` and `Pagination`; a selected row reveals an action strip of
`rowAction(tone)` entries in `RowActions`.

### 13.0 The two shapes of "edit a record", and the link each one needs

**There are exactly two, and a link that picks the wrong one loses the record id.**

| shape | types | the link |
|---|---|---|
| a real route | artisans, products, tools | `/{type}/{id}/edit` |
| an INLINE form on the list page | crafts, workshops, processes | `/{type}?edit={id}` |

The second group has no `/[id]/edit` route, so the id has to travel as a query parameter. Every link
that offered to edit one used to return the **bare list route** — `/crafts`, `/workshops` — which
renders that page's inline form in CREATE mode. So "Edit this workshop" and "New workshop" landed on
the identical blank form, the clicked record was nowhere on screen, and filling the form in produced
a SECOND record. It was wrong in six places at once (`/data`'s `editHref`, the dashboard's
`recordHref` **and** its Update tiles, `/search`, `DataSearchPanel`, the map's `RECORD_HREF`) because
each had independently decided the id was not carryable.

**Receiving side — always `useEditDeepLink` (`components/hooks/useEditDeepLink.ts`), never hand-rolled.**

```tsx
const { loading } = useEditDeepLink<Craft>({
  endpoint: "/crafts", basePath: "/crafts",
  targetRef: formRef,              // omit when the form REPLACES the page (/processes)
  onEdit: resetForm,               // the page's own seeder — not setEditing
  onNew: () => resetForm(null),    // OMIT to leave ?new=1 alone (see below)
  onError: setError,
  allowed: allowManage,
  errorMessage: "Unable to load that craft"
});
```

- **`onEdit` must be the page's full seeder, not `setEditing`.** On `/workshops` the two link pickers
  are React state, not form controls: seeding only `editing` shows the title and place with the
  artisan and craft rosters silently EMPTY — and saving then clears them.
- **The record is fetched BY ID**, never looked up in the list on screen: the caller arrives from
  another page and the row is usually not on page 1 of a 20-row list. (Android has always done this —
  `EditScreen` refetches behind a `LoadingCard`.)
- **Omit `onNew` when the page derives `?new=1` on every render** (`/processes`' `isNew`). It is a
  render MODE there, not a one-shot intent, and consuming it closes the create form as it opens.
- **Both parameters are one-shot and are stripped with `router.replace`** once applied — a parameter
  that survived would re-apply on every re-read and put a cancelled edit back under the Back button.
  The hook forgets its `handled` token when the URL is clean, which is what lets the *same* record be
  opened twice in a row.
- **The scroll is deferred one `requestAnimationFrame`** (the form remounts on `key={editing?.id}`
  and reveals edit-only blocks) and goes to `targetRef`, **not** `window.scrollTo(0, 0)` — on
  `/workshops` an admin has the mapping panel above the form. Give the form `scroll-mt-28`.
- `useSearchParams` needs a **Suspense boundary** (Next 16). Keep `UploadsProvider` OUTSIDE it.

**Sending side: never link to the bare list route for an edit.** If you are writing an `editHref`,
a `recordHref` or a `RECORD_HREF` entry whose signature takes an `id`, use it.

- **Create buttons are gated to `null`, not disabled** (`canCreateRecords(user)`): an ungated "New …"
  invites every tier to press a button that lands on a refusal.
- **Admin surfaces hide the link AND render a `RestrictedPanel` at the route.** A client guard that only
  hides a nav item is not a guard; the server predicates are the boundary.
- **Below-admin users on `/workshop-access/manage` are REDIRECTED** to the request page, while an admin
  with admin view off gets a panel. A rule that leaves someone nowhere to go is a bug even when its
  refusal is correct; silently rerouting an admin who turned the toggle off would look like a demotion.
- **List pages count fetch generations (`currentLoad` ref) instead of aborting** — `listResource` takes
  no signal, and what matters is ignoring the late answer.
- **`items === null` vs `items === []` is a deliberate distinction**: null renders "Loading…", `[]`
  renders the empty state. "No workshops to ask about" during a fetch is both wrong and discouraging.
- `ExistingMedia` only empties on a failed **first** load (`setItems(c => c ?? [])`); a later failure
  keeps what is on screen. Its 15s transcript poll runs only while one is in flight.
- **Bulk approval is sequential, not parallel**, collects failures instead of throwing, and leaves
  failed rows ticked. Only **Approve** is offered in bulk — a shared note across 25 rejections is not
  feedback. An effect prunes ticks pointing at rows another reviewer already decided.
- `ReviewEditPanel` posts **only changed keys** (the server writes a `RecordRevision` from the payload,
  so an untouched value would put a no-op line in the history forever) and **re-reads the record after
  Save** (the server title-cases name-like columns, so the boxes must show the normalised value or the
  next diff is wrong). `reviewEditFields` is a contract with Android's `reviewEditableFields` — change
  one, change the other.
- **`UploadTray` renders an `aria-hidden` spacer** mirroring the dock's measured height, or the fixed
  card sits on top of a form's submit button at the bottom of the page.
- `MediaLightbox` closes on a backdrop click **only when the mousedown also started on the backdrop**,
  so a drag that begins inside (text selection, seek scrubbing) does not close it.
- `OutboxBanner`'s `announcedCount` starts `null` and is set **only** by the completed
  `refreshOutbox()`, never the first render: entries survive a browser restart, so the mount snapshot is
  empty and the load looks like three saves arriving at once — which is how a researcher who opened her
  laptop the next morning, online, was told her week-old queue had just been saved with no connection.
- Every task/status tone carries **an icon and a worded label** — colour never carries meaning alone, so
  the judgement survives colour-blindness, greyscale printing and forced-colours mode.
- `progressGap` returns tone `idle`, not `match`, when both figures are zero: two zeroes agree, but
  agreeing about nothing is not an achievement, and a green tick on an untouched task reads as
  reassurance on exactly the row that deserves a chase.
- `describeTrouble` writes its own sentence per HTTP status because FastAPI's 404 body is the literal
  string "Not Found". **A failed load must not empty the screen** — the built-in default stays visible,
  explicitly labelled as not the live ranking.
- ⚠ The explicit `{" "}` after `<strong>not</strong>` is load-bearing: the JSX transform drops the
  leading space of a text node following an inline element, so without it the sentence reads
  "does notapprove it".

---

## 14. Data, auth and permission plumbing

### 14.1 `apiFetch`

The single HTTP entry point. `buildQuery` + `listResource` + `PageResult` on top.

- ⚠ **A build with a missing or blank `NEXT_PUBLIC_API_URL` silently falls back to
  `http://localhost:8000`** — every signal green while the deployed site reaches nothing. Hence
  `assertApiConfigured()`, which throws only in the browser, only on `https:`, only for a loopback base.
- `ApiUnconfiguredError extends ApiError` with **status 503 and no payload** deliberately: as a plain
  `Error`, `lib/offline.ts` would read it as "the network is down" and bank the save in the outbox — the
  same defect (failure reported as success) the class exists to end.
- **`buildQuery` drops `""` exactly as it drops null/undefined**, so an intentionally-empty value is
  unsendable — which is why "not linked to a workshop" is the reserved word `"none"`. Its parameter type
  is `Record<string, string | number | undefined | null>`: **no arrays, no booleans** — comma-join
  yourself (`ids.join(",")`); the backend's `resolve_workshop_ids` accepts that and repeated parameters.
- The 401 redirect uses `window.location.assign("/login")` and fires **only when a token was sent**, so
  the landing page's anonymous `/me` probe does not navigate a visitor off a public page. `apiFetch`
  never clears the token on 403; `AuthProvider.refreshMe` clears on 401 **and** 403 but deliberately
  keeps it on a network failure or 5xx.
- A 204 returns `undefined as T`; a non-JSON response returns the raw **text** cast to `T` — a typed
  call against a `text/plain` endpoint compiles and lies.
- ⚠ **There is no server-side data fetching anywhere** (the token lives in localStorage), so every page
  that reads the API is a client component. Only `app/layout.tsx`, `app/(protected)/layout.tsx`,
  `app/page.tsx` and the three `/new` pages omit `"use client"`.

### 14.2 Permissions, as the frontend sees them

Six-tier ladder: CROWDSOURCE(10) · FIELD_CONTRIBUTOR(20) · RESEARCHER(30) · PROFESSOR(40) · ADMIN(50) ·
MASTER_ADMIN(60). `ROUTE_GUARDS` is enforced by `AppShell` **above every page** because hiding a nav
entry only removes the link — `/users`, `/review`, `/data` and the create forms are one typed URL away.

- `canManageCrafts` / `canManageWorkshops` are **rank-only** even though the `User` still carries the
  booleans: a per-user grant that lifted a researcher over the taxonomy was invisible in the role
  column. **Deleting is stricter than editing** — a delete control needs `isAdmin`.
- `canReview` is `hasRank(user, "FIELD_CONTRIBUTOR")`, i.e. everyone except crowdsource volunteers. It
  reads elevated and is not; `/review` is deliberately **not** admin chrome and **not** `adminSurface`
  (flagging it once removed the link from an admin who still had the route).
- `/settings/api-keys` is `isAdmin`, not master admin — the earlier master-admin guard made the
  transcription provider ranking (`require_admin` server-side) unreachable for the people who asked for
  it. Key **values** stay master-admin, gated inside the page: an admin may TEST a key they may not
  read, because a verdict is not a credential.
- `ROUTE_REDIRECTS` is declared but **not enforced by `AppShell`** — only `/workshop-access/manage`
  performs it, locally. Declaring a redirect nobody performs would read as enforcement that is not there.

### 14.3 The offline outbox

IndexedDB store + subscription + `saveOrQueue`.

- `saveOrQueue` queues only when `isTransient(error) && !(error instanceof ApiError)` — so a 503
  (including `ApiUnconfiguredError`) is **not** queued: replaying a request the server actually answered
  would repeat a rejection forever and hide the real problem.
- **A 409 in the drain is NEVER read as "our create already landed."** No endpoint means that (a
  clashing Aadhaar, a craft of that name, the same artisan set already interviewed), and the old reading
  destroyed the queued record AND its photographs while reporting success. A 2xx with no readable `id`
  is marked failed with a captive-portal explanation rather than discarded.
- A media batch that **returns** (even partly failed) is marked uploaded and never replayed
  (`uploadMediaBatch` throws only when nothing landed, so a replay would duplicate). Once `created` is
  true the replay skips straight to the media — re-sending the body makes a second record, which is
  what duplicated every record whose upload was interrupted, once per pass, for as long as the signal
  stayed bad.
- A queued save shows **no per-form banner**: `OutboxBanner` in the protected layout is the one place
  that names the entry and says where it lives. A queued record has no id yet, so
  `ProductForm`/`ToolForm` call `carry.prune(...)`.

### 14.4 Media upload

presign → PUT → complete.

- `uploadMediaBatch` **throws only when every file failed**; a partly-failed batch resolves with a
  populated `failed[]`. **Every caller must inspect `failed` and name the filenames that did not make
  it** — treating a resolved promise as success silently loses files.
- Multipart is impossible from a browser unless the bucket's CORS lists **ETag** under ExposeHeaders.
  Part 1 is probed alone so this is discovered after 16 MiB rather than 400 MB; the session then falls
  back to single PUTs. Part PUTs deliberately send **no** Content-Type (the part presign does not sign
  it).
- The watchdog is a **stall** timer, never a flat deadline: a fixed five-minute timeout dooms a large
  video on a slow link and burns every retry. After the last byte there are no progress events at all
  (S3 finalising), which is why the second window is 5 minutes.
- `takeStagedFor` must run **synchronously before the first await** of a save, or a form that unmounts
  the instant it saves deletes the object the save is about to link. Its signature fallback honours only
  an **unambiguous** single match — attaching the wrong photo is far worse than re-uploading one.
- `releaseStagedOwner` waits 2s because StrictMode tears every effect down and re-runs it in
  development; `pagehide` skips deletion when `event.persisted` (a bfcache freeze may be restored).
- ⚠ **Media `url` and `objectKey` are gated server-side at the encoder** — a client that assumes
  `MediaFile.url` is present renders broken players for callers not entitled to the bytes.

### 14.5 Fetch race conventions

Three, and they are not interchangeable: a **generation counter** for list pages (ignore the late
answer), a **`cancelled` flag** for one-shot effects, an **`AbortSignal`** where the fetch accepts one
(the map). Debounced search and clicked filters must go through the **same** timer so the generation
guard stays the only race protection needed.

---

## 15. The public landing page

`app/page.tsx` + `components/hero/*`. It is prerendered and has **no auth and no `ThemeProvider`**, so:

- Use `useHeroReducedMotion()`, never `useAppReducedMotion()` / `guideMotion`.
- **Reduced motion changes DURATIONS, never the `initial` state** (the opposite of the guide's rule).
- Express hover as **CSS** (`transition hover:-translate-y-0.5 … active:translate-y-0`) so the
  globals.css reduced-motion rules neutralise it.
- The standard below-the-fold reveal is a local variant: `hidden { opacity: 0, y: 18 }` →
  `show { opacity: 1, y: 0, transition: { duration: reduce ? 0 : 0.5, ease: [0.16, 1, 0.3, 1] } }` with
  `viewport={{ once: true, amount: 0.3 }}`.
- `HowItWorks.tsx` reuses the guide's scroll spine **with the same numbers** on purpose, so the landing
  page and the walkthrough teach the same gesture.
- The printing bed (`PrintingBed.tsx` + `.fr-*` in globals.css) needs
  `transform-box: fill-box; transform-origin: 50% 50%` on `.fr-buti` — a CSS transform on an SVG element
  resolves its origin against the nearest viewBox, so `scale()` on an impression at (60, 90) would fling
  it to the corner. `.fr-map-label` is `display: none` below 640px because in viewBox units it renders
  under 9px — decoration pretending to be a label; every name is in the `<figcaption>` and the SVG is
  `aria-hidden`. Its stagger is a per-column `transition-delay` (which the reduced-motion CSS reaches),
  not a JS timer (which it cannot).
- Corpus census numbers come from a live endpoint with a **dated snapshot fallback**, and the fallback
  says its date rather than pretending to be current.

---

## 16. Android parity

Visual language = the tokens above. **Wording and structure = Android.**

**Dashboard heading:** "What would you like to do?"
**Tiles, in this order** (label / action): Artisan/Record artisan · Product/Record product ·
Process/Document process · Tool/Record tool · Questionnaire/Take interview · Miscellaneous Media/Upload
media · View Data/Browse records · Sharing/Share data access · Users/Manage users (admin) · Craft/Add
craft · Workshop/Record workshop.
**Menu extras:** My Activity · Tasks · Assign tools to artisans · Give app feedback · Settings (master
admin) · Admin view toggle. **Never invent a label for these.**

Grid: `grid-cols-2 md:grid-cols-3` — 2 per row on phones, 3 on tablets and laptops.
Card anatomy (Android `DashboardActionCard`): white `rounded-2xl` card, small dark-purple icon tile
(`rounded-lg`, light icon), display-font label, a filled purple "New …" button and an outlined "Update"
where editing exists.

**Hierarchy rules — mirror the backend exactly.** Review ladder: master admin reviews everyone;
everybody else reviews creators ranked **strictly** below them; decisions Approve / Reject / **Send for
revision** (mandatory comments → `NEEDS_REVISION`; a creator edit resubmits to `PENDING`). Activity
visibility: professor+ see everyone below their rank, admins see the same rank and below, master admin
sees all. Promotion: assign roles at or below your own tier (professor+); manage only users strictly
below your tier. Tasks: admins assign to users below their rank; assignees move Open → In progress → Done.

**The logo** is the Android launcher icon, recreated as `components/WorkshopLogo.tsx` (exporting `WorkshopLogo`): an 8-point
terracotta `#CC785C` star with a near-black `#181715` centre disc on cream `#FAF9F5`. Keep its native
colours even on purple surfaces (put it in a cream rounded tile there). `app/icon.svg` is the same mark.
Never reintroduce another mark.

**Auth** is a split shell: left brand panel (deep purple, logo in a cream tile, gold-accent copy), right
frosted `.glass-card` on a `.grad-mesh` backdrop. `android/.../ui/AuthScreen.kt` is built against this
same description — **change them together.** Buttons: email+password, then "Continue with Google"
(live), "Continue with Microsoft" and "Continue with Yahoo" — both render a **"Coming soon"** badge and
toast, never a dead request.

**When a feature lands on both clients**, the shared vocabulary must come from the **server**
(`rungCopy`, `reasonCopy`, `childLevel`, `levels`, `overridesAreRepositoryWide` …) so the two cannot
describe one decision differently. Where a platform genuinely differs — hover does not exist on a
phone; a phone has no room for two panes — say so in a comment and pick the equivalent moment or shape,
never a paraphrase of the copy.

---

## 17. Trap index — check before you "simplify"

Each of these looks wrong and is deliberate. Most were a shipped bug.

**Tokens & CSS**
- `bg-surface-100/200/300` do not compile → use `bg-field-100/200/300`.
- `field-500/600/700` are purple-**600/700/800** — the scale is shifted by one stop.
- `border` alone = literal gray-200; `ring-2` alone = stock **blue**.
- `rounded-2xl` == `rounded-lg` (16px); `rounded` is 4px, tighter than `rounded-sm`.
- `font-serif` is Plus Jakarta Sans.
- `ease-out` the *class* is the brand expo curve; `ease-out` in *handwritten CSS* is the spec curve.
- `.nav-sheet`'s doubled `max-height` (vh then dvh) is progressive enhancement.
- The scroll lock is on `<html>`, not `<body>` (iOS Safari).
- Fixed overlays must re-pay `var(--nav-scroll-gutter, 0px)` themselves.
- No `[data-reduced-motion="false"]` rule — the two sources only union.
- Zeroing `transition-delay` is load-bearing.
- `--header-clearance` has zero consumers.
- `accordion-down/up` keyframes are dead scaffold.
- `cn()` is a plain join, not tailwind-merge.

**Nav**
- The scrim is `z-40`, below the island's `z-50`, so the X stays clickable.
- The dimmer is a **sibling**, not the panel's parent (`touch-action: none`).
- Desktop dropdowns are pointer-only **by design**; the sheet is the keyboard route.
- `layoutId="active"` is a single global id — only one `MenuItem` cluster per page.
- Active route is **longest-base-wins**, never `startsWith(href)`.
- `isNavItemVisible` checks `can` **before** the toggle.
- `adminChromeVisible` returns true for non-admins — always AND it with the role check.
- Below `lg` the entire dropdown bar is hidden; below `sm` the pill's admin toggle is too, so the
  sheet-footer toggle is a phone user's only way to flip admin view.
- Never reduce `AppShell`'s `pt-24`.

**Motion**
- No `MotionConfig reducedMotion="user"` — framer animations must branch in JS themselves.
- `Toast` honours the OS preference but **not** the in-app toggle.
- Guide may branch `initial` on `reduce`; the hero may **not**.
- Never centre a framer-animated element with a translate class — inline `transform` wins.
- The guide's step card must **not** be `overflow-hidden` (the focus outline).
- No `aria-live` on a scroll-position readout.
- `aria-controls` only while the panel is mounted.
- No tilt/parallax/spotlight on the guide cards — it was never there.

**Forms**
- `new FormData(event.currentTarget)` first, before any `await`.
- `Select`'s mirror is `type="text"`; `DosDontsField`'s must be a `<textarea>`.
- `FOCUSABLE` excludes `[tabindex="-1"]` so the walker skips the mirrors.
- `Field` is a `<label>` → never wrap a dropdown or a date field in it; use `FieldBlock`.
- `optionText()` recurses on purpose.
- `min-w-0` is load-bearing wherever it appears.
- An edit form never auto-captures location; **omitting `initial`** is the only switch.
- A blank geocoded pincode must be **written**.
- A geocoded district only where the geocoded state stands.
- `subregion` is the district; `county` is the trap.
- Aadhaar mask posts back verbatim; Pehchan mask must be **omitted**.
- `advanceOnSelect={false}` on any dropdown that filters the screen it sits on.
- Empty means everything (`filters.types`) / all (`workshopIds`).
- `FunnelFilters` fires once after load — wait for it.
- Date parsing: local for `parseDateInput`, **UTC** for `DateRangeField`.

**Data**
- Blank `NEXT_PUBLIC_API_URL` silently falls back to localhost.
- 503 / `ApiUnconfiguredError` must not be queued.
- 409 in the drain is never "already landed".
- `uploadMediaBatch` throws only on total failure — inspect `failed`.
- Decimal columns are strings.
- Media `url`/`objectKey` may be absent by entitlement.
- Filter a `WorkshopAssignment` list to `status === "GRANTED"`.
- `/artisans` has no `workshopId` filter — narrow client-side.
- `AddressReference.districts` is optional in the type deliberately (separate deploys).

**Effects guarded by a ref (the deadlock shape)**
- **An effect that claims a ref guard on START and gates its completion on a `cancelled` flag MUST
  release that guard in its cleanup.** Otherwise a teardown between "work issued" and "work resolved"
  leaves the guard held by an attempt that can no longer finish, the re-run returns at the guard, and
  nothing ever completes — a spinner that never stops. `reactStrictMode: true` (`next.config.ts`)
  makes React run setup → cleanup → setup on **every** mount, so this deadlocks 100% of the time in
  `npm run dev` and looks like "the feature just doesn't work". `useEditDeepLink` shipped this bug and
  now does `if (handled.current === token) handled.current = null` in its cleanup.
- **Never put a preference that settles after mount in a dependency array.**
  `useAppReducedMotion()` reads false on the server and the first client render, then flips once
  ThemeProvider reads storage — so as a dep it tears an in-flight effect down, in production, for
  exactly the users who asked for less motion. Read it through a ref (as `useEditDeepLink` does), the
  same treatment the callbacks get.

**Edit links**
- Crafts, workshops and processes have **no `/[id]/edit` route** — the id travels as `?edit={id}`
  (§13.0). A bare `/crafts` / `/workshops` link opens the blank CREATE form; it shipped that way in
  six places.
- A deep-linked seed goes through the page's **`guard()`**, not straight to `resetForm`: the form is
  typeable while the fetch is in flight and `resetForm` remounts it and clears `dirty`, so seeding
  directly discards whatever was typed with nothing asked.
- `useEditDeepLink`'s `onEdit` takes the page's **full seeder**, not `setEditing` — the workshop
  rosters are React state and a partial seed silently clears them on save.
- Omit `onNew` on a page that derives `?new=1` itself, or the create form closes as it opens.
- `/workshops` sends `artisanIds`/`craftIds` **only when they changed**: the backend 403s a
  non-privileged editor who re-sends an already-populated roster, even untouched. Android's
  `WorkshopForm` diffs them the same way.

**Silent-emptiness class (the repeat offender)**
- A NULL `workshopId` matches no workshop scope → a full corpus renders empty. Fixed by
  `services/workshop_inference` + `GET/POST /workshops/unmapped[/map]` + the admin card on `/workshops`
  + the `unassignedInterviews` notice on the completion matrix. **Any new scoped column needs the same
  three things: a backfill, a way to close later gaps, and a visible count of what the scope excludes.**
- Every cap, truncation or skipped row must say so: `rowsTruncated`, `childrenTruncated`,
  `captureTruncated`, `anchorsTruncated`, "the busiest are listed", "Page 0 of 0".

---

## 18. Checklists

### New page
- [ ] `"use client"` (unless it reads no API), under `app/(protected)/`
- [ ] `PageHeader` first, nothing above it; no top padding of your own
- [ ] `ROUTE_GUARDS` row if gated; `ADMIN_CHROME_ROUTES` row if admin chrome (with an honest
      `alternative`); **one** `NAV_ITEMS` entry; a dashboard tile if Android has one
- [ ] content in `panel`s; `EmptyState` for nothing-here; `items === null` vs `[]`
- [ ] fetch race guard (generation / cancelled / signal)
- [ ] z-index from the ladder only

### New form
- [ ] uncontrolled `FormData`; `new FormData(...)` first
- [ ] `Field` for inputs, `FieldBlock` for anything containing a button
- [ ] every themed control calls `markDirty` by hand
- [ ] `useLeaveGuard(dirty, …)`; **no** second back control
- [ ] `LocationFields` — omit `initial` only on create
- [ ] `useWorkshopSelection` + `confirmSubmission()` after FormData, before `setSaving`
- [ ] media through `MediaCaptureField`; inspect `failed` from `uploadMediaBatch`
- [ ] error treatment chosen by meaning (§12.11)

### New animation
- [ ] `useAppReducedMotion()` (app) or `useHeroReducedMotion()` (public)
- [ ] a spring/tween from §8.1–8.2 — do not invent numbers
- [ ] a **static** counterpart for anyone with reduced motion
- [ ] no translate class on anything framer transforms
- [ ] ornaments `aria-hidden`; no `aria-live` on a scroll readout

### New "picked over there, show it over here" interaction
- [ ] `useRevealRow()` — do not hand-roll the scroll maths
- [ ] a nonce so re-picking the same thing re-fires
- [ ] `.fr-flash-row` + `data-flash`, so the static outline survives reduced motion
- [ ] ordinals derived from array order, printed in **both** views
- [ ] the container is `overflow-y-auto` only at the breakpoint where it has room

### New cross-client feature
- [ ] wording, order and copy come from the **server**, not from each client
- [ ] both clients gate on the same predicate, mirroring `deps.py`
- [ ] platform differences are commented, not paraphrased
- [ ] `npm run typecheck && npm run lint` (frontend) · `ruff check app && pytest -q` (backend) ·
      `./gradlew.bat :app:compileDebugKotlin` (Android)
