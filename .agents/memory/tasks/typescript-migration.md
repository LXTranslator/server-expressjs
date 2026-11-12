---
name: memory-task-typescript-migration
description: Task record for moving the server from CommonJS JavaScript to strict TypeScript, with every dependency on its latest version and a clean audit.
---

# Task Record — typescript-migration

Written before any of it was built. Four tasks in this repository, the two reserved slots
and two pieces of work between them. The client runs its own migration in
`LXTranslator/client-reactjs`; neither depends on the other.

## Why

The owner asked for every Node.js repository to move to TypeScript, under a fixed
checklist: latest dependencies and a clean audit, a strict `tsconfig.json` with
`ES2022` and `NodeNext`, every `.js` file renamed and typed, `package.json` pointing at
`dist/`, and a clean build, test run and audit at the end.

## Decisions

| Decision | Reason |
|---|---|
| Source in ES module syntax, output in CommonJS | `module: NodeNext` without `"type": "module"` compiles `import` to `require`. Jest keeps running without the experimental VM modules flag, `__dirname` stays valid, and the worker thread path needs no loader in production. |
| Jest stays, through `ts-jest` | The owner asked not to break the existing test framework. 600 tests are the proof that behaviour did not change. |
| `tsx` for development | `npm run dev` watches the TypeScript source directly; production runs the compiled `dist/`. |
| Types taken from the existing JSDoc first | Every exported function already documents its parameters and return value. Moving those into the signature keeps the documented contract and the checked one the same. |
| No behaviour change | Every response, error, status and table definition stays identical. |
| Gates answered by the recommended choice | The owner is away and asked for each question to be posted with a recommendation and the recommendation taken. Version 0.26.0 was chosen that way: the API is unchanged, but deployment now needs a build step. |

## The tasks

| # | Title | Scope | Repository | Branch | PR |
|---|---|---|---|---|---|
| 1 | Task record | This file and its index row | server | `plan/typescript-migration` | |
| 2 | Latest dependencies | Every dependency on its latest version, TypeScript tooling and `@types`, audit | server | `build/dependencies` | |
| 3 | TypeScript conversion | `tsconfig.json`, `src` and `tests` to `.ts`, scripts, Jest, Dockerfile, docs | server | `refactor/typescript` | |
| 4 | Release | Version, changelog, indexes, close this record | server | `release/0.26.0` | |

Task 1 branches from `master`; task `k` branches from task `k-1`.

Baseline before any task: 600 tests passing across 19 suites, `npm audit` clean.

### Task 1 — plan/typescript-migration

This record and its row in `.agents/index/memory-index.md`.

### Task 2 — build/dependencies

Every direct dependency moved to its latest version: `dotenv` 18.0.10 (a major, and the
only one), `express` 5.3.0, `express-rate-limit` 8.7.4, `multer` 2.5.0, `nodemailer`
10.5.0, `zod` 4.6.7, `pg` 8.23.1, `jest` 30.5.2, `supertest` 7.3.2. The rest were already
current. `dotenv` 18 keeps `config({ quiet: true })`, and the server boots and answers
`/api/v1/health` on it.

Added as devDependencies: `typescript` 7.0.2, `tsx`, `@types/node`, `@types/express`,
`@types/cors`, `@types/jsonwebtoken`, `@types/multer`, `@types/nodemailer`,
`@types/supertest` and `@types/jest`. `bcryptjs` and `sqlite3` ship their own types, so
their `@types` packages are deprecated stubs and were left out.

**`ts-jest` cannot be used.** TypeScript 7 is the native compiler and no longer exposes the
JavaScript compiler API, and `ts-jest` declares `typescript >=4.3 <7`. Jest therefore
transpiles through `@swc/jest` and `@swc/core`, and type checking is `tsc`'s job: task 3
runs it over `src` and `tests` alike.

`npm audit` after the updates: 22 advisories. `npm audit fix` cleared `body-parser`,
`qs` and `undici` (through `node-gyp`) inside the declared ranges. The remaining 19 all
came from Jest's own tree and are pinned through `overrides`, recorded in
`.agents/security/supply-chain.md`. `npm audit` reports 0 vulnerabilities, and
`npm run test:coverage` exercises the overridden `glob` and `test-exclude` path.

`nodemailer` 10.5.0 was checked directly as before: `createTransport` with the
`{host, port, secure, auth}` shape still returns `sendMail`, and a `jsonTransport` send
delivers every field.

Server suite: 600 passing across 19 suites, unchanged.
