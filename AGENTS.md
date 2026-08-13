---
name: agents-entry-point
description: Entry point and activation contract for the LXTranslator server — resolves the shared set and routes to this repository's own instructions.
---

# Agent Instructions — server-expressjs

The backend for LXTranslator, a translation management application. It accepts JSON
locale files, normalises them to an English master, translates them into any number of
target languages through a configurable AI provider, and serves the results back as
downloadable locale files with change tracking built in. The web interface lives in
`LXTranslator/client-reactjs`, a separate repository with its own instruction set — never
apply rules from that one here.

## Shared Instruction Set

The conventions this repository follows — branching, commits, pull requests, task
workflow, the creators — live in the shared instruction set served by the
**`lxagents-agents-base`** MCP server. This repository carries only what is its
own. **Resolve the shared set before doing any work:**

1. If the `lxagents-agents-base` connector is available in this session, that is
   the shared set. Refer to it as `{shared}`; its files are addressed as
   `agents://{folder}/{file}.md`.
2. Read `agents://manifest.json` once. It lists every shared file with its `name`,
   path and description — one read instead of twenty, and it is what the routing
   tables below are checked against.
3. Read `agents://index/root-index.md` and route from there. Do not bulk-read the
   set.
4. If the connector is not available, say so plainly and continue with this
   repository's local instruction set only. **Do not reconstruct the missing rules
   from memory, and do not clone or copy them into this repository.**

Never commit shared content into this repository. A file that can be read from
`agents://` must not exist here as a copy — see
`{shared}/rules/duplicate-instruction-audit.md`.

**Local overrides shared.** A file in `.agents/` whose `name` matches a shared
file's `name` replaces that shared file entirely for this repository. The current
overrides are listed in
[`.agents/index/root-index.md`](.agents/index/root-index.md).

## Auto-Activation

The instruction set is **always active** — the local `.agents/` set and the shared set
together. It applies to every task in this repository whether or not the user mentions
it, links to it, or asks for it. Treat these files as standing orders, not as optional
reference material.

At the start of every session, before doing any work:

1. Read `AGENTS.md` (this file).
2. Resolve the shared set per the bootstrap above.
3. Read [`.agents/index/root-index.md`](.agents/index/root-index.md).
4. Read [`.agents/index/memory-index.md`](.agents/index/memory-index.md) and load only
   the memory rows whose scope matches the current request, so you continue prior work
   instead of restarting it.
5. Match the request against the trigger table below and load the instruction files it
   names, local first, shared second.

If a rule conflicts with a habit, a default, or a template you would otherwise follow,
the rule wins. If it conflicts with an explicit instruction from the user in this
session, the user wins — and you say out loud which rule you are setting aside.

## Trigger Table

`{shared}/rules/auto-activation.md` is the authority behind this table. The shared rows
are mirrored from it unchanged and in order; the local rows below them are this
repository's own.

| When you are about to… | Load and obey |
|---|---|
| Take in any new request of more than one step | `{shared}/planning/task-workflow.md` |
| Create a branch | `{shared}/git/branching-strategy.md` |
| Write a commit message | `{shared}/git/commit-conventions.md` |
| Open or update a pull request | `{shared}/git/pull-request-template.md` |
| Write **any** commit, tag, PR, comment, or file that will be committed or posted | `{shared}/rules/no-session-links.md` |
| Notice a rule worth adding, or content worth adding to an existing instruction | `{shared}/rules/discovery-protocol.md` |
| Wonder whether something is local or shared, or need to override a shared rule | `{shared}/rules/shared-instructions.md` |
| Decide where a new file goes | `{shared}/rules/directories.md` |
| Resolve, connect, or fail to reach the shared set | `{shared}/rules/mcp-connector.md` |
| Add, move, rename, or delete any file in a set or in `wiki/` | `{shared}/creators/index-creator.md` |
| Write a rule or instruction | `{shared}/creators/instruction-creator.md` |
| Write documentation, an SOP, or a domain guideline | `{shared}/creators/information-creator.md` |
| Change code or structure that a document describes | `{shared}/rules/change-propagation.md` |
| Record progress, a decision, or session state | `{shared}/creators/memory-creator.md` |
| Touch anything that carries a version number | `{shared}/rules/versioning.md` |
| Record a release | `{shared}/creators/changelog-creator.md` |
| Report finished work back to the user | `{shared}/rules/work-summary.md` |
| Need project facts, commands, or orientation | [`.agents/wiki/context/repository-map.md`](.agents/wiki/context/repository-map.md) |
| Do anything at all in this project | [`.agents/rules/repository.md`](.agents/rules/repository.md) |
| Touch the translation pipeline, the master language, or change tracking | [`.agents/knowledge/domain.md`](.agents/knowledge/domain.md) |
| Resolve a record from a request identifier, or return anything a caller referenced | [`.agents/security/bola.md`](.agents/security/bola.md) |
| Write or change a request schema, or return a model instance | [`.agents/security/bopla.md`](.agents/security/bopla.md) |
| Add or change an authorization check, or gate anything on a role | [`.agents/security/broken-access-control.md`](.agents/security/broken-access-control.md) |
| Change session handling, login, lockout or a single use token | [`.agents/security/authentication-failures.md`](.agents/security/authentication-failures.md) |
| Encrypt, hash, or store any credential, password or fingerprint | [`.agents/security/cryptographic-failures.md`](.agents/security/cryptographic-failures.md) |
| Add a secret, a default credential, or anything read from the environment | [`.agents/security/secrets-management.md`](.agents/security/secrets-management.md) |
| Write a database query, run a command, or merge an object | [`.agents/security/injection.md`](.agents/security/injection.md) |
| Build a filesystem path from anything a caller supplied | [`.agents/security/path-traversal.md`](.agents/security/path-traversal.md) |
| Accept, validate or store an uploaded file | [`.agents/security/secure-file-upload.md`](.agents/security/secure-file-upload.md) |
| Make an outbound request, or make an endpoint configurable | [`.agents/security/ssrf.md`](.agents/security/ssrf.md) |
| Send anything to an AI provider, or act on what one returns | [`.agents/security/prompt-injection.md`](.agents/security/prompt-injection.md) |
| Let a model trigger an action, or widen what one may do | [`.agents/security/excessive-agency.md`](.agents/security/excessive-agency.md) |
| Decide what leaves the system in a provider request or an API response | [`.agents/security/sensitive-information-disclosure.md`](.agents/security/sensitive-information-disclosure.md) |
| Write an error path, a catch block, or a failure response | [`.agents/security/exceptional-conditions.md`](.agents/security/exceptional-conditions.md) |
| Log anything, or add an alert | [`.agents/security/logging-and-alerting.md`](.agents/security/logging-and-alerting.md) |
| Add an expensive operation, a rate limit, or a payload ceiling | [`.agents/security/unrestricted-resource-consumption.md`](.agents/security/unrestricted-resource-consumption.md) |
| Add, update, or remove a dependency | [`.agents/security/supply-chain.md`](.agents/security/supply-chain.md) |
| Change deployment configuration, headers, or a production default | [`.agents/security/security-misconfiguration.md`](.agents/security/security-misconfiguration.md) |

