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
accounts ──< export_formats                       (download shapes, shared by every project)
accounts ──< account_api_keys                     (encrypted, priority ordered, per namespace)
accounts ──< ai_chat_logs                         (one row per assistant exchange)
```

Every child relation cascades on delete, so removing a namespace removes its
projects, files, keys and translations with it. No orphaned customer data is
left behind.

### Table notes

| Table | Notes |
|---|---|
| `accounts` | Each row is a namespace. An ORG row carries the organization's own `email`, used for billing and account notices, so those never depend on the personal address of whoever created it. `user_id` is the routing handle. The schema calls the credential column `password (Hash)`; it is named `password_hash` here so no reader can mistake it for plaintext. Also carries lockout state. |
| `org_members` | Unique on `(org_account_id, user_account_id)`. Roles are `OWNER`, `ADMIN`, `MEMBER`. |
| `projects` | Unique on `(namespace_account_id, name)`, so names are unique per namespace rather than globally: two accounts may each hold a project called `website`. `id` is an autoincrementing integer drawn from this one table, whoever owns the row, so a project identifier is unique on its own and needs no namespace to disambiguate it. |
| `project_api_keys` | `api_key` holds an AES 256 GCM envelope. Excluded from every default query by a Sequelize scope, so reading it requires asking for it by name. |
| `files` | Carries processing status, the requested target locales and any failure message. |
| `translation_keys` | `original_text` is always the English master. `text_hash` is its 36 character fingerprint. `source_text` retains the upload when it was not English. |
| `translations` | Unique on `(translation_key_id, lang_code)`. `source_hash` records the fingerprint at translation time, which is how staleness is detected. `is_manual` protects human edits from a rerun. |
| `auth_tokens` | Ledger making short lived tokens genuinely single use. Stores a SHA-256 digest, never the token. |
| `export_formats` | Unique on `(namespace_account_id, format_id)`. Describes the shape of a downloaded locale document as data, never as a template: a leaf shape, the field names to emit, and whether dotted paths expand into a tree. Hangs off the namespace so one shape serves every project underneath. |
| `account_api_keys` | The mirror of `project_api_keys` one level up, paying for what an account does outside a single project. Each row names its own platform and chat model, since an account has no record to take them from. Same encryption, same masking, same priority ordering. |
| `ai_chat_logs` | One row per assistant exchange. `account_id` is the namespace the conversation happened in and whose credentials paid; `user_id` is the person who asked, and holds an account id rather than the routing handle `accounts.user_id` carries. `embedding` is nullable text holding a JSON array, so an account with no embedding model configured still chats normally. |

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

## Export formats

A download is packaged one of three ways (a single locale, every locale in one
JSON envelope, or `langs.zip`) and its documents are written in one of the
namespace's formats. The two questions are independent, which is why they are
separate query fields rather than one.

Two formats ship with the application and exist for every namespace without
being stored: `default`, the value and hash shape described below, and
`key_value`, the bare string a localization library reads directly. Neither can
be edited or deleted, because a build script already downloads with it.

A namespace may store further formats of its own, and every project underneath
can then be downloaded in any of them. A stored format is a description rather
than a template: it names the leaf shape (`OBJECT` or `STRING`), the field names
an object leaf carries, and whether a dotted path expands into a tree. Nothing
stored is evaluated, so a format is not an execution surface, and field names
are refused before storage if they could reach `Object.prototype`.

## Change tracking

Every master string carries a deterministic 36 character fingerprint, and the
`default` export shape carries it alongside the translation on every leaf:

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

Choosing `key_value` trades this away: the document holds no fingerprint, so
staleness cannot be read from the file. `GET /files/:fileId/translations` still
reports it, which is where the editor gets its warnings from either way.

### Correcting one string

A correction names one key, so it restamps one fingerprint. The response says
whether the text really moved and which languages are now behind it, and a
separate call refreshes exactly the keys named:

```
PATCH /files/:fileId/keys/:keyId        -> changed, stale_lang_codes
POST  /files/:fileId/keys/retranslate   -> only those keys reach a provider
```

The whole file rerun still exists and is still the right tool after a failure.
It is the wrong tool after a typo: it would send every key to a provider to
refresh one of them.

## Key consistency

The pipeline guarantees a translation was produced from the master. It cannot
guarantee the two still agree structurally afterwards. A model may drop a
placeholder, a reviewer may retype `{name}` in their own language, and a locale
added later may not cover every key. Each string looks fine on its own; the
failure appears at runtime, as a literal brace on screen or a formatter handed
fewer arguments than its format string expects.

`GET /files/:fileId/consistency` compares the interpolation tokens of every key
against every translation of it and reports missing tokens, invented tokens,
missing rows, empty rows and stale rows.

It runs only when asked. Comparing every key against every language on each edit
would put the file's whole token set through a regular expression on every
keystroke a reviewer makes, to answer a question nobody asked at that moment.
The editor calls it when a person wants the answer.

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

### The account level chain

Account credentials use the same walk, over a chain assembled from two owners.
Inside an organization the organization pays first, and the person's own
credentials sit behind it:

```
org key 1     (organization) -> revoked      -> try the next
org key 2     (organization) -> out of quota -> try the next
personal key  (the caller)   -> succeeds     -> done
```

An expired company card stops one purchase rather than the whole team. Only ever
the caller's own personal keys: nothing in the chain can reach a credential
belonging to another member, and a personal namespace is simply the tail of the
chain with no head.

When neither account has a usable key and the build allows it, the built in
development credential is appended, which is what keeps the assistant runnable
on a clean clone. That fallback is refused in production, exactly as it is for
the translation pipeline.

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
