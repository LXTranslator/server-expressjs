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

### Task 3 — feat/second-factor

TOTP on `node:crypto` in `src/core/totp.js`, checked against all six RFC 6238 SHA-1
vectors including the one past 32 bits, which is what catches a counter written as an
`Int32`. Base32 matches the RFC 4648 vector. No dependency added.

Three new tables rather than columns on `accounts`: `account_mfa`,
`account_recovery_codes`, `mfa_challenges`. `sequelize.sync()` in production creates
missing tables and neither adds a column nor extends an ENUM type, so a column would have
worked on every fresh database and in every test and then not existed on a deployment.

Two things were got right only because they were tested for:

* **Replay.** One step of drift keeps a code current for ninety seconds, so acceptance is
  recorded in `account_mfa.last_used_counter` and every acceptance must be strictly
  greater. Written as a conditional UPDATE, not a read and a write, so two requests
  carrying the same code cannot both win. The first test run failed three cases because
  the helper confirmed enrolment with the current code and then tried to sign in with it;
  that was the defence working, and the helper was what changed.
* **Recovery code entropy.** The first generator mapped one random byte to one character
  of a thirty character alphabet. Thirty does not divide 256, so the first sixteen
  characters were measurably likelier, and sixteen characters carried 78 bits rather than
  the 128 the bytes held. Replaced with `crypto.randomInt`, twenty characters, 98 bits.

`completeSignIn` now returns a discriminated result. A correct password with a confirmed
factor yields a challenge and no session, at 200 rather than 401 — a 401 is what a client
treats as "signed out", and it would discard the challenge it was just handed. The
account is absent from that response because `toPublicJson` carries the email address.

The failure counters are deliberately **not** cleared on the challenge branch. Clearing
them would hand somebody holding the password one counter reset per sign in, and with it
unlimited guesses at the second factor.

A password reset leaves the factor in place. Clearing it would make the second factor
exactly as strong as the mailbox it exists to survive.

Also here, because `change-propagation.md` puts them in the same commit: `AUTHENTICATION_NAME`
in `wiki/environments/env.md`, the endpoints in `wiki/reference/api.md`, and the FR and NFR
rows in `wiki/information/requirements.md` with multi factor authentication removed from
Out of scope. Single sign on stays listed there until task 4 removes it.

Server suite: 535 passing, 18 suites, up from 507. No existing test changed.

### Task 4 — feat/oauth-identity

Provider sign in for github.com and gitlab.com, link only. Registry at
`src/infrastructure/oauth/providers/`, mirroring the AI registry: frozen, resolved through
`hasOwnProperty`, every endpoint a constant inside its adapter. Two new tables,
`oauth_states` and `account_identities`.

Their `provider` and `mode` columns are `STRING` with validation rather than `ENUM`, for
the same deployment reason the tables exist at all: `sync()` never alters an existing type,
so an ENUM could never gain a value later. Adding a third provider would work on every
fresh database and fail on the first insert against a real one.

What replaces the cookie, since this API has none:

* A link callback is authenticated, and `oauth_states.account_id` must equal
  `req.account.id`. Without that, an attacker starts a flow with their own provider
  account, walks a signed in victim through the callback, and their identity is bound to
  the victim's account. There is a test that does exactly this.
* A `LINK` state spent on the sign in callback, or the reverse, is refused. Both directions
  are tested.
* The state is consumed **before** the code is exchanged. Consuming afterwards would leave
  it spendable again whenever an exchange failed, which is the code injection PKCE guards.

Two provider details that would otherwise have cost a debugging session: GitHub answers a
failed token exchange with **HTTP 200 and an error body**, so the adapter checks
`payload.error` rather than the status the way the AI adapters do; and GitHub requires a
`User-Agent`. PKCE is on for both — GitHub added S256 for OAuth apps in July 2025, so the
earlier assumption that it did not support PKCE was out of date. The capability is still a
per adapter flag rather than an assumption.

Identity is matched on the provider's immutable numeric id and never on the username.
A username is renameable and, once released, claimable by somebody else, so matching on
one hands the account to whoever picks the name up next. Two tests cover it: a rename keeps
the same account, and a stranger who took the old name does not get in.

No provider access token is stored. It is read once during the callback and discarded.

A `mock` adapter is registered outside production only, and `tests/setupEnv.js` configures
it while leaving github and gitlab unconfigured. That keeps `npm test` network free on a
clean clone and lets one suite prove both that the round trip works and that an
unconfigured provider is genuinely absent.

Server suite: 554 passing, 19 suites, up from 535.