Any row whose file is overridden locally resolves to the local copy — that is what the
override table in [`.agents/index/root-index.md`](.agents/index/root-index.md) is for.

## Reading Order

1. Read `AGENTS.md` (this file).
2. Resolve the shared set.
3. Read [`.agents/index/root-index.md`](.agents/index/root-index.md) — and nothing else
   at this stage.
4. From its routing table, pick the ONE index whose scope matches the task, and read
   that index.
5. If that index delegates to a child index, follow the one branch that matches.
6. Only then open the specific file(s) you need.

## Routing Protocol

Route by reading index tables, not by reading files. Do NOT load every index. Do NOT
bulk-scan either set to build a registry — `agents://manifest.json` already is one, and
it is one read instead of twenty. Do NOT read an instruction body until that instruction
has been selected. The standing exception is
[`.agents/index/memory-index.md`](.agents/index/memory-index.md), read every session
because continuity depends on it.

## Iron Rule

* `AGENTS.md` and `README.md` are overviews and must never carry detailed rules or
  documentation.
* [`.agents/index/root-index.md`](.agents/index/root-index.md) is a **router only**. It
  lists other indexes. It must never contain rules, documentation, prose, or direct
  links to leaf content.
* Each index owns exactly one scope and writes outside it never.
* **Local carries only what is local.** A convention true for more than this repository
  belongs in the shared set — propose it there, do not copy it here.
* `wiki/` is for humans, `.agents/wiki/` is for agents, and neither duplicates the
  other.
* **One subject per file.** A cross-cutting rule gets its own file and is linked, not
  pasted into a file about something else.
* An index never teaches. The moment it explains something, that content belongs in a
  real file.

## Placement

`{shared}/rules/directories.md` is the placement authority. In short:

* Local instructions → `.agents/{folder}/{file}.md`.
* Human documentation → `wiki/{folder}/{file-name}.md`.
* Agent knowledge → `.agents/wiki/{type}/{file-name}.md`.
* Memory → `.agents/memory/{type}/{file-name}.md`; indexes → `.agents/index/{scope}-index.md`.

Anything universal goes to the shared set, never here. No `INDEX.md`, anywhere, ever.

## Discovery Protocol

Source of truth: `{shared}/rules/discovery-protocol.md`.

> While working, if you find an instruction worth adding — a new rule, or content
> that belongs in an existing instruction file — you must NOT create or edit it on
> your own. Present each finding to the user separately, each in its own code block,
> including the target set (local or shared), the proposed file path, `name`,
> `description`, and full body. Let the user select which ones to apply. Create only
> what the user selects. This gate covers instruction files only — writing memory
> under `.agents/memory/` is expected and needs no approval.

## Version Rule

Never change this project's version without explicit user approval — see
`{shared}/rules/versioning.md`. `package.json` is the version carrier here.

## No Session Links

Never write a link or identifier pointing at an assistant or tool session into a file,
commit message, commit trailer, branch name, tag, pull request, or comment. If your
tooling appends one by default, strip it before committing or posting — see
`{shared}/rules/no-session-links.md`.
