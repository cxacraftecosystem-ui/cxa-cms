# CxA Portal — the Centre of Excellence

The Centre's public digital presence and the invisible CMS behind it, in one Next.js application.

Two surfaces, one deployment:

| | Route | What it is |
|---|---|---|
| **Public site** | `/` | Institutional identity, research showcase, knowledge portal, media centre, recruitment portal, living archive. Cinematic, prerendered, fast. |
| **Studio** | `/studio` | The CMS. No visible link points to it from anywhere on the public site. |

---

## Running it with Docker

The whole stack, with nothing installed on the host but Docker:

```bash
docker compose up -d --build
```

That brings up four things and runs two more to completion:

| | |
|---|---|
| **app** → http://localhost:3000 | the site; the studio is at `/studio` |
| **postgres** → `localhost:55432` | published on 55432 so it cannot collide with a host Postgres |
| **minio** → http://localhost:9001 | the storage console (`minioadmin` / `minioadmin`) |
| *migrate* | applies migrations and seeds, then exits; `app` waits for it to succeed |
| *minio-init* | creates the `cxa-media` bucket and its read policy, then exits |

Sign in at http://localhost:3000/studio with `admin@cxa.local` / `docker-development-administrator`.

**Uploads work in this stack.** MinIO stands in for S3, and `minio-init` grants anonymous read on the
bucket — which is what a CDN origin is — so the media pipeline runs end to end, derivatives included.
MinIO already exposes `ETag` and allows any origin, which a real S3 bucket must be told to do
(`docs/OPERATIONS.md` §1).

```bash
docker compose logs -f app     # watch the server
docker compose down            # stop, keep the data
docker compose down -v         # stop and delete the data
```

⚠ **After a schema change, rebuild BOTH images.** `app` and `migrate` are built from separate stages and
each carries its own generated Prisma client; `docker compose build app` leaves the migrator holding the
old one, and since the migrator is what applies migrations, the stack then fails with something that
reads like a database error but is a stale image. Use `docker compose build` with no service argument, or
`up -d --build`.

⚠ **`NEXT_PUBLIC_*` values are inlined at build time**, so changing one in `docker-compose.yml` needs
`--build` to take effect; a restart will not do it. And MinIO deliberately has **two** addresses: the
server reaches it as `minio:9000` over the compose network, while the browser is given `localhost:9000`,
because it sits outside that network and cannot resolve a service name.

The credentials in `docker-compose.yml` are committed on purpose so the stack starts with no setup, and
are therefore **development-only**. `JWT_SECRET` there is real entropy rather than a placeholder because
the app refuses to start on a weak one — replace it, and the seed password, before anything that matters.

## Getting started without Docker

```bash
cp .env.example .env      # then fill it in — see "Configuration" below
npm install
npx prisma migrate dev    # creates the schema
npm run seed              # structural pages, settings, and one administrator
npm run dev
```

The app refuses to start with a missing, short or placeholder `JWT_SECRET`. That is deliberate: a
signing key an attacker can guess is indistinguishable from having no authentication at all, and the
studio is the only thing between a visitor and the institution's public voice.

```bash
openssl rand -base64 48   # a real one
```

## Configuration

Every variable is documented inline in [`.env.example`](.env.example). The four that must be set for
a working deployment:

| Variable | Why |
|---|---|
| `DATABASE_URL` | The runtime Prisma client. Point at a transaction-mode pooler if you have one. |
| `DIRECT_DATABASE_URL` | Migrations and seeding. A transaction-mode pooler cannot run them. |
| `JWT_SECRET` | Session signing. ≥32 characters of real entropy. |
| `NEXT_PUBLIC_SITE_URL` | Canonical URLs, Open Graph, `sitemap.xml`. **Required in production** — without it the site publishes links to `localhost` while every signal stays green. |

Object storage (`S3_*`) is optional for local work on the public pages: without it the app runs and
tells you, in the studio's diagnostics panel, that uploads are disabled. It is required the moment
anybody uploads anything.

## Who can sign in

Two separate questions, kept apart on purpose:

| | Question | Answered by |
|---|---|---|
| **Authentication** | *Who is this?* | a password, or Google / Microsoft / Yahoo |
| **Authorisation** | *Should they be here?* | the **studio access list** |

