# Agent Instructions — server-expressjs

Instructions for AI agents working in **this repository only**. The client
application lives in a separate repository with its own `AGENTS.md` and its own
`.agents/` directory; never read from or apply rules from that one here.

## Before you change anything

1. Read [`INDEX.md`](INDEX.md) for the repository structure.
2. Read [`README.md`](README.md) for the project context and hosting details.
3. Read [`.agents/knowledge/domain.md`](.agents/knowledge/domain.md) for the
   domain invariants. Several of them are subtle and easy to break.
4. Read the relevant file in [`.agents/security/`](.agents/security/) before
   touching auth, uploads, credentials, access control or provider calls.

Keep `INDEX.md` current whenever you add, move or remove a file.

## Project shape

Express backend for a translation management application. Node.js 20 or newer,
CommonJS, Sequelize over PostgreSQL in production and SQLite otherwise.

```
src/config/          settings, driven by the single PROD switch
src/core/            framework free utilities
src/infrastructure/  database, crypto, mail, AI providers
src/middleware/      cross cutting request concerns
src/modules/         feature modules: routes, controller, service, schemas
src/routes/          API composition
src/workers/         worker threads running the translation pipeline
tests/               jest and supertest
```

A layer may call the one below it and never the reverse. `core` and
`infrastructure` must stay free of Express.

## Non negotiable rules

1. **Run with no configuration.** `npm install && npm start` and `npm test` must
   keep working on a clean clone. Never introduce a setting that is required in
   development.
2. **`PROD=true` means production.** PostgreSQL, no built in secrets, and a hard
   failure at boot if a required secret is missing or still a placeholder. Do not
   weaken those guards.
3. **English is always the master.** See the domain invariants before touching
   the pipeline.
4. **Never return a decrypted API key**, in any endpoint, at any role.
5. **Resolve access through `namespace.service.js`.** Never query by a request
   identifier and return the result.
6. **Every request schema is `.strict()`.** Undeclared fields must fail
   validation, not be ignored.
7. **Pipeline work stays on worker threads.** Do not move parsing, hashing or
   provider calls onto the main thread.
8. **Provider endpoints are constants.** Never make a base URL configurable.
9. **Errors reaching a client are generic** unless the application raised them
   deliberately.

## Adding a feature

Follow the existing module layout:

```
src/modules/<feature>/
  <feature>.routes.js      route definitions, middleware wiring
  <feature>.controller.js  HTTP translation only (optional for small modules)
  <feature>.service.js     the rules, testable without a request object
  <feature>.schemas.js     strict zod schemas
```

Mount the router in `src/routes/index.js`. Add tests in `tests/`.

## Style

- CommonJS with `'use strict'`.
- JSDoc on every exported function: purpose, `@param`, `@returns`, `@throws`.
- Comments explain **why**, not what. Do not narrate the next line.
- Two space indent, single quotes, semicolons, trailing commas in multiline
  literals.
- camelCase in JavaScript, snake_case in database columns and JSON payloads.
- Avoid dashes outside file names, directory names and branch names.

## Testing

```bash
npm test                # full suite, no configuration required
npm run test:coverage   # with coverage
npm run audit:security  # fails at high severity
```

Every change to auth, access control, uploads or credentials needs a test. Use
`tests/helpers/testApp.js`, which builds the real application against an in
memory database. Only the AI provider is substituted, by the offline mock, so
tests exercise the production code path.

One caveat: Sequelize cannot reopen a closed connection, so a test file must
call `setupTestApp` and `teardownTestApp` once at the top level rather than once
per `describe`.

## Git

- Branches follow `{type}/{primary-noun}`, for example `feat/login`.
  Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `revert`.
- Never work directly on `main` or `master`.
- Conventional Commits, plain text, no links and no issue identifiers.
- Commit each logical change rather than batching a session into one commit.
  Review the diff before committing.
- Bump `version` in `package.json` on every pull request, following semantic
  versioning.

## License

Proprietary, reserved for the LXTranslator organization. Do not add code under a
license that conflicts with it, and keep the `LICENSE` file intact.
