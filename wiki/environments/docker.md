# Docker

The image is built in two stages so the runtime layer carries no build toolchain. It runs
as an unprivileged user and ships no secrets: every production value arrives from the
environment at run time.

## Building

```bash
docker build -t lxtranslator-server .
```

The dependency stage installs the compiler toolchain, runs `npm ci --omit=dev
--ignore-scripts`, and then rebuilds the SQLite driver from source. That rebuild is not
optional:

> `sqlite3` publishes prebuilt binaries linked against a newer glibc than the
> `node:22-bookworm-slim` base carries. Accepting one produces an image that builds
> cleanly and then dies at boot on `GLIBC_2.38 not found`. Compiling the addon in the
> image it will actually run on is what keeps the two in step across a base image change.

Nothing from that stage reaches the runtime layer except `node_modules`.

## Running

```bash
docker run -p 4000:4000 \
  -e PROD=true \
  -e DATABASE_URL=postgres://... \
  -e JWT_SECRET=... \
  -e ENCRYPTION_PASSPHRASE=... \
  -v lxtranslator-storage:/app/storage \
  lxtranslator-server
```

The container listens on **4000** and runs as the image's unprivileged `node` user.

With `PROD=true` the server requires PostgreSQL and refuses to boot on a missing, short,
or placeholder secret. The full variable list is in [`env.md`](env.md).

## What the image sets up

| Concern | How |
|---|---|
| Signals | `dumb-init` is the entrypoint, so it reaps zombies and forwards SIGTERM — without it the graceful shutdown path never runs. |
| User | Runs as `node`. The base image ships the account, so none is created. |
| Defaults | `NODE_ENV=production`, `PORT=4000`, `HOST=0.0.0.0`. |
| Health | A healthcheck polls `/api/v1/health` every 30s, so an orchestrator can replace a container that has stopped answering instead of leaving it in rotation. |
| Writable paths | `/app/data` and `/app/storage` are created and owned by `node`. |

## Volumes

`/app/data` holds the SQLite file and `/app/storage` holds uploaded artefacts. **In
production both should be mounted volumes rather than image layers** — anything written
into the container filesystem is lost when it is replaced. With `PROD=true` the database
lives in PostgreSQL and only `/app/storage` still needs to persist.
