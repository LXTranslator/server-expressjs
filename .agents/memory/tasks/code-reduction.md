---
name: memory-task-code-reduction
description: Task record for reducing duplicated code in the server without changing behaviour — the admin guard, the vendor request helper, the chat tools, model columns and the sign in response.
---

# Task Record — code-reduction

Confirmed with the owner before any of it was built. Seven tasks in this repository,
the two reserved slots and five pieces of work between them. The client has its own
chain in `LXTranslator/client-reactjs`; neither depends on the other.

## Why

The owner asked for less code and less spaghetti in both repositories. The server is
already layered and mostly well factored: a copy detector finds only 1.4 percent of
`src/` as exact clones. The cost sits in near copies that a detector scores low because
the wording around them differs:

* The "ADMIN inside an organization" check is written out thirteen times across the
  namespace, project and file routes and the chat tools, plus two identical middleware
  functions under different names.
* Six functions in the OpenAI, OpenRouter and Anthropic adapters each repeat the same
  fetch, deadline, transport error, status error and JSON parse handling.
* `src/modules/chat/chat.tools.js` is 1,849 lines in one file, and its handlers repeat
  the same identifier schema, access resolution, project and file summaries and
  `AppError` to refusal conversion.
* Most models repeat the same UUID key, account reference and `created_at` column.
* The password and provider sign in handlers send the same response from two places.

## Decisions taken with the owner

| Decision | Reason |
|---|---|
| No behaviour change | Every API response, error message, status and table definition stays identical, so the existing suite is the proof. |
| No new dependency | The goal is less code; a library would move it rather than remove it. |
| `chat.tools.js` stays the registry | Tests and `.agents/security/excessive-agency.md` both name it as where the tool list lives. Definitions move into `src/modules/chat/tools/`; the list and the dispatcher stay. |
| Characterisation tests before the adapter refactor | Only the OpenRouter adapter has direct tests. The OpenAI and Anthropic error paths are pinned first, against the old code, so the refactor is checked by tests written before it. |
| Model columns verified by diff | Production runs bare `sequelize.sync()`, which never alters an existing table, so a column definition that drifted would surface only on a fresh database. Every model's attributes are dumped before and after and must be identical. |
| Branch convention over the harness branch | The harness named `claude/project-thread-31p81h`; `branching-strategy.md` forbids a tool preset prefix and a generated suffix, and the owner asked for the branch strategy. |
| Gates answered by the recommended choice | The owner said they would be away and asked for each question to be posted as a choice with a recommendation, then for the recommendation to be taken. That stands in for the plan, pull request and version gates. Merging is left to the owner. |

## The tasks

| # | Title | Scope | Repository | Branch | PR |
|---|---|---|---|---|---|
| 1 | Task record | This file and its index row | server | `chore/code-reduction-plan` | |
| 2 | One admin guard | One assertion and one middleware for the ORG ADMIN check | server | `refactor/admin-guard` | |
| 3 | One vendor request helper | One deadline, transport, status and JSON handler for every AI adapter | server | `refactor/provider-request` | |
| 4 | Chat tools split | Tool definitions by area under `tools/`, shared helpers, one issue formatter | server | `refactor/chat-tools` | |
| 5 | Shared model columns | UUID key, account reference and timestamp builders | server | `refactor/model-columns` | |
| 6 | Shared sign in response | One sender for the password and provider sign in result | server | `refactor/sign-in-response` | |
| 7 | Release | Version, changelog, indexes, close this record | server | `release/{version}` | |

Task 1 branches from `master`; task `k` branches from task `k-1`. Tasks 2 and 4 both
touch `chat.tools.js`, which is why the guard lands first and the split builds on it.

Baseline before any task: 560 tests passing across 19 suites.

## Progress

### Task 1 — chore/code-reduction-plan

Created this record and its row in `.agents/index/memory-index.md`. Nothing else was
written, so the plan can be read before any diff exists.

Task 2 depends on nothing here beyond the ordering.

### Task 2 — refactor/admin-guard

`assertAdmin(namespace, role)` in `src/modules/namespaces/namespace.service.js` is now
the one place that says "ADMIN inside an organization, nothing in a personal
namespace". `src/middleware/requireAdmin.js` wraps it for routes. It replaces the
`requireNamespaceAdmin` and `requireProjectAdmin` functions, which were the same code
under two names, eleven inline copies across the namespace, project and file routes,
and three copies in `chat.tools.js`.

The middleware sits exactly where each inline check used to run, which is after
`validate` on the routes that validated first and after multer on the key merge
route. Moving it earlier would turn some 400 answers into 403 answers for a member,
which is a behaviour change, so the order was kept.

`tests/access.test.js`, `exportFormat`, `accountAi` and `organization` cover the
refusal branch: coverage reports both branches of `requireAdmin.js`.

Server suite: 560 passing across 19 suites, unchanged.
