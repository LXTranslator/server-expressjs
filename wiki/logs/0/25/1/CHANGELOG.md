# 0.25.1

2026-10-12. Less repeated code in the server, and a dependency tree that audits clean
again.

Nothing a client or a deployment can observe has changed. Every API response, status
code, error message and table definition is what it was at 0.25.0, and taking this
version needs nothing from anyone. Code lines under `src/`, excluding comments and blank
lines, went from 11,167 to 10,690.

## Added

- `assertAdmin` in `src/modules/namespaces/namespace.service.js` and
  `src/middleware/requireAdmin.js`, the one statement of "ADMIN inside an organization,
  nothing in a personal namespace".
- `src/infrastructure/ai/vendorRequest.js`, the one place an AI vendor is called over the
  network. It owns the deadline, the transport, status and JSON parse failures, and the
  rule that a vendor's response body reaches only `cause` and never a message.
- `src/modules/chat/tools/`, the assistant tool definitions grouped by area, with
  `shared.js` holding what they have in common. `defineArguments` derives a tool's JSON
  Schema and its zod schema from one declaration per argument, so the two can no longer
  drift apart.
- `src/infrastructure/database/models/columns.js`, the UUID primary key, the cascading
  reference and the `created_at` column most tables share.
- `src/modules/auth/auth.http.js`, the session response and the sign in answer.
- Forty characterisation tests in `tests/provider.test.js` pinning the endpoint,
  credential header, transport, deadline, status and malformed body handling of every
  network adapter, written against the old adapters before they changed. The suite is
  600 tests across 19 files, up from 560.

## Changed

- The namespace, project and file routes and the chat tools call `requireAdmin` or
  `assertAdmin` in place of `requireNamespaceAdmin`, `requireProjectAdmin` and fourteen
  written out copies. Each check runs at the same point in its route as before, so a
  member whose request fails validation is still answered 400 rather than 403.
- The OpenAI, OpenRouter and Anthropic adapters and `openaiChat.js` send through
  `vendorRequest.js` instead of carrying six copies of the same handling.
- `src/modules/chat/chat.tools.js` went from 1,849 lines to 146: the security notes, the
  ordered tool list and the dispatcher. What the model is shown was compared before and
  after as serialised JSON and is byte identical.
- The models build their shared columns from `columns.js`. Every model's attributes,
  indexes and timestamp options, and the tables `sync()` creates, were compared before
  and after and are identical. That comparison is what makes the change safe: production
  runs bare `sequelize.sync()`, which never alters an existing table, so a drifted column
  would have surfaced only on a fresh database.
- Registering, both sign ins and an answered second factor challenge build their response
  through `auth.http.js`. The bodies and their key order are unchanged.

## Security

`npm audit` reports **0 vulnerabilities**, where it reported six, one of them critical.
None were introduced here; they were published against the 0.25.0 tree after it audited
clean. Every fix is inside the ranges `package.json` already declares, so only
`package-lock.json` changed and no dependency was added.

- `proxy-addr` 2.0.7 to 2.0.8, critical: IP spoofing through an IPv4 mapped IPv6 trust
  subnet. It reaches production through express.
- `nodemailer` 10.0.1 to 10.1.0, high, five advisories. No test exercises it, so it was
  checked by running the calls `mailer.js` makes.
- `brace-expansion` 5.0.9 to 5.0.12, high, development only.
- `multer` 2.3.0 to 2.4.0, `moment` 2.30.1 to 2.31.0 and `ip-address` 10.7.0 to 10.7.4,
  moderate. `multer` 2.4.0 no longer depends on `concat-stream`, `buffer-from` or
  `typedarray`, which left the tree.

## Notes

**For a contributor, three places to start from.** A route that needs an organization
ADMIN uses `requireAdmin`. A new assistant tool goes in the matching file under
`src/modules/chat/tools/` and into the ordered list in `chat.tools.js`, which is still the
only place a tool becomes callable. A new table takes its key, references and
`created_at` from `columns.js`.

**One inconsistency was kept on purpose.** The `provider` recorded on a `ProviderError`
is the lowercase adapter name on a translation call and the display label on a chat or
embedding call. Something could be reading it, so changing it would be a behaviour
change, and it was left for whoever decides it matters.
