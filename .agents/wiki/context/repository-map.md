---
name: agent-wiki-context-repository-map
description: Orientation for an agent working in server-expressjs — what lives where, the commands, entry points, generated paths and known gotchas.
---

# Repository Map — server-expressjs

Read this before touching anything. It says where things are and how to run them. The
underlying facts about the system live in `wiki/` and are linked rather than repeated;
the rules live in [`../../rules/repository.md`](../../rules/repository.md).

## What this repository is

`lxtranslator_server`, the Express backend for LXTranslator. It accepts JSON locale
files, normalises them to an English master, translates them through a configurable AI
provider, and serves the results back with change tracking. Node.js 20 or newer,
CommonJS, Sequelize over PostgreSQL in production and SQLite otherwise, Jest and
Supertest for tests.

The shared instruction set is **not** in this repository. It resolves through the
`lxagents-agents-base` MCP connector — see the bootstrap block in
[`../../../AGENTS.md`](../../../AGENTS.md).

## Commands

```bash
npm install             # once, on a clean clone
npm start               # http://localhost:4000
npm run dev             # same, with --watch
npm test                # full Jest suite, no configuration required
npm run test:watch      # watch mode
npm run test:coverage   # with coverage
npm run audit:security  # npm audit, fails at high severity
```

`npm install && npm start` and `npm test` must keep working on a clean clone with no
configuration, no database server and no vendor key. That is a hard constraint, not a
convenience — never introduce a setting that is required in development.

## Where things live

| Path | What it holds |
|---|---|
| `src/index.js` | Process entry point. Connects the database, applies the schema, starts the worker pool, then accepts traffic — in that order. |
| `src/app.js` | Express application assembly. |
| `src/config/` | Every setting, read in one place and driven by the single `PROD` switch. |
| `src/core/` | Framework free utilities. No Express here. |
| `src/infrastructure/` | `database/`, `crypto/`, `email/`, `ai/`. No Express here either. |
| `src/middleware/` | Cross cutting request concerns. |
| `src/modules/` | Feature modules — `auth`, `accounts`, `accountKeys`, `namespaces`, `orgs`, `projects`, `files`, `translations`, `exportFormats`, `chat`, `usage`. |
| `src/routes/` | API composition; `index.js` mounts every module router. |
| `src/workers/` | Worker threads running the translation pipeline. |
| `tests/` | Jest and Supertest. `helpers/testApp.js` builds the real application against an in memory database. |
| `jest.config.js` | Test configuration; `tests/setupEnv.js` runs before the suite. |

**Layering is enforced by convention and matters:** a layer may call the one below it and
never the reverse. `core` and `infrastructure` stay free of Express.

## Generated paths — leave them alone

`node_modules/`, `coverage/`, `data/` (the SQLite file), `storage/` (uploaded artefacts),
`/logs/` at the repository root. None are committed. Note that `wiki/logs/` **is**
committed — it holds the versioned change logs, and the ignore pattern is anchored to the
root so the two do not collide.

## Entry points for a change

* **A new feature** — a module under `src/modules/<feature>/` with `routes`, `service`,
  strict `schemas` and an optional `controller`, mounted in `src/routes/index.js`. The
  layout is in [`../../rules/repository.md`](../../rules/repository.md).
* **A new setting** — `src/config/`, and only if it is optional in development.
* **Anything touching the pipeline** — read
  [`../../knowledge/domain.md`](../../knowledge/domain.md) first. Several invariants are
  subtle and easy to break.

## Gotchas

* **Sequelize cannot reopen a closed connection.** A test file must call `setupTestApp`
  and `teardownTestApp` once at the top level, not once per `describe`. This has bitten
  before.
* **`PROD=true` refuses to boot** if a required secret is missing, shorter than 32
  characters, or still carries the development placeholder marker. That is deliberate —
  do not weaken it to make a deployment start.
* **Never return a decrypted API key**, in any endpoint, at any role.
* **Never query by a request identifier and return the result.** Access resolves through
  `namespace.service.js`; anything else is a broken object level authorization bug.
* **Every request schema is `.strict()`.** An undeclared field must fail validation rather
  than be silently ignored.
* **Provider base URLs are constants.** Making one configurable turns the server into an
  SSRF gadget.
* **Only the AI provider is substituted in tests**, by the offline mock. Everything else
  runs the production code path, so a test that passes against a stubbed service is not
  testing what ships.
* **The API speaks snake_case**; JavaScript here is camelCase.
