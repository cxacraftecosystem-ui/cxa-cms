# Security hardening, October 2026

Five bugs found in the old CMS, each fixed here instead of being carried over: links beginning with
`//` or `/\` treated as internal, upload signing with no size or checksum, rate limits that a spoofed
`X-Forwarded-For` dodged, the cron secret accepted in the URL, and raw emails and IPs in the audit log.
This page is the reviewer's map of branch `security/hardening`: what each fix changed, where, how it is
tested, and what a deployment has to do. The long explanations are in the files' own header comments and
in `AUDIT-PRIVACY.md`. This page links to them and does not repeat them.

Scope against `main`: 104 tracked files changed (+1624 / −888), plus 30 new files (about 4,850 lines,
half of it tests).

---

## 0. Deploying this branch: the short list

| # | Step | Required? |
|---|---|---|
| 1 | Apply migration `20261010120000_audit_log_ip_hash` (`prisma migrate deploy` in the normal release step). Additive: one nullable column and one index. | **Yes**, before the new code serves traffic. Without it every audit write fails on the missing `ipHash` column. |
| 2 | Set `AUDIT_IP_HASH_SECRET` (≥ 32 chars, `openssl rand -base64 48`). | Recommended. Unset, a key is derived from `JWT_SECRET`, and Settings → Diagnostics warns until it is set. |
| 3 | **Off Vercel only:** set `TRUSTED_PROXY_HOPS` to the real number of proxies in front of the app (1 for the nginx in `DEPLOYMENT.md`). | **Yes** for Docker/VM. If it is unset there, every visitor shares one `no-ip` rate-limit bucket. Leave it unset on Vercel. |
| 4 | Make sure no scheduler calls `/api/cron/*` with `?secret=`. Rotate `CRON_SECRET` if one ever did. | **Yes.** Those calls now get a 401. Both GitHub workflows already send the header. |
| 5 | Check the bucket CORS allows `x-amz-checksum-sha256` (fine with the documented `AllowedHeaders: ["*"]`). | **Yes** if the CORS rule was narrowed. Otherwise every upload fails at the PUT. |
| 6 | `prisma/manual/audit_log_scrub_legacy_pii.sql`: NULL the legacy email/IP data on old audit rows. | **Optional, manual and irreversible.** A person runs it after checking for legal holds. See `AUDIT-PRIVACY.md` §4. |

No change to `package.json` or the lockfile.

---

## 1. Links starting with `//` or `/\` were treated as internal

**Before.** More than a dozen copies of `href.startsWith("/")` decided what counted as internal.
`//evil.example`, `/\evil.example`, `/<tab>/evil.example` and `/%2F%2Fevil.example` all passed. They
were rendered through `next/link` as on-site links, sent in redirect `Location` headers, accepted in
`?next=` after sign-in, and stored by the studio with no check on save. A raw JSX `<a href>` in MDX
skipped the `components.a` override completely.

**After.** One rule, `lib/safe-href.ts` (no imports, so it is safe for client, server and Zod). It strips
control characters, then classifies a link as `internal` / `same-page` / `external` / `contact` /
`relative` / `unsafe`. A link is internal only if it has exactly one leading `/` and **no** segment,
percent-decoded until stable, contains a `/`, `\` or control character or is a dot segment (`.`, `..`).
The first segment must also survive one strict `decodeURIComponent` as written (`/%zz` and `/100%` are
refused; `/100%25`, a correctly encoded `%`, is internal — the second review's version decoded it
strictly twice and refused it).
That applies to every segment, not only the first: `/a/..%2F..%2F/evil.example` decodes once to
`/a/../..//evil.example`, which normalises to `//evil.example`. Rendering and saving both use it:

- **Render:** `components/RichText.tsx`, `components/site/ProseArticle.tsx` + new `MdxLink.tsx`,
  `SiteFooter`, `AnnouncementBar`, `ArcCarousel`, `DefinitionList`, `ui/Button.tsx`, every
  `components/sections/*Section.tsx`, the newsletter email renderer (`lib/newsletter/email-richtext.ts`)
  and the public `people` / `projects` / `publications` pages. An unsafe link renders as its words, with
  no anchor. A rich-text image's `blurDataUrl` reaches next/image only if it is a base64
  png/jpeg/webp/gif (`safeBlurDataUrl`). next/image writes that value unescaped inside a CSS `url("…")`,
  so the old "starts with `data:`" check let a value close the string and add a full-viewport overlay
  with a third-party `url()`.
- **MDX:** new `lib/mdx-links.ts`. A remark plugin renames JSX `<a>` to `MdxSafeLink`, drops unsafe or
  expression URL attributes, `on*`, `style`, `className` / `class` / `id` and `background`, plus
  `width` / `height` / `bgcolor` on raw elements, and removes tags that navigate or load (`base`, `meta`,
  `iframe`, `form`, `script`, `img`, …, in any case). Without the class rule, Tailwind utilities such as
  `fixed inset-0 z-50 opacity-0` could lay a transparent layer over an external link, so a click
  anywhere left the site. `background` on a table tag is a CSS `background-image`: it used to be checked
  as a URL, so `<td background="https://evil.example/b.png" height="5000">` made every visitor fetch a
  third-party image and painted an author-chosen picture outside `MediaFigure`. A JSX tag is kept only
  if it is an exact lowercase name on the allow-list or a component the renderer maps
  (`MDX_COMPONENT_NAMES`: `MediaFigure`, `MdxSafeLink`); everything else — `<Foo-bar>`, `<Svg:A>`,
  `<Div>`, `<Foo_Bar>`, `<x.y>`, `<ÄB>` — is unwrapped to its content. The unmapped component names
  used to pass the save check and then make `compileMDX` throw "Expected component … to be defined", so
  a saved article broke its own public page. `mdxLinkProblems()` runs the same plugin at save time, and
  the news routes refuse the save when it reports anything.
- **Save:** `lib/sections/schema.ts`, `lib/settings/schema.ts`, new `lib/studio/link-fields.ts`
  (navigation, redirects, announcements, publications), and the studio CRUD routes for people,
  projects, research, crafts, events, news and pages. Rich-text documents are checked mark by mark,
  and every node's `blurDataUrl` is checked as well. The editor also drops a pasted `data-blur` that
  fails the check. Above `MAX_RICH_TEXT_NODES` the check fails closed.
- **Redirects / `?next=`:** `lib/pages.ts` (`findPageRedirect` → `safeRedirectDestination`), and the
  `next` handling in `app/studio/login/page.tsx`, `app/api/auth/refresh/route.ts` and
  `lib/auth/oauth-cookies.ts` (`isSafeSitePath`).
- **Editor:** `components/studio/editor/extensions.ts` (link dialog, paste, autolink) and
  `components/studio/fields/LinkField.tsx` refuse what the server would refuse.
  `lib/navigation.ts` / `navigation-server.ts` share the rule.

**Tests.** `tests/security/safe-href.test.ts` (103 cases: the bypass corpus in `href-corpus.ts`, the
legitimate links that must still work, and redirect destinations), `href-surfaces.test.ts` (185: the
editor, newsletter, section and settings schemas on save) and `href-render-and-save.test.ts` (499: MDX
rendered and saved, the oversized rich-text fail-closed check, `RichText`, `MdxLink`, `LinkButton`,
`SiteFooter`). `href-followup.test.ts` (36) covers the second review's four gaps: the blur CSS breakout
on render and save, MDX `className` / `id` overlays, encoded separators and dot segments past the first
segment (including as `?next=` and redirect destinations), and hyphenated or namespaced tag names. A
third review added 27 more to the same file (63 in all): table `background` / sizing attributes, a
`%25` in the first path segment, and unmapped component names (`<Foo_Bar>`, `<x.y>`, `<ÄB>`, `<Div>`,
`<A>`, `<MdxLink>`, `<Inline>`), each rendered without throwing and refused on save, plus `<Script>` and
`<IFRAME>`, removed with their content.

**Deployment.** None. Content that already holds an unsafe link stays stored but renders as plain text.
The next save of that record is refused until the link is fixed. The same goes for the follow-up rules.
A stored image with a bad `blurDataUrl` renders without the placeholder. An MDX article that used
`className` or `id` renders without them, and its next save is refused until they are removed. The
same goes for table `background` / `width` / `height` / `bgcolor`, and for a component name the
renderer does not map (its content is shown without the tag, where before the page threw). A
redirect row or link with an encoded `/`, `\` or dot segment anywhere in its path is ignored.

## 2. Upload signing did not require a file size or checksum

**Before.** The presigned PUT signed only the key. Anyone holding the URL could write any number of
bytes of any content until it expired. The size cap ran only in the browser, plus a `HEAD` size check
against whatever the finalize request body claimed.

**After.**

- `lib/storage/client.ts` `presignUpload` refuses to sign without an exact `byteSize` and a canonical
  base64 SHA-256. It signs `Content-Type`, `Content-Length` and `x-amz-checksum-sha256` as headers, so
  storage itself rejects a body with a different size, type or content.
- New `lib/storage/upload-limits.ts` holds the per-kind caps (images and panoramas 150 MB, video and 3D
  200 MB, audio and documents 100 MB, file store 200 MB). It has no imports, so the routes and the browser
  read the same numbers.
- New `lib/storage/upload-ticket.ts`: presign returns an `uploadTicket`, an HMAC under `JWT_SECRET` with
  its own domain label. It records the size, type and SHA-256 that were signed, and is bound to the object
  key and the user. It is valid for 24 h.
- Finalize routes (`media/complete`, `media/[id]/replace`, `files`, `files/[id]/versions`) verify the
  ticket, then `confirmUploadedObject` `HEAD`s the object with checksum mode on. If the size, checksum or
  type differ from the ticket, the object is **deleted** and the request is refused. The stored checksum
  column is derived from the verified digest.
- Browser: new `lib/client/checksum.ts` (WebCrypto SHA-256), used by `lib/client/upload.ts`,
  `fileUpload.ts`, `UploadQueue`, `PickerUpload` and `MediaDetailPanel`.

**Tests.** `tests/storage/upload-integrity.test.ts` (18). Covers presign refusing to sign without a
size or checksum, the signed headers, the caps, digest format and Node/browser parity, ticket tampering,
key, user and expiry checks, and finalize deleting the object on each kind of mismatch.

**Deployment.** Bucket CORS (step 5 above; `OPERATIONS.md` §1). The storage must support
`x-amz-checksum-sha256`. AWS S3 and the silo image in `docker-compose.yml` do. The studio must be served
over https (or localhost), because `crypto.subtle` exists only there. Uploads already in progress during
the deploy have no ticket and must be restarted.

## 3. Rate limits could be dodged by spoofing `X-Forwarded-For`

**Before.** `clientIp()` (`lib/api.ts`) read the **leftmost** `X-Forwarded-For` entry, and the client
writes that entry. Rotating the header gave every request a fresh bucket, which bypassed the limits on
sign-in, two-factor, contact and newsletter.

**After.** New `lib/request-ip.ts`, which `clientIp()` now delegates to:

- On Vercel (`VERCEL=1`): only `x-vercel-forwarded-for`, then `x-real-ip`. Vercel's edge overwrites
  both.
- Elsewhere: the `TRUSTED_PROXY_HOPS`-th entry **from the right**. A chain shorter than the hop count
  returns null.
- Studio pages that read `headers()` for Server Actions (`account`, `audit`, `recycle-bin`, `redirects`,
  `subscribers`, `templates`) call `clientIpFromHeaders` directly. They used to parse the leftmost entry
  themselves.
- Otherwise null, which `lib/ratelimit.ts` treats as one shared `no-ip` bucket. A value that is not a
  valid IP is also null, and so is an IPv6 zone id (`fe80::1%eth0`).
- **IPv6 is limited per /64, not per address.** An ordinary connection owns a whole /64 and can send each
  request from a different address in it, which was the same fresh-bucket-per-request bypass done by
  rotating addresses instead of headers (and it pushed the in-memory map toward `MAX_BUCKETS`, evicting
  real buckets). `rateLimitSubject()` cuts an IPv6 address to its /64 and keeps IPv4 whole; `bucketKey`
  in `lib/ratelimit.ts`, the search-log cap (`lib/search/query.ts`) and the access-log refusal cap
  (`lib/requestLog.ts`) all key on it. The audit fingerprint still uses the whole address.
- **One spelling per address.** `normaliseIp()` rebuilds IPv6 in its RFC 5952 form (lower case, no leading
  zeros, longest zero run compressed) and turns every IPv4-mapped spelling (`::ffff:1.2.3.4`,
  `0:0:0:0:0:ffff:1.2.3.4`, `::ffff:102:304`) into the IPv4 address. Before, `2001:DB8::1` and
  `2001:db8:0::1` gave different bucket keys and different audit fingerprints, so an exact-address
  provenance search typed in another spelling found nothing.
- `clientIpConfigurationWarning()` reports a production process that is off Vercel and trusts no hop. It
  shows at start-up (`instrumentation.ts`, `[client-ip]`) and in Diagnostics (`lib/env.ts`).

**Tests.** `tests/security/client-ip.test.ts` (12). Includes a rotating spoofed header that must stay in
one bucket, a client rotating through its IPv6 /64 that must stay in one bucket, equal fingerprints for
different spellings of one IPv6 address, and checks that the leftmost entry is never read.

**Deployment.** `TRUSTED_PROXY_HOPS` (step 3; `DEPLOYMENT.md` reverse-proxy section). It must equal the
real hop count: one too many re-opens the spoof.

## 4. The cron secret was accepted in the URL

**Before.** `assertCronAuthorised` accepted `?secret=<CRON_SECRET>` as well as the bearer header.
Proxies, platform logs and the 90-day log-drain archive all recorded that URL.

**After.** `lib/cron.ts` accepts only the header `Authorization: Bearer <secret>`. Any request that
carries `?secret=` gets a **401, even if the bearer is valid**, so a misconfigured scheduler fails loudly
instead of leaking quietly. The value is never compared or logged. The server log names the path and
says to rotate. A missing or wrong bearer now gets a 401, and a deployment with no `CRON_SECRET` still
gets a 403. `assertNewsletterDrainAuthorised` follows the same rules. Comments updated in
`lib/drains.ts` and `lib/requestLog.ts`. The drain still redacts `secret` from archived URLs as a backstop.

**Tests.** `tests/security/cron-auth.test.ts` (5, including "never writes a query-string secret to the
log"). `tests/newsletter/drain-auth.test.ts` was updated for the 401/403 split.

**Deployment.** Step 4. Monitoring that expected a 403 from a wrong secret will now see a 401.

## 5. The audit log stored raw emails and IP addresses

**Before.** Every `audit_logs` row copied `actorEmail` and the raw `ipAddress`. Sign-in, sign-out and
refused sign-in rows also repeated the address in `entityLabel` and `after.email`.

**After.** The full account is in `AUDIT-PRIVACY.md`. In short:

- `lib/audit.ts` writes `actorId` and `ipHash` = `<keyId>:` + HMAC-SHA256 of the normalised address,
  truncated to 128 bits (new `lib/audit-ip.ts`). Key rotation is supported through
  `AUDIT_IP_HASH_PREVIOUS_SECRETS`, including `jwt:<old JWT_SECRET>` for keys that were derived.
- Account rows go through `scrubAccountIdentity` (new `lib/audit-subject.ts`). The label loses the
  address. A typed sign-in address is stored as `emailHash` + `emailDomain`. Other addresses become
  `••••@domain #<hex>`. The auth routes (`login`, `logout`, `two-factor`, `set-password`, OAuth
  callback) no longer pass an address.
- Read side: new `lib/audit-actor.ts` and `lib/audit-accounts.ts` join `users` at read time. After a hard
  delete the row reads "Deleted user". `lib/provenance.ts` groups by fingerprint and merges legacy rows.
  `app/api/studio/audit/route.ts`, `app/studio/audit/page.tsx`, `app/studio/page.tsx` and
  `ProvenanceConsole` use the join and show `net·<hex>` instead of an address. Search by exact IP or
  address still works through the fingerprint.
- Lock take-overs: `takeOverLock` (`lib/studio/crud.ts`) used to write both editors' addresses as
  `before.editingHeldBy` / `after.editingHeldBy` on the PAGE or POST row, which `scrubAccountIdentity`
  never sees. It now writes `editingHeldById`, and the audit screen and the single-entry API join the
  name at read time (`lockHoldersForAuditRows`, `withLockHolderNames`). The audit list answer and the
  provenance timeline, which report only changed field NAMES, name that field `editingHeldBy` too
  (`displayFieldNames`), so no screen shows the storage name.
- `prisma/schema.prisma`: `ipHash String?` plus an index. `actorEmail` and `ipAddress` stay as nullable,
  read-only legacy columns.

**Tests.** `tests/security/audit-privacy.test.ts` (11), `audit-account-rows.test.ts` (10),
`audit-lock-takeover.test.ts` (5, including the field name a list of headlines shows),
`audit-provenance.db.test.ts` (3) and `audit-lock-takeover.db.test.ts` (4: the real writer, step 5 of
the scrub file run against an old-style row, step 5 with an address that has since changed hands, which
must name the account that had it then or nobody, and the record's provenance timeline naming the
take-over field `editingHeldBy`). The DB tests run only
against a local database, and passed against a throwaway Postgres with every migration applied.

**Migration.** `prisma/migrations/20261010120000_audit_log_ip_hash/migration.sql` is purely additive:
`ADD COLUMN "ipHash" TEXT` plus `CREATE INDEX audit_logs_ipHash_createdAt_idx`. It has no backfill,
because the database must never hold the key. `prisma migrate diff` from the migrations to the schema
shows no drift from this branch. Its only output is the existing `DROP INDEX
"search_documents_title_trgm_idx"`. That index is a hand-written expression index (see
`20260814120000_restore_search_title_trgm_index`), and Prisma always proposes dropping it.

**Optional data scrub.** `prisma/manual/audit_log_scrub_legacy_pii.sql` is not a migration, and every
statement in it is commented out. It NULLs the legacy columns on old rows, cuts addresses out of account
labels and payloads, replaces a lock take-over's `editingHeldBy` address with the id of the account that
had that address when the row was written (from the legacy `actorEmail`/`actorId` pair, which is why
`actorEmail` is cleared last; ambiguous or unknown addresses are dropped, never matched to whoever has
the address today), and leaves
contact, registration and grant rows alone. Take a backup first. Old rows
lose network correlation, and rows for hard-deleted actors will read "Deleted user". `access_logs` (CIC
90-day retention) is untouched.

---

## 6. Verification

The final run used a clean `npm ci --ignore-scripts` copy of the working tree (npm 11.17.0, Node
24.19.0) on 2026-10-10. `prisma generate` was run, and `DATABASE_URL` pointed at a throwaway local
Postgres (17, and 16 for the take-over field-name rerun and the final pre-commit rerun) with every
migration applied. The Postgres was removed afterwards. The shared checkout's
`node_modules` predates Prisma 7 and Zod 4 and cannot run the suite. Run `npm ci` there first.

| Command | Result |
|---|---|
| `npm test` | 958 tests, 958 pass, 0 fail, 0 skipped (the three `*.db.test.ts` files included; rerun after the third review's link fixes) |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm run lint` (`eslint .`) | clean: 0 errors, 0 warnings |
| The rest of `npm run check`: `route-check`, `media-select-check`, `screens-check`, `media-render-check`, `framing-select-check`, `video-check`, `font-check`, `theme-check`, `site-url-check` | all PASS |
| `next build` with `NEXT_PUBLIC_SITE_URL=https://cxa.example.org` and no database | succeeds, with 30/30 static pages. The `prisma:error` lines it prints are the expected failed connections when there is no database. |
| `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script` (with a shadow database) | only the existing `DROP INDEX "search_documents_title_trgm_idx"` (see §5). Nothing from this branch. |
| `prisma migrate deploy` + `audit-provenance.db.test.ts` and `audit-lock-takeover.db.test.ts` on the throwaway Postgres | 7 pass. The whole scrub file, uncommented, also executes there without error, and a second run changes nothing it already changed (only step 4 re-touches a row whose address sits deeper than the top level, as the file says). |

The rows below come from earlier runs during the review, against the code before each fix.

| Command | Result |
|---|---|
| The IPv6 and lock take-over tests against the code before those fixes | 8 of the 10 new tests fail (all four IPv6 tests, three lock take-over unit tests, the take-over DB test) |
| The two take-over field-name tests without `displayFieldNames` | both fail: the unit test, and the DB test, whose timeline read `["editingHeldById","editingHeldSince","lockHadExpired","takenOver"]` |
| `href-followup.test.ts` against the code before those four fixes | 23 of the 36 fail (every blur, class/id, deep-segment and capitalised-tag case). The 13 that pass are the must-still-work cases and the inputs the old code already refused. |
| The 27 third-review tests in `href-followup.test.ts` against the code before those three fixes | 19 fail (every `background`/sizing, `%25` first-segment and unmapped-component case). The 8 that pass are must-still-work cases and inputs the old code already refused. |
| `NODE_ENV=production` render of the blur payload on an `objectKey` image, with a CDN URL set | No injected CSS and no `evil.example` in the output. A real WebP blur still renders. |
| The new and updated tests run against a `main` snapshot | All fail: cron 4/5, href surfaces 137/185, drain-auth 1/3. The rest fail to import the new modules. |
