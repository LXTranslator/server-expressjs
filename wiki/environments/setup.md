# Local Setup

## Requirements

* Node.js 20 or newer.
* npm, which ships with Node.

Nothing else. No database server, no vendor API key, no configuration file.

## First run

```bash
npm install
npm start
```

The server listens on `http://localhost:4000` and stores its data in a local SQLite file
under `data/`. It boots with built in development secrets and an offline AI provider, so
it is fully exercisable without an account anywhere.

To run the web interface against it, clone `LXTranslator/client-reactjs` and run
`npm run dev`; its dev server proxies `/api` here.

## Commands

```bash
npm start               # http://localhost:4000
npm run dev             # same, restarting on change
npm test                # full Jest suite
npm run test:watch      # watch mode
npm run test:coverage   # with coverage
npm run audit:security  # npm audit, fails at high severity
```

## Running with no configuration is a constraint

`npm install && npm start` and `npm test` must keep working on a clean clone. A setting
that is *required* in development breaks that promise, so every new setting must have a
working default. The full variable list and the `PROD` switch that governs them are in
[`env.md`](env.md).

## Project layout

`src/index.js` is the process entry point. It connects the database, applies the schema,
starts the worker pool, and only then accepts traffic — failing any earlier step exits
rather than serving requests from a half configured process.

```
src/config/          settings, driven by the single PROD switch
src/core/            framework free utilities
src/infrastructure/  database, crypto, mail, AI providers
src/middleware/      cross cutting request concerns
src/modules/         feature modules: routes, controller, service, schemas
src/routes/          API composition
src/workers/         worker threads running the translation pipeline
```

A layer may call the one below it and never the reverse; `core` and `infrastructure` stay
free of Express. The reasoning is in
[`../information/architecture.md`](../information/architecture.md).

## Tests

Jest with Supertest, configured in `jest.config.js`. The suite runs against an isolated in
memory SQLite database so it needs no configuration and no network. `tests/helpers/testApp.js`
builds the **real** application; only the AI provider is substituted, by the offline mock,
so the tests exercise the production code path.

One caveat worth knowing before writing a test file: Sequelize cannot reopen a closed
connection, so call `setupTestApp` and `teardownTestApp` once at the top level of the file
rather than once per `describe`.

## Production

Set `PROD=true` and supply real secrets. The server then requires PostgreSQL, refuses any
built in credential, and fails at boot if a required secret is missing, shorter than 32
characters, or still carries the development placeholder marker — deliberately, so a
deployment fails loudly rather than running on a publicly known key. See [`env.md`](env.md)
and [`docker.md`](docker.md).
