---
name: memory-task-auth-security-refinement
description: Task record for adding alternative sign in, a second factor, account linking, policy pages and upload hardening across both LXTranslator repositories.
---

# Task Record — auth-security-refinement

Confirmed with the user before any of it was built. Twelve tasks across two
repositories, two reserved slots per repository, the work between them.

## Why

Both repositories recorded single sign on and multi factor authentication as
deliberately deferred: `wiki/information/requirements.md` listed them under **Out of
scope**, and `.agents/security/authentication-failures.md` carried a **Not yet
implemented** section saying the same. This work moves both lines into the product.

It also closes a verified defect in the upload path. `persistRawUpload` was called with
`project.id`, a `DataTypes.INTEGER`, so `path.resolve(root, 7)` threw a `TypeError` that
the surrounding catch swallowed. Tests run at `LOG_LEVEL=silent` and nothing asserted a
file reached disk, so the only filesystem write in the application had never executed,
and the containment guard `.agents/security/path-traversal.md` calls one of two mandatory
defences was dead code on the only path using it.

## Decisions taken with the user

| Decision | Reason |
|---|---|
| OAuth is link only | An unknown provider identity never creates an account and never auto links by email. Every account keeps a password, so unlinking can never lock anybody out. |
| TOTP plus ten recovery codes | A lost authenticator needs a path back that is not editing the database by hand. |
| TOTP and the QR encoder written here | `supply-chain.md` prefers a standard library equivalent; `src/core/zip.js` is the precedent. No new dependency in either repository. |
| `AUTHENTICATION_NAME` | The user wrote `AUTHENCATION_NAME`; the spelling was corrected with their agreement. Defaults to `LXTranslator`. |
| Hyphenated public paths | A namespace owns the first path segment, so `/policy` would need reserving in both repositories and would orphan an account of that name. `/privacy-policy` cannot collide, because an identifier may not contain a hyphen. |
| Every new piece of state is a new table | `sequelize.sync()` in production creates missing tables and nothing else. It adds no column to an existing table and no value to an existing Postgres ENUM type, so neither a column on `accounts` nor a new `auth_tokens.purpose` would exist on a real deployment. |
| Branch convention over the harness branch | The harness mandated `claude/auth-security-refinement-txkz8q`; `branching-strategy.md` forbids a tool preset prefix and a generated suffix. The user chose the convention, which is the permission the harness required. |

## The tasks

| # | Title | Scope | Repository | Branch | PR |
|---|---|---|---|---|---|
| 1 | Task record | This file and its index row | server | `chore/auth-security-refinement-plan` | |
| 2 | Single sign-in gate | Extract the one function both sign in paths pass through | server | `refactor/sign-in-gate` | |
| 3 | Second factor | TOTP core, enrolment, login challenge, recovery codes | server | `feat/second-factor` | |
| 4 | OAuth identity | Provider registry, link and sign in flows | server | `feat/oauth-identity` | |
| 5 | Upload containment | The verified defect, orphan cleanup, double extensions, multer limits | server | `fix/upload-containment` | |
| 6 | Release 0.25.0 | Version, changelog, indexes, close this record | server | `chore/release` | |
| 7 | Task record | The same record, for the client | client | `chore/auth-security-refinement-plan` | |
| 8 | Policy pages | Two public pages and a footer column | client | `feat/policy-page` | |
| 9 | Upload validation | Close the double extension gap client side | client | `fix/upload-validation` | |
| 10 | Second factor | Challenge step at login, enrolment page, QR encoder | client | `feat/second-factor` | |
| 11 | Account linking | Provider buttons, callback page, connections page | client | `feat/account-linking` | |
| 12 | Release 0.17.0 | Version, changelog, indexes, close the record | client | `chore/release` | |

Task 1 branches from `master`; task `k` branches from task `k-1`. Tasks 7 to 12 are a
second chain in the client repository, ordered after this one rather than stacked on it,
because branches cannot stack across repositories.

Task 2 is separate on purpose. Both authentication features must issue their session
through one gate. If the OAuth callback calls `issueAccessToken` directly then the second
factor is silently bypassable by anyone holding a linked provider account, and a small
pure refactor is the only diff in which a reviewer will actually see that gate.

## Progress

### Task 1 — chore/auth-security-refinement-plan

Created this record and its row in `.agents/index/memory-index.md`. Nothing else was
written: the plan is stated before the work exists so a reviewer can check the work
against the plan rather than infer the plan from a diff.

Task 2 depends on nothing here beyond the ordering.

### Task 2 — refactor/sign-in-gate

Extracted `assertNotLocked`, `registerFailedAttempt`, `clearFailedAttempts` and
`completeSignIn` from `login()` in `src/modules/auth/auth.service.js`, and exported all
four. No behaviour change: `tests/auth.test.js`, `session`, `security` and `access` pass
untouched, which is what makes this a refactor rather than a rewrite.

The lockout check stays in `login()` *before* the password comparison, so a locked
account is still told it is locked rather than spending an attempt on a correct password.
`completeSignIn` re-checks it, because the provider sign in added in task 4 reaches the
gate without passing through `login()` at all.

`register()` deliberately still calls `issueAccessToken` directly. A brand new account
cannot be locked and cannot hold a second factor, and routing it through the gate would
add a "Login succeeded" log line to a registration.

Tasks 3 and 4 both depend on this: task 3 adds the second factor branch inside
`completeSignIn`, and task 4's provider callback calls it rather than minting its own
session.
