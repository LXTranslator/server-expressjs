---
name: excessive-agency
description: Keep every action an AI model can trigger behind an authorization check written in backend code in the LXTranslator server.
---

# Excessive Agency

There are two AI surfaces in this system and they have deliberately different
boundaries. Do not reason about one using the rules of the other.

## The translation path: no agency at all

The model in the translation pipeline has exactly one capability: **return an
array of translated strings**. It cannot:

- Call a tool or a function.
- Read or write the database.
- Read or write the filesystem.
- Make a network request.
- Choose which provider or credential is used.
- Decide what gets translated, or into which languages.

Every one of those decisions is made by application code before the provider is
ever contacted. The model is a pure text transformer at the end of a fixed
pipeline.

### Rules

1. **Do not add tool calling to the translation path.** Translation does not
   need it. The assistant exists for the things that do.
2. **The reply is validated before it is used.** An array of strings of the
   expected length, or the batch fails. Never write an unvalidated model
   response into the database.
3. **The model never selects a destination.** Provider endpoints are constants
   and the registry is fixed. See `ssrf.md`.
4. **The model never influences authorization.** Access decisions are made
   before any provider call and are never revisited afterwards.

## The assistant: bounded agency, zero authority

The assistant in `src/modules/chat/` does call tools, and those tools create
projects, add languages and edit descriptions. That is agency, and it is
constrained by construction rather than by instruction.

### What it may invoke

Exactly the tools declared in `src/modules/chat/chat.tools.js`, and nothing
else. A name outside that list resolves to nothing and returns a refusal.

| Tool | Effect | Role required |
|---|---|---|
| `switch_namespace` | Changes the active namespace | Membership, proven per call |
| `list_projects` | Reads | Namespace access |
| `check_project_languages` | Reads | Project access |
| `get_project_description` | Reads | Project access |
| `find_chat` | Reads the caller's own history | Namespace access |
| `list_files` | Reads | Project access |
| `create_project` | Writes, may upload a file | `ADMIN` in an organization |
| `upload_file` | Writes, uploads into an existing project | `ADMIN` in an organization |
| `update_project_description` | Writes | `ADMIN` in an organization |
| `add_languages` | Writes, spends provider quota | `ADMIN` in an organization |
| `stop` | Ends the turn | None |

### Rules

1. **The model never authorises anything.** Every handler resolves access itself,
   against `context.actor`, which is the authenticated account and is never
   taken from anything the model said. It resolves through the same functions
   the HTTP routes use: `resolveNamespaceAccess`, `resolveProjectAccess`,
   `assertRole`. A model may name any object; naming one it is not entitled to
   fails exactly as the REST API would fail.

   This is the whole defence against prompt injection here. No instruction, in a
   message or inside a project name a tool returned, becomes access, because
   access is not decided anywhere the model can reach.

2. **Tool arguments are untrusted input.** The model writes them, so they pass a
   strict zod schema before a service sees them, exactly like a request body. An
   undeclared argument fails rather than reaching a service.

3. **The loop is bounded by configuration, not by the model.**
   `AGENTS_CHAT_REPEAT` caps the passes in one turn, default five. There is an
   explicit `stop` tool, and reaching the ceiling ends the turn with an honest
   answer rather than another call. Never make the bound depend on the model
   deciding it is finished.

4. **Every write has a role check a person could also have passed.** A tool must
   never do something the equivalent endpoint would refuse. When you add a tool
   that writes, find the endpoint that does the same thing and copy its check.

5. **A refusal is a result, not an exception.** Tools return
   `{ ok: false, error }` so the assistant can explain the refusal to the person.
   Only messages from the application's own error taxonomy are passed through;
   anything else becomes a generic message and is logged in full.

6. **Effects are bounded.** `add_languages` touches at most 25 projects per call.
   `create_project` and `upload_file` each handle at most the one attachment the
   request carried, which went through the same verification an ordinary upload
   does. A tool that could spend unbounded quota needs a ceiling before it
   merges.

7. **Nothing destructive is exposed.** There is no tool that deletes a project, a
   file or a member, and none that touches credentials, billing or membership.
   Adding one requires more than a role check: see below.

8. **The log records the person, not the payer.** When an organization's
   credential answers a member's question, `ai_chat_logs.account_id` is the
   organization and `user_id` is the member. Every invocation is attributable to
   a human.

### Before adding a tool

- Name the endpoint that does the same thing by hand. If there is none, ask why
  a person cannot do this themselves.
- Copy that endpoint's authorization check into the handler. Do not invent a
  looser one.
- Declare the arguments in a strict schema.
- Give it a ceiling if it can spend quota or touch many rows.
- Add a test that a caller lacking the role gets a refusal **and that nothing
  changed**, as `tests/chat.test.js` does.
- Anything that deletes, spends money or changes who can access what needs
  explicit human confirmation in the interface, not just a role check. No tool
  in the current set is in that category, and that is not an accident.
