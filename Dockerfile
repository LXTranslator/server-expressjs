# syntax=docker/dockerfile:1

# LXTranslator server image.
#
# Multi stage so the runtime layer carries no build toolchain. The image runs as
# an unprivileged user and ships no secrets: every production value arrives from
# the environment at run time. See wiki/environment.md.

# Pinned to a digest tagged release rather than a floating tag, so a rebuild
# cannot silently pull a different base.
FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

# Toolchain for compiling the SQLite driver below. It exists in this stage only,
# so nothing of it reaches the runtime layer.
RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copied on their own so the dependency layer is reused whenever only source
# files change.
COPY package.json package-lock.json ./

# `npm ci` installs exactly what the lockfile pins, which is what makes the
# build reproducible and blocks an unexpected transitive upgrade.
#
# sqlite3 publishes prebuilt binaries built against a newer glibc than this base
# image carries, so accepting one produces an image that builds cleanly and then
# dies at boot on `GLIBC_2.38 not found`. Compiling the addon here links it
# against the glibc of the image it will actually run on, which is the only way
# the two stay in step across a base image change.
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild sqlite3 --build-from-source \
  && npm cache clean --force


FROM node:22-bookworm-slim AS runtime

# Non root by default. The node image ships an unprivileged `node` user, so no
# account needs to be created here.
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# `dumb-init` reaps zombies and forwards signals, so SIGTERM reaches the process
# and the graceful shutdown path actually runs.
RUN apt-get update \
  && apt-get install --no-install-recommends -y dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Writable locations for the SQLite file and uploaded artefacts. In production
# these should be mounted volumes rather than image layers.
RUN mkdir -p /app/data /app/storage && chown -R node:node /app/data /app/storage

USER node

EXPOSE 4000

# Reports unhealthy if the process stops answering, so an orchestrator can
# replace the container instead of leaving it in the rotation.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
