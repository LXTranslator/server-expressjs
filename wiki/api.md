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
      }
    ],
    "default_provider": "mock",
    "default_model": "mock-small"
  }
}
```

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
{ "display_name": "Acme Corporation", "description": "...", "website_url": "https://acme.com" }
```

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

### `DELETE /projects/:projectId`

Returns **204**. Cascades to files, keys and translations.

---

## Project API keys

All routes require authentication and, inside an organization, `ADMIN` or above.

**No endpoint returns a stored key.** Responses identify a credential by label
and its last four characters.

### `GET /projects/:projectId/keys`

```json
{
  "data": {
    "keys": [
      {
        "id": "...",
        "label": "primary",
        "masked_key": "****7890",
        "priority_order": 1,
        "is_active": true,
        "last_used_at": "2026-07-25T19:00:00.000Z",
        "last_error_at": null,
        "last_error_reason": null
      }
    ]
  }
}
```

### `POST /projects/:projectId/keys`

```json
{
  "api_key": "your_provider_api_key",
  "label": "primary",
  "priority_order": 1,
  "is_active": true
}
```

Returns **201**. `priority_order` defaults to the end of the chain, so a new key
never silently displaces the one in use.

### `PATCH /projects/:projectId/keys/:keyId`

Any of `api_key`, `label`, `priority_order`, `is_active`.

### `POST /projects/:projectId/keys/reorder`

```json
{ "ordered_key_ids": ["id_three", "id_one", "id_two"] }
```

Must list every key on the project exactly once. This is the order the fallback
chain will walk.

### `DELETE /projects/:projectId/keys/:keyId`

Returns **204**.

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

```json
{ "original_text": "Hello there, {name}!" }
```

Editing the master restamps its fingerprint, which is exactly how every derived
translation becomes visibly stale.

### `GET /files/:fileId/download`

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
