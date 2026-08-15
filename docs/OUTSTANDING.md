# Outstanding work

**Nothing is outstanding.** Every item previously listed here has been built, fixed and verified against
a running application with a real PostgreSQL database — most recently against one carrying the full
demonstration corpus, which is the first time these checks have run over a site with content on it.

This file is kept rather than deleted because the *shape* of what went wrong is worth remembering, and
because the checks that now guard each class of defect only make sense once you know what they were
written to catch.

---

## What was wrong, and what now prevents it recurring

### 1. Twenty-odd studio routes were called but never existed

Every client half typechecked, linted and built. `fetch("/api/studio/lookup")` is a **string**, so
nothing connected a screen to its handler. The worst case was `/api/studio/lookup` — the relation picker
used by every editor — which meant no project team, event speaker, publication author or featured item
could be set anywhere in the CMS. `/api/studio/settings/[group]` was missing too, so **no setting could
be saved at all**.

Several were worse than a 404: a path like `/api/studio/files/presign` resolved to `files/[id]` with
`id="presign"` and returned **405**, which sends whoever debugs it looking at the wrong file.

**Now prevented by `npm run route-check`** (part of `npm run check`), which resolves every `/api/…`
literal the way Next does and fails on any with no handler exporting that method. Its own header records
the two false-negative bugs it had while being written, because a coverage check that misses things is
worse than none — it converts an unknown into a confident wrong answer.

**And by `npm run smoke`**, which is the layer that actually proves a handler *works*. `route-check` only
proves a path resolves; a route can exist, resolve, and 500 on every call.

### 2. A refusal was reported as a server fault

`requireCapability` throws an `ApiError`, which is right in a route handler (the `route()` wrapper turns
it into JSON) and wrong in a Server Component, where it becomes an unhandled error and a **500** telling
an editor "something went wrong on our side". That is false, and it sends somebody hunting a bug that
does not exist.

`error.tsx` cannot repair it: Next redacts a server error's message in production, so the boundary cannot
tell a deliberate refusal from a genuine fault.

**Fixed** by `requireStudioCapability` / `requireStudioRole` / `requireStudioUser`, which call Next's
`forbidden()` and render `app/studio/forbidden.tsx` with a real 403. **Now enforced** as contract §1.9
and asserted by `smoke`, which fails if a lower tier gets anything but 403.

### 3. Every missing page returned HTTP 200

A `loading.tsx` at the `(site)` group root started streaming, which flushes the status line as `200 OK`
before `notFound()` can set it. Every missing person, project, publication, article, event, album and
craft was a **soft-404**: 404 content under a success status. Search engines index those; broken-link
monitoring detects nothing.

**Fixed** by scoping the only `loading.tsx` to `search/`, the one segment with no `notFound()` beneath
it. **Now** contract §13a, and `smoke` asserts nine missing-record URLs return a real 404.

### 4. Draft content could have leaked to the public site

Not a specific bug found, but the highest-consequence *class*: an omission across ninety-odd queries that
neither the type checker nor review catches reliably.

**Now prevented by `npm run leak-check`**, which creates a draft **and** a soft-deleted record of every
content type — different columns guard each, so a filter can easily cover one and miss the other — and
fails if a canary string appears on any public surface or if any detail URL returns anything but 404.

It also **indexes those fixtures for search** and plants a **published control record** that every search
surface must return. Both are load-bearing rather than thorough: public search reads only
`search_documents`, so fixtures made with a direct Prisma create used to reach no search surface at all,
and three assertions on `/search`, `/api/public/search` and `/api/public/suggest` passed for a reason
entirely unrelated to what they claimed to prove. The control record is what stops that recurring — a
search box answering nothing looks exactly like a publish filter working perfectly.

---

### 5. A whole feature was called but never existed — and `route-check` could not see it

`app/studio/pages/[id]/page.tsx` built its preview address as `/studio/preview/<slug>?preview=<token>`
and handed it to `PreviewFrame`, which rendered it in an iframe. **There was no route at that path.**
So the preview panel — the four device widths, the light/dark toggle, the reload-on-save, and later the
whole live-draft mechanism with its per-editor server store — was a complete, working front end aimed at
a 404, for an entire release.

This is defect class 1 above, reappearing on the one kind of path that check cannot cover. `route-check`
resolves `/api/…` literals; a PAGE route is outside its remit, and a preview URL is a **string** like
any other, so `tsc`, `eslint` and `next build` were all green. Nobody noticed because the panel is
behind a tab an editor has to open, and an iframe that fails renders as a blank rectangle rather than
as an error.

