# Deployment

Two supported paths, side by side. **Vercel**, where the platform runs a changing number of short-lived
copies of the application, and **a long-lived server**, where one Node process stays up inside a
container. The code is identical on both; what differs is documented in §3, and every difference has at
least one feature attached to it.

This file covers *getting it running*. Three things it deliberately does not repeat, because they are
already written once and would drift:

- **Object storage CORS** — [`OPERATIONS.md` §1](./OPERATIONS.md). Get this wrong and uploads fail at
  the browser, with nothing in the application's logs.
- **What each environment variable does** — [`.env.example`](../.env.example), documented inline.
- **Backups, the scheduled jobs' semantics, the verification suite** — `OPERATIONS.md` §3, §6, §8.

`lib/runtime.ts` prints the live version of §3 for whichever platform is actually running, into the
studio's Settings → Diagnostics panel. If this document and that panel disagree, the panel is right.

---

## 0. Which path

| Choose Vercel when | Choose a long-lived server when |
|---|---|
| Nobody wants to own a server, TLS renewal or an operating system. | The institution requires the data and the application inside its own network. |
| Traffic is spiky — a launch, a call for papers, a conference. | Traffic is steady and modest, which is the ordinary case here. |
| A managed Postgres with a connection pooler is available. | You already run Postgres, and want one process with one connection pool. |
| You are on a paid plan. The ten-minute cron schedule needs one (§1.7). | You want the request limits to mean exactly what they say (§3). |

Neither is a worse deployment. The Vercel path trades a handful of exact behaviours for having no server
to look after; the container path trades operational work for a single process where in-memory state
means what it looks like.

---

## 1. Vercel

### 1.1 Connect the repository

Import the repository in the Vercel dashboard. Framework preset **Next.js**; leave the root directory at
the repository root. `vercel.json` supplies the build command, the schedules and the two function
overrides, so there is nothing to type into the dashboard's build settings — and nothing should be typed
there, because a dashboard value silently wins over the file and the next person reads the file.

**Do not add `output: "standalone"`.** Vercel does its own output handling and the setting is at best
redundant there. It is switched on *only* in the container build, by a wrapper the `Dockerfile`
generates — see §2.2.

### 1.2 Environment variables

Set these for **Production**, **Preview** and **Development** unless a row says otherwise.
`.env.example` says what each one is for; this table is about *when Vercel needs it*.

