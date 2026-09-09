# 0.25.0

Two new ways to prove who you are, and a filesystem write that had never once run.

The server gains a TOTP second factor and provider sign in through github.com and
gitlab.com. Both are configured entirely by environment variable, and a deployment that
sets neither behaves exactly as it did at 0.24.0 — nothing here is required, in any mode.

`wiki/information/requirements.md` listed single sign on and multi factor authentication
under **Out of scope** at 0.24.0. Both lines are gone, replaced by the requirements that
now describe them.

## Added

- `src/core/totp.js` — RFC 6238 over RFC 4226, written against Node's `crypto` rather
  than installed. SHA-1, six digits, a thirty second period and one step of drift, which
  is what an authenticator app implements. Checked against every SHA-1 vector in RFC 6238
  appendix B, including the one whose counter exceeds 32 bits.
- `src/infrastructure/oauth/providers/` — a frozen registry with adapters for github.com,
  gitlab.com and an offline mock. Every endpoint is a constant inside its adapter, so a
  tampered row can select a different adapter but never introduce a new endpoint. The mock
  is registered only outside production, and is what keeps `npm test` free of the network
  on a clean clone.
- `src/modules/auth/mfa.*` and `src/modules/auth/oauth.*` — the two feature modules,
  mounted under `/auth` by `auth.routes.js`.
- Five tables: `account_mfa`, `account_recovery_codes`, `mfa_challenges`, `oauth_states`
  and `account_identities`. New tables rather than new columns, deliberately — see
  **Notes** below.
- `AUTHENTICATION_NAME`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
  `GITLAB_OAUTH_CLIENT_ID` and `GITLAB_OAUTH_CLIENT_SECRET`, all optional.
- `tests/twoFactor.test.js` and `tests/oauth.test.js`, and an `archived uploads` group in
  `tests/security.test.js`. The suite is 560 tests across 19 files, up from 507 across 17.

## Changed

- `src/modules/auth/auth.service.js` — `completeSignIn` is now the single gate every sign
  in passes through, whatever proved the identity. A provider callback that minted its own
  session would walk straight past the second factor, and this is the structural defence
  against that rather than a convention to remember.
- `POST /auth/login` answers **200** with a challenge and no session when a second factor
  is confirmed. Not 401: the credentials were correct, and a client that treats 401 as
  "signed out" would discard the challenge it was just handed. The account is absent from
  that response, because it carries the email address.
- Wrong second factor codes draw on the same lockout budget as wrong passwords. A separate
  budget would hand somebody who already holds the password a fresh set of guesses.
- `src/core/filename.js` — uploaded filenames are validated against
  `SAFE_UPLOAD_STEM_PATTERN`, which forbids a dot in the stem, so `evil.php.json` and
  `report.html.json` are refused. Download names keep the looser `SAFE_STEM_PATTERN`,
  which legitimately produces a dotted stem such as `everything.json.zip`. **An upload
  named `en_us.v2.json` is now refused**, which is the cost of the rule.
- `src/middleware/upload.js` — `parts` and `headerPairs` ceilings are stated rather than
  left implied by the file and field limits.
- `src/core/logger.js` — `verifier` and `recoverycode` join the redaction list. A bare
  `code` would have been far too broad: it would redact every language code, status code
  and error code the logs exist to show.

## Fixed

- **The only filesystem write in the application had never executed.**
  `persistRawUpload` was called with `project.id`, a `DataTypes.INTEGER`, so
  `path.resolve(root, 7)` threw a `TypeError` before the containment guard ran. The
  surrounding catch swallowed it by design, the suite runs at `LOG_LEVEL=silent`, and
  nothing asserted that a file reached disk. The guard `security/path-traversal.md` calls
  one of two mandatory defences was dead code on the one path that used it. Reverting the
  fix now fails four tests.
- An archived upload is named after its `File` row and removed when that row is deleted.
  Previously the name was a fresh UUID nothing recorded, so every deleted file left its
  copy behind for the life of the deployment.
- `package-lock.json` carried `"version": "0.21.0"`, three minor versions behind
  `package.json`.

## Security

Every dependency moved to its latest version, and `npm audit` reports **0 vulnerabilities**
where it previously reported five, four of them high. None of these were introduced by this
release; they were published against the existing tree since the last clean audit.

- `multer` 2.2.0 to 2.3.0, clearing four high advisories on the upload path this release
  also hardens — among them a file size limit bypass through an async `fileFilter` race.
- `nodemailer` 9.0.3 to 10.0.1, a major. No test exercises it, since the suite runs the
  console transport, so it was verified by running the calls `mailer.js` actually makes.
- `zod` 4.5.4, `jest` 30.5.1, `pg` 8.23.0, `express-rate-limit` 8.7.0.
- Overrides: `brace-expansion` raised to `^5.0.9` — its previous `^5.0.8` ceiling was
  itself the vulnerable version — plus `qs` at `^6.16.0`, pinned by express and the only
  one of these that reaches production, and `js-yaml` at `^5.4.1`.

## Notes

**Why five new tables and no new columns.** Production runs bare `sequelize.sync()`, which
issues `CREATE TABLE IF NOT EXISTS` and nothing else. It adds no column to a table that
already exists, and it does not `ALTER TYPE` an ENUM. Columns on `accounts`, or a new
value in `auth_tokens.purpose`, would have worked on every fresh database and in every
test, and then failed on the first insert against a real deployment. For the same reason
the `provider` and `mode` columns on the new tables are `STRING` with validation rather
than `ENUM`: an ENUM here could never gain a third provider later.

**A password reset does not clear the second factor.** It would be natural to add it to
the list of things a reset revokes. Doing so would make the second factor exactly as
strong as the mailbox it exists to survive.

**Provider sign in is linking only.** An identity nobody has linked is refused: no account
is created, and none is matched by the email address a provider reports. An account made
here would have no password, and one matched by email would belong to whoever controls
that mailbox at the provider.

**Self hosted GitLab and GitHub Enterprise Server are not supported.** Both would need a
configurable provider base URL, which NFR-13 refuses.
