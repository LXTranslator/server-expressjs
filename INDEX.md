# Repository Index

This file is the entry point for understanding the project structure. Agents MUST read it first, and keep it updated whenever the structure or indexed content of this repository changes. It reflects only the files and directories that exist in this repository.

## Root Files

| Directory / File | Purpose |
|---|---|
| [`./`](./) | Repository root directory. |
| [`INDEX.md`](INDEX.md) | This project structure index. |
| [`README.md`](README.md) | Human facing project overview. |
| [`LICENSE`](LICENSE) | Proprietary license reserved for the LXTranslator organization. |
| [`package.json`](package.json) | Dependency, script and version configuration. |
| [`package-lock.json`](package-lock.json) | Pinned dependency tree for reproducible installs. |
| [`jest.config.js`](jest.config.js) | Test runner configuration. |
| [`Dockerfile`](Dockerfile) | Multi stage production image definition. |
| [`.dockerignore`](.dockerignore) | Paths excluded from the Docker build context. |
| [`.gitignore`](.gitignore) | Git ignore configuration. |
| [`.gitattributes`](.gitattributes) | Git attributes configuration. |

## Source Modules / Architecture

A layered monolith. Requests enter through `routes`, pass through `middleware`,
and are handled by feature modules under `modules`. Every module delegates to a
service that owns the rules; services use `infrastructure` for the database,
cryptography, email and AI providers. CPU and network heavy work is handed to
`workers`. Nothing in `core` or `infrastructure` depends on Express, which keeps
those layers unit testable in isolation.

### Entry Point

Process bootstrap and the Express application factory.

| Directory / File | Purpose |
|---|---|
| [`src/`](src/) | Root source directory. |
| [`src/index.js`](src/index.js) | Process entry point, boot sequence and graceful shutdown. |
| [`src/app.js`](src/app.js) | Express application factory with security middleware. |

### Configuration

Resolves every setting, driven by the single `PROD` switch.

| Directory / File | Purpose |
|---|---|
| [`src/config/`](src/config/) | Configuration layer. |
| [`src/config/index.js`](src/config/index.js) | Assembled configuration object and production guards. |
| [`src/config/env.js`](src/config/env.js) | Typed environment variable readers. |
| [`src/config/defaults.js`](src/config/defaults.js) | Built in development defaults, refused in production. |

### Core

Framework free primitives shared by every layer.

| Directory / File | Purpose |
|---|---|
| [`src/core/`](src/core/) | Core utilities. |
| [`src/core/errors.js`](src/core/errors.js) | Application error taxonomy. |
| [`src/core/logger.js`](src/core/logger.js) | Structured JSON logger with sensitive field redaction. |
| [`src/core/asyncHandler.js`](src/core/asyncHandler.js) | Async route wrapper forwarding rejections to Express. |
| [`src/core/textHash.js`](src/core/textHash.js) | Deterministic 36 character source fingerprint. |
| [`src/core/reservedIdentifiers.js`](src/core/reservedIdentifiers.js) | Namespace identifiers the client routes to itself. |
| [`src/core/zip.js`](src/core/zip.js) | Minimal in memory ZIP writer for the archive download. |
| [`src/core/jsonTree.js`](src/core/jsonTree.js) | JSON flattening and expansion with prototype pollution guards. |
| [`src/core/filename.js`](src/core/filename.js) | Upload filename sanitisation and path containment. |
| [`src/core/placeholders.js`](src/core/placeholders.js) | Interpolation token extraction and comparison. |

### Infrastructure

Adapters for everything outside the process.