A provider only ever answers the first. Adding "Continue with Google" without the second would let
anybody on earth with a Google account open the CMS — so **no session is issued and no account is
created until the address appears on the access list**, whichever method was used.

The list lives at **Studio → Studio access** and is managed by a **master administrator** — a tier above
administrator, and deliberately so. An administrator runs the site; a master administrator decides who
is allowed *near* it. Keeping them apart means the account used every day, and therefore the one most
likely to be phished, cannot widen the circle of people who can sign in.

Any address works, including a personal one: there is no domain restriction.

Full setup for each provider, and what happens on a refusal, is in **[docs/SIGN-IN.md](docs/SIGN-IN.md)**.

```bash
# Create or promote a master administrator. The password is read from the environment and stored
# only as a bcrypt hash — never written to .env or docker-compose.yml.
ADMIN_PASSWORD='…' node scripts/dev/grant-master-admin.mjs someone@example.com "Their Name"

# Omit ADMIN_PASSWORD for a provider-only account with no password at all.
node scripts/dev/grant-master-admin.mjs someone@example.com
```

## Reaching the studio

There is no "Admin" button anywhere. Four doors, all equivalent:

- Navigate to `/studio`
- Navigate to `/console` (redirects to `/studio`)
- Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> on any public page
- Click the footer wordmark seven times

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | `prisma generate` then a production build |
| `npm run check` | `typecheck` + `lint` + `route-check` — run this before every commit |
| `npm run route-check` | Proves every `/api/...` path called from the source resolves to a handler that exports that method. Static; needs nothing running. |
| `npm run smoke -- http://127.0.0.1:3000` | Drives the real HTTP surface signed in: every screen, every studio endpoint, a refusal, and a full content lifecycle. Needs the app running. |
| `npm run leak-check -- http://127.0.0.1:3000` | Proves no draft or deleted record is reachable from the public site. Needs the app running. See below. |
| `npm run prisma:migrate` | Create and apply a migration |
| `npm run prisma:studio` | Browse the database |
| `npm run seed` | Seed structural pages, settings and the first administrator |
| `npx tsx prisma/seed.ts --with-corpus` | …and a demonstration corpus: 42 crafts, 24 people, 14 projects, 30 publications, 18 articles, 13 events. Rebuilds the search index over it. **Opt-in by name** — see below. |
| `npx tsx prisma/seed.ts --purge-corpus` | Remove the demonstration corpus again, by slug. |
| `npx tsx prisma/seed.ts --replace-pages` | Re-apply the seeded page content over existing pages. Destroys editor work; refuses under `NODE_ENV=production`. |
| `npx tsx scripts/fetch-craft-imagery.ts` | Re-fetch the bundled craft photography from Wikimedia Commons, re-encode it, and regenerate its licence manifest. |
| `node scripts/dev/shoot.mjs <url> <out.png> [w] [h] [selector\|--print]` | Screenshot the running site over the DevTools protocol — scrolls first so `Reveal` sections are actually visible, and `--print` renders as the printer sees it. |

## The demonstration corpus

A fresh install has three pages and no content, which is correct and unusable: every showcase on the
homepage says it has nothing to show, the craft map is empty, the A–Z index is a row of dead letters
and search answers nothing. All of that is the software behaving properly, and none of it can be
evaluated or designed against.

`npx tsx prisma/seed.ts --with-corpus` writes a coherent body of content about real Indian craft
traditions, cross-referenced the way an archive would be — 58 regions in a three-deep tree, 42 crafts,
6 research areas, 24 people, 14 projects with teams and milestones, 30 publications with author
relations, 18 articles, 13 events, 13 partners.

**It is opt-in by name, and `--purge-corpus` takes it out again.** Seeded fiction has a habit of
reaching production and being discovered by a visitor rather than by a developer, so the door has a
handle on both sides. Every record is created only if its slug is absent, so re-running never
overwrites an editor's rewrite.

**What it will not do.** No real researcher, artisan or public figure is named; every person,
project, funder and partner is invented. No real DOI, ISBN, journal or grant number appears. The craft
traditions themselves are real and described as accurately as the authors could vouch for — where a
detail was uncertain it was left out rather than guessed, and `prisma/corpus/crafts.ts` records what
was omitted and why. **No fictional person is illustrated with a photograph of a real, identifiable
person**; the directory renders an initials plate instead.

