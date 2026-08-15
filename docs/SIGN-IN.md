# Signing in to the studio

Two things decide whether somebody can open the CMS, and keeping them apart is the whole design:

| | Question | Answered by |
|---|---|---|
| **Authentication** | *Who is this?* | a password, or Google / Microsoft / Yahoo |
| **Authorisation** | *Should they be here?* | the **studio access list** |

A provider only ever answers the first. Adding "Continue with Google" without the second would mean
every Google account on earth could open the CMS of a research institution — so nothing creates an
account, and no session is issued, until the address appears on the access list.

---

## The access list

**Studio → Studio access**, master administrator only.

Adding somebody is adding their email address. Nothing else lets them in: not a password they were
given, not a Google account at the right domain, not an old invitation. Removing them is revoking the
grant.

Each entry records the role their account is created with on first sign-in, who added them, why, and
whether the grant has ever been used. **An unused grant from eight months ago is the most useful thing
on that screen** — an access list nobody can prune is one that only ever grows.

A few rules the screen enforces, and says so:

- **Revoking a grant does not sign the person out.** Their session lives until it expires; the screen
  offers to revoke their sessions at the same time.
- **You cannot revoke your own grant**, and you cannot remove the last master administrator's — both
  checked inside the transaction, because an outer check races two concurrent requests and leaves an
  installation nobody can ever add anybody to.
- **Revoking is a flag, not a delete**, so the record of who was once allowed in survives. Deleting a
  grant is a separate, deliberately harder action.

### Why master administrator, and not administrator

An administrator runs the site. A master administrator decides who is allowed *near* it. Keeping the
two apart means the account used every day — and therefore the one most likely to be phished — cannot
widen the circle of people who can sign in. It is the difference between *somebody defaced a page* and
*somebody let themselves in*.

---

## Setting up a provider

Each is optional and independent. **A provider that is not configured is not rendered on the sign-in
page at all** — a greyed-out button invites a click that cannot succeed.

The callback URL is the same shape for all three:

```
https://your-site.example/api/auth/oauth/<google|microsoft|yahoo>/callback
```

For local Docker use `http://localhost:3000/...`. It must match what you register **exactly**,
including scheme and port.

### Google

1. Google Cloud Console → *APIs & Services* → *Credentials* → **OAuth client ID**, type *Web
   application*.
2. Add the callback URL under *Authorised redirect URIs*.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Microsoft

1. Entra ID → *App registrations* → **New registration**.
2. Redirect URI, platform *Web*, the callback URL above.
3. *Certificates & secrets* → **New client secret**.
4. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.
5. **Set `MICROSOFT_TENANT_ID` to your directory (tenant) ID.** Left unset it defaults to `common`,
   which accepts any Microsoft account including personal ones. The access list still gates entry, but
   naming your tenant is the narrower door and it also lets the issuer be pinned exactly rather than
   matched by shape.

> Microsoft does not send `email_verified`. The code trusts its `xms_edov` claim when present and
> otherwise trusts a **work** account — whose address is issued by a directory the organisation
> controls — while refusing a **personal** account, because one can be created with an arbitrary
> address and the access list is keyed on the address. The reasoning is in `lib/auth/oauth.ts`.

### Yahoo

1. Yahoo Developer Network → **Create an App**, with *OpenID Connect Permissions* and the `profile` and
   `email` scopes.
2. Redirect URI: the callback URL above. **Yahoo rejects `http://` redirect URIs**, so a local test
   needs an HTTPS tunnel; Google and Microsoft both accept `http://localhost`.
3. Set `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET`.

### Environment

```bash
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
MICROSOFT_CLIENT_ID=""
MICROSOFT_CLIENT_SECRET=""
MICROSOFT_TENANT_ID=""     # your directory ID; blank means "any Microsoft account"
YAHOO_CLIENT_ID=""
YAHOO_CLIENT_SECRET=""
```

---

## What happens on a provider sign-in

1. `/api/auth/oauth/<provider>/start` mints `state`, `nonce` and a PKCE verifier, stores them in one
   short-lived cookie, and redirects.
2. The provider returns to the callback with a code.
3. The callback clears the handshake cookie **first**, then checks `state` in constant time, exchanges
   the code with the verifier, and verifies the ID token's **signature, issuer, audience and nonce**
   against the provider's JWKS.
4. It refuses an address the provider has not verified.
5. It looks the account up by the provider's `sub` — **never by email**, because an address is
   reassignable inside an organisation and a subject identifier is not.
6. **It consults the access list.** A refusal creates nothing and is audited with the real reason.
7. It links or creates the account, issues the session, and stamps the grant as used.

Every refusal shows the reader the **same** sentence, whatever the cause. Distinguishing "no such
address" from "revoked" from "wrong button" would turn the sign-in page into a directory of who works
at the Centre. The specific reason goes to the audit log, where the people who can act on it will see
it.

---

## Two-factor authentication

Independent of all of the above and set up per account in **Studio → Account**. Recovery codes are
shown once, stored as hashes, and are single-use — enforced by a compare-and-swap, so two requests
presenting the same code cannot both succeed.

An administrator can *disable* somebody's second factor as an account-recovery measure. Nobody can ever
*read* one: the secret is encrypted at rest with a key derived from `JWT_SECRET`, and no endpoint
returns it.

---

## If you are locked out

The seed creates the first master administrator and its access grant together, and backfills a grant
for every account that already existed — so an upgrade cannot lock an institution out of its own CMS.

```bash
# Docker
docker compose run --rm migrate

# Local
npm run seed
```

It is idempotent: an existing account is never given a new password, and an existing grant is never
overwritten.
