---
name: Injection Prevention
description: Prevent SQL, command and prototype pollution injection in the LXTranslator server.
---

# Injection Prevention

## SQL

1. **All database access goes through Sequelize.** Values are bound as
   parameters, never interpolated into SQL text.
2. **Never build a query with string concatenation or a template literal.** If a
   raw query is genuinely unavoidable, use `sequelize.query` with `replacements`
   or `bind`, never an interpolated string.
3. **Never place user input into `order` or `attributes`.** Those are rendered
   as identifiers, not bound values. Map a user supplied sort key through an
   allowlist first.
4. **Operators come from the `Op` symbols.** Do not accept an operator name from
   a request payload.

## Operating system commands

The server executes no shell commands. If one ever becomes necessary, use
`child_process.execFile` with an argument array, never `exec` with a composed
string, and validate every argument against an allowlist first.

## Prototype pollution

Uploaded JSON is attacker controlled and is walked key by key, which makes
prototype pollution a live risk rather than a theoretical one.

1. `src/core/jsonTree.js` rejects the key segments `__proto__`, `constructor`
   and `prototype` on both flatten and expand.
2. `expandTranslationTree` builds its intermediate objects with
   `Object.create(null)`, so a write cannot reach `Object.prototype` even if a
   guard were bypassed.
3. Never write to an object using a key taken straight from user input without
   passing it through `assertSafeSegment`.

## Header injection

`src/infrastructure/email/mailer.js` rejects carriage returns and newlines in
recipient addresses and subject lines, because either would let an attacker
append arbitrary SMTP headers.

Download filenames are built from a locale code that has already passed a strict
pattern, so a response header cannot be split.

## Verification

```bash
npm test                                    # includes prototype pollution tests
git grep -nE "sequelize\.query\(\`|\\\$\{.*\}.*FROM"   # must return nothing
```