## Craft photography and attribution

`public/craft/` holds 26 openly licensed photographs, fetched and re-encoded by
`scripts/fetch-craft-imagery.ts`, with `lib/media/craft-imagery.ts` carrying each one's photographer,
licence, licence URL and source page.

Most are Creative Commons BY or BY-SA, which grant the right to publish on one condition: the
attribution travels with the work. So `components/site/CraftPhoto.tsx` renders
`components/site/ImageCredit.tsx` **unconditionally** — a bundled photograph cannot be placed without
its credit — and `/credits` lists every one, split by whether its licence imposes conditions. Reach
for `CraftPhoto` rather than `next/image` for anything in that manifest.

## Syndication and reference pages

| Route | What it is |
|---|---|
| `/news/feed.xml` · `/news/atom.xml` | RSS 2.0 and Atom 1.0 for the newsroom |
| `/events/calendar.ics` | An iCalendar feed of every published event, plus a per-event "add to calendar" |
| `/a-z` | An alphabetical index of every record on the site, in one batched read |
| `/credits` | Photography attribution (see above) |
| `/accessibility` | The accessibility statement |
| `/preview/[[...slug]]` | A page as it will look before publication, gated by an HMAC of its slug |

⚠ `/preview` deliberately sits under `(site)` and not under `/studio`. It renders inside the real site
layout, so an editor reviews the design rather than the design inside a sidebar; and it is outside
`middleware.ts`'s `/studio/*` matcher, so the signed token really is the gate and a preview link can be
forwarded. `docs/OUTSTANDING.md` §5 records what happened when it lived at the other address.

## Architecture

```
Visitor ─→ Next.js (App Router, RSC)
              ├── Server Components read PostgreSQL directly (Prisma)
              ├── Route handlers under /api serve the studio's interactive screens
              ├── Media is uploaded browser → object storage directly (presigned PUT)
              │   and served through the CDN
              └── Sessions are httpOnly cookies: a short-lived signed access token
                  plus a rotating, DB-backed refresh token
```

**Content model.** `Page` owns routing, SEO and publication state; `PageSection` owns ordered, typed
blocks whose payload is JSON. A new homepage section is a new `SectionType` value, a Zod schema, a
renderer and an editor form — **never a migration**. Thirty block types ship, including four narrative
ones (`STORY_SCROLL`, `PARALLAX_BANNER`, `HORIZONTAL_RAIL`, `PROCESS_STEPS`) whose motion is
scroll-scrubbed rather than an entrance; `PageTemplate` rows let an administrator create and edit page
arrangements without a deploy. Everything that is genuinely queried, filtered
and cited (people, projects, publications, news, events, crafts, media) is a first-class table.

**Three invariants** run through the whole codebase, and each has a paragraph explaining itself where
it is enforced:

1. **Soft delete everywhere.** Nothing user-facing is hard-deleted by the CMS. Every read path
   filters through `livePublishableWhere()` / `liveStatusWhere()` in `lib/content.ts`.
2. **Audited mutation.** Every write goes through `lib/audit.ts`, which writes the row, its revision
   and the audit entry inside one transaction. A log that can exist without its change is a log
   nobody can trust during an incident.
3. **Publication state is resolved at read time.** The cron job that flips `SCHEDULED → PUBLISHED` is
   a convenience so the studio's status column matches reality. The filters are the mechanism, so a
   stalled cron cannot leave an expired embargo readable.

## Documentation

| | |
|---|---|
| **[docs/CONTRACT.md](docs/CONTRACT.md)** | The binding build contract — tokens, motion, z-index, accessibility, and an index of traps. Read before touching any UI. |
| **[docs/SIGN-IN.md](docs/SIGN-IN.md)** | The access list, the master-administrator tier, and provider setup. |
| **[docs/OPERATIONS.md](docs/OPERATIONS.md)** | Storage CORS, environment, cron, backups, the container images. |
| **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** | Vercel and long-lived-server deployment, and what differs between them. |
| **[docs/OUTSTANDING.md](docs/OUTSTANDING.md)** | What went wrong historically, what prevents it recurring, and the honest remaining limits. |

## Design system

The visual language is shared, verbatim, with the sibling Field Repository product: one purple ramp
locked at hue 305°, tinted neutrals that invert under `data-theme="dark"`, purple-tinted shadows, and
a gold accent restricted to marketing surfaces.

