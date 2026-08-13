---
name: memory-state-repository-state
description: Current known state of server-expressjs after adopting the shared instruction set — what exists, the stack, and the next obvious step.
---

# Repository State — server-expressjs

## What this is

`lxtranslator_server`, version 0.24.0. The Express backend for LXTranslator, serving the
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

## What is not built

* No change log history before 0.24.0 — the `wiki/logs/` tree starts at the version
  current when the instruction system was adopted.
* No CI workflow in this repository.
* No `.agents/wiki/sop/` or `.agents/wiki/domain/` pages yet; only `context/` is
  populated.

## Next obvious step

The eight security topics this repository shares by filename with
`LXTranslator/client-reactjs` have different bodies in each repository because one is a
server and the other is a browser bundle. Whether any of them should be promoted to the
shared set is an open question for the user; it would be a change to `LXAgents/mcp-server`
and has not been made.
