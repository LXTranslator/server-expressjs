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

### Task 3 — refactor/provider-request

`src/infrastructure/ai/vendorRequest.js` is now the one place an AI vendor is called
over the network. `postJson` owns the deadline, the transport, status and JSON parse
failures and the rule that a vendor body reaches only `cause`; `assertNoUpstreamError`
owns the error OpenRouter reports inside a 200 body; `readTranslations` owns the
"unusable reply" wrapping around `parseTranslationReply`. The OpenAI, OpenRouter and
Anthropic adapters and `openaiChat.js` call those instead of carrying six copies.

Two things were kept exactly as they were, because something could read them:

* The `provider` recorded on an error is still the lowercase adapter name on a
  translation call and the display label on a chat or embedding call. That
  inconsistency predates this work; changing it is a behaviour change, so it is left
  for whoever decides it matters.
* The transport message still says "embedding request" for an embedding call.

The tests came first, in their own commit: forty cases in `tests/provider.test.js`
pin the endpoint, credential header, transport, deadline, status and malformed body
handling of all eight network calls, written and passing against the old adapters.
A throwaway script also compared the old and new adapters on 45 request and reply
shapes, headers and bodies included, with no difference.

Server suite: 600 passing across 19 suites, up from 560 by the forty new cases.

### Task 4 — refactor/chat-tools

`src/modules/chat/chat.tools.js` was 1,849 lines holding eighteen tool definitions,
their helpers and the dispatcher. It is now 146 lines: the security notes, the ordered
tool list and the dispatcher. The definitions moved by area into
`src/modules/chat/tools/`:

| File | Holds |
|---|---|
| `shared.js` | Result shapes, argument pieces, ceilings, access resolution and the helpers below |
| `conversation.js` | `switch_namespace`, `find_chat`, `stop` |
| `projects.js` | `list_projects`, `create_project`, the description pair, `list_platforms`, `update_project_ai` |
| `languages.js` | `check_project_languages`, `add_languages` |
| `files.js` | `upload_file`, `list_files`, `create_file`, `add_keys`, `export_file` |
| `exportFormats.js` | `list_export_formats`, `create_export_format` |

What was repeated and is now written once:

* **Every argument was declared twice**, as the JSON Schema the model is shown and as
  the zod schema that validates it, and nothing kept the two in step.
  `defineArguments` takes one `[zod, JSON Schema]` pair per field and derives both,
  with a field required exactly when its zod schema is not optional.
* **The `AppError` to refusal conversion** was a try and catch in eleven places.
  `attempt(step, body)` returns `{ value, failure }` and rethrows anything the
  application did not raise, exactly as each copy did.
* **Resolve, then require ADMIN, then skip** was two steps everywhere a tool changes
  something. `resolveProject` and `resolveFile` take `{ admin: true }`.
* The project and file summaries, the one project argument tools, the no argument
  tools, the project target collection shared by `update_project_ai` and
  `add_languages`, the key count ceiling shared by `create_file` and `add_keys`, the
  format preview and the platform catalogue on a refusal.

The list order in `chat.tools.js` is the order before the split, because it is the
order the model is shown. `listToolDefinitions()` was compared before and after as
serialised JSON and is byte identical.

By code lines, excluding comments and blank lines, the module went from 1,353 to
1,366. The deduplication removed about as much as six files of imports cost. This
task is about structure and about the two argument declarations that could drift;
the line count is roughly flat.

Planned and dropped: sharing the zod issue formatting between `validate.js` and the
dispatcher. It is four lines in each place, and a shared helper with its JSDoc would
have added more than it removed. `chat.tools.js` cannot import it from the middleware
layer either, since a module may not call the layer above it.

`.agents/security/excessive-agency.md` still says the tools are declared in
`chat.tools.js`. That stays true: the list is there, and a name outside it resolves
to nothing.

Server suite: 600 passing across 19 suites, unchanged. `tests/chat.test.js` covers
the tool files at 96.9 percent of lines.

### Task 5 — refactor/model-columns

`src/infrastructure/database/models/columns.js` holds the three column definitions
most tables repeated, each returned as a new object per call because Sequelize writes
into the attribute objects it is given:

* `uuidKey()`, the random UUID primary key, used by fifteen models.
* `reference(table, field, options)`, the cascading reference to another table's
  `id`, used by all twenty references. Only `file.project_id` (an integer) and
  `oauth_states.account_id` (nullable) pass options.
* `createdAt()`, the `created_at` column, used by all eighteen models.

Field comments stayed on the line above each column. A block was replaced only where
it matched the shared definition exactly, so nothing was folded in by approximation.

Checked by diff, as decided above: every model's attributes, indexes and timestamp
options, and the SQLite table definitions `sync()` creates, were dumped before and
after the change and are identical.

By code lines, excluding comments and blank lines, the models went from 1,673 to
1,429.

Server suite: 600 passing across 19 suites, unchanged.

### Task 6 — refactor/sign-in-response

`src/modules/auth/auth.http.js` holds what the three auth controllers each wrote out
for themselves:

* `sendSignIn(res, result)` answers a password or provider sign in, with either the
  second factor challenge or the session. `auth.controller.js` and
  `oauth.controller.js` carried the same two branches word for word.
* `sessionData(session)` builds the account, bearer token and lifetime body that
  registering, both sign ins and an answered second factor challenge all return. It
  was written out in four places.
* `clientContext(req)`, the user agent a new session records, was defined in all three
  controllers. The longest of the three comments, the one explaining why the address
  is not stored, moved with it.

The response bodies, their key order and their status codes are unchanged. The suite
covers both branches of `sendSignIn` and every line of the new file.

By code lines, excluding comments and blank lines, the three controllers and the new
file came to 270, down from 304 for the controllers alone.

Server suite: 600 passing across 19 suites, unchanged.
