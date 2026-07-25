---
name: Security Logging and Alerting
description: Log security relevant events with sensitive values redacted in the LXTranslator server.
---

# Security Logging and Alerting

## What is logged

| Event | Level | Location |
|---|---|---|
| Account registered | info | `auth.service.js` |
| Login succeeded | info | `auth.service.js` |
| Login failed, with attempt count | warn | `auth.service.js` |
| Account locked | warn | `auth.service.js` |
| Password reset requested and completed | info | `auth.service.js` |
| Settings token denied | warn | `account.service.js` |
| Organization membership changes | info | `org.service.js` |
| Credential added, updated, removed, reordered | info | `project.service.js` |
| Credential failed to decrypt | error | `project.service.js` |
| File uploaded, processed, failed | info / error | `file.service.js` |
| Worker crashed | error | `pool.js` |
| Expected request failure | warn | `errorHandler.js` |
| Unhandled error, with stack | error | `errorHandler.js` |

## Rules

1. **Redaction happens at the sink, not the call site.**
   `src/core/logger.js` walks every logged object and replaces any field whose
   name resembles a password, token, key, secret, credential or authorization
   header. Redacting centrally means a new call site cannot forget.
2. **Never log a request body wholesale.** Log the specific fields that matter.
3. **Never log an API key, a JWT, or a reset link.** The console mail transport
   logs a reset link at `debug` only, so it never reaches a shipped log at the
   default level.
4. **Log identifiers, not contents.** An account id is useful; an email address
   in every line is unnecessary exposure.
5. **Logs are structured JSON on one line**, with a `requestId` that ties every
   line for a request together.
6. **Errors go to stderr, everything else to stdout**, so a container runtime
   can separate them.

## Alerting

The application emits the signal; the deployment decides what to do with it.
Recommended alerts:

- A spike in `Account locked` — credential stuffing in progress.
- Any `A stored API key could not be decrypted` — likely a botched passphrase
  rotation.
- A sustained rate of `Unhandled error` — a regression in production.
- `Translation worker crashed` recurring — a defect in the pipeline.

## When adding a log line

Include enough context to investigate without including anything that would
itself be a finding if the log leaked.