| Variable | Needed | Note |
|---|---|---|
| `DATABASE_URL` | build **and** runtime | The **pooled** address. See §1.4. |
| `DIRECT_DATABASE_URL` | build | The **unpooled** address. Migrations run in the build. See §1.4. |
| `JWT_SECRET` | build **and** runtime | `openssl rand -base64 48`. The build evaluates route modules and `lib/auth/config.ts` refuses a weak value, so a missing one fails the build rather than the first sign-in. |
| `JWT_ALGORITHM`, `ACCESS_TOKEN_TTL_MINUTES`, `REFRESH_TOKEN_TTL_DAYS` | runtime | Defaults are sensible; set them to be explicit. |
| `NEXT_PUBLIC_SITE_URL` | **build** | Baked into the bundle. Also read on the server, where a missing value throws in production on purpose. **Production only:** a Preview deployment without it uses its own address instead (`VERCEL_BRANCH_URL`, else `VERCEL_URL`). ⚠ Never give Preview the production origin — a password or newsletter link minted on a preview would carry its token to production, where it does not exist. |
| `NEXT_PUBLIC_SITE_NAME`, `NEXT_PUBLIC_CDN_URL` | **build** | Baked into the bundle. |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | runtime | Required here, not optional. §1.5. |
| `S3_PUBLIC_BASE_URL` | **build** only | `next.config.ts` derives the image optimiser's host allowlist from it at build time, and that is its only reader — `lib/env.ts` deliberately leaves it out of the runtime shape. A host missing from that list renders as a broken image, not an error. ⚠ It does **not** stand in for `NEXT_PUBLIC_CDN_URL`: setting this and leaving that blank serves an "Image unavailable" placeholder for every photograph on the site. |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_SSE_ALGORITHM` | runtime | Only for non-AWS storage (R2, Backblaze, MinIO). |
| `CRON_SECRET` | runtime | Vercel Cron sends it for you. §1.7. |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | runtime | **Secrets.** The IAM user that sends newsletter mail through Amazon SES; it needs `ses:SendEmail` and `ses:GetAccount` and nothing else. Without them (or without `NEWSLETTER_FROM_ADDRESS`) nothing is sent and every message queues. §1.9. |
| `SES_REGION` | runtime | The region the SES identity is verified in. Defaults to `ap-south-1`. |
| `NEWSLETTER_FROM_ADDRESS` | runtime | The From address — an identity verified in SES. ⚠ See §1.9 on why it should be on a domain the Centre controls. |
| `NEWSLETTER_FROM_NAME` | runtime | Optional. The From display name; defaults to `NEXT_PUBLIC_SITE_NAME`. |
| `SES_CONFIGURATION_SET` | runtime | Optional. An SES configuration set to send through. |
| `NEWSLETTER_DRAIN_SECRET` | runtime | **Secret.** The bearer the GitHub Actions drain schedule presents to `/api/cron/newsletter-drain` (Vercel's daily fallback cron presents `CRON_SECRET`). The same value goes in the repository secret of the same name. §1.7. |
| `SES_FEEDBACK_TOPIC_ARNS` | runtime | Optional, comma-separated. The SNS topics whose bounce/complaint notifications are accepted; defaults to `arn:aws:sns:ap-south-1:626159998512:ses-feedback`. §1.9. |
| `MEDIA_PURGE_AFTER_DAYS` | runtime | Defaults to 30. |
| `LOG_ARCHIVE_DESTINATION_IS_PRIVATE` | runtime | ⚠ **A precondition, not a preference, and it defaults to refusing.** Unset, `/api/cron/logs-archive` archives **nothing** every night and a log drain would be refused too — so the 90-day retention clause 4 obliges is being met by Postgres alone, with no object-storage evidence. Set it only once the bucket policy excludes `files/logs/*` from anonymous `GetObject`, because that is what it asserts. `OPERATIONS.md` §3. |
| `ACCESS_LOG_ENABLED`, `ACCESS_LOG_RETENTION_DAYS` | runtime | Default `true` and `180`. Off, no `access_logs` row is written for anything; below 90 the retention variable **throws**, because 90 is the term in the undertaking and not a preference. |
| `VERCEL_LOG_DRAIN_SECRET`, `VERCEL_LOG_DRAIN_VERIFY` | runtime | **Pro plan only** — Log Drains do not exist on Hobby, so leaving both blank is correct here. `OPERATIONS.md` §9. |
| `GOOGLE_*`, `MICROSOFT_*`, `YAHOO_*` | runtime | Each optional and independent. `docs/SIGN-IN.md`. |
| `SEED_ADMIN_*`, `SEED_MASTER_ADMIN_EMAILS` | — | **Do not set on Vercel.** The seed is not part of the build; run it once from your own machine against the production database (§1.8). |

⚠ **A `NEXT_PUBLIC_*` change needs a REDEPLOY, not a restart.** Those values are inlined into the
JavaScript sent to the browser at build time. Editing one in the dashboard changes nothing until the next
build, and the symptom is a site that keeps using the old value with every signal green.

⚠ **Preview deployments run the same build command, including the migration.** A preview branch pointed
at the production `DATABASE_URL` will apply that branch's migrations to production. Give Preview its own
database, or accept that a branch with a migration is a production schema change.

### 1.3 The install and build commands

`vercel.json` installs with npm 12 (`npm install -g npm@12.2.0 && npm ci`), as CI and the Dockerfile do.
npm 12 runs a dependency's install scripts only where `package.json`'s `allowScripts` allows them:
`@prisma/engines` (it fetches the schema engine `prisma migrate` runs) is allowed; `esbuild`, `prisma`
and `unrs-resolver` are denied, because each works from its prebuilt optional package without its script.
A dependency that gains an install script is skipped until somebody reviews it with
`npm install-scripts ls` and approves or denies it — that is the point of the policy.


```
prisma generate && prisma migrate deploy && next build
```

Three steps, in the only order that works.

- **`prisma generate`** — the build imports `@prisma/client`, and without the generated client it fails
  with a message about a missing module rather than a missing generate step. The CLI reads
  `prisma.config.ts` (Prisma 7): schema, migrations, seed, and the migration URL.
- **`prisma migrate deploy`** — applies committed migrations and nothing else. Never `migrate dev`, which
  will happily invent a migration from schema drift; in a build that means unreviewed DDL against a real
  database. Putting it *before* `next build` matters: the build reads the database through
  `generateStaticParams`, so a build against an unmigrated schema prerenders nothing and the first
  visitor pays for every page.
- **`next build`**.

`lib/prerender.ts` catches a database failure during the build and prerenders nothing rather than failing
the deploy — so a build that cannot reach the database **succeeds**, quietly, with empty listings that
repair themselves within each page's `revalidate` window. Check the build log for its warning; do not
take a green deployment as proof the database was reachable.

Prisma needs no `binaryTargets` entry in `schema.prisma`. From Prisma 7 the client has no engine at all —
it talks to Postgres through node-postgres (`lib/prisma-adapter.ts`) — and the CLI's schema engine detects
Vercel's Amazon Linux and the container's Debian on its own.

### 1.4 Two database URLs, and why

```
DATABASE_URL         → the pooler, transaction mode                  (runtime)
DIRECT_DATABASE_URL  → one continuous session: session mode or direct (migrations)
```

From Prisma 7 the URLs are not in `prisma/schema.prisma`. The application connects from `DATABASE_URL`
through the driver adapter in `lib/prisma-adapter.ts`; the CLI (`prisma migrate`) reads
`prisma.config.ts`, which uses `DIRECT_DATABASE_URL` and falls back to `DATABASE_URL`.

**Why the runtime URL must be pooled.** Every copy of the application opens its own connection pool, and
the platform starts copies as traffic needs them. Postgres has a fixed connection allowance, so a busy
period exhausts it and pages begin failing with a connection error that reads like a database outage. A
pooler in front means the app's many short connections share a few real ones.

**Why migrations must NOT go through it.** A transaction-mode pooler hands a connection back to the pool
at the end of each transaction, so a session cannot rely on anything that outlives one statement. DDL
needs exactly that: `CREATE INDEX`, advisory locks, `SET` statements and Prisma's own migration lock all
assume one continuous session. Run `prisma migrate deploy` through a transaction pooler and it fails
part-way, or — worse — reports success on a lock it never actually held, and two concurrent builds
migrate the same database at once.

If `DIRECT_DATABASE_URL` is absent, `prisma.config.ts` falls back to the pooled URL and the studio's diagnostics
panel says so. That fallback works against a plain Postgres and fails against a pooler, which is the
single most confusing failure in this list: the same command works locally and fails in the build.

**On Supabase, which is what production uses.** Both URLs go through Supabase's pooler, on the host
Supabase → **Connect** shows for the project (`aws-0-<region>.pooler.supabase.com`; production's
project is in `ap-south-1`). Placeholders only — the real values are Vercel secrets:

```
DATABASE_URL        = postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10&pool_timeout=30&sslmode=require
DIRECT_DATABASE_URL = postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

Every part of the first one is load-bearing:

- **Port `6543`** is transaction mode: a server connection is lent for one transaction and returned,
  so however many copies of the application are running share a handful of real connections.
- **`pgbouncer=true`** says a transaction pooler is in front. Prisma 6 needed it to stop naming its
  prepared statements, because a statement prepared on one server connection does not exist on the next
  one the pooler lends (`prepared statement "s0" already exists`). Prisma 7's adapter names none unless
  told to, so the parameter is now a statement of fact the adapter strips; keep it in the URL.
- **`connection_limit=10`** is the pool *each copy* of the application keeps (the adapter's pool `max`). Prisma's generic advice
  for serverless is `1`, and **it is wrong here**: the build prerenders pages in parallel through one
  client, and the production build of 2026-09-24 12:41 UTC failed with `P2024 Timed out fetching a new
  connection from the connection pool … (connection limit: 1)`. The same commit built cleanly minutes
  later, once `DATABASE_URL` had been re-created (the operators' record of the new URL carries
  `connection_limit=10`; the deployed value is a secret). Fluid compute also serves several requests
  from one copy at once, and Vercel advises against a pool of one for that reason. The smallest
  Supabase computes (Nano, Micro) admit 200 pooler clients, so 10 per copy leaves room for about
  twenty copies at once.
- **`pool_timeout=30`** is how many seconds a query waits for a free connection from that pool before
  failing (default 10; `lib/audit.ts` still tells the editor what `P2024` used to). Builds run in Washington (`iad1`) against a database in Mumbai, so
  every connection there is slow to open and slow to give back.
- **`sslmode=require`** encrypts the connection without verifying the server certificate — libpq's and
  Prisma 6's meaning. node-postgres would read it as `verify-full` and refuse Supabase's certificate, so
  `lib/prisma-adapter.ts` translates it; verifying needs Supabase's CA shipped with the functions, which
  is not done.

The second URL is the **session pooler on port 5432 of the same host**, one server connection for the
whole session, which is what `prisma migrate deploy` needs. It is not the "direct connection" Supabase
also offers, `db.<project-ref>.supabase.co`: without Supabase's paid IPv4 add-on that host resolves to
IPv6 only, and Vercel's builds and functions cannot reach IPv6. It carries none of the pool
parameters, because a migration is one session doing one thing.

`schema`, `pgbouncer`, `connection_limit`, `pool_timeout` (and `socket_timeout`,
`statement_cache_size`, `sslaccept`, `sslidentity`) are **Prisma's own parameters, not Postgres's** —
`lib/prisma-adapter.ts` reads each one and strips it before node-postgres sees the URL —
`psql` and every other libpq client refuse a URL that carries them with `invalid URI query
parameter`. Anything that hands one of these URLs to such a tool strips them first —
`.github/workflows/keep-warm.yml` shows how.

### 1.5 Object storage is not optional here

**A serverless filesystem cannot hold an upload.** There is a temporary folder for the life of one
request and nothing else is writable; the folder is discarded when the request ends, and the next request
may be served by an entirely different copy of the application. A file written during an upload would be
gone before anybody could ask for it.

This is why the application **presigns direct-to-storage** and never accepts the bytes itself
(`lib/storage/client.ts`, `lib/client/upload.ts`):

1. the browser computes the file's SHA-256 and asks `/api/studio/media/presign` for a signed URL. The
   signature covers the **exact size** (capped per kind, `lib/storage/upload-limits.ts`), the **content
   type** and the **SHA-256** (`x-amz-checksum-sha256`), and the answer carries a signed `uploadTicket`;
2. the browser PUTs the file **straight to the bucket** — the application never sees it, which is what
   makes a 200 MB video possible at all. Storage refuses a body of any other size, type or content;
3. the browser calls `/api/studio/media/complete` with the ticket, which `HEAD`s the object (asking for
   its stored checksum), refuses if it is not there, deletes and refuses it if its size, checksum or type
   differ from the ticket, and only then writes the row.

Two consequences worth knowing before the first upload:

- **The bucket's CORS policy decides whether step 2 is allowed**, not the application. `OPERATIONS.md`
  §1, and `ExposeHeaders: ["ETag"]` is the line people miss.
- **`S3_PUBLIC_ENDPOINT` is for split addressing only** — a server and a browser that reach storage at
  different origins. On Vercel with AWS S3 or R2 both use the same public address, so leave it blank.

### 1.6 `vercel.json`, entry by entry

The file is strict JSON and cannot carry comments, so the reasons live here. Every key in it is load-bearing.

| Key | Why it is there |
|---|---|
| `$schema` | Editor validation. A typo in a function path is otherwise discovered as a setting that silently did nothing. |
| `framework: "nextjs"` | Explicit rather than detected, so a future `package.json` change cannot alter the build. |
| `regions: ["bom1"]` | Every function runs in Mumbai, beside the Supabase database and the media bucket, both in `ap-south-1`. Without it functions run in the project's default region, Washington (`iad1`), and every database round trip crosses the world: a one-query endpoint took 1.4–1.5 s warm and 4 s cold there, against 0.24–0.5 s for the museum app on the same Supabase region with its functions in `bom1`, and every studio save is an interactive transaction holding row locks across several such trips. The Hobby plan allows one region. Builds still run in `iad1`; only functions move. Set Project → Settings → Functions → Function Region to Mumbai too, so a deployment that ignores this file cannot quietly fall back to Washington. |
| `buildCommand` | §1.3. |
| `crons` | §1.7. |
| `functions["app/api/studio/media/complete/route.ts"]` | `memory: 2048`, `maxDuration: 300` — 2048 MB is the Hobby plan's ceiling, and the original 3009 was refused at deploy. This route pulls the uploaded object into memory and runs `sharp` over it to make every derivative. A 40-megapixel heritage scan decodes to a bitmap of several hundred megabytes, and the pipeline runs the sizes **sequentially** for exactly this reason. At the default memory the function is killed part-way: the object is already in the bucket, so the file exists with no row and no error anybody sees. |
| `functions["app/api/studio/media/[id]/replace/route.ts"]` | The same two values, because it does the same work — replacing the bytes behind an asset re-runs the whole derivative pipeline. It previously had **no entry**, and the route's own header says so; without it a large replacement is killed and the asset keeps pointing at the old file with nothing on screen to explain why. |
| `functions["app/api/studio/files/route.ts"]` | `maxDuration: 60`, memory left at the default. Registering a document reads the whole object back to fingerprint it, up to a stated 128 MB cap. That is a large download plus a SHA-256, and it does not reliably finish inside the default ten-to-fifteen seconds. A 128 MB buffer fits the default memory comfortably, so only the clock needed raising. |
| `functions["app/api/studio/files/[id]/versions/route.ts"]` | The same, for the same reason — it is the new-version half of the same flow and carries the same 128 MB cap. |
| `functions["app/api/cron/newsletter-drain/route.ts"]` | `maxDuration: 60`. The drain spaces its sends at Amazon SES's per-second rate and stops starting new ones after 40 seconds, so it needs more than the default clock and never more than this. |
| `functions["app/api/studio/newsletter/issues/[id]/send/route.ts"]` | `maxDuration: 60`. Pressing Send queues the issue and then runs a first drain batch after the response (`after()`), inside the same invocation. |

Notes on that block:

- **The keys are source paths, not URL paths.** `app/api/studio/media/[id]/replace/route.ts`, with the
  bracket segment verbatim. A key that matches nothing is accepted silently and grants nothing.
- **The values are ceilings, not reservations.** A raised `maxDuration` costs nothing on a request that
  finishes quickly. Raised *memory* is billed for the whole invocation, which is why the two file-store
  routes get time and not memory, and why nothing here is applied with a wildcard.
- **If your plan caps memory or duration lower than these values, the deployment is rejected** with a
  message naming the limit. That is the good failure. Lower the numbers and expect large scans to be
  refused rather than killed — `DERIVE_MAX_BYTES` and `CHECKSUM_MAX_BYTES` in those routes already state
  their skips on screen.
- **Nothing else has an entry, on purpose.** `app/api/studio/reindex/route.ts` sets `maxDuration = 300`
  in the route file itself, which Vercel honours; each of the three cron routes caps its own work per
  run (`MAX_ASSETS_PER_RUN` in the purge, `MAX_DAYS_PER_RUN`/`MAX_ROWS_PER_RUN` in `logs-archive`) so
  the default clock is ample; every other route is a database query. ⚠ If `logs-archive` ever starts
  failing a large day on the clock rather than on its own budget, the entry it needs is `maxDuration`,
  not memory — it streams a day a page at a time and never holds more than `ROWS_PER_PART` rows.

### 1.7 Cron

```json
{ "path": "/api/cron/purge",            "schedule": "17 3 * * *" }
{ "path": "/api/cron/logs-archive",     "schedule": "41 3 * * *" }
{ "path": "/api/cron/newsletter-drain", "schedule": "53 3 * * *" }
```

**That is the whole `crons` array, and there is a fourth cron route that is not in it.**
`/api/cron/publish` is scheduled every five minutes from **`.github/workflows/keep-warm.yml`**, not
from here — the Hobby plan rejects the deploy outright with `Hobby accounts are limited to daily cron
jobs` for any schedule that fires more than once a day, so the ten-minute job had to move somewhere
else and the two daily slots went to the jobs that cannot be run any other way. ⚠ **Scheduled is not
run.** GitHub's scheduler is best-effort, and over 100 runs from 2026-09-20 to 2026-10-08 it left a
median of 263 minutes between them (longest 529), so a scheduled page reaches the studio's status
column and the search index hours late. `ARCHITECTURE.md` §3.2 is the long version. Confirmed against
`vercel.json`, that workflow, and the routes that exist. What each job does is in `OPERATIONS.md` §3.

- **The newsletter drain runs from two schedules.** `.github/workflows/newsletter-drain.yml` POSTs to
  `/api/cron/newsletter-drain` every five minutes (best-effort, like every GitHub schedule) with
  `Authorization: Bearer $NEWSLETTER_DRAIN_SECRET`, reading the origin from the repository **variable**
  `NEWSLETTER_SITE_URL` and the bearer from the repository **secret** `NEWSLETTER_DRAIN_SECRET`; the
  daily entry above is the fallback and presents `CRON_SECRET`. Neither is the main trigger:
  transactional mail is sent inline by the request that causes it, and pressing Send on an issue starts
  the first batch straight away. The endpoint accepts either bearer, compared in constant time, and is
  safe to call concurrently and as often as anybody likes. Running the workflow by hand drains at once.
- **`CRON_SECRET` must be set as an environment variable.** Vercel Cron then sends
  `Authorization: Bearer <CRON_SECRET>`, which is exactly what `assertCronAuthorised` expects. Without
  it the endpoints refuse every request and log why — the safe direction.
- **The `?secret=` query form no longer exists.** `lib/cron.ts` accepts only
  `Authorization: Bearer <secret>`, and a request that carries `?secret=` at all is answered **401** even
  when the value is right — a secret in a URL is logged by every proxy in between, so a scheduler still
  using it must fail loudly rather than leak quietly. The value is never compared or logged; the server
  log names the path and says to move to the header and rotate. A scheduler that cannot set a header calls
  through something that can (both GitHub workflows do). The log drain receiver still redacts `secret`
  from archived URLs (`OPERATIONS.md` §9) as a backstop for old callers.
- ⚠ **`logs-archive` has two preconditions that are not environment variables you can guess at.**
  `LOG_ARCHIVE_DESTINATION_IS_PRIVATE=true` — which is an assertion that the bucket policy excludes
  `files/logs/*` from anonymous `GetObject` — and a lifecycle rule of **at least 90 days** on that
  prefix, with no shorter bucket-wide rule applying to it. Without the first the job archives nothing,
  nightly, while returning 200. Without the second the bucket deletes the evidence on its own schedule
  and the job still reports success. Both are in `OPERATIONS.md` §3 and in `.env.example`.
- **The times are deliberately `03:17` and `03:41`, not `03:00`.** Schedules are in **UTC**; that is
  mid-morning in India, which is fine for a job that deletes bytes already past their retention window
  and for one that copies closed days. The odd minutes keep them off the hour, where every other
  scheduled job on the platform queues up, and apart from each other.
- ⚠ **A ten-minute schedule needs a scheduler that keeps time, and GitHub's does not.** Vercel's free
  tier allows roughly one cron invocation per day, which is why `publish` is not in the array. Two
  schedulers would keep time, and which one to use is an open decision; neither is set up:
  - **Supabase Cron**, in the cxa-cms Supabase project: enable `pg_cron` and `pg_net`, keep
    `CRON_SECRET` in Supabase Vault, and schedule a `net.http_get` of `/api/cron/publish` with the
    bearer header every ten minutes. Free on the current plan; a rotated `CRON_SECRET` then has to be
    changed in Vault as well as on Vercel.
  - **Vercel Pro**: add `{ "path": "/api/cron/publish", "schedule": "*/10 * * * *" }` back to this
    array.

  Either way, drop the publish step from `keep-warm.yml` afterwards. Neither is best-effort, and
  neither is switched off by 60 days of repository inactivity.

### 1.8 First deployment

```bash
# once, from your own machine, against the production database
DATABASE_URL=<direct url> npm run seed
```

The seed creates the structural pages, settings, navigation and one administrator. It is idempotent and
non-destructive, and it creates **no account at all** without `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` — a seeded `admin/admin123` reaches production more often than anyone admits.

Then: set the bucket's CORS policy (`OPERATIONS.md` §1), sign in at `/studio`, and read Settings →
Diagnostics. Anything the deployment is missing is a sentence on that screen.

### 1.9 Newsletter email (Amazon SES)

**What sends.** `lib/newsletter/mailer-ses.ts` sends through the SESv2 `SendEmail` API, `Content.Simple`
with an HTML part, a plain-text part and the RFC 8058 headers (`List-Unsubscribe` naming
`/api/public/newsletter/one-click?token=…` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`). It is
registered at start-up by `instrumentation.ts` when `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` and
`NEWSLETTER_FROM_ADDRESS` are set. Throttling and 5xx answers are retried with backoff (1, 2, 4 … minutes,
five attempts); a rejected message fails at once; a credentials or sender problem pauses the queue
without using up attempts. Settings → Diagnostics and the studio's newsletter screens say plainly when
the sender is not configured.

**The IAM user** needs exactly `ses:SendEmail` (on the sending identity, and the configuration set if one
is used) and `ses:GetAccount` (to read the sending rate; without it the drain assumes one per second).

⚠ **The From address must be on a domain whose DNS the Centre controls.** SES can send as a single
verified address, but a `@gmail.com` (or any other mailbox provider's) From address cannot pass DMARC
alignment when sent through SES — the DKIM signature is SES's or the Centre's domain, not Google's — and
Gmail and Yahoo now reject or spam-folder unaligned bulk mail. Verify a domain identity in SES
(`ap-south-1`), publish its three DKIM CNAMEs, set a custom MAIL FROM subdomain and a DMARC record, and
use an address on it.

**Bounces and complaints.** Account-level suppression is on in SES. The site also listens for them, so a
bounced or complaining address stops getting mail from this application and the studio shows why:
`POST /api/public/newsletter/ses-feedback` verifies each SNS message's signature against Amazon's
certificate, accepts only the topics in `SES_FEEDBACK_TOPIC_ARNS`, confirms the subscription itself, and
marks permanent bounces (`bouncedAt`) and complaints (`complainedAt`, which also unsubscribes). To connect
it to the existing topic — once, by somebody with SNS access, after the site is deployed:

```bash
aws sns subscribe --region ap-south-1   --topic-arn arn:aws:sns:ap-south-1:626159998512:ses-feedback   --protocol https   --notification-endpoint https://<production origin>/api/public/newsletter/ses-feedback
```

The endpoint fetches the confirmation URL itself; `aws sns list-subscriptions-by-topic` should then show
the subscription with a real ARN rather than `PendingConfirmation`. The SES identity's bounce and
complaint notifications (or a configuration set's event destination for Bounce and Complaint) must
publish to that topic. Delivery notifications are not needed and are ignored.

---

## 2. A long-lived server (Docker)

### 2.1 The stack

`docker-compose.yml` brings up Postgres, MinIO-compatible storage (silo, a maintained MinIO fork, as the
service `minio`), a one-shot migrator and the application:

```bash
docker compose up -d --build
docker compose logs -f app
```

⚠ **As committed it is a LOCAL DEVELOPMENT STACK.** It starts with no setup because the secrets are in
the file, which is exactly why it must not be pointed at anything real unchanged. For a server, in this
order:

1. **`JWT_SECRET` and `CRON_SECRET`** — new values from `openssl rand -base64 48`. The committed ones are
   marked as development-only in the file and are public.
2. **`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`** on the `migrate` service — a real address and a real
   password, or leave both empty and create the first account another way.
3. **Stop publishing the database and storage ports.** `55432:5432` and `9000:9000`/`9001:9001` exist so
   the smoke tests can reach them from the host. On a server, remove the `ports:` blocks from `postgres`
   and `minio` and let the compose network carry that traffic. Only `app` needs a published port, and
   only to the reverse proxy — bind it to the loopback interface: `127.0.0.1:3000:3000`.
4. **Decide about the bundled storage (silo, a MinIO fork).** It is real S3-compatible storage and it works, but it is one more thing to
   back up, patch and secure. Managed storage (S3, R2, Backblaze) with the `S3_*` variables pointed at it
   is usually the better trade. Either way, `MINIO_ROOT_PASSWORD` cannot stay `minioadmin`.
5. **The four addresses.** `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_CDN_URL` and `S3_PUBLIC_BASE_URL` become
   your real domain, and `S3_ENDPOINT` stays the address the **server** uses while `S3_PUBLIC_ENDPOINT`
   is the one the **browser** uses. The two-address split is explained at length in the compose file; the
   short version is that a presigned URL is followed by the browser, and SigV4 signs the host, so it
   cannot be rewritten after signing.

⚠ **`NEXT_PUBLIC_*` AND `S3_PUBLIC_BASE_URL` ARE BUILD ARGS, NOT RUNTIME SETTINGS.** They are inlined
into the browser bundle by `next build` inside the image. Changing them in the `environment:` block does
nothing for the browser; the domain lives in the `args:` block, and moving domain means
`docker compose up -d --build`. They appear in *both* blocks in the committed file and that is not a
duplicate — the server reads them too.

### 2.2 `output: "standalone"` is switched on only in the container build

`next.config.ts` does not contain it. The `Dockerfile`'s builder stage renames the committed config to
`next.config.base.ts` and writes a four-line wrapper that re-exports it with that one field added.

Written as a wrapper rather than a second config file so every security header, redirect, image host and
experimental flag stays in force and is maintained in exactly one place. A duplicate config drifts the
first time somebody adds a header to the real one and not to the copy. And it is not committed because
this repository also deploys to Vercel, where standalone output is redundant.

The consequence to know: the runtime image contains **only what the server reaches**. The Prisma CLI, the
schema and `tsx` are all excluded, which is why migrations run from a separate `migrator` image and why
`next start` does not exist in the container — the entrypoint is `node server.js`. `OPERATIONS.md` §3a
has the rest.

### 2.3 The reverse proxy

The container speaks plain HTTP on 3000. Put nginx, Caddy or Traefik in front of it. **Three headers are
load-bearing** — a proxy that omits them produces failures that look nothing like a proxy problem:

| Header | What breaks without it |
|---|---|
| `X-Forwarded-For` | **Read only together with `TRUSTED_PROXY_HOPS`.** Set it to the number of proxies you run in front of the container (1 for the nginx below). The client is then the entry that many places from the RIGHT — the one your proxy appended; the left end is whatever the client sent and is never read (`lib/request-ip.ts`). Without it, or without the header, every visitor falls into one shared rate-limit bucket named `no-ip` — one person can exhaust the sign-in, two-factor and contact limits for everybody — and audit entries record no network fingerprint. A production process that is not on Vercel and trusts no hop says so at start-up (`[client-ip]` in the container log) and in Settings → Diagnostics. |
| `X-Forwarded-Host` | `assertSameOrigin()` compares the `Origin` header against the request host or this one. A proxy that rewrites `Host` to the container name makes **every mutation in the studio a 403** — saving a page, uploading a file, changing a setting. |
| `X-Forwarded-Proto` | Redirects and generated URLs can come back as `http://`, which on an HSTS domain the browser then refuses. |

Nginx, minimally:

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-Host  $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
}
```

Caddy sets all three itself; `reverse_proxy 127.0.0.1:3000` is the whole configuration.

⚠ **`TRUSTED_PROXY_HOPS` must equal the real number of proxies, no more.** One too many and the app reads
an entry the client wrote, which is the spoof this setting exists to prevent; one too few and every
visitor is bucketed under your own proxy's address. On Vercel leave it unset: there the address comes from
`x-vercel-forwarded-for` / `x-real-ip`, which the platform's edge overwrites.

No large-body limit is needed. Uploads go browser → storage directly (§1.5), so the biggest thing the
application ever receives is a JSON body of a few hundred kilobytes.

### 2.4 TLS

⚠ **TLS is not optional in production, and the failure is silent.** Session cookies are issued with the
`Secure` attribute whenever `NODE_ENV=production` (`lib/auth/cookies.ts`), and a browser **discards a
`Secure` cookie arriving over plain HTTP without saying anything**. Serve a production build over `http://`
on a real domain and sign-in appears to succeed and then does nothing at all, for ever, with no error in
any log.

- Terminate TLS at the proxy. Caddy obtains and renews certificates on its own; nginx with certbot needs
  a renewal timer that somebody checks.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains` is sent by production builds
  (`next.config.ts`). It is **remembered by the browser for two years per host**, so do not put a
  production build on a hostname you intend to serve over plain HTTP later. On `http://localhost` the
  header is inert — the specification requires browsers to ignore it over an insecure connection.
- `preload` is deliberately absent. Submitting a domain to the browsers' preload list is close to
  irreversible and belongs to whoever owns the domain.

### 2.5 Scheduling the four jobs yourself

**Nothing in the container runs them.** `vercel.json`'s schedule applies to Vercel only, and there is no
in-process timer anywhere in this codebase (deliberately — see `lib/runtime.ts`). A host crontab — and
here there is no plan limit, so `publish` goes back on its ten-minute schedule:

```cron
*/10 * * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-site.example/api/cron/publish      >/dev/null
17   3 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-site.example/api/cron/purge        >/dev/null
41   3 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-site.example/api/cron/logs-archive >/dev/null
*/5  * * * *  curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-site.example/api/cron/newsletter-drain >/dev/null
```

`-f` matters: without it `curl` exits 0 on a 403 and a refused job looks like a successful one. Read
`OPERATIONS.md` §3 for what each job does and what stops working without it.

⚠ **`-f` is not enough for `logs-archive`.** It answers **200** when it archives nothing because
`LOG_ARCHIVE_DESTINATION_IS_PRIVATE` is unset, so `curl` is happy and the compliance archive is empty.
That state is reported on the studio's diagnostics panel and written to `audit_logs` every night it
happens, which is where to check it — not in the exit status. The MinIO default policy in
`docker/minio-public-read.json` grants anonymous `GetObject` on the **whole bucket**, so on this path
the flag is a real piece of work and not a formality.

### 2.6 One process, and what a second one costs

The container's default is one process, which is the configuration every in-memory assumption in this
codebase is exactly right for. Scaling to two — `docker compose up --scale app=2`, or a process manager
with several workers — silently changes two behaviours:

- **every rate limit is multiplied by the number of copies** (`lib/ratelimit.ts`), and
- **the guard against two simultaneous search-index rebuilds stops working** across copies.

Neither shows on screen. `lib/ratelimit.ts` accepts a shared store precisely so this is fixable without a
rewrite; until one is registered, prefer one larger container to two smaller ones.

---

## 3. What differs

`lib/runtime.ts` prints the live version of this into Settings → Diagnostics. Features are named because
"in-memory state does not survive" is not a sentence anybody can act on.

| | Vercel (serverless) | Long-lived server (Docker) |
|---|---|---|
| **Rate limits** — sign-in, second factor, password links, contact form, event registration, search, suggestions, view beacon, counted downloads | **Per copy of the app.** The real limit is the configured number × however many copies are running, and a newly started copy allows a full fresh allowance. A speed bump, not a ceiling. | **Exact, with one process.** Multiplied by the replica count if you run more (§2.6). |
| **Cold starts** | Real. After a quiet period the next request rebuilds the storage client, the JWT signing key and each sign-in provider's key set — commonly a second or two on the first sign-in of the morning. No data is affected. | None. The process stays warm; those caches are built once at start-up. |
| **Cron** | **Split across two schedulers.** The two daily jobs are declared in `vercel.json` and run by the platform, which supplies the `Authorization` header from `CRON_SECRET`; `/api/cron/publish` runs from `.github/workflows/keep-warm.yml`, because Hobby rejects any schedule finer than daily — and GitHub runs it hours apart, not every five minutes (§1.7). | **Nothing runs any of them.** One host crontab covers all four, with the header set by hand (§2.5). |
| **Logs** | Per invocation, in the platform dashboard, retained for a period the plan decides. `console.warn` from the rate limiter's bucket-ceiling message and `[cron]` lines land here. Not files; not greppable across a month unless you forward them somewhere. | `docker compose logs -f app`, or whatever the daemon's logging driver is pointed at. One continuous stream, and yours to rotate. |
| **Sticky in-memory state** | Nothing survives. Rate-limit buckets, the rebuild-in-progress guard (`__cxaReindexState`) and every `let cached…` are rebuilt per copy and lost on each cold start. Two administrators can start two index rebuilds at once. | Survives for the life of the process. The rebuild guard works; the limiter counts correctly; a restart resets both. |
| **Database connections** | One pool **per copy**, with the number of copies changing under load. `DATABASE_URL` must be a pooler (§1.4). | One pool, one process. A direct connection is fine. |
| **Uploads** | Must go browser → storage. There is no writable disk (§1.5). | The same code, and still the right design — but the constraint is a choice here rather than a fact. |
| **Migrations** | In the build command, over `DIRECT_DATABASE_URL`. Runs on preview deployments too (§1.2). | The one-shot `migrate` container, before the app starts. |
| **`output: "standalone"`** | Not set. The platform handles output. | Set by a wrapper the `Dockerfile` generates (§2.2). |
| **Function limits** | Real ceilings on time and memory; the image pipeline needs the overrides in `vercel.json` (§1.6). | The container's own limits. `sharp` gets whatever the host has. |
| **TLS** | Provided by the platform. | Yours, and **not optional** — `Secure` cookies are dropped over plain HTTP with no error (§2.4). |

---

## 4. After either deployment

```bash
npm run check                                   # typecheck + lint + route coverage
npm run smoke      -- https://your-site.example # screens, endpoints, refusals, lifecycle
npm run leak-check -- https://your-site.example # nothing unpublished is publicly reachable
```

Then, in the studio: **Settings → Diagnostics**. `configurationWarnings()` reports what is missing from
the environment; `runtimeWarnings()` reports what this platform implies. A clean panel and a clean smoke
run together are the closest thing to proof that the deployment works.

`OPERATIONS.md` §8 explains what each check proves and — the part that matters more — what each one is
blind to.
