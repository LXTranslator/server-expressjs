---
name: security-index
description: Index of the eighteen server security policies — access control, credentials, input handling, AI provider boundaries and operations.
---

# Security Index — server-expressjs

The security policies that apply to this repository. Parent:
[`agents-index.md`](agents-index.md). Grouped by what the policy protects; every file
lives flat in `.agents/security/`.

Any file added to, removed from, or renamed in `.agents/security/` is reflected in this
index in the same commit.

## Access control

| File | Purpose |
|---|---|
| [`../security/broken-access-control.md`](../security/broken-access-control.md) | Deny by default authorization, enforced through namespace resolution. |
| [`../security/bola.md`](../security/bola.md) | Verify ownership of every referenced record on every API call. |
| [`../security/bopla.md`](../security/bopla.md) | Prevent mass assignment and excessive data exposure. |
| [`../security/authentication-failures.md`](../security/authentication-failures.md) | Session handling, credential storage, lockout and single use token rules. |

## Credentials and cryptography

| File | Purpose |
|---|---|
| [`../security/secrets-management.md`](../security/secrets-management.md) | Keep API keys, passwords and tokens out of source, logs and responses. |
| [`../security/cryptographic-failures.md`](../security/cryptographic-failures.md) | Correct encryption and hashing for stored credentials, passwords and fingerprints. |

## Input handling

| File | Purpose |
|---|---|
| [`../security/injection.md`](../security/injection.md) | Prevent SQL, command and prototype pollution injection. |
| [`../security/path-traversal.md`](../security/path-traversal.md) | Keep every filesystem operation inside the storage root. |
| [`../security/secure-file-upload.md`](../security/secure-file-upload.md) | Layered validation of uploaded translation files. |

## AI provider boundary

| File | Purpose |
|---|---|
| [`../security/prompt-injection.md`](../security/prompt-injection.md) | Treat every translatable string as untrusted data rather than instruction. |
| [`../security/excessive-agency.md`](../security/excessive-agency.md) | Keep every model triggered action behind an authorization check written in backend code. |
| [`../security/sensitive-information-disclosure.md`](../security/sensitive-information-disclosure.md) | Control what leaves the system in provider requests and API responses. |
| [`../security/ssrf.md`](../security/ssrf.md) | Restrict outbound requests to a fixed provider registry. |

## Operations

| File | Purpose |
|---|---|
| [`../security/exceptional-conditions.md`](../security/exceptional-conditions.md) | Handle every error without leaking internal detail to clients. |
| [`../security/logging-and-alerting.md`](../security/logging-and-alerting.md) | Log security relevant events with sensitive values redacted. |
| [`../security/unrestricted-resource-consumption.md`](../security/unrestricted-resource-consumption.md) | Bound every expensive operation so one caller cannot exhaust the server. |
| [`../security/security-misconfiguration.md`](../security/security-misconfiguration.md) | Hardened defaults and deployment configuration rules. |
| [`../security/supply-chain.md`](../security/supply-chain.md) | Dependency selection, pinning and auditing rules. |
