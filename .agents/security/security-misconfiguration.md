---
name: security-misconfiguration
description: Hardened defaults and deployment configuration rules for the LXTranslator server.
---

# Security Misconfiguration

## Boot guards

`PROD=true` makes the configuration layer refuse to start when:

- `JWT_SECRET` or `ENCRYPTION_PASSPHRASE` is missing.
- Either is shorter than 32 characters.
- Either still contains the `lxtranslator_development_` marker.
- Any required PostgreSQL setting is missing.

Failing at boot is deliberate. A deployment running on a publicly known
development key is worse than a deployment that will not start.

## Headers

`helmet` is configured with a content security policy of `default-src 'none'`,
because the API returns JSON only. Should any endpoint ever be coaxed into
returning markup, the browser refuses to execute it. `frameAncestors`,
`baseUri` and `formAction` are all `'none'`; the referrer policy is
`no-referrer`; HSTS is enabled in production only.

`x-powered-by` is disabled so the stack is not advertised.

## Cross origin

An explicit allowlist from `CORS_ORIGINS`. The origin is never reflected.
Credentials are carried in an `Authorization` header rather than a cookie, so
there is no ambient authority for a cross site request to abuse and no CSRF
token is required. **If a cookie is ever introduced, CSRF protection becomes
mandatory** and this note must be revisited.

## Proxy trust

`TRUST_PROXY` defaults to the value of `PROD`. Trusting a forwarded address
header unconditionally would let any caller spoof their address and evade rate
limiting, so it is enabled only where a proxy genuinely terminates the
connection.

## Database

Production uses PostgreSQL with TLS required and certificate validation on
(`rejectUnauthorized: true`). SQLite is development and test only. Foreign key
enforcement is switched on per connection for SQLite, which otherwise ignores it
and would silently defeat every cascade in the schema.

Production boots run `sequelize.sync()` without `alter` or `force`. Schema
changes belong in reviewed migrations.

## Container

- Runs as the unprivileged `node` user.
- Multi stage build, so no build toolchain reaches the runtime layer.
- `dumb-init` as the entry point, so SIGTERM reaches the process and the
  graceful shutdown path actually runs.
- `.dockerignore` keeps `.env`, tests, git metadata and local databases out of
  the build context.
- The Kubernetes example sets `readOnlyRootFilesystem`, drops all capabilities
  and disallows privilege escalation.

## Checklist before deploying

- [ ] `PROD=true`
- [ ] Both secrets generated from a cryptographic source, at least 32 characters
- [ ] `CORS_ORIGINS` set to the real client origin only
- [ ] `TRUST_PROXY=true` behind a load balancer, and TLS terminated in front
- [ ] `PG_SSL=true`
- [ ] `MAIL_TRANSPORT=smtp` with real credentials
- [ ] A real AI provider selected, since the mock performs no translation
- [ ] `LOG_LEVEL=info`, never `debug`, which logs reset links