**Fixed** by building `app/(site)/preview/[[...slug]]/page.tsx`. It went under `(site)` rather than
`/studio` for two reasons that turned out to matter: the site layout gives the preview the real header,
footer and type, so it shows the design being reviewed rather than the design inside a sidebar; and it
sits outside `middleware.ts`'s `/studio/*` matcher, so the signed token is genuinely the gate and a
preview link can be forwarded — which is what `lib/pages.ts` had always claimed and, under `/studio`,
was not true of.

**Now guarded by three `smoke` assertions**: a valid token renders, a wrong one 404s, an absent one
404s identically. The last two matter as much as the first — answering them *differently* would make
the route an oracle for which unpublished slugs exist.

### 6. A hundred and fifty published records were invisible to the site's own search

`prisma/corpus/` seeds a demonstration corpus — 42 crafts, 24 people, 14 projects, 30 publications, 18
articles, 13 events. `SearchDocument` rows are written by the studio's CRUD layer *as an editor saves*;
`seedCorpus()` writes through Prisma directly, because there is no editor and no request. **So nothing
indexed what it created.** `/search` answered nothing for "patola", `/api/public/suggest` returned an
empty list for every keystroke, and the only three rows in the index were the seeded pages.

Nothing surfaced it, and the reason is worth keeping: **every listing page reads the content tables and
never touches the index.** So the crafts page showed 42 crafts, the A–Z showed 143 entries, each detail
page rendered — and only search was empty. On a site somebody is evaluating, an empty search does not
read as "the index is stale"; it reads as "the search is broken".

**Fixed** by having `--with-corpus` call `reindexAll()` — the same function the studio's *Rebuild index*
button calls, so there is one indexing path rather than two that can disagree.

⚠ The first version of that call was guarded with `if (created > 0)`, which was **exactly** the wrong
condition: the run that WRITES the corpus is the run that leaves it unindexed, so on the second run —
when nothing is created because every slug already exists — the index would never have been built at
all. The state the call exists to repair is precisely "the records are there and the index is not". It
is unconditional now.

### 7. Two independently written seed modules disagreed on every shared slug

`prisma/corpus/work.ts` (projects, publications) and `prisma/corpus/people.ts` (research areas, people)
were written separately and link by slug. Every `person`, every `authors` entry and four of six
`researchArea` references in `work.ts` named something that did not exist — so the seed would have
written 14 projects with no team and 30 publications with no authors, and a "their publications" list
would have been empty on all 24 profiles.

**Caught before it reached the database**, by `seedCorpus()` collecting every unresolved reference and
reporting each one with the record, the field and the target slug rather than counting them. A count
would have been almost useless: nobody can act on "23 unresolved references". Writing them as nulls and
saying nothing — the obvious implementation — would have produced a plausible-looking corpus with a
silent hole in exactly the relations that make it worth having.

**The lesson for any future generated content**: a cross-reference that resolves to nothing must be
reported by name at write time. It is the one class of defect in seeded data that no downstream check
catches, because the rows are all individually valid.

### 8. A social card that renders is not a social card that is used

Five per-type `opengraph-image.tsx` routes were written, compiled, and rendered correct 1200×630 PNGs.
**Not one of them was ever fetched by a crawler**, because Next applies a file-based
`opengraph-image` only when the segment's own metadata does not already carry `openGraph.images` — and
`pageMetadata()` always emitted one, falling back to the institutional card. A hard-coded fallback does
not duplicate the file convention; it *suppresses* it.

⚠ **And the obvious repair was worse than the defect.** Passing
`absoluteUrl("/people/x/opengraph-image")` looks right and 404s: Next serves those routes only at a
cache-busted path (`/people/x/opengraph-image-17pym6?<hash>`), and the suffix is a build-time hash no
application code can know. A platform that fetches a 404 renders a broken image rather than falling
back, so every affected page was left advertising something worse than the generic card.

**Fixed** by omitting `openGraph.images` when the page has no image of its own, so Next resolves the
nearest `opengraph-image` in the segment hierarchy and writes the hashed URL itself.

