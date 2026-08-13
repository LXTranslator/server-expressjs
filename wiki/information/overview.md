# Overview

The backend for LXTranslator, a translation management application. It accepts JSON
locale files, normalises them to an English master, translates them into any number of
target languages through a configurable AI provider, and serves the results back as
downloadable locale files with change tracking built in.

Every authorization decision in the product is made here. The web interface,
`LXTranslator/client-reactjs`, renders what this server allows and decides nothing on its
own.

## Who it is for

Teams who ship software in more than one language and want their locale files translated,
corrected and tracked in one place — with enough bookkeeping to know which translations
went stale when the English changed.

## What it does

* **Namespaces instead of users.** An account is a namespace and is either a person or an
  organization. Projects belong to a namespace, so the same permission model covers
  individuals and teams without a separate users table.
* **English is always the master.** A file uploaded in any language is first translated
  into `en_us`, and every other language is derived from that master.
* **Change tracking.** Every master string carries a deterministic 36 character
  fingerprint, exported alongside its translation, so a consumer can tell when a source
  string has changed and a translation has gone stale.
* **API key fallback.** A namespace may hold several provider credentials in priority
  order. When one fails because it is revoked, throttled or out of quota, the next is
  tried automatically.
* **Export formats.** A configurable catalogue decides how a locale is shaped on the way
  out.
* **An assistant.** A chat that can act on a project through tools, with what it did and
  what it cost recorded per call.
* **Runs with no configuration.** A bundled offline provider and built in development
  defaults mean `npm install && npm start` works on a clean clone, with no vendor key and
  no database server.

## How it is built

Express on Node.js 20 or newer, CommonJS, with Sequelize over PostgreSQL in production
and SQLite otherwise. The code is layered — `config`, `core`, `infrastructure`,
`middleware`, `modules`, `routes`, `workers` — and a layer may call the one below it and
never the reverse.

Heavy work runs on worker threads, so parsing, hashing and provider calls never block the
event loop. The layers, the data model and the request flow are described in
[`architecture.md`](architecture.md); the endpoints are in
[`../reference/api.md`](../reference/api.md).

## Constraints worth knowing up front

* **One switch decides everything about the environment.** `PROD=true` means PostgreSQL,
  no built in secrets, and a hard failure at boot if a required secret is missing or still
  a placeholder. See [`../environments/env.md`](../environments/env.md).
* **A decrypted API key never leaves the server**, in any endpoint, at any role.
* **Provider endpoints are constants**, never configurable, so the server cannot be
  pointed at an arbitrary host.
* **Every request schema is strict.** An undeclared field fails validation rather than
  being ignored.
