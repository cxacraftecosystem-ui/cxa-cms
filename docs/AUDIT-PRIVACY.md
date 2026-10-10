# The audit log: no raw emails, no raw IP addresses

The audit log (`audit_logs`, written only by `lib/audit.ts`) used to copy two pieces of personal data onto
every row: the actor's email address (`actorEmail`) and the client's IP address (`ipAddress`). Since
migration `20261010120000_audit_log_ip_hash` it stores neither. This page records what replaced them,
why, and what was deliberately left alone.

## 1. What a row stores now

| Was | Now | How it is shown |
|---|---|---|
| `actorEmail` (a copy of the address) | `actorId` only (it was always there) | Joined from `users` at read time (`lib/audit-actor.ts`). A soft-deleted account still joins. After a **hard** delete `actorId` is nulled by `onDelete: SetNull` and the row reads **"Deleted user"**. |
| `ipAddress` (the address) | `ipHash`: `<keyId>:<32 hex>` | `net·` + the first 12 hex characters (`displayIpFingerprint`). |
| `entityLabel` = the account's address on every sign-in, sign-out and account row (`LOGIN asha@…`) | No label (or the name alone, `Asha Rao`); the account is `entityId` | Joined from `users` by `entityId` (`accountLabel` in `lib/audit-subject.ts`): the account's current `Name <address>`, or **"Deleted user"** once it is hard-deleted. |
| `after.email` = the address typed at a refused sign-in | `after.emailHash` (keyed fingerprint, same key as `ipHash`) + `after.emailDomain` | The whole address when it belongs to an account (`entityId`) or its fingerprint matches an account's or a grant's address; otherwise `••••@domain`, as before. |
| Any other address in a `User` payload (a snapshot's `email`, an OAuth `linkedAddress`) | `••••@domain #<12 hex>` | Still differs when the address changed, so "what changed" still says so. |
| `before.editingHeldBy` / `after.editingHeldBy` = both holders' addresses when an editor takes over another's editing lock (a row on the page or post, not an account row) | `editingHeldById`: the account id (`takeOverLock`, `lib/studio/crud.ts`) | Joined from `users` at read time (`lockHoldersForAuditRows`, `withLockHolderNames`) and shown as "Editing held by: <name>"; "Deleted user" once the account is hard-deleted. |

**The account rows are the important half.** Dropping `actorEmail` alone left the actor's own address on every
sign-in and sign-out row under the name `entityLabel`, and in `after.email` on every refused one — the most
numerous rows in the log — so a hard-deleted account's address survived everywhere and "Deleted user" hid
nothing. Every row with `entityType: "User"`, and every `LOGIN` / `LOGIN_FAILED` / `LOGOUT` whatever its type,
now passes through `scrubAccountIdentity` (`lib/audit-subject.ts`) inside `auditRowData` (`lib/audit.ts`), the
one place a row is assembled; the auth routes no longer pass an address at all, and the scrub is the backstop
for the next route somebody writes. Searching the audit screen for an address still finds those rows: it
resolves through the account (`auditAccountSearch`), and a whole typed address through its fingerprint.

The lock take-over row is the one writer outside the account rows that recorded who acted by address. It is
filed against the content, so `scrubAccountIdentity` never sees it; it now stores ids, and
`tests/security/audit-lock-takeover.test.ts` (and its `.db.test.ts` twin) pin that.

`ipHash` is `HMAC-SHA256(key, normalised address)`, truncated to 128 bits (`lib/audit-ip.ts`):

- **Keyed, not a plain hash.** All of IPv4 is 2³² values; an unkeyed hash of each is minutes of work, so a
  plain SHA-256 would be the address with extra steps. Without the key, the table and every export of it
  are useless for recovering an address.
- **Still correlates.** Equal addresses give equal fingerprints, so the provenance screens still group
  refused sign-ins by source and list the networks a colleague worked from (`lib/provenance.ts`).
- **One spelling per address.** The address is normalised before hashing (`normaliseIp`, `lib/request-ip.ts`):
  IPv6 is rebuilt in its RFC 5952 form, so `2001:DB8::1` and `2001:db8:0::1` fingerprint equally, every
  IPv4-mapped spelling becomes the plain IPv4 address, and a zone id (`fe80::1%eth0`) is refused.
- **Searchable by exact address.** Typing a whole IP into the provenance search fingerprints it under the
  current key *and every previous key* and matches exactly, in whichever spelling it is typed. A partial address matches nothing — a
  substring of a keyed hash means nothing. Pasting a displayed `net·…` fingerprint matches by prefix.

The address itself still arrives in `AuditContext.ipAddress` (from `clientIp()`, which since the same change
reads only platform-trusted headers — see `lib/request-ip.ts`) and is hashed at the moment of writing.

## 2. The key, and rotating it

| Variable | |
|---|---|
| `AUDIT_IP_HASH_SECRET` | The key. At least 32 characters (`openssl rand -base64 48`). Shorter is ignored. |
| `AUDIT_IP_HASH_PREVIOUS_SECRETS` | Comma-separated retired keys, used **only for searching**, never for writing. Each entry is a retired dedicated secret, or `jwt:<a retired JWT_SECRET>` for a key that was derived from one. |

Unset, the key is **derived from `JWT_SECRET`** with HKDF under its own label, so a deployment that was never
given the new variable still fingerprints instead of storing nothing. The derivation is one-way. The cost is
that rotating `JWT_SECRET` also rotates the fingerprints, so Settings → Diagnostics warns until a dedicated
secret is set.

The key id (the part before `:`) is a hash *of* the key, so a rotation is visible as a new prefix. Writing
always uses the current key; exact-address search (and recognising a typed address) tries the current key and
every retired one. The three rotations, and what each needs:

| From → to | What to set | Why it works |
|---|---|---|
| Derived (no `AUDIT_IP_HASH_SECRET`) → dedicated | Only `AUDIT_IP_HASH_SECRET`. | While a dedicated secret is current, the key derived from the **current** `JWT_SECRET` is always searched too. The most likely first rotation needs nothing else. |
| Dedicated → new dedicated | New `AUDIT_IP_HASH_SECRET`; append the old one to `AUDIT_IP_HASH_PREVIOUS_SECRETS`. | A retired dedicated secret is used as the key directly. |
| `JWT_SECRET` rotated while still on the derived key (or after the step above, if `JWT_SECRET` changes later) | Append `jwt:<the old JWT_SECRET>` to `AUDIT_IP_HASH_PREVIOUS_SECRETS`. | The `jwt:` form re-derives the key the old signing secret produced. The old value verifies nothing once it is retired; it is kept only as the way back to the fingerprints written under it. Better still, set a dedicated secret at the same time. |

Grouping does not span a rotation (a network seen on both sides appears twice for the window that straddles
it); exact-address search does. An entry that is neither form is skipped, never thrown on — a typo costs a
search hit, not every audit write.

**Rows from before this change** have a raw `ipAddress` and no `ipHash`. The provenance aggregates ("the
addresses they worked from", "where the refusals came from") group both generations and merge them
(`groupByNetwork` in `lib/provenance.ts`), so old rows are not silently dropped; a network seen on both sides
of the change appears once as its legacy address and once as a fingerprint, for the same reason as above.

⚠ **Never give the database the key.** That is why there is no backfill of `ipHash` for old rows, and why the
key lives only in the application's environment.

## 3. Why the legacy columns were kept, not dropped

`actorEmail` and `ipAddress` remain as **nullable, read-only legacy columns**. Nothing writes them; the
screens read them only as a fallback for rows written before the change (an old row still names an account
that has since been hard-deleted, and still shows its address).

They were not dropped or nulled by the migration because **a deploy must not destroy production evidence on
its own**: the audit log is what gets read during an incident, an investigation may be open, and the rows
cannot be re-derived. Clearing them is a decision for a person, made once, deliberately.

## 4. The optional scrub of old rows

`prisma/manual/audit_log_scrub_legacy_pii.sql` NULLs `ipAddress` and `actorEmail` on every existing row, cuts
the address out of older account rows' `entityLabel`, replaces a refused sign-in's `after.email` with its
domain, removes top-level `email` / `linkedAddress` from older `User` snapshots, and replaces a lock
take-over's `editingHeldBy` address with `editingHeldById`: the account that address belonged to when the row
was written, read from the legacy `actorEmail` beside each older row's `actorId` (so `actorEmail` is cleared
last). Addresses change hands (an account changes its address and another is given the old one; a
hard-deleted colleague's address is invited again), so today's `users` table is consulted only for an
address no older row ever recorded. Anything ambiguous, or matching nobody, is dropped rather than
attributed to the wrong person. It is **not a migration** (`prisma migrate` never reads `prisma/manual/`), and every statement in it is
commented out so pasting the file does nothing.

Run it when nothing is under legal hold or open investigation that needs the old addresses. Consequences:

- Old rows lose their network correlation entirely (they cannot be hashed — see §2), and old refused
  sign-ins can no longer be grouped or recognised by the typed address (they keep its domain).
- Old rows whose actor was **hard**-deleted lose the only thing that named the person; they read "Deleted user".
- Nothing else changes. The nightly log archive (`lib/logArchive.ts`, the `audit` source) keeps whatever it
  already copied into object storage, under that bucket's own lifecycle rule.

To run it: take a backup, uncomment the block, check the `SELECT` counts, execute against the intended
database only.

## 5. What this change did not touch

- **`access_logs`** still stores the client IP and the signed-in actor's email. It is the log that clause 4
  of the CIC hosting undertaking requires us to retain and produce for 90 days (`OPERATIONS.md`), and it has
  its own retention purge. It now receives a trustworthy address (`clientIp()` no longer believes the leftmost
  `X-Forwarded-For` entry).
- **Payloads of rows that are not about an account.** A contact enquiry's label is `Name <address>`, an event
  registration's the same, and a studio-access grant's label is the address on the allow-list. Those
  addresses are the *content* of the record — the grant is the address — not metadata about whoever acted,
  and each has its own screen and erasure path. The provenance screens already withhold the first two
  (`safeEntityLabel`). Account rows, by contrast, are covered in full (§1).
- **Newsletter consent evidence and inquiries** keep their own `ipAddress` columns; those are evidence of
  consent or of a message's origin, governed by their own screens and erasure paths.