**The class, stated once for the next person:** a metadata URL is never requested by the application —
only by somebody else's crawler — so the page renders identically whether the URL is right, wrong or
missing. Neither `tsc`, `eslint`, `next build`, `route-check`, `smoke` nor `leak-check` can see it
(`leak-check` greps HTML and these return PNGs). **The only way to know is to read the advertised URL
out of the rendered page and fetch it.** This same omission had already shipped once as
`/og-default.png`, a file that has never existed in this repository.

### 9. A page could be saved at an address the router can never serve

`Page.slug` is a full path, so nothing stopped an editor typing `news/annual-review`. That URL is
matched by `app/(site)/news/[slug]`, which looks for an article called "annual-review", finds none and
answers 404 — the catch-all that would have served the page is never consulted, because a static
segment beats it. The row sat in the studio marked PUBLISHED, appeared in every listing and in the
sitemap, and 404ed for the editor who made it.

An earlier proposal was to filter such rows out of the A–Z index. That is guesswork at the wrong end:
it drops rows on an assumption about every route's shape, risks hiding reachable records to hide
unreachable ones, and leaves the row itself in place.

**Fixed** by `pageSlugConflict()` in `lib/pages.ts`, wired into both page schemas, so the row cannot be
created and the editor is told at the moment they can act — with a message naming the collision
("addresses beginning with `news/` already belong to the news section") rather than a generic refusal.

⚠ **The trap in writing this rule is refusing too much.** `about` and `contact` are seeded, structural
pages whose routes deliberately read their own `Page` row — a validator that reserved every code-owned
path would reject the seed and make the installation unable to re-seed itself. The rule therefore
distinguishes three cases: a multi-segment slug under a route that owns a dynamic child (refused), an
exact match against a code page with no `Page` reader (refused), and an exact match against `about` or
`contact` (allowed, because those routes render the row). **`smoke` now asserts both directions** — the
unreachable address is refused and an ordinary one is not — because a rule that quietly over-refuses is
harder to notice than one that under-refuses.

### 10. The animation had never been reviewed, and two findings were real costs

Everything else in this repository had been through an adversarial pass; the motion had not. Four
reviewers found 23 defects, of which two were worth the exercise on their own:

**`will-change: transform` was set permanently on every parallax photograph.** It was keyed off the
`parallax` prop — a render-time marker, not a signal that anything is moving — so a layer was promoted
for the whole life of the page: under reduced motion, when the GSAP chunk never arrived, and while the
chapter was nowhere near the viewport. A full-bleed 1600×900 photograph is roughly 5.8 MB of GPU memory
as its own layer, and one seeded story has eight chapters. `CraftPhoto`'s own comment stated the correct
rule while the line beneath it did the opposite. Removed: GSAP's `force3D: "auto"` already promotes for
the duration of a tween and reverts afterwards, which IS "set while animating, cleared after".

**The hero's pointer wash repainted the whole hero on every pointer frame.** It was a
`useMotionTemplate` writing `background-image`, so each frame reparsed a 48rem gradient string and
repainted a full-viewport layer on the main thread — on top of the particle canvas's rAF loop and the
tapestry's two pointer transforms. One movement of the mouse drove three motion systems, one of them a
repaint. Now a constant gradient on a layer translated by `x`/`y`, which compose into a single
`translate3d` and composite on the GPU. It cannot uncover an edge because the gradient's last stop is
`transparent 68%` — the layer is already transparent well inside its own boundary.

⚠ **And a reduced-motion reader was downloading animation libraries they would never see.**
`useReducedMotionPreference()` reports `false` on the first render by design (a value that differed
between the prerendered HTML and the first paint would flash), and the first commit's effect is the one
that starts the import — so GSAP (~95 KB) and Lenis were fetched and then discarded one render later.
Behaviour was correct; the cost was paid by exactly the readers who opted out. Both now test a
synchronous `prefersLessMotionNow()` alongside the hook.

### 11. `leak-check` could not see the social cards, and the first attempt to fix that passed vacuously

Seven `opengraph-image.tsx` routes each rasterise a record's title into a PNG using their own copy of
the page's publication filter. Seven copies is seven chances to drop it — and a draft's headline drawn
into an image is a leak that survives the record being deleted, because the platform that fetched it has
cached the picture. `leak-check` greps HTML for a marker, and **a marker cannot be grepped out of a
PNG**: the text is glyph outlines, then compressed.

⚠ **The first version of the probe built the plain card path and got a 404 for every fixture, so it
skipped them all and reported success** — the exact failure this script's own header warns about. It was
caught by testing whether the assertion could discriminate at all, rather than by trusting a green run.
The second attempt tried to learn the cache-busted path from a published page, which fails whenever
every record of a type has an uploaded cover (as all six research areas do). The path is now read from
`.next/app-path-routes-manifest.json`, the one place that knows it.

