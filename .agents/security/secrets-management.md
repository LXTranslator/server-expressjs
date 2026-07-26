---
name: Secrets Management
description: Prevent API keys, passwords and tokens from being written into source, logs or responses in the LXTranslator server.
---

# Secrets Management

## Rules

1. **Never write a credential into source.** Every sensitive value is read
   through `src/config/`, which resolves it from the environment.
2. **`.env` is excluded from version control.** It is listed in `.gitignore` and
   `.dockerignore`. Never commit one, and never add an example file carrying a
   realistic value.
3. **Development defaults are the single exception, and they are contained.**
   `src/config/defaults.js` holds publicly known placeholders so the server runs
   with no configuration. Every one carries the marker
   `lxtranslator_development_`, and `src/config/index.js` refuses to boot when
   `PROD=true` if any is still in use. Do not remove those guards, and do not
   add a default that lacks the marker.
4. **Provider API keys are user data, not configuration.** They arrive through
   the API, are encrypted with `encryptSecret` before they touch the database,
   and are decrypted in exactly one function, `loadDecryptedKeys`.
5. **No endpoint returns a key.** The `project_api_keys` model excludes the
   secret column from every default query through its `defaultScope`. Reading it
   requires the explicit `withSecret` scope. Client responses carry only a label
   and the last four characters.
6. **Logs are redacted at the sink.** `src/core/logger.js` replaces any field
   whose name resembles a password, token, key, secret or authorization header.
   Redacting centrally means a new call site cannot forget.

## When adding code

- Adding a field that holds a secret? Add its name to `REDACTED_FIELDS` in the
  logger and exclude it from the model's default scope.
- Adding an endpoint that touches credentials? Assert in a test that the
  response body does not contain the plaintext, as
  `tests/security.test.js` does.
- Needing a new production secret? Add it to `requireString` handling in the
  config, document it in `wiki/environment.md` with a `your_*` placeholder, and
  never give it a default.

## Verification

```bash
npm test                       # includes credential exposure tests
git grep -nE "sk_live|sk-ant-|-----BEGIN"   # must return nothing
```
