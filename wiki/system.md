# System Architecture

## Shape

A layered monolith. Each layer may call the one below it and never the reverse.

```
HTTP  ->  routes  ->  middleware  ->  modules (controller -> service)
                                          |
                                          +-> infrastructure (database, crypto, mail, AI)
                                          +-> workers (threads)
                                          |
                                        core (framework free utilities)
```

`core` and `infrastructure` know nothing about Express, so both are unit
testable without a request object. Every module owns its rules in a service; the
controllers only translate between HTTP and that service.

## Why namespaces instead of users

There is no `users` table. An account row **is** a namespace, and its `type`
column decides whether it behaves as a person or an organization.

The benefit is that ownership has exactly one shape. A project always belongs to
one namespace account, whether that namespace is a person or a company, so
authorization is a single question asked in a single place. Modelling users and
organizations separately would mean two ownership paths and two permission
checks, which is where inconsistencies become vulnerabilities.

Reaching a namespace requires either owning it or holding a membership row:

```
Account (USER)  --owns-->  Account (USER) namespace       role OWNER
Account (USER)  --member-> Account (ORG)  namespace       role from org_members
```

`src/modules/namespaces/namespace.service.js` is the only place this is decided.
Project and file access resolve upward to that same function, so no route can
accidentally use a weaker rule.

## Data model

```
accounts ──┬─< org_members >── accounts          (organization membership)
           │
           └─< projects ──┬─< project_api_keys   (encrypted, priority ordered)
                          │
                          └─< files ──< translation_keys ──< translations

accounts ──< auth_tokens                          (single use short lived tokens)
```

Every child relation cascades on delete, so removing a namespace removes its
projects, files, keys and translations with it. No orphaned customer data is
left behind.

### Table notes

| Table | Notes |
|---|---|
| `accounts` | `user_id` is the routing handle. The schema calls the credential column `password (Hash)`; it is named `password_hash` here so no reader can mistake it for plaintext. Also carries lockout state. |
| `org_members` | Unique on `(org_account_id, user_account_id)`. Roles are `OWNER`, `ADMIN`, `MEMBER`. |
| `projects` | Unique on `(namespace_account_id, name)`, so names are unique per namespace rather than globally. |
| `project_api_keys` | `api_key` holds an AES 256 GCM envelope. Excluded from every default query by a Sequelize scope, so reading it requires asking for it by name. |
| `files` | Carries processing status, the requested target locales and any failure message. |
| `translation_keys` | `original_text` is always the English master. `text_hash` is its 36 character fingerprint. `source_text` retains the upload when it was not English. |
| `translations` | Unique on `(translation_key_id, lang_code)`. `source_hash` records the fingerprint at translation time, which is how staleness is detected. `is_manual` protects human edits from a rerun. |
| `auth_tokens` | Ledger making short lived tokens genuinely single use. Stores a SHA-256 digest, never the token. |

## The translation pipeline

English is always the master. A file uploaded in another language is translated
into `en_us` first, and every other language is derived from that master rather
than from the original upload. Translating Thai to Japanese via English is more
predictable than translating between arbitrary pairs, and it means one master
document defines the project's canonical strings.

```
upload
  │
  ├─ verify bytes really parse as a JSON object
  ├─ flatten nested keys to dot notation      (greeting.hello)
  │
  ├─ if the source is not en_us:
  │     translate every string into en_us     <- this becomes the master
  │
  ├─ fingerprint each master string           (36 character hash)
  │
  └─ for each target locale:
        translate from the master             <- never from the original upload
```

Steps two onward run inside a worker thread. Parsing, hashing and provider calls
are exactly the work that would otherwise stall the event loop for every other
request.

### Worker boundary

The worker receives a self contained job and returns a plain result. It performs
no database access at all, which keeps connection pools out of the threads and
makes the pipeline trivially parallel. The main thread owns persistence and
writes the result in one transaction.

Decrypted credentials are passed into the worker because that is where provider
calls happen. They exist only in that message and in memory for the duration of
the job; nothing is written to disk and nothing reaches a log.

## Change tracking

Every master string carries a deterministic 36 character fingerprint, and every
exported leaf carries it alongside the translation:

```json
{
  "hello": {
    "value": "สวัสดี",
    "hash": "123e4567-e89b-12d3-a456-426614174000"
  }
}
```

The value is a SHA-256 digest truncated to 128 bits and formatted as a UUID, so
the same source text always produces the same hash. A consumer comparing the
hash it holds against a fresh export learns immediately whether the English
source changed. Without it, an edited source string would silently keep its old
translation.

This is a change detection fingerprint, not a security primitive. It is never
used for authentication, signatures or password storage.

## API key fallback

A project may hold several credentials for its provider, ordered by
`priority_order`. The worker walks them from the top.

```
key 1 (priority 1)  -> revoked        -> try the next
key 2 (priority 2)  -> rate limited   -> try the next
key 3 (priority 3)  -> succeeds       -> done
```

Provider failures are mapped onto a small set of categories, and the category
decides what happens next:

| Category | Behaviour |
|---|---|
| `AUTH`, `QUOTA`, `RATE_LIMIT` | Move to the next credential immediately. |
| `SERVER`, `NETWORK`, `TIMEOUT` | Retry the same credential once, then move on. |
| `INVALID_RESPONSE` | Move to the next credential. |
| `REQUEST` | Stop the chain entirely. |

`REQUEST` is the important exception. It means the payload we sent was
malformed, so every remaining credential would fail identically. Continuing
would burn the project's real quota and hide the actual defect.

## Authentication

Two families of token:

**Session tokens** are ordinary JWTs valid for their configured lifetime. The
account is re-read from the database on every request rather than trusted from
the claims, so a deleted or locked account loses access immediately.

**Action tokens** cover password reset and settings changes. The specification
requires them to expire in exactly ten minutes and to die on first use. A JWT
alone cannot do the second part, because a signed token keeps verifying until it
expires. So each one is also recorded in `auth_tokens`, and redemption is a
conditional update:

```sql
UPDATE auth_tokens SET consumed_at = now()
WHERE id = :jti AND consumed_at IS NULL AND expires_at > now()
```

Exactly one of two concurrent redemptions can affect a row, so the token is
genuinely single use. Only a digest of the token is stored, so reading the table
yields nothing usable.

## Request flow

```
request
  -> helmet security headers
  -> origin allowlist
  -> body size limit
  -> correlation id
  -> rate limiter
  -> authentication      (loads the live account)
  -> access resolution   (namespace, project or file)
  -> schema validation   (replaces the payload, dropping unknown fields)
  -> controller
  -> service
  -> response
```

Errors from any stage reach one handler. Errors the application raised
deliberately are described to the client; anything else becomes a generic
message, with the full detail logged server side.

## Concurrency and limits

| Concern | Control |
|---|---|
| Event loop blocking | Pipeline runs on worker threads. |
| Runaway jobs | Bounded pool, queue, and a per task timeout. |
| Worker crashes | The pool replaces a dead thread and fails its in flight task. |
| Oversized uploads | Size ceiling enforced during streaming. |
| Hostile documents | Depth and key count ceilings. |
| Provider hangs | Per request timeout with an abort signal. |
| Request floods | Tiered rate limiting per endpoint class. |

## Scaling

The server is stateless apart from the database and the upload archive, so it
scales horizontally behind a load balancer. Worker threads scale vertically with
`WORKER_POOL_SIZE`. Sessions carry no server side state, so no sticky routing is
needed. The upload archive should be a shared volume or object store when more
than one instance runs.
