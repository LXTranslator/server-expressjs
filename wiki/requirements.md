# Requirements

## Scope

The backend for LXTranslator. It manages accounts and organizations, projects
and their AI provider credentials, uploaded locale files, and the translations
derived from them. The React client in `client-reactjs` is the only intended
consumer.

## Functional requirements

### Accounts and namespaces

| Id | Requirement | Status |
|---|---|---|
| FR-1 | There is no `users` table. An account is a namespace and is either `USER` or `ORG`. | Done |
| FR-2 | Register with `user_id`, `email`, `password` and a confirmation. | Done |
| FR-3 | `user_id` is lowercase letters, digits and underscores, 3 to 32 characters, unique. | Done |
| FR-4 | Email addresses are unique and format checked. | Done |
| FR-5 | Passwords require 10 characters with lower case, upper case and a digit. | Done |
| FR-6 | Registration can be pre checked for availability of a user id or email. | Done |
| FR-7 | Log in with either the user id or the email address. | Done |
| FR-8 | Sessions use JWT bearer tokens. | Done |
| FR-9 | Forgot password issues a token that expires in exactly 10 minutes. | Done |
| FR-10 | A reset token becomes invalid immediately on first use. | Done |
| FR-11 | Settings changes require a separate 10 minute single use token. | Done |
| FR-12 | Users may change their `user_id`, email address and password. | Done |

### Organizations

| Id | Requirement | Status |
|---|---|---|
| FR-13 | A personal account may create organization namespaces. | Done |
| FR-14 | The creator becomes `OWNER`. | Done |
| FR-15 | Membership is held in `org_members` with roles `OWNER`, `ADMIN`, `MEMBER`. | Done |
| FR-16 | Members can be invited by user id or email, have their role changed, and be removed. | Done |
| FR-17 | Nobody may grant a role above their own. | Done |
| FR-18 | An organization always keeps at least one owner. | Done |
| FR-19 | Organization profile details are editable by `ADMIN` and above. | Done |
| FR-19a | An organization holds its own contact email, separate from any member personal address, for billing and account notices. | Done |
| FR-19b | An organization can be permanently deleted by an owner, confirming by retyping its identifier. | Done |

### Projects and credentials

| Id | Requirement | Status |
|---|---|---|
| FR-20 | Projects belong to a namespace and are unique by name within it. | Done |
| FR-21 | A project selects an AI provider and model. | Done |
| FR-22 | An account may hold several API keys, across several platforms, with an explicit priority order. A project holds none and borrows from the account that owns it. | Done |
| FR-23 | Keys are encrypted before storage and never returned to a client. | Done |
| FR-24 | Keys can be added, edited, deactivated, reordered and removed. | Done |
| FR-25 | When a key fails, the next by priority is tried automatically. | Done |

### Translation

| Id | Requirement | Status |
|---|---|---|
| FR-26 | Upload accepts `.json` files only. | Done |
| FR-27 | `en_us.json` is always the master file. | Done |
| FR-28 | A non English upload is translated into `en_us` first. | Done |
| FR-29 | Target languages are chosen per upload. | Done |
| FR-30 | Parsing, hashing and provider calls run on worker threads. | Done |
| FR-31 | Every master string carries a 36 character fingerprint. | Done |
| FR-32 | Exported files carry `value` and `hash` per key. | Done |
| FR-33 | Nested keys are preserved through the round trip. | Done |
| FR-34 | Translations can be corrected by hand and are then protected from reruns. | Done |
| FR-35 | Editing a master string marks its translations stale. | Done |
| FR-36 | Locale files can be downloaded individually or together. | Done |
| FR-37 | A conversation with the assistant is a named record that can be listed, renamed and deleted, and belongs to one namespace and one person. | Done |

## Non functional requirements

### Security

| Id | Requirement | Status |
|---|---|---|
| NFR-1 | Passwords stored as bcrypt digests. | Done |
| NFR-2 | Provider keys encrypted with AES 256 GCM. | Done |
| NFR-3 | Uploads validated by extension, media type, size and sanitised filename. | Done |
| NFR-4 | Path traversal prevented; stored paths proven to sit inside the storage root. | Done |
| NFR-5 | Every object access resolved through its owning namespace. | Done |
| NFR-6 | Payloads validated against strict schemas that drop unknown fields. | Done |
| NFR-7 | Rate limiting tiered by endpoint sensitivity. | Done |
| NFR-8 | Repeated login failures lock the account temporarily. | Done |
| NFR-8a | A session is revocable, and an account may hold many at once. | Done |
| NFR-8b | The API is usable from a machine through a revocable token, without a password. | Done |
| NFR-9 | Security headers set, including a restrictive content security policy. | Done |
| NFR-10 | Cross origin access restricted to an explicit allowlist. | Done |
| NFR-11 | Errors return generic messages; detail is logged server side only. | Done |
| NFR-12 | Credentials and tokens redacted from logs. | Done |
| NFR-13 | Outbound AI requests limited to a fixed provider registry. | Done |
| NFR-14 | Untrusted content kept separate from system instructions in prompts. | Done |
| NFR-15 | Dependencies audit clean at high severity. | Done |

### Reliability and operations

| Id | Requirement | Status |
|---|---|---|
| NFR-16 | The server runs with no configuration for development and testing. | Done |
| NFR-17 | `PROD=true` selects PostgreSQL and refuses built in secrets. | Done |
| NFR-18 | Uploads respond immediately; progress is polled. | Done |
| NFR-19 | A crashed worker is replaced and its task failed cleanly. | Done |
| NFR-20 | Worker jobs and provider requests both have timeouts. | Done |
| NFR-21 | Shutdown drains in flight work. | Done |
| NFR-22 | A health endpoint is available for probes. | Done |
| NFR-23 | Logs are structured JSON with a request correlation id. | Done |
| NFR-24 | Deleting a namespace cascades to all dependent data. | Done |

### Quality

| Id | Requirement | Status |
|---|---|---|
| NFR-25 | Automated tests cover auth, pipeline, access control and security primitives. | Done, 82 tests |
| NFR-26 | The suite runs with no configuration. | Done |
| NFR-27 | Code is separated into focused modules with a single responsibility each. | Done |
| NFR-28 | Node.js 20 or newer. | Done |

## Out of scope

* Billing and subscriptions.
* Translation memory and glossary management.
* Real time collaborative editing.
* Formats other than JSON.
* Single sign on.
* Multi factor authentication. Account lockout and single use action tokens are
  in place; a second factor is the natural next hardening step for a financial
  deployment.

## Assumptions

* The client is a browser application holding its token in memory or session
  storage. No cookie is issued, so no CSRF token is required.
* Provider credentials belong to the customer and are entered per account rather
  than configured globally. They sit on the account because a credential is a
  billing relationship; a project names only a platform and a model.
* One PostgreSQL instance is sufficient at the intended scale; the application
  is stateless and scales horizontally.
