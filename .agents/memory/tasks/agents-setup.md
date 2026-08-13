---
name: memory-tasks-agents-setup
description: Record of the server-expressjs adoption of the shared instruction set — what was found, what was built, and what was proposed.
---

# Task — Adopt the shared agent instruction set

## Goal

Make this repository a compliant consumer of the LXAgents shared instruction set, so it
carries only what is genuinely its own and reads everything universal from the connector.

## Mode

**B — consumer.** The shared set is served by `lxagents-agents-base` and resolved at
session start. This repository is not `LXAgents/mcp-server` and copies nothing from it.

## Branch

`docs/agents-setup`, from `master`.

## What the duplicate audit found

The audit in `{shared}/rules/duplicate-instruction-audit.md` was run against the full
manifest. Every candidate under `.agents/` classified as **local-only**: no frontmatter
`name` matched a shared `name`, no normalized body hash matched a shared `sha256`, and no
candidate sat at a path mirroring a shared path. **Zero files were deleted by the audit.**

The duplication was not at file level. It was prose: the `## Git` section of the old
root `AGENTS.md` restated the shared branching strategy and commit conventions in
substance. That section was removed rather than deleted as a file, because it never was
one.

## What was created

* `.agents/index/` — `root-index.md` (with the empty override table), `agents-index.md`,
  `security-index.md`, `agent-wiki-index.md`, `project-wiki-index.md`, `memory-index.md`,
  `logs-index.md`.
* `.agents/rules/repository.md`.
* `.agents/wiki/context/repository-map.md`.
* `.agents/memory/state/repository-state.md` and this file.
* `wiki/information/overview.md`, `wiki/environments/setup.md`,
  `wiki/environments/docker.md`, `wiki/logs/0/24/0/CHANGELOG.md`.

## What was changed

* `AGENTS.md` rewritten as an entry point and activation contract: connector bootstrap
  block verbatim, auto activation contract, trigger table mirroring
  `{shared}/rules/auto-activation.md` row for row with local rows appended, reading order,
  routing protocol, iron rule, placement summary, discovery protocol block, version rule,
  no session links. No rule bodies remain in it.
* The trigger table gained one row per security policy, so each activates on the work it
  governs instead of relying on an agent to go looking.
* `README.md` reduced to an overview pointing at the wiki index.
* Documentation relocated into the mandated layout — the four loose `wiki/*.md` pages into
  `information/`, `reference/` and `environments/`.
* Frontmatter `name` values under `.agents/` converted to kebab-case and made unique
  within the local set.
* `.gitignore` anchored its runtime log pattern to the repository root, because a bare
  `logs/` also matched `wiki/logs/` and would have kept the mandated change log tree
  untracked.

## What was deleted

* `INDEX.md`, and its line in `.dockerignore`. Forbidden by the shared directory
  architecture; its routing role belongs to `.agents/index/`.

## Decisions

* **License and version untouched.** Proprietary, LXTranslator organization, already in
  `LICENSE`. `package.json` stays at 0.24.0 — a version bump needs explicit user approval.
* **`.agents/security/` earns a child index.** Eighteen files is past the split threshold,
  so `security-index.md` was created and `agents-index.md` points at it with a single
  Child Indexes row.
* **`.agents/knowledge/` kept as an instruction folder.** The shared directory
  architecture lists `knowledge/` as a valid local instruction folder, and `domain.md` is
  normative, so it stays there rather than moving to `.agents/wiki/domain/`.

## Proposed but not applied

Eight security topics exist in both this repository and `LXTranslator/client-reactjs`
under the same filenames with different bodies: `authentication-failures`,
`broken-access-control`, `exceptional-conditions`, `secrets-management`,
`secure-file-upload`, `security-misconfiguration`, `sensitive-information-disclosure`,
`supply-chain`. The shared directory architecture lists `security/` as a usually-shared
folder, so a shared core with local overrides is plausible — but it would be a change to
`LXAgents/mcp-server`, which is out of scope for this task and requires the user's
approval. Raised as a discovery, not applied.
