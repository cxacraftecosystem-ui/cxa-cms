# Operations

What a deployment needs that the code cannot arrange for itself. Everything here is a thing that will
otherwise be discovered as a failure — most of them at the worst possible moment, part-way through
somebody's upload.

---

## 1. Object storage CORS — the one that bites hardest

**Uploads go browser → storage directly**, using a presigned PUT (`lib/storage/client.ts`). The
application never sees the bytes, which is what makes a 400 MB video possible at all. It also means the
bucket, not the app, decides whether the browser is allowed to talk to it.

Set this on the bucket before anybody tries to upload:

```json
[
  {
    "AllowedOrigins": ["https://your-site.example"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

**`ExposeHeaders: ["ETag"]` is the load-bearing line.** A browser cannot read a response header that is
not exposed, and a multipart upload identifies each part by its `ETag` — so without it multipart is
impossible from a browser and every large transfer silently falls back to single PUTs. The symptom is
not an error: it is large uploads becoming slow and fragile, which reads as a network problem.

`AllowedOrigins` must list the **exact** origin including scheme and port. A wildcard works and is worth
avoiding: any page on the internet can then read from the bucket with the visitor's credentials.

**`GET` in `AllowedMethods` is also what makes SUBTITLES work**, and that one fails silently in a way
uploads do not. A `<track>` on a `<video>` is fetched as a CORS request, and the media is served from
`NEXT_PUBLIC_CDN_URL` — a different origin from the page by construction. Without the grant the browser
refuses the track: no error a reader can see, no captions, and a subtitles menu that appears and does
nothing. `components/site/VideoPlayer.tsx` sets `crossOrigin="anonymous"` on the element **only when a
caption file is present**, precisely so a bucket that has never allowed cross-origin reads keeps playing
the videos it plays today; captions are the new capability, and they are the only thing that needs the
header.

## 2. Environment

Every variable is documented inline in [`.env.example`](../.env.example). The ones whose absence is
silent rather than loud:

| Variable | If unset |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | **Throws at boot in production**, deliberately. Without it, canonical URLs, Open Graph tags and `sitemap.xml` all publish pointing at `localhost` while every signal stays green. A Vercel **preview** without it uses its own address instead (`VERCEL_BRANCH_URL`, else `VERCEL_URL`), so links minted there stay there. |
| `CRON_SECRET` | Cron endpoints **refuse every request** and log why. That is the safe direction: an unauthenticated purge endpoint on the public internet is worse than a purge that never runs. |
| `DIRECT_DATABASE_URL` | Migrations run through the pooled connection, which fails against a transaction-mode pooler. Reported by the studio's diagnostics panel. |
| `S3_*` | Uploads are disabled and the studio **says so** on the settings screen, rather than failing at 90% of a transfer. |
| `NEXT_PUBLIC_CDN_URL` | **Every photograph on the public site renders as an "Image unavailable" placeholder.** There is no signed-URL fallback for images — signing exists for document downloads only — so this is the one storage variable whose absence is visible to readers. `lib/env.ts` warns at boot. ⚠ It is inlined at build time, so setting it needs a **rebuild**, not a restart. |
| `LOG_ARCHIVE_DESTINATION_IS_PRIVATE` | **The nightly log archive writes nothing, and a log drain would be refused too.** It defaults to refusing on purpose — archive keys are derived from the date, and the media bucket grants anonymous `GetObject` on every key, so writing there unstated would publish the audit trail. Clause 4 is then being met by Postgres alone, with no object-storage evidence at all. Reported on the diagnostics panel; read §9 and the entry in `.env.example` before setting it, because it is an assertion about the **bucket policy**, not a feature switch. |
| `ACCESS_LOG_ENABLED` | Set to `false`, **no `access_logs` row is written for anything** — the studio, the authentication routes, the cron endpoints. It defaults on; its being off is reported on the diagnostics panel, because while it is off there is nothing to produce to CIC. |

`JWT_SECRET` is validated for strength at boot: shorter than 32 characters, a known placeholder, or
fewer than 8 distinct characters and the application **refuses to start**. A signing key an attacker can
guess is indistinguishable from having no authentication at all.

```bash
openssl rand -base64 48
```

## 3. Scheduled jobs

**There are three cron routes and they are scheduled from two different places.** That is not an
oversight — the Hobby plan **refuses any cron that fires more than once a day**, and the deploy is
rejected outright with `Hobby accounts are limited to daily cron jobs` — so the two daily jobs live in
`vercel.json` and the ten-minute one had to move to GitHub Actions. Check the table against
`vercel.json` and `.github/workflows/keep-warm.yml`, because it goes stale the moment either is
edited. On another platform, call all three with `Authorization: Bearer $CRON_SECRET`.

| Job | Scheduled by | Schedule | What it does |
|---|---|---|---|
| `/api/cron/purge` | `vercel.json` | `17 3 * * *` | Deletes the bytes of assets soft-deleted longer than `MEDIA_PURGE_AFTER_DAYS`, then their rows. Prunes expired sessions. |
| `/api/cron/logs-archive` | `vercel.json` | `41 3 * * *` | Copies closed days of `audit_logs` and `access_logs` into `files/logs/<source>/<YYYY>/<MM>/<DD>/`, one manifest per day. **Deletes nothing.** |
| `/api/cron/publish` | **`.github/workflows/keep-warm.yml`** | `*/5 * * * *` requested | Flips `SCHEDULED → PUBLISHED` and `PUBLISHED → ARCHIVED` at their dates, and re-syncs the search index's `isPublished` flag. The same workflow then checks that the database answers; that check no longer gates the publish. A missing `SITE_URL` or `CRON_SECRET` repository secret fails the publish step and turns the run red, and the database check still runs; it used to warn and stay green while nothing flipped. ⚠ GitHub's scheduler is best-effort, and in practice runs this **hours** apart — a median of 263 minutes between runs over 100 runs from 2026-09-20 to 2026-10-08 — so the studio's status column and search catch up hours after the date; and **GitHub silently disables scheduled workflows in a repository with no activity for 60 days**. `DEPLOYMENT.md` §1.7 has the two schedulers that would keep time; `ARCHITECTURE.md` §3.2. |

⚠ **`logs-archive` has two preconditions this repository cannot satisfy for you, and it is not
compliant without them.** Both are in §2 and in `.env.example`, and both are infrastructure:

1. **`LOG_ARCHIVE_DESTINATION_IS_PRIVATE=true`** — and the bucket policy that makes it a true
   statement. Until it is set the job runs nightly, returns 200, and archives **nothing**. It says so
   in its response and on the studio's diagnostics panel, and it writes an `audit_logs` row each
   night recording that it did nothing, so the silence is discoverable later than the hour Vercel
   keeps the console line.
2. **A lifecycle rule of at least 90 days on `files/logs/`** — and, more precisely, *no* expiry rule
   shorter than that. Code puts the objects there; only the bucket decides how long they survive, and
   a 30-day expiry inherited from a bucket-wide rule would quietly undo the whole obligation with the
   job still reporting success every night.

**On Pro, move `publish` back into `vercel.json`** as `{ "path": "/api/cron/publish", "schedule":
"*/10 * * * *" }` and drop the publish step from the workflow — or, on the current plan, schedule the
same call from Supabase Cron (`DEPLOYMENT.md` §1.7). Either keeps time; GitHub's scheduler does not,
and is disabled by repository inactivity.

**The publish job is a convenience, not the mechanism.** `livePublishableWhere()` compares against
`now` on every read, so a scheduled article goes live at its minute even if the job has not run since
yesterday, and a stalled job cannot leave an expired embargo readable. What the job buys is honesty in
the studio (the status column matching reality) and an audit entry recording the transition.

The **index re-sync inside it is not optional**, though. `isPublished` is computed at write time while
publication state resolves at read time, so without the job a page past its `unpublishAt` 404s at its own
URL while its title keeps coming back from `/search` — a withdrawn page still findable by name.

**The purge job's ordering is the whole design: bytes first, row second.** A failure to delete bytes
aborts that row's deletion. The reasoning is in the route's header and worth reading before changing it:
an orphaned *row* is visible, reported and fixable; an orphaned *object* is invisible, unbilled to any
feature, and accumulates forever.

## 3a. The container images

`Dockerfile` builds four stages; two of them are runnable and the reasons are worth knowing.

| Stage | Why it exists |
|---|---|
| `deps` | `node_modules`, cached against the lockfile alone. |
| `builder` | `prisma generate` then `next build`. |
| **`migrator`** | A **separate runnable image** that keeps the Prisma CLI, the schema and `tsx`. The runtime image cannot run migrations: standalone output contains only what the *server* reaches, and all three are build-time tools it deliberately excludes. |
| **`runtime`** | The standalone server and nothing else. |

**Debian slim, not Alpine, and that is deliberate.** Two native dependencies — `sharp` (libvips) and
Prisma's schema engine (the binary behind `prisma migrate`; from Prisma 7 the client has no engine) — need
builds matching the C library. On Alpine that means a musl engine and a musl sharp build; each fails at *run*
time, and each fails with a message about an ELF header that says nothing about musl. Debian costs ~40 MB
and removes both problems. `openssl` is installed explicitly in every stage: the schema engine links
against it, it is absent from slim, and without it `prisma generate` succeeds while every migration fails.

**Two copies in the runtime stage look redundant and are not:**

- `.next/static` and `public/` are emitted **outside** the traced bundle. Miss them and every page
  returns 200 with no CSS and no JavaScript — which reads as a broken stylesheet, not a missing step.
- `node_modules/.prisma` and `@prisma/client` are copied **explicitly**. The reason used to be Prisma 6's
  query engine, a binary loaded by path; Prisma 7 has none (queries go through node-postgres), but the
  generated client in `.prisma` is still reached through a require Next does not follow reliably.

**`output: "standalone"` is not committed.** The Dockerfile generates a wrapper that re-exports the real
config with that one field added, so every header, redirect and image host stays in force and is
maintained in one place. A second full config would drift the first time somebody added a security header
to only one of them.

## 4. First deployment

```bash
npx prisma migrate deploy      # includes the hand-written search-index migration
npm run seed                   # structural pages, settings, navigation, one administrator
```

The seed is **idempotent and non-destructive** — safe to re-run after adding a structural page. It
creates **no default credential**: without `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` it creates no
account and says so. A seeded `admin/admin123` reaches production more often than anyone admits.

**One manual step after any change to `searchUrlFor`:** run *Rebuild index* in
Studio → Settings, or call `POST /api/studio/reindex`. Public URLs are **stored** on each
`SearchDocument` row, so a change to how they are built does not reach rows already written.

## 5. Database notes

- `prisma/migrations/*_search_indexes/` is **hand-written** and must stay in step with the query in
  `lib/search/query.ts`. Prisma cannot express an expression index. If the two expressions differ by so
  much as a `coalesce`, Postgres silently declines to use the index and every search becomes a
  sequential scan — fast on a hundred rows, a timeout on a hundred thousand.
- Nothing in the schema uses `Decimal`, on purpose: Prisma serialises it to a **string** over JSON, and
  a field typed as `number` on the client empties a dropdown the first time it is read. Keep it that way.
- Content models are **soft-deleted**. Every read path must filter through `livePublishableWhere()` or
  `liveStatusWhere()` from `lib/content.ts`. They are two functions rather than one because
  `publishAt`/`unpublishAt` do not exist on every model, and referencing a missing column is a runtime
  error, not a type error.

## 6. Backups

Two stores, and **both are needed**; either alone is not a restore.

1. **Postgres** — everything except bytes. Point-in-time recovery if the provider offers it.
2. **The bucket** — the bytes. Enable versioning: the purge job is designed to be recoverable up to
   `MEDIA_PURGE_AFTER_DAYS`, but a bucket-level mistake is outside anything the application controls.

A database restored to a point *before* an upload leaves the object orphaned (harmless, invisible). A
bucket restored *behind* the database leaves rows pointing at absent objects — broken images with a
perfectly healthy-looking database. **If you must restore one, restore the bucket to at or after the
database's point.**

## 7. Reaching the studio

There is no visible link, by design. Four equivalent doors:

- `/studio`
- `/console` (redirects)
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> on any public page
- the footer wordmark, clicked seven times

`proxy.ts` refuses every `/studio/*` path but the login screen without a live session, and sends
`X-Robots-Tag: noindex` on all of them. `robots.txt` disallows `/studio`, `/console`, `/api/`, `/search`
and `/preview` — but robots.txt is a **request, not an access control**, and none of it substitutes for
the proxy.

## 8. Before every deploy

```bash
npm run check                                   # typecheck + lint + route coverage
npm run build && npx next start -p 3000 &
npm run smoke      -- http://127.0.0.1:3000     # signed in: screens, endpoints, refusals, lifecycle
npm run leak-check -- http://127.0.0.1:3000     # nothing unpublished is publicly reachable
```

`.github/workflows/ci.yml` runs all four against a throwaway Postgres. See the README's *verification
suite* section for what each layer proves and what it is blind to — the honest limits matter as much as
the coverage.

## 9. Platform log drains — the traffic the application never sees

**Nothing in this section is switched on, and nothing can be until the team is on Pro.** The receiver
exists so that the day the plan changes, the work is a dashboard form and two environment variables
rather than a design decision taken in a hurry.

### Why it is needed at all

The audit trail and the access log cover what the *application* does. They structurally cannot cover
traffic that never wakes the application:

| Invisible to the app | Why |
|---|---|
| A cached public page | Answered by the CDN. The function is never invoked, so nothing in `route()` runs. |
| `/_next/*` chunks, fonts, images | Served as static assets or from `NEXT_PUBLIC_CDN_URL`. Never routed through the app. |
| A request `proxy.ts` refused | The 401 JSON and the 307 to login are answered by the proxy, in front of `route()` — the only place an access row is written — and the proxy is kept off the database on purpose. |
| A function that timed out, ran out of memory, or was killed | The process is gone before it can write anything. `vercel.json` raises `maxDuration` on exactly the media routes most likely to hit this. |
| A failed build or migration | `buildCommand` runs `prisma migrate deploy`; a failure there is a build-log event. |

Vercel sees all of it. On Hobby it keeps it for **one hour**. A Log Drain is the only way to get it
out, and it is the only thing that closes the gap between what we can honestly tell CIC we retain and
"all website-related logs".

### Plan and cost — read before switching it on

**Drains are Pro and Enterprise only.** Hobby and Pro Trial cannot create one.

Billing is **$0.50 per GB** of drain volume, and *how* it is measured is the part that surprises
people: Vercel bills the **uncompressed JSON serialisation of each record**, regardless of the format
or encoding used to deliver it. Compressing the delivery, or choosing a compact format, does **not**
reduce the bill — the number your destination reports receiving will be lower than the number you are
charged for, and the two are not comparable. The lever that actually reduces cost is the drain's own
**sampling rules** and **source selection**, both set when the drain is configured.

⚠ **Sampling and clause 4 are in tension, and the choice has to be deliberate.** A drain sampled at
10% retains one request in ten, which is a perfectly good cost control and a poor answer to "show us
the logs for this address on this date". If cost forces sampling, sample the `static` source and leave
`lambda`, `edge` and `firewall` at 100% — those are the sources an incident is actually reconstructed
from.

### Configuring the drain

⚠ **Step 1 is about the bucket, not about the drain, and the receiver will refuse every delivery
until it is done.** This is the step that used to be missing from this section, and the deployment it
produced was the worst of both worlds: `logs-archive` correctly archiving nothing because the
destination was not confirmed private, while `/api/drains/logs` published every visitor IP and every
request URL the CDN served into that same bucket. The two policies were exactly inverted relative to
the sensitivity of what each writes.

1. **Make `files/logs/*` non-public, then say so.** Exclude that prefix from anonymous `GetObject` in
   the bucket policy — or give the archive a private bucket of its own — and set
   `LOG_ARCHIVE_DESTINATION_IS_PRIVATE=true`. Drain deliveries land under the same
   `files/logs/` root the archive cron uses, so this gate covers both, and `/api/drains/logs` answers
   `503 archive_destination_public` while it is unset. `Cache-Control` is **not** what protects these
   objects (see *Where the lines land*); the bucket policy is. While you are in there, give the
   prefix a lifecycle rule of at least 90 days and make sure no shorter bucket-wide rule applies.
2. Set `VERCEL_LOG_DRAIN_SECRET` in the project's environment and re-deploy. Until it is set the
   endpoint refuses every request and logs why, the same way the cron endpoints do without
   `CRON_SECRET`. That is the safe direction: an unauthenticated endpoint that appends to the
   compliance archive lets a stranger forge or flood the evidence trail, which is worse than having
   no endpoint at all.
3. Team Settings → **Drains** → **Add Drain**, data type **Logs**.
4. Select the projects, the sources (`lambda`, `edge`, `static`, `build`, `external`, `firewall`,
   `redirect`) and the environments (`production`, `preview`).
5. Destination **Custom Endpoint**:
   - **Endpoint URL** — `https://aicraft.iitkgp.ac.in/api/drains/logs`
   - **Format** — **NDJSON**. The receiver accepts either and stores one record per line either way,
     so this is now a mild preference rather than the strong one it used to be: NDJSON is what the
     archive stores, so choosing it means the records are re-emitted rather than restructured, and a
     body that cannot be parsed at all is still kept line by line instead of being filed whole as
     `.raw`. ⚠ This bullet used to say the NDJSON path stored the bytes **verbatim**, byte-identical
     to what the signature covered. That is no longer true and could not stay true — see *What is
     scrubbed before anything is stored* below.
   - **Signature Verification Secret** — must be the same string as `VERCEL_LOG_DRAIN_SECRET`.
6. **Create Drain.** Vercel tests the endpoint automatically, and there is a **Test** button
   afterwards.

### Environment

| Variable | Effect |
|---|---|
| `LOG_ARCHIVE_DESTINATION_IS_PRIVATE` | **Unset ⇒ the endpoint refuses every delivery** with `503 archive_destination_public`, exactly as the archive cron refuses to write. It is an assertion about the bucket policy, not a feature switch — see step 1 above. Shared with the archive cron deliberately: one gate for one prefix. |
| `VERCEL_LOG_DRAIN_SECRET` | The drain's signature secret. **Unset ⇒ the endpoint refuses every delivery** and logs why. Empty string counts as unset — HMAC-ing with an empty key is a signature anybody can compute. |
| `VERCEL_LOG_DRAIN_VERIFY` | Optional. Only needed if a drain-creation flow demands an `x-vercel-verify` challenge. The current custom-endpoint flow does not; the handler exists so registration can never be blocked by one. |

All three are in `.env.example`. The studio's diagnostics panel reports two related states: the
privacy flag being unset or malformed, and `VERCEL_LOG_DRAIN_SECRET` being set on a deployment with no
object storage (every delivery would 503). It deliberately does **not** warn that the drain secret is
absent — on Hobby a drain cannot exist, so that would be a permanent red line nobody could clear, and
a panel like that is one operators stop reading.

### Where the lines land

Drain deliveries use the same key layout as everything else the site retains — `lib/logArchive.ts`
owns it, and the receiver imports `dayPrefix` from it rather than keeping its own copy:

    files/logs/vercel/<YYYY>/<MM>/<DD>/delivery-<HHMMSSmmm>-<16 hex>.ndjson

UTC, one object per delivery, day-level prefix so that "what happened on this date" is one prefix per
source. `files/logs`, not `logs`, because `isSafeObjectKey` only accepts keys whose first segment is
one of `media`, `files`, `models`, `tmp` — reusing `files` means that allowlist never has to change,
and there is no collision with real file assets because `buildObjectKey` always emits
`files/<YYYY>/…` and a four-digit year is never the literal `logs`.

**The sixteen hex characters are the first 64 bits of the SHA-256 of the delivery as it arrived**, not
random bytes. They do the same collision job — two deliveries in the same millisecond with the same
digest are the same delivery twice — and they are also the only durable record of *which* delivery an
object came from, now that the stored bytes are not the delivered bytes. A listing of a day therefore
carries the provenance of everything in it without anyone opening a file.

⚠ **`private, no-store` is a caching directive and NOT the access control**, and this paragraph used
to read as though it were. Objects are written with it, overriding `putObject`'s year-long immutable
default, because these bytes record who visited the site, are never served to a browser, and a cached
copy of them in an intermediary is a disclosure with no upside. What decides whether a stranger can
*fetch* them is the bucket policy, which is step 1 of *Configuring the drain* and the thing
`LOG_ARCHIVE_DESTINATION_IS_PRIVATE` asserts. A bucket that grants anonymous `GetObject` on every key
serves these objects to anyone who can name one, `no-store` or not.

### What is scrubbed before anything is stored

⚠ **Drain records carry credentials in URLs, and the receiver redacts them before the PUT.** A drain
record's `proxy.path` is documented by Vercel as "Request path with query parameters" — so a
deployment using the `?secret=` cron form that `assertCronAuthorised` supports for schedulers that
cannot set a header would otherwise file `GET /api/cron/purge?secret=<CRON_SECRET>` verbatim into a
90-day archive, readable by every operator and by the CIC recipient of any range export. The same
applies to every invitation and password-reset link: `/studio/set-password?token=<live credential>`
in cleartext is account takeover for the life of the token.

So `frameDelivery` parses each record and runs three fields — top-level `path`, `proxy.path` and
`proxy.referer` — through **the same `scrubPath`/`scrubQuery` pair the access log uses**, imported
from `lib/requestLog.ts` rather than reimplemented. Query parameter *names* are kept and *values* are
redacted, so "a request carried `token`" stays visible while the token does not. A key added to
`SECRET_QUERY_KEYS` or to `lib/audit.ts`'s `REDACTED_KEYS` covers the drain on the day it is added.

Two consequences worth knowing rather than rediscovering:

- **`message` is not scrubbed.** It is up to 256 KB of the application's own console output per
  record, and it has no structure to scrub; a matcher loose enough to find a credential in arbitrary
  prose is loose enough to destroy evidence in it. The obligation is on the writer — nothing in this
  application may `console.log` a credential — and that is a rule about our code, not about the
  receiver.
- **A line that is not valid JSON is stored as it arrived, unredacted, and counted.** Refusing it
  would mean a non-2xx, which Vercel retries, so the evidence would be discarded on every attempt and
  the drain would eventually be flagged. The count appears in the `[drain] vercel` log line as
  `unscrubbedLines`; it should always be zero, and if it is not, the format being sent is not the one
  this receiver was written against.

**One object per delivery, never an append**, because S3 has no append: "add to today's object" means
read-modify-write, which silently loses one of two concurrent deliveries. An archive that drops lines
under load — exactly when the lines matter — is worse than one with many small objects.

⚠ **The drain source has no `manifest.json`, and that breaks the normal retrieval route.** The
archival cron seals each closed day with a manifest naming its parts, so a reader answers a date range
by computing keys — never by listing the bucket, which matters because the bucket policy denies
`s3:ListBucket` and `listObjectKeys` throws above 200 keys. A receiver cannot write that manifest: a
day is never "complete" while deliveries are still arriving, and rewriting a shared index per delivery
is the read-modify-write race again. So **drain objects are today discoverable only by listing their
day prefix**, and a reader following the manifest protocol will not see them. The `delivery-` prefix
in the filename (rather than `part-NNNN`) marks them as unsealed. Closing this properly means a
scheduled job that seals yesterday's drain prefix into a manifest — see *Unfinished* below.

### What each refusal means

| Response | Meaning | Vercel's behaviour |
|---|---|---|
| `503 drain_unconfigured` | `VERCEL_LOG_DRAIN_SECRET` is not set. | Retries; the drain errors. |
| `503 storage_unconfigured` | No `S3_*` configuration, so there is nowhere to put the bytes. | Retries; the drain errors. |
| `503 archive_destination_public` | `LOG_ARCHIVE_DESTINATION_IS_PRIVATE` is unset or not a yes, so the destination has not been confirmed non-public. Step 1 of *Configuring the drain*. | Retries — which is the point: nothing is published while an operator fixes the bucket policy, and nothing is lost. |
| `503 log_archive_unavailable` | The archive key was refused by `isSafeObjectKey` — the archive root has moved out from under `files/`. Should never happen. | Retries; the drain errors. |
| `503 archive_write_failed` | The bucket refused or could not be reached. The delivery was **not** retained. | Retries — which is the point: the retry is what turns a transient blip into a delay rather than a hole. |
| `403 invalid_signature` | Not from Vercel, **or** the two secrets disagree. The response deliberately does not say which; the server log does. | Retries; the drain errors. |
| `413 too_large` | Body above the receiver's 8 MB memory guard. Vercel's own request limit is lower, so this should be unreachable from a genuine delivery. | Retries. |

Vercel emails and flags the drain when more than 80% of deliveries fail, or more than 50 fail, in an
hour. **A drain that has errored is retaining nothing**, so that email is the monitoring signal clause
4 asks for — treat it as an incident, not a notification.

### Two settings that are easy to get wrong

- **IP Address Visibility** (Team Settings → Security & Privacy) can hide client IPs in drain data. It
  must stay **on** for this purpose: "which address requested what, when" is precisely the question
  clause 4 exists to make answerable, and a drain with the addresses stripped answers it with
  "somebody". Note the trade — those addresses are personal data and the archive is subject to
  whatever retention and access rules that implies.
- **The receiver is not behind `proxy.ts`.** Its matcher is `/studio`, `/studio/*` and
  `/api/studio/*`, so `/api/drains/*` is not matched and must not be added — the signature is the
  authentication, verified by the route itself (`lib/drains.ts`), and the proxy knows nothing of it.

### Unfinished

Two things are deliberately not done, and each would be a separate change:

1. **Nothing seals the drain prefix into a manifest**, so drain objects are not reachable by the
   manifest-driven reader the rest of the archive uses (above). A daily job that lists yesterday's
   `files/logs/vercel/<date>/` prefix and writes a `manifest.json` naming what it found would close
   this; it belongs next to the existing archive cron, not in the receiver. ⚠ **That manifest key is
   a pure function of the date**, so it converts the whole drain archive into a single fetch for
   anyone who can type a date. It is safe to write only because the privacy gate above is now
   enforced on this prefix; do not add the sealing job on a deployment where that gate is being
   worked around.
2. **Nothing applies retention to drain objects.** The 90-day floor and the retention window are
   enforced for the database tables the archive job reads. Objects written by this receiver are
   subject to no expiry at all — which errs in the safe direction for clause 4 but means the bucket
   grows without bound and without a stated policy.

The third item that used to be here — `VERCEL_LOG_DRAIN_SECRET` being in neither `.env.example` nor
`configurationWarnings()` — is done. See *Environment* above for what the panel does and does not
report, and why the absent-secret case is deliberately not one of them.
