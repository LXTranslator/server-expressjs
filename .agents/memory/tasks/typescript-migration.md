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
| Jest stays, through `@swc/jest` | The owner asked not to break the existing test framework. 600 tests are the proof that behaviour did not change. Planned as `ts-jest`, which cannot run on TypeScript 7; see task 2. |
| `tsx` for development | `npm run dev` watches the TypeScript source directly; production runs the compiled `dist/`. |
| Types taken from the existing JSDoc first | Every exported function already documents its parameters and return value. Moving those into the signature keeps the documented contract and the checked one the same. |
| No behaviour change | Every response, error, status and table definition stays identical. |
| Gates answered by the recommended choice | The owner is away and asked for each question to be posted with a recommendation and the recommendation taken. Version 0.26.0 was chosen that way: the API is unchanged, but deployment now needs a build step. |

## The tasks

| # | Title | Scope | Repository | Branch | PR |
|---|---|---|---|---|---|
| 1 | Task record | This file and its index row | server | `plan/typescript-migration` | #42 |
| 2 | Latest dependencies | Every dependency on its latest version, TypeScript tooling and `@types`, audit | server | `build/dependencies` | #43 |
| 3 | TypeScript conversion | `tsconfig.json`, `src` and `tests` to `.ts`, scripts, Jest, Dockerfile, docs | server | `refactor/typescript` | #44 |
| 4 | Release | Version, changelog, indexes, close this record | server | `release/0.26.0` | #45 |

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

### Task 3 — refactor/typescript

Every file in `src/` and `tests/` renamed from `.js` to `.ts` with `git mv`, so history
follows each file. `require` and `module.exports` became `import` and `export`: an object
of names became named exports, anything else a default export. The output is still
CommonJS, so `__dirname` needed no change. Two lazy `require` calls inside functions,
used to break the `project.service` and `file.service` cycle, became top level imports,
which CommonJS live bindings keep safe. The mailer keeps its lazy `require('nodemailer')`
on purpose, typed through `import type`.

`tsconfig.json` is strict with `ES2022`, `NodeNext`, `rootDir` `src`, `outDir` `dist`,
declarations and source maps. `tsconfig.test.json` extends it to check the tests.
Strict mode started at 1463 errors in `src` and 2091 in `tests`, and both reach zero
without `// @ts-ignore` or `@ts-expect-error` anywhere. Types added along the way:
attributes, instances and public JSON for every model; the provider neutral AI shapes
in `infrastructure/ai/types.ts`; the OAuth adapter shape; the chat tool context and
result; the Express request fields the middleware sets, in `src/types/express.d.ts`.
Chat tools are declared through `defineTool`, an identity function that types each
handler's arguments from the zod schema that validates them.

The one route change is a rename: the file record moved from `req.file` to
`req.fileRecord`, because multer owns `req.file`. Nothing a client sees changed.

Test bodies are read through `ApiJson`, a loose record, the way a client reads a
response. That and the test-only `as` casts on partial contexts are the only places
an explicit loose type appears.

`package.json`: `main` and `types` point at `dist/`, `build` is `tsc`, `start` builds and
then runs `dist/index.js`, `dev` is `tsx watch`, and `npm test` type checks before Jest.
The package has no `bin`, so there was none to move. The worker pool runs the compiled
`translation.worker.js` when it exists and the `.ts` source through `tsx` otherwise, which
is what lets the suite run without a build.

`jest.config.js` stays JavaScript, since Jest reads it before any transform exists, and
runs the `.ts` files through `@swc/jest`. The Dockerfile gained a build stage; the
runtime image carries `dist/` and no compiler. Docker was not available in this
environment, so the image itself was not built; the build stage's `npm ci
--ignore-scripts` and `npm run build` were run on a clean copy and produce a `dist/` that
loads.

Checked: `npm run build` with zero errors, `npm run typecheck` with zero errors, 600 of
600 tests across 19 suites, `npm audit` clean, `node dist/index.js` boots and translates
an upload on the compiled worker, and `tsx src/index.ts` boots.

### Task 4 — release/0.26.0

Version 0.26.0, a minor because a deployment now needs a build step even though the API
is unchanged. `package.json` and both version fields of `package-lock.json`,
`wiki/logs/0/26/0/CHANGELOG.md`, its `logs-index.md` row, and the stack and shared
pieces in `.agents/memory/state/repository-state.md`.

Server chain complete: four tasks, four branches, `npm run build` and `npm run
typecheck` with zero errors, 600 tests passing across 19 suites, `npm audit` clean.

## Discovery findings, awaiting the owner's decision

Proposed rather than written, per the discovery protocol:

1. `.agents/rules/repository.md` still says "CommonJS with `'use strict'`" and lists the
   module layout as `.js` files. It should say strict TypeScript in ES module syntax,
   compiled to CommonJS, with the `.ts` names, and add that `npm test` type checks first.
2. Seventeen of the `.agents/security/` policies point at source files by their `.js`
   names, such as `src/middleware/authenticate.js`. Every one now ends in `.ts`. The
   change is mechanical but those are instruction files.
3. `.gitignore` still has no `.agents/plans/` line (raised before, at 0.25.1). The
   working plan was kept out of every commit through `.git/info/exclude` again.