| Directory / File | Purpose |
|---|---|
| [`src/infrastructure/`](src/infrastructure/) | External adapters. |
| [`src/infrastructure/database/sequelize.js`](src/infrastructure/database/sequelize.js) | Connection factory selecting PostgreSQL or SQLite. |
| [`src/infrastructure/database/models/index.js`](src/infrastructure/database/models/index.js) | Model registry and associations. |
| [`src/infrastructure/database/models/account.js`](src/infrastructure/database/models/account.js) | Namespace accounts for people and organizations. |
| [`src/infrastructure/database/models/orgMember.js`](src/infrastructure/database/models/orgMember.js) | Organization membership and roles. |
| [`src/infrastructure/database/models/project.js`](src/infrastructure/database/models/project.js) | Projects owned by a namespace. |
| [`src/infrastructure/database/models/projectApiKey.js`](src/infrastructure/database/models/projectApiKey.js) | Encrypted provider credentials with priority order. |
| [`src/infrastructure/database/models/file.js`](src/infrastructure/database/models/file.js) | Uploaded translation files and processing status. |
| [`src/infrastructure/database/models/translationKey.js`](src/infrastructure/database/models/translationKey.js) | Master strings and their fingerprints. |
| [`src/infrastructure/database/models/translation.js`](src/infrastructure/database/models/translation.js) | Per language translated strings. |
| [`src/infrastructure/database/models/authToken.js`](src/infrastructure/database/models/authToken.js) | Single use short lived token ledger. |
| [`src/infrastructure/crypto/secretBox.js`](src/infrastructure/crypto/secretBox.js) | AES 256 GCM encryption for stored credentials. |
| [`src/infrastructure/email/mailer.js`](src/infrastructure/email/mailer.js) | Console and SMTP mail transports. |
| [`src/infrastructure/ai/providerError.js`](src/infrastructure/ai/providerError.js) | Provider failure categories driving the fallback chain. |
| [`src/infrastructure/ai/prompt.js`](src/infrastructure/ai/prompt.js) | Prompt construction and reply validation. |
| [`src/infrastructure/ai/keyFallback.js`](src/infrastructure/ai/keyFallback.js) | Credential fallback executor. |
| [`src/infrastructure/ai/providers/index.js`](src/infrastructure/ai/providers/index.js) | Fixed provider registry. |
| [`src/infrastructure/ai/providers/mock.js`](src/infrastructure/ai/providers/mock.js) | Offline provider for zero configuration runs. |
| [`src/infrastructure/ai/providers/openai.js`](src/infrastructure/ai/providers/openai.js) | OpenAI chat completions adapter. |
| [`src/infrastructure/ai/providers/anthropic.js`](src/infrastructure/ai/providers/anthropic.js) | Anthropic messages adapter. |
| [`src/infrastructure/ai/providers/openrouter.js`](src/infrastructure/ai/providers/openrouter.js) | OpenRouter broker adapter reaching several vendors on one credential. |

### Middleware

Cross cutting request concerns.

| Directory / File | Purpose |
|---|---|
| [`src/middleware/`](src/middleware/) | Express middleware. |
| [`src/middleware/authenticate.js`](src/middleware/authenticate.js) | Bearer token verification and account loading. |
| [`src/middleware/validate.js`](src/middleware/validate.js) | Schema validation that replaces the request payload. |
| [`src/middleware/rateLimit.js`](src/middleware/rateLimit.js) | Tiered rate limiters. |
| [`src/middleware/upload.js`](src/middleware/upload.js) | Multipart upload with layered security checks. |
| [`src/middleware/errorHandler.js`](src/middleware/errorHandler.js) | Terminal error handler that hides internal detail. |
| [`src/middleware/notFound.js`](src/middleware/notFound.js) | Structured 404 for unmatched routes. |

### Feature Modules

One directory per business capability.

