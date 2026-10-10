# The audit log: real email addresses and real IP addresses, kept and shown

**Owner decision, 2026-10-10.** The audit log (`audit_logs`, written only by `lib/audit.ts`) **stores and
shows the actor's real email address and the client's real IP address**, as it did before commit 4675432.
That commit had replaced both with an account id and a keyed fingerprint (finding 5 of
`security/2026-10-hardening.md`); the owner reversed that part the same day. No scrub of old rows is
offered or wanted: the opt-in scrub script that commit added has been removed, and production's 559
legacy rows have had their addresses restored.

What stayed from 4675432 is the part that was a security fix rather than a privacy choice: the client
address is derived **only** from platform-trusted headers (`lib/request-ip.ts`), never the leftmost
`X-Forwarded-For` entry, so the address the log records is one a client cannot forge by sending a header.
The keyed fingerprint (`ipHash`) is also still written, beside the address.

## 1. What a row stores

| Column / field | What is written | How it is shown |
|---|---|---|
| `actorId` | The signed-in account. | Joined for the account's current name. |
| `actorEmail` | The actor's address **at the time** (from the session). Denormalised so a hard-deleted account does not erase the trail. | The audit screen shows `Name <address>`; every "who" falls back to it when the account is gone (`lib/audit-actor.ts`), and says "Deleted user" only when a row has neither. |
| `ipAddress` | The client IP from `clientIp()` / `clientIpFromHeaders()` (`lib/request-ip.ts`), in canonical form (`normaliseIp`: RFC 5952 IPv6, IPv4-mapped → IPv4). Null when no trusted hop supplied one. | "from &lt;IP&gt;" on each audit entry; the provenance screens' sign-in lists, refusals and "addresses they worked from"; `ipAddress` in `/api/studio/audit`. |
| `ipHash` | `<keyId>:<32 hex>`, HMAC-SHA256 of the same normalised address (`lib/audit-ip.ts`). | Not shown on a row that has `ipAddress`. Used by an exact-address search to find the fingerprint-only rows (below), and returned as `networkFingerprint` by the API. |
| `entityLabel` on account rows | The account's address on every sign-in and sign-out, `Name <address>` on a `User` create/update, and the **typed** address on a refused sign-in — as before 4675432. | As recorded (`accountLabel`, `lib/audit-subject.ts`). |
| `after.email` on a refused sign-in | The address that was typed, plus `emailHash` (keyed fingerprint) and `emailDomain`, which group refusals across the fingerprint-only rows. | Provenance shows it whole when it belongs to a studio account or an access grant, and `••••@domain` otherwise — an unrecognised address may be somebody's typo of a personal one. The audit screen (administrators only) shows the label as recorded. |
| `before/after.editingHeldBy` on a lock take-over | Both holders' addresses, **and** `editingHeldById` (account ids), written by `takeOverLock` (`lib/studio/crud.ts`). | "Editing held by: &lt;current name&gt;" while the account exists, the recorded address once it is gone (`withLockHolderNames`). |

**Search.** The audit screen and `/api/studio/audit?q=` match the label, the entity id, the actor's email
(the recorded `actorEmail`, or the joined account's), and — when `q` is a whole IP address — rows from
that address **exactly** (`auditIpSearchClauses`: `ipAddress` in canonical and typed spelling, plus the
fingerprint under every search key). The provenance refusal search accepts a whole address (exact), part
of one (substring), or a pasted `net·…` fingerprint (prefix).

### Rows written between the deploy and the reversal

Rows written on 2026-10-10 between the deploy of 4675432 and this reversal carry `actorId` and `ipHash`
but no `actorEmail`, no `ipAddress`, and no address in the label or payload. They cannot be given the
address back (the database never holds the fingerprint key), so they display gracefully:

- no "from &lt;IP&gt;" is shown, but an exact-address search still finds them through `ipHash`;
- "who" is the joined account (its current address), or "Deleted user" if it has since been hard-deleted;
- an account row is named through `entityId` (`accountLabel`), a refused sign-in for an unknown address
  as `••••@domain`, and a typed address that fingerprints to a known account or grant is recognised;
- the provenance "where from" lists group them under their `net·…` fingerprint rather than dropping them
  (`groupByNetwork`), so a network seen on both sides of the change can appear twice for that window.

## 2. The fingerprint key, and rotating it

The fingerprint is still keyed so the hash column on its own is not a reversible copy of the address.

| Variable | |
|---|---|
| `AUDIT_IP_HASH_SECRET` | The key. At least 32 characters (`openssl rand -base64 48`). Shorter is ignored. |
| `AUDIT_IP_HASH_PREVIOUS_SECRETS` | Comma-separated retired keys, used **only for searching**, never for writing. Each entry is a retired dedicated secret, or `jwt:<a retired JWT_SECRET>` for a key that was derived from one. |

Unset, the key is **derived from `JWT_SECRET`** with HKDF under its own label. The cost is that rotating
`JWT_SECRET` also rotates the fingerprints, so Settings → Diagnostics warns until a dedicated secret is set.

The key id (the part before `:`) is a hash *of* the key, so a rotation is visible as a new prefix. Writing
always uses the current key; exact-address search tries the current key and every retired one.

| From → to | What to set |
|---|---|
| Derived → dedicated | Only `AUDIT_IP_HASH_SECRET`; the key derived from the current `JWT_SECRET` is always searched too. |
| Dedicated → new dedicated | New `AUDIT_IP_HASH_SECRET`; append the old one to `AUDIT_IP_HASH_PREVIOUS_SECRETS`. |
| `JWT_SECRET` rotated while on the derived key | Append `jwt:<the old JWT_SECRET>` to `AUDIT_IP_HASH_PREVIOUS_SECRETS`. |

Since every new row also stores the address, a lost or rotated key only affects searching the
fingerprint-only rows from 2026-10-10.

## 3. Who can see it

The audit log, the provenance console and `/api/studio/audit` are administrator-only
(`canViewAuditLog`). The log holds, in full, the email address and IP address of everybody who has signed
in or changed anything, the addresses typed at refused sign-ins, and the before/after content of every
change. Passwords, password hashes, TOTP secrets, recovery codes and storage keys are still stripped by
name before anything is stored (`redact()` in `lib/audit.ts`). The nightly log archive (`lib/logArchive.ts`)
copies the table as it is.

## 4. Related logs, unchanged

- **`access_logs`** stores the client IP and the signed-in actor's email (CIC hosting undertaking, clause 4;
  90-day retention purge — `OPERATIONS.md`). It receives the same trusted address.
- **Newsletter consent evidence and inquiries** keep their own `ipAddress` columns, governed by their own
  screens and erasure paths.