**[`docs/CONTRACT.md`](docs/CONTRACT.md) is binding reading before touching any UI.** It carries the
token ladders, the motion vocabulary with its exact spring constants, the z-index ladder, the
accessibility contract, and an index of traps — each of which was a shipped bug somewhere before it
was a rule.

## The verification suite

Four layers, each covering a blind spot of the ones above it. Every one of them has found a real bug in
this codebase, which is why they exist rather than a test-count target.

| | Proves | Blind to |
|---|---|---|
| `typecheck` + `lint` | the code is internally consistent | a `fetch` path is a string; it cannot know the route exists |
| `route-check` | every path literal resolves to a handler exporting that method | whether the handler *works* |
| `smoke` | signed in, every screen and endpoint actually answers; a refusal is 403 not 500; a full create→publish→delete lifecycle | content that is present but shouldn't be |
| `leak-check` | nothing unpublished is reachable from any public surface | the studio (it never signs in) |

```bash
npm run check                                   # typecheck + lint + route-check
npm run build && npx next start -p 3000 &
npm run smoke      -- http://127.0.0.1:3000
npm run leak-check -- http://127.0.0.1:3000
```

`smoke` exists because the checks above it were **all green** while twenty-odd studio routes were
unreachable. The only thing that catches that is asking the running application. It asserts the
distinctions that matter and are easy to get wrong: a missing record must be **404, not a soft-404**; an
anonymous studio API call must be **401 JSON, not an HTML login page**; and a lower tier must be
**403, not 500** — a deliberate refusal reported as a server fault sends somebody hunting a bug that
does not exist.

### `route-check` — the client/server contract

A screen and the handler it calls are two halves of one contract written in two files, and **nothing in
TypeScript connects them**: `fetch("/api/studio/lookup")` is a string. A client can call a route that
does not exist and everything still typechecks, lints and builds. The failure appears when somebody
clicks the button — as a 404, or worse a **405** from a neighbouring dynamic route that swallowed the
path (`/api/studio/files/presign` resolving to `files/[id]` with `id="presign"`).

It found more than twenty such call sites, including `/api/studio/lookup` — the relation picker used by
every editor in the CMS, which meant **not one relation could be set anywhere**. It is part of
`npm run check`, so it cannot regress silently.

⚠ **It resolves `/api/…` literals only, and a PAGE route is outside what it can see.** That blind spot
has since cost a whole feature: the page builder pointed its preview iframe at `/studio/preview/<slug>`
for an entire release and no route existed there, so the preview panel was a working front end aimed at
a 404 with every check green. `smoke` now asserts that route in three directions — see
`docs/OUTSTANDING.md` §5. When you add a page route that something else addresses by string, add a
`smoke` assertion for it; nothing else will notice.

## The draft-leak check

The highest-consequence defect this codebase can have is a **draft or soft-deleted record appearing on
the public site** — an embargoed publication, an unannounced partnership, somebody's unfinished
biography — quietly, with every signal green. It is an *omission* (a missing publish filter in one of
about ninety queries), so neither the type checker nor code review catches it reliably.

`scripts/leak-check.ts` settles the question empirically. It creates one draft and one soft-deleted
record of **every** content type with a marker string in every field, fetches every public URL, and
fails if the marker appears anywhere or if any detail URL returns anything but a 404. It removes its
fixtures in a `finally`, and refuses to run with `NODE_ENV=production`.

```bash
npm run build && npx next start -p 3000 &
npm run leak-check -- http://127.0.0.1:3000
```

It has already earned its keep: it caught four detail routes returning **500 instead of 404** for an
unpublished record, because a `forbidden.tsx` at the app root read cookies and made statically
generated routes fail at runtime.

## Accessibility

Not a checklist item; a constraint the components enforce.

- Theme, reduced motion, larger text and high contrast are viewer preferences, applied to `<html>`
  before first paint by a blocking boot script.
- Reduced motion is honoured on **both** paths — the CSS rules cover CSS, and every framer-motion
  animation branches in JavaScript, because CSS cannot reach an inline style.
- Colour never carries meaning alone: every status has an icon and a word.
- Any signal that exists only as motion is paired with a static counterpart.