| Directory / File | Purpose |
|---|---|
| [`src/modules/`](src/modules/) | Feature modules. |
| [`src/modules/auth/auth.routes.js`](src/modules/auth/auth.routes.js) | Authentication route definitions. |
| [`src/modules/auth/auth.controller.js`](src/modules/auth/auth.controller.js) | Authentication HTTP handlers. |
| [`src/modules/auth/auth.service.js`](src/modules/auth/auth.service.js) | Registration, login, lockout and password reset. |
| [`src/modules/auth/auth.schemas.js`](src/modules/auth/auth.schemas.js) | Authentication request schemas. |
| [`src/modules/auth/token.service.js`](src/modules/auth/token.service.js) | Session and single use token issuing and redemption. |
| [`src/modules/accounts/account.routes.js`](src/modules/accounts/account.routes.js) | Account settings routes. |
| [`src/modules/accounts/account.service.js`](src/modules/accounts/account.service.js) | Confirmed user id, email and password changes. |
| [`src/modules/accounts/account.schemas.js`](src/modules/accounts/account.schemas.js) | Account settings request schemas. |
| [`src/modules/namespaces/namespace.routes.js`](src/modules/namespaces/namespace.routes.js) | Namespace, organization and project listing routes. |
| [`src/modules/namespaces/namespace.service.js`](src/modules/namespaces/namespace.service.js) | Namespace, project and file access resolution. |
| [`src/modules/orgs/org.service.js`](src/modules/orgs/org.service.js) | Organization creation, profile and membership. |
| [`src/modules/orgs/org.schemas.js`](src/modules/orgs/org.schemas.js) | Organization request schemas. |
| [`src/modules/projects/project.routes.js`](src/modules/projects/project.routes.js) | Project, credential and upload routes. |
| [`src/modules/projects/project.service.js`](src/modules/projects/project.service.js) | Project settings and credential management. |
| [`src/modules/projects/project.schemas.js`](src/modules/projects/project.schemas.js) | Project request schemas. |
| [`src/modules/files/file.routes.js`](src/modules/files/file.routes.js) | File status, editor and download routes. |
| [`src/modules/files/file.service.js`](src/modules/files/file.service.js) | Upload verification, storage and pipeline orchestration. |
| [`src/modules/files/file.schemas.js`](src/modules/files/file.schemas.js) | Upload and export request schemas. |
| [`src/modules/translations/translation.service.js`](src/modules/translations/translation.service.js) | Editor data, manual edits and export. |
| [`src/modules/translations/translationExport.js`](src/modules/translations/translationExport.js) | Value and hash export format builder. |
| [`src/modules/translations/translationConsistency.js`](src/modules/translations/translationConsistency.js) | On demand master to translation consistency report. |
| [`src/modules/translations/translation.schemas.js`](src/modules/translations/translation.schemas.js) | Translation edit request schemas. |

### Routing

| Directory / File | Purpose |
|---|---|
| [`src/routes/`](src/routes/) | API composition. |
| [`src/routes/index.js`](src/routes/index.js) | Version one router mounting every module. |

### Workers

Off thread execution of the translation pipeline.

| Directory / File | Purpose |
|---|---|
| [`src/workers/`](src/workers/) | Worker thread layer. |
| [`src/workers/pool.js`](src/workers/pool.js) | Bounded worker pool with queueing and timeouts. |
| [`src/workers/translation.worker.js`](src/workers/translation.worker.js) | Worker thread entry point. |
| [`src/workers/pipeline.js`](src/workers/pipeline.js) | Parse, hash, normalise and translate pipeline. |

## Tests

| Directory / File | Purpose |
|---|---|
| [`tests/`](tests/) | Automated test suite. |
| [`tests/setupEnv.js`](tests/setupEnv.js) | Test environment pinning applied before module load. |
| [`tests/helpers/testApp.js`](tests/helpers/testApp.js) | Shared harness building the real app on an in memory database. |
| [`tests/auth.test.js`](tests/auth.test.js) | Registration, login, lockout and password reset tests. |
| [`tests/pipeline.test.js`](tests/pipeline.test.js) | Upload, translation, export and staleness tests. |
| [`tests/access.test.js`](tests/access.test.js) | Object level authorization and role tests. |
| [`tests/organization.test.js`](tests/organization.test.js) | Organization creation, availability and deletion tests. |
| [`tests/project.test.js`](tests/project.test.js) | Project name scoping, identifier sequencing and malformed identifier tests. |
| [`tests/fileGrowth.test.js`](tests/fileGrowth.test.js) | Adding languages and merging new keys into an existing file. |
| [`tests/locale.test.js`](tests/locale.test.js) | Locale code acceptance across the whole supported catalogue. |
| [`tests/archive.test.js`](tests/archive.test.js) | ZIP writer round trips, entry name safety and the archive download. |
| [`tests/consistency.test.js`](tests/consistency.test.js) | Placeholder extraction, single key updates, partial retranslation and the consistency check. |
| [`tests/provider.test.js`](tests/provider.test.js) | OpenRouter adapter, registry and model allowlist tests. |
| [`tests/security.test.js`](tests/security.test.js) | Sanitisation, encryption, fallback and upload hardening tests. |

