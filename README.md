# Project Overview

* **Platform:** [github.com](https://github.com)
* **Organization:** [LXTranslator](https://github.com/LXTranslator)
* **Repository:** [server-expressjs](https://github.com/LXTranslator/server-expressjs)

---

## LXTranslator Server

The backend for LXTranslator, a translation management application. It accepts JSON
locale files, normalises them to an English master, translates them into any number of
target languages through a configurable AI provider, and serves the results back as
downloadable locale files with change tracking built in.

Heavy work runs on worker threads, so parsing, hashing and provider calls never block the
event loop.

## What it does

* **Namespaces instead of users.** An account is a namespace — a person or an organization
  — so one permission model covers individuals and teams.
* **English is always the master.** A file uploaded in any language is first translated
  into `en_us`, and every other language is derived from that master.
* **Change tracking.** Every master string carries a deterministic fingerprint, exported
  alongside its translation, so a consumer can tell when a translation has gone stale.
* **API key fallback.** Provider credentials are tried in priority order when one is
  revoked, throttled or out of quota.
* **Runs with no configuration.** A bundled offline provider and built in development
  defaults mean a clean clone works immediately.

## Quick start

```bash
npm install
npm start          # http://localhost:4000
npm test
```

The server listens on port 4000 and stores data in a local SQLite file. Setting
`PROD=true` switches it to PostgreSQL and requires real secrets.

## Documentation

Start here:

| Document | Contents |
|---|---|
| [`wiki/information/overview.md`](wiki/information/overview.md) | What the server is, who it is for, and what it does. |
| [`wiki/environments/setup.md`](wiki/environments/setup.md) | Local setup, the commands, and how the tests are run. |
| [`wiki/information/architecture.md`](wiki/information/architecture.md) | Layers, the data model and the request flow. |

The full map of the documentation is
[`.agents/index/project-wiki-index.md`](.agents/index/project-wiki-index.md).

## Working with agents

[`AGENTS.md`](AGENTS.md) is the entry point for AI agents working in this repository. The
organization wide conventions it relies on are not stored here — they are served by the
`lxagents-agents-base` MCP connector and resolved at session start.

## License

Proprietary. Reserved for the LXTranslator organization. See [`LICENSE`](LICENSE).

Created by Jetsada Wijit.