**The assertion**: every refusal renders `fallbackCard()`, whose only input is the institution's name,
so a card for a nonexistent slug and a card for a merely-unpublished one must be byte-identical. Proven
in both directions — two nonexistent slugs return identical bytes, and with one route's filter
deliberately removed the probe named both offending fixtures and failed the run. A `checked === 0`
guard fails the run if the fixtures and the routes ever stop overlapping, so it cannot go vacuous again.

### 12. `Reveal`'s default threshold was unreachable for a tall section — permanently invisible

framer hands `viewport.amount` straight to an IntersectionObserver as its `threshold`, and the largest
ratio an element can reach is `viewportHeight / elementHeight`. So **anything taller than about 3.3
viewports could never satisfy the default 0.3**: `whileInView` never fired and the section kept framer's
inline `opacity: 0` for ever. Not a late entrance — a permanently blank section, structurally complete in
the DOM, on a page that otherwise worked. `amount="all"` is unreachable for anything taller than the
viewport at all.

Five call sites had already been bitten and hand-guarded with `amount="some"`, each carrying its own ⚠
comment naming the mechanism. That was the right fix in the wrong place: the sixth author to write a tall
section got no warning, and the symptom reads as a broken page rather than a mistuned threshold.

**Fixed** by `useAchievableAmount` in `Reveal.tsx`, which measures the element once on mount and — only
where the requested amount is unreachable — falls back to `"some"`, exactly the value those five call
sites chose. Nothing that already worked changes behaviour, and the hand-written guards become
belt-and-braces rather than load-bearing. ⚠ Changing the DEFAULT to `"some"` instead was considered and
rejected: it would retune ninety-odd call sites so each fires as its first pixel crosses the fold, before
the reader can see it, to guard a case five places had already covered.

**Proven in both directions rather than reasoned about.** A probe page with a section four viewports tall
(3200px in an 800px viewport, max reachable ratio 0.25 against a 0.3 threshold) reports
`opacity: 1` with the clamp and `opacity: 0` without it. framer's own `InViewFeature.update()` compares
`amount` and restarts the observer, which is what lets the correction reach a section that has not yet
entered view — verified by reading
`node_modules/framer-motion/dist/es/motion/features/viewport/index.mjs`.

⚠ **What it deliberately does not cover:** an element that grows past 3.3 viewports AFTER mount, such as
an accordion opening. The answer there is `amount="some"` at the call site, not a `ResizeObserver` per
reveal — at twenty reveals a page that would be twenty observers to guard a case that cannot arise from
static content, since every image on this site reserves its space before it loads.

### 13. The repo's own skill files described a different repository — and were named as authoritative

Three independent motion auditors, working from separate file lists and unaware of each other, each ended
their report with the same unprompted note: **`skills/motion/SKILL.md` and `skills/gsap/SKILL.md` instruct
the reader to import from paths that do not exist here.** One put it plainly — *"an agent that followed
those skill files literally would import a hook that does not resolve."*

They were right, and it was worse than a stale path:

| The skills said | The truth here |
|---|---|
| `useAppReducedMotion()` from `@/components/guide/useAppReducedMotion` | `useReducedMotionPreference()`; `components/guide/` **does not exist** |
| factories `springy()` / `layoutSpring()` in `components/guide/guideMotion.ts` | `components/motion/variants.ts` + `constants.ts` |
| "GSAP is used by **exactly one file**, `frontend/components/guide/useGsapHeadline.ts`" | GSAP owns **two** jobs through `useGsapScope`, across six files |
| tear a timeline down with `timeline.kill()` | `ctx.revert()` — `kill()` freezes the element at whatever mid-scrub transform it was holding |
| "`will-change: transform, opacity` is set on the spans while they animate" | **the opposite of this repo's rule** — a permanent `will-change` cost ~5.8 MB of GPU memory per full-bleed photograph, and was a *finding of the very audit that flagged the file* |
| "protected page", Android wording parity, `backend/app/core/deps.py` | a different product entirely |

**Why nothing caught it.** A skill file is prose. `tsc` does not read it, `eslint` does not lint it, and
no test imports it — so a document can name a hook that has never existed in this repository and stay
green for ever. Its only consumer is the next person or agent to read it, and by then the damage is an
import that does not resolve, or worse, one that does: `will-change` is valid CSS and a reviewer who
trusts the contract would have waved it through.