## Agent Configuration

| Directory / File | Purpose |
|---|---|
| [`.agents/`](.agents/) | Agent configuration for this repository only. |
| [`.agents/knowledge/`](.agents/knowledge/) | Domain context for this codebase. |
| [`AGENTS.md`](AGENTS.md) | Agent instructions for this repository. |
| [`.agents/knowledge/domain.md`](.agents/knowledge/domain.md) | Translation domain concepts and invariants. |
| [`.agents/security/`](.agents/security/) | Security policies applying to this repository. |
| [`.agents/security/secrets-management.md`](.agents/security/secrets-management.md) | Credential handling rules. |
| [`.agents/security/cryptographic-failures.md`](.agents/security/cryptographic-failures.md) | Encryption and hashing rules. |
| [`.agents/security/injection.md`](.agents/security/injection.md) | Query and command injection prevention. |
| [`.agents/security/authentication-failures.md`](.agents/security/authentication-failures.md) | Session and credential handling rules. |
| [`.agents/security/broken-access-control.md`](.agents/security/broken-access-control.md) | Authorization enforcement rules. |
| [`.agents/security/secure-file-upload.md`](.agents/security/secure-file-upload.md) | Upload validation rules. |
| [`.agents/security/path-traversal.md`](.agents/security/path-traversal.md) | Filesystem path handling rules. |
| [`.agents/security/bola.md`](.agents/security/bola.md) | Object level authorization rules. |
| [`.agents/security/bopla.md`](.agents/security/bopla.md) | Property level authorization and mass assignment rules. |
| [`.agents/security/unrestricted-resource-consumption.md`](.agents/security/unrestricted-resource-consumption.md) | Rate limiting and payload ceiling rules. |
| [`.agents/security/ssrf.md`](.agents/security/ssrf.md) | Outbound request restriction rules. |
| [`.agents/security/exceptional-conditions.md`](.agents/security/exceptional-conditions.md) | Error handling and disclosure rules. |
| [`.agents/security/logging-and-alerting.md`](.agents/security/logging-and-alerting.md) | Logging and redaction rules. |
| [`.agents/security/supply-chain.md`](.agents/security/supply-chain.md) | Dependency management rules. |
| [`.agents/security/security-misconfiguration.md`](.agents/security/security-misconfiguration.md) | Deployment hardening rules. |
| [`.agents/security/prompt-injection.md`](.agents/security/prompt-injection.md) | Untrusted content handling for AI calls. |
| [`.agents/security/sensitive-information-disclosure.md`](.agents/security/sensitive-information-disclosure.md) | Data sent to and returned from AI providers. |
| [`.agents/security/excessive-agency.md`](.agents/security/excessive-agency.md) | Limits on autonomous AI actions. |

## Documentation

| Directory / File | Purpose |
|---|---|
| [`wiki/`](wiki/) | Human facing documentation root directory. |
| [`wiki/api.md`](wiki/api.md) | API specifications and endpoints. |
| [`wiki/environment.md`](wiki/environment.md) | Environment configuration, variables and infrastructure examples. |
| [`wiki/requirements.md`](wiki/requirements.md) | Project requirements. |
| [`wiki/system.md`](wiki/system.md) | System architecture documentation. |
