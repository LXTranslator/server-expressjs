---
name: memory-state-repository-state
description: Current known state of server-expressjs after adopting the shared instruction set — what exists, the stack, and the next obvious step.
---

# Repository State — server-expressjs

## What this is

`lxtranslator_server`, version 0.25.0. The Express backend for LXTranslator, serving the
API that `LXTranslator/client-reactjs` consumes.

## Stack

Node.js 20 or newer, CommonJS, Express, Sequelize. PostgreSQL when `PROD=true`, SQLite
otherwise. Translation work runs on worker threads. Jest and Supertest for tests, against
an in memory database with only the AI provider substituted. Deployed as a multi stage
Docker image running as an unprivileged user under `dumb-init`.

## Instruction system

Mode B consumer. The shared set resolves through the `lxagents-agents-base` MCP
connector; nothing shared is copied into this repository, and the override table in
`.agents/index/root-index.md` is empty. Local content is:

* `.agents/rules/repository.md` — this repository's own rules.
* `.agents/knowledge/domain.md` — translation domain vocabulary and invariants.
* `.agents/security/` — eighteen policies, past the split threshold and carrying their
  own child index.
* `.agents/wiki/context/repository-map.md` — agent orientation.
* `.agents/index/` — seven indexes routing all of the above plus both wiki trees.

Human documentation lives in `wiki/` under `information/`, `reference/`, `environments/`
and `logs/`.

## Authentication, as of 0.25.0

Three ways to prove an identity, and one gate they all pass through.

* **Password**, as before: bcrypt, a generic 401 with a timing decoy on a miss, five
  failures then a fifteen minute lock.
* **A TOTP second factor**, optional per account, with ten single use recovery codes.
  A confirmed factor turns login into two steps: correct credentials yield a challenge
  and never a session.
* **github.com and gitlab.com**, link only. An identity nobody has linked is refused; no
  account is created and none is matched by email.

`completeSignIn` in `src/modules/auth/auth.service.js` is the single gate. Both the
password path and the provider callback go through it, which is what makes the second
factor apply to a provider sign in. A new sign in path that calls `issueAccessToken`
directly would bypass the factor silently — that is the mistake to watch for.

Five tables carry it: `account_mfa`, `account_recovery_codes`, `mfa_challenges`,
`oauth_states`, `account_identities`.

## The schema constraint that governs every future change here

Production runs bare `sequelize.sync()`. It creates missing tables and does nothing else:
**no new column on an existing table, and no new value in an existing ENUM type.** New
state therefore goes in a new table, and any column whose set of values might grow is
`STRING` with validation rather than `ENUM`. Both would otherwise work on every fresh
database and in every test, then fail on the first insert against a real deployment.

## What is not built

* No change log history before 0.24.0 — the `wiki/logs/` tree starts at the version
  current when the instruction system was adopted.
* No CI workflow in this repository.
* No `.agents/wiki/sop/` or `.agents/wiki/domain/` pages yet; only `context/` is
  populated.
* No migration system. 0.25.0 was designed around its absence rather than adding one;
  that remains its own piece of work.
* Self hosted GitLab and GitHub Enterprise Server as sign in providers. Both need a
  configurable provider base URL, which the SSRF rule refuses.

## Next obvious step

`LXTranslator/client-reactjs` has to catch up: the endpoints added at 0.25.0 have no
interface yet. That is tasks 7 to 12 of the `auth-security-refinement` record.

Four instruction findings are waiting on the user's decision rather than being written,
per the discovery protocol. They are listed at the end of
[`../tasks/auth-security-refinement.md`](../tasks/auth-security-refinement.md).

Still open from 0.24.0: the eight security topics this repository shares by filename with
`LXTranslator/client-reactjs` have different bodies in each repository because one is a
server and the other is a browser bundle. Whether any of them should be promoted to the
shared set is an open question for the user; it would be a change to `LXAgents/mcp-server`
and has not been made.