**It was actively dangerous rather than merely wrong.** `.build-state.md` — the file the hail-mary cron
reads to restart a killed build — pointed every resuming agent at these two files as "the animation
rules". So the repository was instructing its own agents to violate its own contract.

**Fixed** by rewriting both against the real code, with `docs/CONTRACT.md` §8 as the authority, and
carrying a banner that names what the old version claimed so a reader with the stale copy in mind is
corrected rather than merely contradicted. `skills/field-repo-frontend/SKILL.md` is a third case: it is
1591 lines of a *different* product's frontend reference (`D:\Portal_Development_Designer`) whose token
ladders and trap index genuinely do apply here while its screens, nav, permissions and Android-parity
rules do not. Rewriting it would be invention rather than reading, so it gained a banner that separates
the two halves and a vocabulary map — and `.build-state.md` now points at `docs/CONTRACT.md` first.

⚠ **The general lesson, which applies to every `.md` in this repository:** prose is unverified by
construction, so a document's age is not evidence of its truth. The three that were checked were checked
only because an auditor happened to read code and doc side by side. Nothing schedules that.

### 14. Twenty-two font binaries shipped with no licence text and no copyright notice

The type library arrived with its licensing reasoned about carefully: an `ACCEPTABLE_LICENCES`
**allowlist** that refuses a licence string it has never seen rather than assuming it is fine, the
licence and its URL recorded per face, and a header explaining that the OFL requires its terms to
travel with the font **files** rather than appearing on the page. Every one of those judgements is
correct — including the last, which is a genuine and often-missed distinction: **CC BY obliges
attribution to the reader** (which is why the photographs are credited on `/credits`), **the OFL does
not**. It obliges the notice to reach whoever receives the files.

⚠ **And then the repository did not do it.** `fonts/` contained twenty-two `.woff2` files and nothing
else. No OFL text, no per-family copyright line, anywhere in the tree.

OFL-1.1 §2 permits redistribution *"provided that each copy contains the above copyright notice and
this license"* — and explicitly accepts a text file alongside the fonts as the way to do it. What was
actually shipped was the string `"OFL-1.1"` and a link to the licence's website in a TypeScript
manifest. **That is a reference to a licence, not a copy of one**, and it contains no copyright notice
at all: "Copyright 2011 The Lora Project Authors" appears nowhere in `licence: "OFL-1.1"`.

**The shape of this defect is the one this repository keeps finding**: a comment stating the right rule
while the code beneath it does something else — the same shape as the `will-change` note that described
the correct policy above a line that violated it. The rule was not misunderstood. It was written down
and then not implemented, and nothing could tell the difference, because a licence breach has no
symptom. The fonts render perfectly either way.

**Fixed at the source that can keep it fixed.** `scripts/fetch-fonts.ts` now fetches each family's
licence text — from the Fontsource npm package, or from upstream for the two bundled faces — validates
that the bytes really are the licence they claim to be (jsDelivr answers a miss with an HTML page and
HTTP 200, so "the file exists" is not "the licence is there"), and writes `fonts/licences/<id>.txt`
plus a README indexing every family's copyright line. It runs on **every** invocation over the **whole**
roster, so a one-face run cannot leave eleven licences to rot — the same discipline `existingFacts()`
already applied to the manifest.

**And turned into an assertion**, which is the part that matters: `scripts/font-check.ts` (`npm run
font-check`, now part of `npm run check`) makes 261 offline assertions — every declared file exists,
matches its recorded byte count and SHA-256, and carries the `wOF2` signature; every face's licence text
ships, is not truncated, and names the licence it claims; nothing on disk is undeclared and no licence
is orphaned; `TYPE_LIBRARY_BYTES` agrees with the sum; and every face is declared in `app/layout.tsx`
and keyed in `tailwind.config.ts`, because a face missing from either renders as a silent fallback.

⚠ **Proven to discriminate before being trusted**, per defect class 11: removing one licence names that
family and fails; flipping a single byte inside a `.woff2` is caught by the hash and not the byte count;
an undeclared font appearing in `fonts/` fails. All three restore to PASS. A `checks < 20` guard fails
the run if the manifest ever empties, because every loop in the script is vacuously true over an empty
roster.

