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
| `NEXT_PUBLIC_SITE_URL` | **build** | Baked into the bundle. Also read on the server, where a missing value throws in production on purpose. |
| `NEXT_PUBLIC_SITE_NAME`, `NEXT_PUBLIC_CDN_URL` | **build** | Baked into the bundle. |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | runtime | Required here, not optional. §1.5. |
| `S3_PUBLIC_BASE_URL` | **build** only | `next.config.ts` derives the image optimiser's host allowlist from it at build time, and that is its only reader — `lib/env.ts` deliberately leaves it out of the runtime shape. A host missing from that list renders as a broken image, not an error. ⚠ It does **not** stand in for `NEXT_PUBLIC_CDN_URL`: setting this and leaving that blank serves an "Image unavailable" placeholder for every photograph on the site. |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_SSE_ALGORITHM` | runtime | Only for non-AWS storage (R2, Backblaze, MinIO). |
| `CRON_SECRET` | runtime | Vercel Cron sends it for you. §1.7. |
| `MEDIA_PURGE_AFTER_DAYS` | runtime | Defaults to 30. |
| `GOOGLE_*`, `MICROSOFT_*`, `YAHOO_*` | runtime | Each optional and independent. `docs/SIGN-IN.md`. |
| `SEED_ADMIN_*`, `SEED_MASTER_ADMIN_EMAILS` | — | **Do not set on Vercel.** The seed is not part of the build; run it once from your own machine against the production database (§1.8). |

⚠ **A `NEXT_PUBLIC_*` change needs a REDEPLOY, not a restart.** Those values are inlined into the
JavaScript sent to the browser at build time. Editing one in the dashboard changes nothing until the next
build, and the symptom is a site that keeps using the old value with every signal green.

⚠ **Preview deployments run the same build command, including the migration.** A preview branch pointed
at the production `DATABASE_URL` will apply that branch's migrations to production. Give Preview its own
database, or accept that a branch with a migration is a production schema change.

### 1.3 The build command

```
prisma generate && prisma migrate deploy && next build
```

Three steps, in the only order that works.

- **`prisma generate`** — the build imports `@prisma/client`, and without the generated client it fails
  with a message about a missing module rather than a missing generate step.
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

Prisma needs no `binaryTargets` entry in `schema.prisma`. It detects Vercel's Amazon Linux and the
container's Debian on its own, and pinning one would break the other.

### 1.4 Two database URLs, and why

```
DATABASE_URL         → the pooler, transaction mode   (runtime)
DIRECT_DATABASE_URL  → the database itself, no pooler (migrations)
```

`prisma/schema.prisma` already wires this up: `url = env("DATABASE_URL")`,
`directUrl = env("DIRECT_DATABASE_URL")`.

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

If `DIRECT_DATABASE_URL` is absent, Prisma falls back to the pooled URL and the studio's diagnostics
panel says so. That fallback works against a plain Postgres and fails against a pooler, which is the
single most confusing failure in this list: the same command works locally and fails in the build.

### 1.5 Object storage is not optional here

**A serverless filesystem cannot hold an upload.** There is a temporary folder for the life of one
request and nothing else is writable; the folder is discarded when the request ends, and the next request
may be served by an entirely different copy of the application. A file written during an upload would be
gone before anybody could ask for it.

This is why the application **presigns direct-to-storage** and never accepts the bytes itself
(`lib/storage/client.ts`, `lib/client/upload.ts`):

1. the browser asks `/api/studio/media/presign` for a signed URL;
2. the browser PUTs the file **straight to the bucket** — the application never sees it, which is what
   makes a 400 MB video possible at all;
