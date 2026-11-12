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