**Two corrections I made along the way, both the same mistake.** `RosterEntry` carries `family`,
`licence` and `upstream` **only** on its `origin: "bundled"` arm — for the ten fetched faces those come
from the API later in the run. My first version read them off the entry, so it printed `undefined` for
ten families and silently defaulted its licence check to OFL instead of identifying anything. The
licence is now read **out of the document**, which is stronger than trusting a field, and the family and
upstream come from the manifest. The second was in `copyrightNotice()`: a scan for a line beginning
"Copyright" returned `"copyright statement(s)."` for Source Serif 4 — a wrapped line of the OFL's own
preamble, quoted where the author's name belonged. It now anchors on a **year** and stops before the
licence body begins. Source Serif 4 genuinely has no dated notice; its file opens with "Google Inc.",
which is the correct credit and is what the index now shows.

### 15. A themed neutral used as a fixed scrim — white text on a white plate, in dark theme only

The hero rebuild reported one bug outside its file list: `ImageCredit`'s overlay chip filled itself
with `bg-ink-900/55` and set `text-white`. **`ink-900` is a THEMED neutral and inverts** — `30 27 46`
in light, `242 240 249` in dark — so in the dark theme the chip became a near-white plate carrying
white text. Unreadable, on the element whose entire purpose is to satisfy a CC BY attribution.

Grepping for the pattern rather than fixing the one instance turned it into a class. Every one of these
was a **dark scrim with white content, sitting on a surface the theme does not control**:

| Where | What it was | What it became in dark theme |
|---|---|---|
| `ImageCredit` overlay chip | `bg-ink-900/55` + `text-white` | unreadable attribution over any photograph |
| `BeforeAfterSlider` — both labels | `bg-ink-900/70` + `text-white` | unreadable "before"/"after" over the photographs |
| `CraftMap` marker tooltip | `bg-ink-900/90` + `text-white` | unreadable label over the map tiles |
| `MediaLightbox` backdrop | `bg-ink-900/92` | the lightbox opened as a near-WHITE flash |
| `MediaLightbox` prev/next | `bg-ink-900/60` + `text-white` | white buttons with white chevrons |

**The rule, which the codebase already had and which these five had drifted from:** a scrim whose
content is unconditionally white must itself be unconditionally dark. It cannot track the theme,
because what is behind it — a photograph, a map tile, a video poster — is not themed either. The
established spelling is the brand ramp: `--purple-950` is defined once in `:root`, never in the dark
block, and `globals.css` already documents `bg-purple-950` + `text-white` as *literal brand classes*
for the hero bands and the footer. All five now use it at their original alphas.

⚠ **Why nothing caught it, and why it survived a design review.** It is invisible in the light theme,
which is the one a developer, a screenshot and a print stylesheet all default to. Every automated gate
here is blind to it by construction: `tsc` sees a valid string, `eslint` sees a valid class,
`route-check` and `smoke` read HTML rather than computed colour, and `leak-check` greps for markers. A
contrast checker would catch it — pointed at the dark theme, on a page with a photograph, which is a
combination nothing in this repository currently automates.

**Now guarded.** `scripts/theme-check.ts` (`npm run theme-check`, part of `npm run check`) fails the run
if a background built from an inverting token appears in the same class string as `text-white` or
`text-black`. 485 files, ~2400 class literals, offline, milliseconds.

Two things make it trustworthy rather than decorative:

- **A self-test that runs first.** The rule is pointed at the five strings that actually shipped, written
  out verbatim, plus variant-prefixed and `!important` spellings — and at the five *correct* patterns
  that replaced them, including the backdrop with no text on it and the brand `bg-purple-950 text-white`
  pairing. If the rule ever stops matching the historical bugs, or starts matching the fixes, the script
  fails **before** it reports on the codebase, because a green run from a rule that cannot match is
  indistinguishable from a green run from clean code (defect class 11).
- **A drift guard on the token list.** It reads the `[data-theme="dark"]` block in `globals.css` and
  fails if the stylesheet inverts a neutral the script has never heard of — a new inverting token nobody
  told the checker about is a new instance of this defect that cannot be detected. Verified by removing
  `ink-300` from the list: the run named it and failed.

⚠ **The mirror rule was written, tested and deleted**, and that is recorded in the script at length: it
produced twelve findings and every one was wrong, because a class string read as an unordered bag of
tokens cannot see variant scoping (`hover:bg-purple-50 hover:text-purple-700` is a self-consistent
*second* pair) or alpha (`bg-purple-700/10` is a tint over the themed surface beneath it). It fired on
the commonest correct pattern in the codebase. A check with a 100% false-positive rate is worse than no
check, because it teaches people to ignore the output — including the precise rule next to it.

