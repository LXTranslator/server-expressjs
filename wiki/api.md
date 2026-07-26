# API Reference

Base path: `/api/v1`

## Conventions

Successful responses carry a `data` object; failures carry an `error` object.

```json
{ "data": { "account": { "id": "..." } } }
```

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The submitted data failed validation.",
    "details": [{ "field": "email", "message": "Enter a valid email address." }]
  }
}
```

Authenticated requests carry a bearer token:

```
Authorization: Bearer your_access_token
```

### Identifiers in paths

| Segment | Form |
|---|---|
| `:namespace` | The routing `user_id` of a user or organization account, for example `orgA`. |
| `:projectId` | A positive integer. Project rows share one table and one sequence, so the identifier is unique on its own. Anything that is not a positive integer is **404**. |
| `:fileId`, `:keyId`, `:memberId`, `:translationId` | UUIDs. |

A **locale code** is two to eight lowercase letters, optionally followed by an
underscore and a two to eight character region or script subtag: `en_us`,
`th_th`, `bar`, `nds_de`, `zlm_arab`. The language part is not restricted to two
letters, because many translatable locales have no two letter form. The
character set is deliberately narrow, since a locale code reaches a generated
filename, a `Content-Disposition` header and a ZIP entry name.

A project **name** is unique only within its namespace, so two accounts may each
hold a project called `website`. Address a project by its identifier, never by
its name alone.

### Status codes

| Code | Meaning |
|---|---|
| 200 | Success. |
| 201 | Resource created. |
| 202 | Accepted; work continues in the background. |
| 204 | Success with no body. |
| 400 | Malformed request. |
| 401 | Missing, invalid or expired credentials. |
| 403 | Authenticated but not permitted. |
| 404 | Not found, or not visible to this caller. |
| 409 | Conflicts with existing data. |
| 413 | Payload too large. |
| 415 | Unsupported media type. |
| 422 | Failed schema validation. |
| 429 | Rate limited. |
| 500 | Unexpected server error. |

A caller who is not entitled to a resource receives **404, not 403**, wherever a
403 would confirm that the resource exists.

### Rate limits

| Endpoint class | Default |
|---|---|
| Global | 300 requests per minute. |
| Credentials (`/auth/*`, `/settings/confirm`) | 10 per minute. |
| Availability probe | 20 per minute. |
| Uploads | 20 per minute. |
| Assistant turns | 30 per minute. One turn may be several provider calls. |

---

## Service

### `GET /health`

Liveness probe. No authentication.

```json
{ "data": { "status": "ok", "timestamp": "2026-07-25T19:13:31.012Z" } }
```

### `GET /providers`

Provider and model catalogue for the project settings page. No authentication.

```json
{
  "data": {
    "providers": [
      {
        "name": "anthropic",
        "label": "Anthropic Claude",
        "default_model": "claude-opus-5",
        "models": ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
        "requires_network": true
      },
      {
        "name": "openrouter",
        "label": "OpenRouter",
        "default_model": "openai/gpt-4o-mini",
        "models": ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5"],
        "requires_network": true
      }
    ],
    "default_provider": "mock",
    "default_model": "mock-small"
  }
}
```

`mock`, `openai`, `anthropic` and `openrouter` are the whole registry. Because
OpenRouter brokers several vendors through one credential, its model names carry
a vendor prefix; a project set to `openrouter` can change vendor by changing the
model, without a new key. `ai_model` must be one of the names the catalogue
lists for the chosen provider, or the request is **400**.

Each entry also carries `embedding_models`, `default_embedding_model` and
`supports_caching`, which is what an account settings page needs to offer both
dropdowns:

| Platform | Embedding models |
|---|---|
| `openrouter` | `qwen/qwen3-embedding-8b` (default), `openai/text-embedding-3-small`, `openai/text-embedding-3-large`, `qwen/qwen3-embedding-4b` |
| `openai` | `text-embedding-3-small` (default), `text-embedding-3-large` |
| `anthropic` | none |
| `mock` | `mock-embedding` |

Anthropic's list is empty because it serves no embeddings endpoint of its own
and points at external partners for it. An account using Anthropic for chat
either leaves the embedding model empty, which the assistant handles, or adds a
second credential on a platform that does serve one.

`supports_caching` reports whether the platform caches a prompt prefix.
OpenRouter and Anthropic are sent an explicit cache mark on the system
instruction, which matters most in the assistant: one question may take several
passes, and without it the same instruction and tool catalogue are charged in
full on every pass.

---

## Authentication

### `GET /auth/availability`

Checks whether an identifier can still be registered. Used by the registration
form before submitting.

| Query | Required | Notes |
|---|---|---|
| `user_id` | one of the two | Lowercase letters, digits, underscores, 3 to 32 characters. |
| `email` | one of the two | Valid address. |

```json
{ "data": { "user_id_available": false, "email_available": true } }
```

A namespace occupies the first path segment of a client URL, so identifiers the
client already routes cannot be registered: `api`, `assets`, `login`,
`namespaces`, `organizations`, `register` and `settings`. The probe reports them
as unavailable rather than failing validation, so the form behaves the same way
it would for a name already taken. Registering one is **422**.

### `POST /auth/register`

```json
{
  "user_id": "jetsada",
  "email": "jetsada@example.com",
  "password": "your_password",
  "confirm_password": "your_password"
}
```

Password policy: at least 10 characters, with a lowercase letter, an uppercase
letter and a digit.

Returns **201** with the account and a session token. Any field not listed above
causes a **422**; the payload cannot be used to set the account `type`.

### `POST /auth/login`

```json
{ "identifier": "jetsada", "password": "your_password" }
```

`identifier` accepts the user id or the email address. Returns **200** with a
session token.

A wrong password and an unknown account return the same **401** message. After
five failures the account is locked for fifteen minutes.

### `POST /auth/password/forgot`

```json
{ "email": "jetsada@example.com" }
```

Always **200** with the same message whether or not the address is registered.
Sends a reset link that expires in exactly ten minutes and dies on first use.

Outside production the response also carries `development_token`, so the flow
can be completed without an inbox.

### `POST /auth/password/reset`

```json
{
  "token": "your_reset_token",
  "password": "your_new_password",
  "confirm_password": "your_new_password"
}
```

Returns **401** if the token is expired, already used, or was minted for a
different purpose. Resetting invalidates every other outstanding action token.

### `GET /auth/me`

Returns the account behind the current session. Requires authentication.

---

## Account settings

All routes require authentication.

Sensitive changes are a two step flow: confirm the current password to mint a
ten minute single use token, then spend it on exactly one change.

### `GET /settings`

Returns the signed in account.

### `POST /settings/confirm`

```json
{ "password": "your_current_password" }
```

```json
{ "data": { "token": "your_settings_token", "expires_in": 600 } }
```

### `PATCH /settings/identifier`

```json
{ "token": "your_settings_token", "user_id": "new_user_id" }
```

### `PATCH /settings/email`

```json
{ "token": "your_settings_token", "email": "new@example.com" }
```

### `PATCH /settings/password`

```json
{
  "token": "your_settings_token",
  "password": "your_new_password",
  "confirm_password": "your_new_password"
}
```

### `PATCH /settings/profile`

Display fields only, so no settings token is required.

```json
{
  "display_name": "Jetsada Wijit",
  "description": "Localization engineer",
  "website_url": "https://example.com"
}
```

---

## Namespaces

All routes require authentication. `:namespace` accepts the routing `user_id` or
the account id.

### `GET /namespaces`

Every namespace the caller can act in: their own, plus organizations they belong
to, each with the caller's role.

### `POST /namespaces/organizations`

```json
{
  "user_id": "acme_corp",
  "email": "team@acme.com",
  "display_name": "Acme Corporation",
  "description": "Localization team"
}
```

Returns **201**. The creator becomes `OWNER`.

### `GET /namespaces/:namespace`

Namespace profile and the caller's role. **404** if the caller has no access.

### `PATCH /namespaces/:namespace/settings`

Organization profile. Requires `ADMIN` or above. **400** on a personal
namespace.

```json
{
  "display_name": "Acme Corporation",
  "description": "Localization team",
  "website_url": "https://acme.com",
  "email": "accounts@acme.com"
}
```

Every field is optional; omitted fields are left unchanged.

`email` is the **organization's own contact address**, held separately from
every member's personal address. Billing and account notices are addressed to
the organization rather than to whichever person happened to create it, since
that person may later leave. Changing it to an address already registered to
another account returns **409**.

### `DELETE /namespaces/:namespace`

Permanently deletes an organization namespace and everything under it: its
membership rows, projects, files, translation keys and translations.

```json
{ "confirm_user_id": "acme_corp" }
```

Three guards apply:

* **Owner only.** `ADMIN` is deliberately not sufficient, so a 403 is returned.
* **The identifier must be echoed.** `confirm_user_id` must equal the
  namespace's own `user_id`, otherwise **400**. This makes a misdirected delete
  far harder than a bare confirmation would.
* **Personal namespaces are refused** with **400**. Deleting one would mean
  deleting the account, which is a separate flow.

Returns **204** on success. The identifier becomes available for reuse.

### `GET /namespaces/:namespace/settings/members`

Lists membership.

### `POST /namespaces/:namespace/settings/members`

```json
{ "identifier": "teammate_user", "role": "MEMBER" }
```

`identifier` is a user id or email of an existing personal account. `role` is
`OWNER`, `ADMIN` or `MEMBER` and defaults to `MEMBER`. Requires `ADMIN` or
above, and nobody may grant a role above their own.

### `PATCH /namespaces/:namespace/settings/members/:memberId`

```json
{ "role": "ADMIN" }
```

### `DELETE /namespaces/:namespace/settings/members/:memberId`

Returns **204**. Members may remove themselves; removing anyone else requires
`ADMIN`. The last `OWNER` cannot be removed or demoted.

### `GET /namespaces/:namespace/export_formats`

The shapes a locale document can be downloaded in. A format belongs to the
namespace rather than to a project, so one is written once and offered by every
project underneath it. Any role may read the list, since picking a format is
part of downloading.
## Account AI credentials

The only place a provider credential is stored. These keys pay for everything the
application sends to a vendor: translating a file inside a project and answering
a question in the assistant alike.

A credential is a billing relationship, so it belongs to the account being
billed rather than to a project. An account may hold keys for several platforms
at once — one for OpenAI, one for Anthropic, one for OpenRouter — and each
project draws on the ones matching the platform its settings name.

All routes require authentication and, inside an organization, `ADMIN` or above.
Reading is as privileged as writing here: the list is a statement about the
organization's spending.

**No endpoint returns a stored key.** Responses identify a credential by label
and its last four characters.

### `GET /namespaces/:namespace/settings/ai_keys`

```json
{
  "data": {
    "export_formats": [
      {
        "format_id": "default",
        "name": "Value and hash",
        "description": "Every leaf carries the translated string and the fingerprint...",
        "leaf_shape": "OBJECT",
        "value_field": "value",
        "hash_field": "hash",
        "nested": true,
        "built_in": true,
        "created_at": null
      },
      {
        "format_id": "key_value",
        "name": "Key and value",
        "leaf_shape": "STRING",
        "value_field": null,
        "hash_field": null,
        "nested": true,
        "built_in": true,
        "created_at": null
    "keys": [
      {
        "id": "...",
        "provider": "openrouter",
        "chat_model": "openai/gpt-4o-mini",
        "embedding_model": "qwen/qwen3-embedding-8b",
        "label": "organization primary",
        "masked_key": "****7890",
        "priority_order": 1,
        "is_active": true,
        "last_used_at": null,
        "last_error_at": null,
        "last_error_reason": null
      }
    ]
  }
}
```

`default` and `key_value` ship with the application and exist in every
namespace. They are listed first and cannot be changed or removed: **409** on a
`PATCH`, a `DELETE`, or a `POST` that reuses one of their identifiers.

### `POST /namespaces/:namespace/export_formats`

Creates a format for the namespace. Requires `ADMIN` or above inside an
organization.

```json
{
  "format_id": "flat_text",
  "name": "Flat text",
  "description": "One dotted key per line, no fingerprint.",
  "leaf_shape": "STRING",
  "nested": false
}
```

| Field | Required | Notes |
|---|---|---|
| `format_id` | yes | 2 to 50 lowercase letters, digits and underscores. Unique within the namespace and immutable afterwards, since a build script downloads with it. |
| `name` | yes | Up to 80 characters. |
| `description` | no | Up to 500 characters. |
| `leaf_shape` | no | `OBJECT` (default) writes a leaf object; `STRING` writes the translated text itself. |
| `value_field` | no | Field holding the translation. `OBJECT` only, defaults to `value`. |
| `hash_field` | no | Field holding the fingerprint. `OBJECT` only, defaults to `hash`. Pass `null` for a leaf with no fingerprint. |
| `nested` | no | `true` (default) expands `greeting.hello` into a tree; `false` keeps it as one key. |

A format is a description, never a template, so nothing stored here is
evaluated. Field names must start with a letter and hold only lowercase letters,
digits and underscores, which is what keeps a name such as `__proto__` out
(**422**). Naming a field on a `STRING` leaf, or giving the value and the hash
the same name, is **400**. A namespace may hold 50 formats.

### `PATCH /namespaces/:namespace/export_formats/:formatId`

Any of `name`, `description`, `leaf_shape`, `value_field`, `hash_field`,
`nested`. The identifier itself cannot change. Requires `ADMIN` or above inside
an organization.

### `DELETE /namespaces/:namespace/export_formats/:formatId`

Returns **204**. Requires `ADMIN` or above inside an organization. Downloads
naming a removed format become **404**.
### `POST /namespaces/:namespace/settings/ai_keys`

```json
{
  "provider": "openrouter",
  "chat_model": "openai/gpt-4o-mini",
  "embedding_model": "qwen/qwen3-embedding-8b",
  "api_key": "your_provider_api_key",
  "label": "organization primary",
  "priority_order": 1,
  "is_active": true
}
```

Returns **201**. Each row names its own platform and models, which is what lets
one account hold credentials for several vendors and lets a project pick between
them. `provider` must be in the registry `GET /providers` lists and `chat_model`
must be one of that platform's models, otherwise **400**. `chat_model` defaults to the platform's
own default. `priority_order` defaults to the end of the chain. An account may
hold 20 credentials.

`embedding_model` is optional and `null` is meaningful: an account with no
embedding model chats normally, stores no vectors, and searches conversations by
text. Naming one the platform does not serve is **400**, and for Anthropic every
name is, since it serves no embeddings endpoint.

The first credential in the chain that names an embedding model is the one that
produces vectors, so an organization can pay for search while a personal
credential only answers chat, or the reverse.

### `PATCH /namespaces/:namespace/settings/ai_keys/:keyId`

Any of `provider`, `chat_model`, `embedding_model`, `api_key`, `label`,
`priority_order`, `is_active`. Changing the platform without naming a model
falls back to that platform's default, and drops an embedding model the new
platform cannot serve rather than failing the whole update.

### `POST /namespaces/:namespace/settings/ai_keys/reorder`

```json
{ "ordered_key_ids": ["id_three", "id_one", "id_two"] }
```

Must list every key on the account exactly once. This is the order the fallback
chain will walk.

### `DELETE /namespaces/:namespace/settings/ai_keys/:keyId`

Returns **204**.

### How the chain is walked

When a person acts inside an organization, the organization's credentials are
tried first, in their priority order, and that person's own personal
credentials follow. A revoked, throttled or exhausted organization key falls
through to the personal one rather than failing the request.

The chain only ever contains the caller's own personal keys. No request can
reach a credential belonging to another member, and a personal namespace is
simply the chain with no organization ahead of it.

Translating a file walks the same chain, narrowed to the platform the project
named, so a project configured for one vendor never sees another vendor's keys.

With no usable credential anywhere, and outside production, the built in
development credential answers, so both translation and the assistant work on a
clean clone.

---

## The assistant

Answers questions about a namespace and acts on it through a fixed set of tools.
All routes require authentication and access to the namespace. Any member may
talk to it: each tool enforces its own role, so a `MEMBER` asking it to create a
project is refused by the tool rather than at the door.

### `POST /namespaces/:namespace/chat`

```json
{ "message": "Which languages does the web app project have?", "session_id": "..." }
```

Also accepts `multipart/form-data` with a `message` field and an optional `file`
part, which lets the assistant create a project from an attached locale file.
The attachment passes exactly the checks an ordinary upload passes.

| Field | Required | Notes |
|---|---|---|
| `message` | yes | Up to `AGENTS_CHAT_MAX_PROMPT` characters. |
| `session_id` | no | Continues that conversation, which must be one of the caller's own. Absent starts a new one. |
| `file` | no | Multipart only. A `.json` locale file, same limits as an upload. |

```json
{
  "data": {
    "session_id": "...",
    "session": {
      "id": "...",
      "title": "Which languages does the web app project have?",
      "turn_count": 4,
      "total_token_usage": 3140,
      "last_message_at": "2026-07-26T19:00:00.000Z"
    },
    "answer": "The web app project has th_th and ja_jp.",
    "namespace": "acme_corp",
    "tool_calls": [{ "name": "check_project_languages", "ok": true }],
    "steps": 2,
    "stopped_by_tool": false,
    "token_usage": 812,
    "total_token_usage": 3140
  }
}
```

`steps` never exceeds `AGENTS_CHAT_REPEAT`, default 5. A tool that refuses does
not fail the request: it appears in `tool_calls` with `ok: false` and an
`error`, and the assistant explains it in the answer.

**404** when `session_id` names a conversation that is not the caller's own,
which is checked before anything is spent.

**503** when no credential in the namespace chain can answer. See
*Account AI credentials* for how that chain is assembled.

A new conversation is named from the question that opened it, cut at a word
boundary, so a list is readable without anybody naming anything. Renaming
replaces that, and nothing rewrites a chosen name afterwards.

### Tools the assistant may call

| Tool | Effect | Role required |
|---|---|---|
| `switch_namespace` | Changes the namespace the conversation acts in | Membership, proven per call |
| `list_projects` | Lists the current namespace's projects | Namespace access |
| `check_project_languages` | Master language, per file sources and targets | Project access |
| `get_project_description` | Reads a description | Project access |
| `update_project_description` | Replaces a description | `ADMIN` in an organization |
| `create_project` | Creates a **new** project, uploading the attachment when present | `ADMIN` in an organization |
| `upload_file` | Uploads the attachment into a project that **already exists** | `ADMIN` in an organization |
| `list_files` | Lists a project's files and their status | Project access |
| `add_languages` | Adds targets to one project, several, or all | `ADMIN` in an organization |
| `find_chat` | Searches the caller's own past conversations | Namespace access |
| `stop` | Ends the turn with a summary | None |

**The model authorises nothing.** Every tool resolves access itself, on every
call, against the signed in account, through the same functions the REST routes
use. Naming a namespace or project the caller cannot reach fails with the same
message the API would give. Tool arguments are validated by a strict schema
before any service sees them.

`create_project` instructs rather than guesses: asked to translate with no file
attached it says so, and a name already taken comes back with a suggestion to
choose another.

`upload_file` is the one to use when the project is already there. Both tools
take the same single attachment, so an attached file can reach either a new
project or an existing one, and neither ever requires deleting or recreating a
project to get a file into it.

`add_languages` touches at most 25 projects per call. Files that cannot take a
language are reported in `skipped` with a reason rather than failing the rest.

### `GET /namespaces/:namespace/chat/sessions`

Lists the caller's conversations in this namespace, most recently used first.

| Query | Required | Notes |
|---|---|---|
| `limit` | no | At most 100. Defaults to 50. |

```json
{
  "data": {
    "sessions": [
      {
        "id": "...",
        "title": "Thai rollout",
        "turn_count": 6,
        "total_token_usage": 4820,
        "last_message_at": "2026-07-26T19:00:00.000Z",
        "created_at": "2026-07-26T18:12:00.000Z"
      }
    ]
  }
}
```

The caller's own and nobody else's, including inside an organization. An
administrator manages the credentials that pay for the assistant, which is not
the same as reading what a colleague asked it.

`last_message_at` is separate from `updated_at` on purpose: renaming a
conversation must not reorder the list.

### `GET /namespaces/:namespace/chat/sessions/:sessionId`

Reads a conversation back, oldest turn first, alongside the conversation record.

| Query | Required | Notes |
|---|---|---|
| `limit` | no | Turns to read. Defaults to `AGENTS_CHAT_HISTORY_TURNS`. |

Always the caller's own conversation. A session identifier belonging to somebody
else is **404**, not 403, since a 403 would confirm it exists.

### `PATCH /namespaces/:namespace/chat/sessions/:sessionId`

```json
{ "title": "Thai rollout" }
```

Names a conversation. At most 120 characters. An empty or blank title clears the
name, putting the conversation back to being listed by its opening question.
**404** when it is not the caller's own.

### `DELETE /namespaces/:namespace/chat/sessions/:sessionId`

Returns **204**. Cascades to every turn in the conversation. **404** when it is
not the caller's own.

### `GET /namespaces/:namespace/chat/search`

| Query | Required | Notes |
|---|---|---|
| `q` | yes | What to look for. |
| `limit` | no | At most 20. Defaults to 5. |

```json
{
  "data": {
    "method": "EMBEDDING",
    "matches": [{ "id": 42, "user_prompt": "...", "score": 0.87 }]
  }
}
```

`method` is `EMBEDDING` when an embedding model is configured and the rows carry
vectors, and `TEXT` otherwise, so a client can explain why a search found less
than expected. Scoped to the caller's own conversations.

### `POST /namespaces/:namespace/chat/embeddings`

Embeds past exchanges that have no vector yet, for the account that chatted
before configuring an embedding model.

```json
{ "limit": 50 }
```

```json
{
  "data": {
    "embedded": 50,
    "failed": 0,
    "remaining": 118,
    "model": "qwen/qwen3-embedding-8b",
    "configured": true
  }
}
```

Bounded per call by `AGENTS_CHAT_EMBED_BATCH`, so a long history is caught up
over several requests. `configured: false` with `embedded: 0` means the account
has no embedding model, which is not an error.

### `GET /namespaces/:namespace/chat/log_buffer`

Chat logs are written asynchronously and survive a failed write in memory, so
this reports what is still waiting.

```json
{ "data": { "pending": 0, "written": 128, "dropped": 0, "failures": 0 } }
```

### `POST /namespaces/:namespace/languages`

Adds target languages across a namespace in one call, rather than once per file.

```json
{ "target_langs": ["ko_kr"], "all_projects": true }
```

| Field | Required | Notes |
|---|---|---|
| `target_langs` | yes | Locales to add. |
| `project_ids` | one of the two | Projects to change, at most 50. |
| `all_projects` | one of the two | Every project in the namespace. |

Returns **202** with `applied` and `skipped`. A file that already carries a
language, or a project with no files, is reported with a reason rather than
failing the rest. Requires `ADMIN` or above inside an organization.

---

### `GET /namespaces/:namespace/projects`

Lists the namespace's projects.

### `POST /namespaces/:namespace/projects`

```json
{
  "name": "web_app",
  "description": "Marketing site strings",
  "ai_provider": "openai",
  "ai_model": "gpt-4o-mini"
}
```

Returns **201**. Inside an organization this requires `ADMIN` or above.

---

## Projects

All routes require authentication.

### `GET /projects/:projectId`

Project, its namespace and the caller's role.

### `PATCH /projects/:projectId/settings`

```json
{ "name": "web_app", "ai_provider": "anthropic", "ai_model": "claude-opus-5" }
```

Changing the provider without naming a model falls back to that provider's
default, since the previous model almost certainly does not exist there.

### `GET /projects/:projectId/description`

```json
{ "data": { "project_id": 12, "description": "Marketing site strings" } }
```

Separate from the settings payload because the description is the one project
field with no consequence: changing it cannot invalidate a credential, retarget
a provider or cost anything. Reading it needs only access to the project.

### `PUT /projects/:projectId/description`

```json
{ "description": "Marketing site strings" }
```

An empty string clears it. Requires `ADMIN` or above inside an organization.

### `DELETE /projects/:projectId`

Returns **204**. Cascades to files, keys and translations.

---

## Project credentials

A project has none. It names a platform and a model in its settings, and the key
that pays for a call is resolved from the account chain described under
[Account AI credentials](#account-ai-credentials): the namespace that owns the project
first, then the personal keys of whoever asked, narrowed to the platform the
project named.

There is therefore no `/projects/:projectId/keys` endpoint. Manage credentials at
`/namespaces/:namespace/settings/ai_keys`.

---

## Files

### `GET /projects/:projectId/files`

Lists the project's files.

### `POST /projects/:projectId/files`

`multipart/form-data`.

| Field | Required | Notes |
|---|---|---|
| `file` | yes | A `.json` file, at most 2 MB by default. |
| `source_lang` | no | Locale of the upload. Defaults to `en_us`. |
| `target_langs` | yes | JSON array, comma separated list, or repeated field. |

Returns **202**: the record exists but the pipeline is still running. Poll
`GET /files/:fileId` until `status` is `READY` or `FAILED`.

Rejections: **400** for a wrong extension or unparseable content, **415** for a
disallowed content type, **413** for an oversized file, **422** for a malformed
locale code, **409** for a duplicate filename in the project.

### `GET /files/:fileId`

```json
{
  "data": {
    "file": {
      "id": "...",
      "filename": "en_us.json",
      "source_lang_code": "en_us",
      "target_lang_codes": ["th_th", "ja_jp"],
      "status": "READY",
      "key_count": 4,
      "error_message": null,
      "processed_at": "2026-07-25T19:00:05.000Z"
    }
  }
}
```

`status` is `PENDING`, `PROCESSING`, `READY` or `FAILED`.

### `POST /files/:fileId/languages`

Adds target languages to a file that already exists.

```json
{ "target_langs": ["ja_jp", "ko_kr"] }
```

Returns **202** with the languages actually added. The existing keys are
translated into the new locales only: a locale already present is never
retranslated, so nothing already reviewed is disturbed and the run costs quota
for the new languages alone. **400** when every language listed is already on
the file, or the file has no keys yet. Inside an organization this requires
`ADMIN`.

### `POST /files/:fileId/keys`

Merges a dropped locale document into a file, adding only keys it does not
already have. Multipart, one `file` part, the same limits as an upload.

```json
{ "data": { "file": { "...": "..." }, "existing_key_count": 128 } }
```

Returns **202**. A key the file already holds is skipped entirely: its master
text, its translations and any manual correction all survive, even when the
dropped document carries a different value for it. Only new keys reach a
provider, so merging a large document that contains two new strings costs two
strings. New keys are translated into every locale the file already carries.
Inside an organization this requires `ADMIN`.

Editing an existing string is the editor's job, not an upload's, which is why a
repeated key is skipped rather than overwritten.

### `POST /files/:fileId/reprocess`

Re runs the pipeline from the stored master text. Returns **202**.

### `DELETE /files/:fileId`

Returns **204**.

---

## Translations

### `GET /files/:fileId/translations`

Editor payload.

```json
{
  "data": {
    "file": { "id": "...", "filename": "en_us.json" },
    "master_lang_code": "en_us",
    "available_locales": ["en_us", "th_th", "ja_jp"],
    "stale_translations": [
      {
        "key_name": "greeting.hello",
        "lang_code": "th_th",
        "translated_with_hash": "old_hash_value",
        "current_hash": "new_hash_value"
      }
    ],
    "keys": [
      {
        "id": "...",
        "key_name": "greeting.hello",
        "original_text": "Hello {name}",
        "source_text": null,
        "text_hash": "123e4567-e89b-12d3-a456-426614174000",
        "translations": [
          {
            "id": "...",
            "lang_code": "th_th",
            "translated_text": "สวัสดี {name}",
            "source_hash": "123e4567-e89b-12d3-a456-426614174000",
            "is_manual": false
          }
        ]
      }
    ]
  }
}
```

`stale_translations` lists rows whose `source_hash` no longer matches the key's
current `text_hash`, meaning the English source changed after translation.

### `PATCH /files/:fileId/translations/:translationId`

```json
{ "translated_text": "สวัสดี {name}" }
```

Marks the row `is_manual`, so a later pipeline run leaves it alone.

### `PATCH /files/:fileId/keys/:keyId`

Updates **one** master string. The key is named in the path, so a reviewer
correcting a single string restamps a single fingerprint; there is no endpoint
that takes the file's whole key set and writes it back.

```json
{ "original_text": "Hello there, {name}!" }
```

```json
{
  "data": {
    "key": { "id": "...", "text_hash": "new_hash_value" },
    "changed": true,
    "stale_lang_codes": ["th_th", "ja_jp"]
  }
}
```

Editing the master restamps its fingerprint, which is exactly how every derived
translation becomes visibly stale.

`changed` is `false` when the submitted text equals the stored text, and nothing
is written in that case. `stale_lang_codes` describes the key's current state
rather than this one request: it lists every language now behind the master,
including any left behind by an earlier edit. A client can use the pair to
enable an update control only when the `en_us` text really moved.

### `POST /files/:fileId/keys/retranslate`

Refreshes the keys named and nothing else.

```json
{ "key_ids": ["key_one", "key_two"], "target_langs": ["th_th"] }
```

Returns **202** with the keys queued and the languages they will be produced in.
Poll `GET /files/:fileId` until `status` is `READY` or `FAILED`.

```json
{
  "data": {
    "file": { "...": "..." },
    "keys": [{ "id": "...", "key_name": "greeting.hello" }],
    "target_langs": ["th_th"]
  }
}
```

`POST /files/:fileId/reprocess` re runs the whole file, which is the wrong price
for one corrected string: on a file of a few thousand keys it spends thousands
of strings of quota to refresh one. Here only the named keys are sent to a
provider, and no other key is rewritten.

`target_langs` is optional and defaults to every target language on the file.
Naming a language the file does not carry is **400**; an identifier belonging to
another file is **404**. At most 200 keys per request, and the upload rate limit
applies, since each key costs quota in every language.

A manual correction still outranks a machine rerun: a translation flagged
`is_manual` is left alone unless the master text itself changed, in which case
the correction was already stale.

### `GET /files/:fileId/consistency`

Validates that every language still matches the English master structurally.
This is the on demand check: it never runs as a side effect of an edit, because
it reads every key and every translation of the file and compares the
interpolation tokens of each pair.

| Query | Required | Notes |
|---|---|---|
| `lang` | no | Check one locale instead of all of them. |

```json
{
  "data": {
    "file_id": "...",
    "master_lang_code": "en_us",
    "checked_lang_codes": ["th_th", "ja_jp"],
    "checked_key_count": 120,
    "consistent": false,
    "issue_count": 2,
    "truncated": false,
    "issues": [
      {
        "key_id": "...",
        "key_name": "greeting.hello",
        "lang_code": "th_th",
        "kind": "PLACEHOLDER_MISSING",
        "detail": "The master carries {name} and the translation does not.",
        "token": "{name}",
        "expected_count": 1,
        "found_count": 0
      }
    ]
  }
}
```

| `kind` | Meaning |
|---|---|
| `MISSING_TRANSLATION` | The language has no row for this key. |
| `EMPTY_TRANSLATION` | A row exists but holds no text, while the master does. |
| `STALE_TRANSLATION` | The master changed after the translation was written. |
| `PLACEHOLDER_MISSING` | A token the master carries is absent, or appears fewer times. |
| `PLACEHOLDER_UNEXPECTED` | A token the master does not carry, or appears more times. |

Recognised tokens are `{name}`, `{{count}}`, ICU messages such as
`{count, plural, other {#}}`, markup and component tags (`<b>`, `<br/>`, `<0>`),
printf conversions (`%s`, `%1$s`, `%.2f`), named printf (`%(name)s`) and colon
prefixed names (`:page_id`). Comparison is on the exact token and on how often
it occurs, so `<b>` and `<i>` are not interchangeable and losing one of two
`{name}` occurrences is reported.

`lang` may name a language the file was asked to produce but has not produced
yet; every key comes back as `MISSING_TRANSLATION`. A language the file does not
carry at all is **400**. `issue_count` is always exact; `issues` stops at 500
entries and sets `truncated`.

### `GET /files/:fileId/export_formats`

The formats this file can be downloaded in, taken from the namespace that owns
its project. Identical to
`GET /namespaces/:namespace/export_formats`, offered here so the download screen
does not have to resolve the namespace first.

### `GET /files/:fileId/download`

| Query | Result |
|---|---|
| none | Every locale in one JSON envelope, for the editor. |
| `lang=th_th` | That locale as a JSON attachment. |
| `format=zip` | Every locale in one archive, always named `langs.zip`. |
| `export_format=key_value` | Written in that format. Defaults to `default`. |

`format` and `export_format` answer different questions. `format` is how the
download is packaged; `export_format` is the shape of the documents inside it.
Either can change without the other, and `export_format` applies to all three
packagings.

`format=zip` returns `application/zip` with one entry per locale, named exactly
as the single locale download names it, so unpacking the archive and downloading
each language by hand produce identical trees. The archive is named `langs.zip`
whichever format its documents are written in. Any other `format` is **422**.

`export_format` must name a format the owning namespace offers, otherwise
**404**; a malformed identifier is **422**. With `export_format=key_value`, the
same locale comes back ready to use as it is:

```json
{ "greeting": { "hello": "สวัสดี {name}" } }
```

Without `?lang=`, returns every locale in one envelope:

```json
{
  "data": {
    "files": {
      "en_us.json": { "greeting": { "hello": { "value": "Hello {name}", "hash": "..." } } },
      "th_th.json": { "greeting": { "hello": { "value": "สวัสดี {name}", "hash": "..." } } }
    }
  }
}
```

With `?lang=th_th`, returns that single document as a file attachment:

```json
{
  "greeting": {
    "hello": {
      "value": "สวัสดี {name}",
      "hash": "123e4567-e89b-12d3-a456-426614174000"
    }
  }
}
```

Nesting is preserved: a key stored as `greeting.hello` is emitted nested, exactly
as it was uploaded.
