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

## 2. Environment

Every variable is documented inline in [`.env.example`](../.env.example). The ones whose absence is
silent rather than loud:

| Variable | If unset |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | **Throws at boot in production**, deliberately. Without it, canonical URLs, Open Graph tags and `sitemap.xml` all publish pointing at `localhost` while every signal stays green. |
| `CRON_SECRET` | Cron endpoints **refuse every request** and log why. That is the safe direction: an unauthenticated purge endpoint on the public internet is worse than a purge that never runs. |
| `DIRECT_DATABASE_URL` | Migrations run through the pooled connection, which fails against a transaction-mode pooler. Reported by the studio's diagnostics panel. |
| `S3_*` | Uploads are disabled and the studio **says so** on the settings screen, rather than failing at 90% of a transfer. |
| `NEXT_PUBLIC_CDN_URL` | **Every photograph on the public site renders as an "Image unavailable" placeholder.** There is no signed-URL fallback for images — signing exists for document downloads only — so this is the one storage variable whose absence is visible to readers. `lib/env.ts` warns at boot. ⚠ It is inlined at build time, so setting it needs a **rebuild**, not a restart. |

`JWT_SECRET` is validated for strength at boot: shorter than 32 characters, a known placeholder, or
fewer than 8 distinct characters and the application **refuses to start**. A signing key an attacker can
guess is indistinguishable from having no authentication at all.

```bash
openssl rand -base64 48
```

## 3. Scheduled jobs

`vercel.json` declares both. On another platform, call them with
`Authorization: Bearer $CRON_SECRET`.

| Job | Schedule | What it does |
|---|---|---|
| `/api/cron/publish` | every 10 minutes | Flips `SCHEDULED → PUBLISHED` and `PUBLISHED → ARCHIVED` at their dates, and re-syncs the search index's `isPublished` flag. |
| `/api/cron/purge` | daily, off-peak | Deletes the bytes of assets soft-deleted longer than `MEDIA_PURGE_AFTER_DAYS`, then their rows. Prunes expired sessions. |

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
Prisma's query engine — need builds matching the C library. On Alpine that means an explicit
`binaryTargets = ["linux-musl-openssl-3.0.x"]` and a musl sharp build; each fails at *run* time, and each
fails with a message about an ELF header that says nothing about musl. Debian costs ~40 MB and removes
both problems. `openssl` is installed explicitly in every stage: Prisma's engine links against it, it is
absent from slim, and without it `prisma generate` succeeds while every query fails.

**Two copies in the runtime stage look redundant and are not:**

- `.next/static` and `public/` are emitted **outside** the traced bundle. Miss them and every page
  returns 200 with no CSS and no JavaScript — which reads as a broken stylesheet, not a missing step.
- `node_modules/.prisma` and `@prisma/client` are copied **explicitly**, because Next's tracing follows
  `import` statements and the query engine is a binary the client loads *by path*. Nothing imports it, so
  nothing traces it.

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

`middleware.ts` refuses every `/studio/*` path but the login screen without a live session, and sends
`X-Robots-Tag: noindex` on all of them. `robots.txt` disallows `/studio`, `/console`, `/api/`, `/search`
and `/preview` — but robots.txt is a **request, not an access control**, and none of it substitutes for
the middleware.

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