**Deliberately left alone:** `NavSheet` and `StudioShell` both use `bg-ink-900/50` as a modal backdrop
with **no white content on it**. Those sit over themed UI, so a scrim that lightens with the theme is a
defensible token choice rather than a bug, and changing them would alter how the studio and the nav
sheet look in dark mode — a design decision, not a defect fix. `EmbedSection`'s `hover:bg-ink-900/15`
is the same case at an alpha too low to read either way.

## The remaining known limits

These are honest gaps, stated so nobody mistakes a green suite for a proof.

- **`route-check` cannot see dynamic-segment shadowing when the method is unknown.**
  A static path with no directory of its own still *resolves* if a dynamic sibling can swallow it:
  `/api/studio/media/<anything>` matches `media/[id]`, so a missing handler of that shape would pass the
  path check and 405 at runtime. Flagging it needs the HTTP method, and most paths live in an endpoint map
  whose method is supplied in another file; guessing GET produced eight false positives. `smoke` covers
  the endpoints it exercises — its `STUDIO_GET_ENDPOINTS` list is what actually closes this for a real
  path — so a new endpoint of this shape should be added to it.
  *(This caveat used to name `/api/studio/media/duplicates`, which has had a route file of its own for
  some time and is on `smoke`'s list; naming a live, covered route made the limit read as a live defect.
  These admissions are only worth keeping while they are exact.)*
- **`route-check` reads literals**, so a path assembled entirely from a variable is invisible to it.
- **`leak-check` writes its search index rows itself**, because `lib/search/index.ts` is `server-only` and
  cannot be imported into a plain Node script. It uses the product's own `isLive()` for the published
  flag, so both that predicate and the read-time `"isPublished" = true` filter are under test — but the
  studio save path's *own* call into the indexer is not. `smoke` exercises that, in the published
  direction only.
- **No `script-src` in the Content-Security-Policy.** A real one needs per-request nonces, and the
  pre-paint theme boot is a blocking inline script. `'unsafe-inline'` would permit exactly what it claims
  to prevent while looking like protection in an audit. The directives that *are* set (`base-uri`,
  `form-action`, `object-src`, `frame-ancestors`, `upgrade-insecure-requests`) each close a real path and
  touch no script or style. See the long comment in `next.config.ts`.
- **The rate limiter is per process**, so on a horizontally scaled deployment it is a speed bump rather
  than a guarantee. Its own header says so. A shared store (Redis) is the real answer; nothing security-
  critical rests on it — the token signature is what refuses a guessed credential link.
- **`smoke` and `leak-check` write to the database** and refuse to run with `NODE_ENV=production`.
- **`font-check` verifies that a licence text is present, intact and recognised — not that it is the
  RIGHT licence for that family.** It reads the file and confirms it really is the OFL (or Apache-2.0)
  rather than an error page, but it cannot know that `fonts/licences/lora.txt` is Lora's own notice and
  not another family's. The fetcher is what establishes that, by taking each text from that family's own
  package; the check defends it from drifting afterwards. It also does not read the WOFF2 `name` table,
  so it cannot confirm the binary on disk is the family the manifest names — the SHA-256 pins it to the
  bytes that *were* measured, which is a different and weaker guarantee than identity.
- **Nothing checks prose.** No gate reads a `.md` or a header comment, so a document can describe a
  codebase that does not exist and stay green indefinitely — which is exactly what defect class 13 was.
  Treat every comment as a claim with a date on it.
- **`theme-check` only sees colours written in the SAME class string.** A wrapper carrying `bg-ink-900`
  whose child carries `text-white` is the identical bug and is invisible to it — pairing colours across
  elements needs the rendered tree, and a check that needs a browser is a check that stops being run. It
  also says nothing about contrast RATIOS: two theme-stable colours can still be unreadable together.
  **Nothing in this repository measures contrast**, in either theme. That is the largest remaining hole
  in the visual gates and it wants a real axe-core or computed-style pass over both themes.

## One manual step after any deploy that changes `searchUrlFor`

Public URLs are **stored** on each `SearchDocument` row, so a change to how they are built does not reach
rows already written. Run *Rebuild index* in Studio → Settings, or `POST /api/studio/reindex`.