3. the browser calls `/api/studio/media/complete`, which `HEAD`s the object, refuses if it is not there,
   cross-checks the size, and only then writes the row.

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
| `buildCommand` | §1.3. |
| `crons` | §1.7. |
| `functions["app/api/studio/media/complete/route.ts"]` | `memory: 3009`, `maxDuration: 300`. This route pulls the uploaded object into memory and runs `sharp` over it to make every derivative. A 40-megapixel heritage scan decodes to a bitmap of several hundred megabytes, and the pipeline runs the sizes **sequentially** for exactly this reason. At the default memory the function is killed part-way: the object is already in the bucket, so the file exists with no row and no error anybody sees. |
| `functions["app/api/studio/media/[id]/replace/route.ts"]` | The same two values, because it does the same work — replacing the bytes behind an asset re-runs the whole derivative pipeline. It previously had **no entry**, and the route's own header says so; without it a large replacement is killed and the asset keeps pointing at the old file with nothing on screen to explain why. |
| `functions["app/api/studio/files/route.ts"]` | `maxDuration: 60`, memory left at the default. Registering a document reads the whole object back to fingerprint it, up to a stated 128 MB cap. That is a large download plus a SHA-256, and it does not reliably finish inside the default ten-to-fifteen seconds. A 128 MB buffer fits the default memory comfortably, so only the clock needed raising. |
| `functions["app/api/studio/files/[id]/versions/route.ts"]` | The same, for the same reason — it is the new-version half of the same flow and carries the same 128 MB cap. |

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
  in the route file itself, which Vercel honours; the two cron routes cap their own work per run
  (`MAX_ASSETS_PER_RUN`) so the default clock is ample; every other route is a database query.

### 1.7 Cron

```json
{ "path": "/api/cron/publish", "schedule": "*/10 * * * *" }
{ "path": "/api/cron/purge",   "schedule": "17 3 * * *" }
```

Both confirmed against the routes that exist. What each does is in `OPERATIONS.md` §3 — read it, because
the publish job is a convenience and the index re-sync inside it is not.

- **`CRON_SECRET` must be set as an environment variable.** Vercel Cron then sends
  `Authorization: Bearer <CRON_SECRET>`, which is exactly what `assertCronAuthorised` expects. Without
  it the endpoints refuse every request and log why — the safe direction.
- **Never use the `?secret=` query form on a scheduler that can set a header.** It exists for schedulers
  that cannot, and every proxy in between logs it.
- **The purge time is deliberately `03:17`, not `03:00`.** Schedules are in **UTC**; 03:17 UTC is
  mid-morning in India, which is fine for a job that only deletes bytes already past their retention
  window. The odd minute keeps it off the hour, where every other scheduled job on the platform queues up.
- ⚠ **A ten-minute schedule needs a paid plan.** Vercel's free tier allows roughly one cron invocation
  per day. On a free plan the publish job effectively does not run: nothing is published early or left
  readable past its date — publication is resolved on every read — but the studio's status column drifts
  out of step, and withdrawn pages keep coming back from search by name until it does run.

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

---

## 2. A long-lived server (Docker)

### 2.1 The stack

`docker-compose.yml` brings up Postgres, MinIO, a one-shot migrator and the application:

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
4. **Decide about MinIO.** It is real S3-compatible storage and it works, but it is one more thing to
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
| `X-Forwarded-For` | Every visitor falls into one shared rate-limit bucket named `no-ip` (`lib/ratelimit.ts` says so in its own comment), so ordinary traffic throttles each other. Audit entries also record no address. |
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

### 2.5 Scheduling the two jobs yourself

**Nothing in the container runs them.** `vercel.json`'s schedule applies to Vercel only, and there is no
in-process timer anywhere in this codebase (deliberately — see `lib/runtime.ts`). A host crontab:

```cron
*/10 * * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-site.example/api/cron/publish >/dev/null
17   3 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-site.example/api/cron/purge  >/dev/null
```

`-f` matters: without it `curl` exits 0 on a 403 and a refused job looks like a successful one. Read
`OPERATIONS.md` §3 for what each job does and what stops working without it.

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
| **Cron** | Declared in `vercel.json` and run by the platform, which supplies the `Authorization` header from `CRON_SECRET`. Ten-minute schedules need a paid plan (§1.7). | **Nothing runs them.** A host crontab, systemd timer or external scheduler, with the header set by hand (§2.5). |
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
