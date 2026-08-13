---
name: repository-rules
description: Rules specific to the LXTranslator server — layer boundaries, the non negotiables, the module layout, coding style and the test approach.
---

# Repository Rules — server-expressjs

Rules that are true for **this repository only**. Everything universal — branching,
commits, pull requests, task workflow — comes from the shared set and is never restated
here.

## Mode and resolution

This repository is a **Mode B consumer**. The shared instruction set is served by the
`lxagents-agents-base` MCP connector and resolved at session start per the bootstrap
block in [`../../AGENTS.md`](../../AGENTS.md). Nothing from that set is copied into this
repository; the only local file that may carry a shared `name` is a declared override,
and every override is registered in [`../index/root-index.md`](../index/root-index.md).

## Project shape

Express backend for a translation management application. Node.js 20 or newer, CommonJS,
Sequelize over PostgreSQL in production and SQLite otherwise.

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

**A layer may call the one below it and never the reverse.** `core` and `infrastructure`
must stay free of Express.

## Non negotiable rules

1. **Run with no configuration.** `npm install && npm start` and `npm test` must keep
   working on a clean clone. Never introduce a setting that is required in development.
2. **`PROD=true` means production.** PostgreSQL, no built in secrets, and a hard failure
   at boot if a required secret is missing or still a placeholder. Do not weaken those
   guards. See [`../security/secrets-management.md`](../security/secrets-management.md).
3. **English is always the master.** See
   [`../knowledge/domain.md`](../knowledge/domain.md) before touching the pipeline.
4. **Never return a decrypted API key**, in any endpoint, at any role. See
   [`../security/sensitive-information-disclosure.md`](../security/sensitive-information-disclosure.md).
5. **Resolve access through `namespace.service.js`.** Never query by a request identifier
   and return the result. See [`../security/bola.md`](../security/bola.md).
6. **Every request schema is `.strict()`.** Undeclared fields must fail validation, not be
   ignored. See [`../security/bopla.md`](../security/bopla.md).
7. **Pipeline work stays on worker threads.** Do not move parsing, hashing or provider
   calls onto the main thread.
8. **Provider endpoints are constants.** Never make a base URL configurable. See
   [`../security/ssrf.md`](../security/ssrf.md).
9. **Errors reaching a client are generic** unless the application raised them
   deliberately. See
   [`../security/exceptional-conditions.md`](../security/exceptional-conditions.md).

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

* CommonJS with `'use strict'`.
* JSDoc on every exported function: purpose, `@param`, `@returns`, `@throws`.
* Comments explain **why**, not what. Do not narrate the next line.
* Two space indent, single quotes, semicolons, trailing commas in multiline literals.
* camelCase in JavaScript, snake_case in database columns and JSON payloads.
* Avoid dashes outside file names, directory names and branch names.

## Testing

```bash
npm test                # full suite, no configuration required
npm run test:coverage   # with coverage
npm run audit:security  # fails at high severity
```

Every change to auth, access control, uploads or credentials needs a test. Use
`tests/helpers/testApp.js`, which builds the real application against an in memory
database. Only the AI provider is substituted, by the offline mock, so tests exercise the
production code path.

One caveat: Sequelize cannot reopen a closed connection, so a test file must call
`setupTestApp` and `teardownTestApp` once at the top level rather than once per
`describe`.

## License

Proprietary, reserved for the LXTranslator organization. Do not add code under a license
that conflicts with it, and keep the `LICENSE` file intact. Dependency policy is in
[`../security/supply-chain.md`](../security/supply-chain.md).
