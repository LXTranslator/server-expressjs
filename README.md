# Project Overview

* **Platform:** [github.com](https://github.com)
* **Organization:** [LXTranslator](https://github.com/LXTranslator)
* **Repository:** [server-expressjs](https://github.com/LXTranslator/server-expressjs)

---

## LXTranslator Server

The backend for LXTranslator, a translation management application. It accepts
JSON locale files, normalises them to an English master, translates them into
any number of target languages through a configurable AI provider, and serves
the results back as downloadable locale files with change tracking built in.

Heavy work runs on worker threads, so parsing, hashing and provider calls never
block the event loop.

## What it does

* **Namespaces instead of users.** An account is a namespace and is either a
  person or an organization. Projects belong to a namespace, so the same
  permission model covers individuals and teams without a separate users table.
* **English is always the master.** A file uploaded in any language is first
  translated into `en_us`, and every other language is derived from that master.
* **Change tracking.** Every master string carries a deterministic 36 character
  fingerprint, exported alongside its translation, so a consumer can tell when a
  source string has changed and a translation has gone stale.
* **API key fallback.** A project may hold several provider credentials in
  priority order. When one fails because it is revoked, throttled or out of
  quota, the next is tried automatically.
* **Runs with no configuration.** A bundled offline provider and built in
  development defaults mean `npm install && npm start` works on a clean clone,
  with no vendor key and no database server.

## Quick start

```bash
npm install
npm start          # http://localhost:4000
npm test           # 82 tests, no configuration required
```

The server listens on port 4000 and stores data in a local SQLite file. Setting
`PROD=true` switches it to PostgreSQL and requires real secrets; see
[`wiki/environment.md`](wiki/environment.md).

## Documentation

| Document | Contents |
|---|---|
| [`INDEX.md`](INDEX.md) | Repository structure index. |
| [`wiki/requirements.md`](wiki/requirements.md) | Functional and non functional requirements. |
| [`wiki/api.md`](wiki/api.md) | Endpoint reference. |
| [`wiki/environment.md`](wiki/environment.md) | Environment variables and infrastructure examples. |
| [`wiki/system.md`](wiki/system.md) | Architecture, data model and request flow. |

## License

Proprietary. Reserved for the LXTranslator organization. See [`LICENSE`](LICENSE).

Created by Jetsada Wijit.
