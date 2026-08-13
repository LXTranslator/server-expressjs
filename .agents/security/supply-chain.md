---
name: supply-chain
description: Dependency selection, pinning and auditing rules for the LXTranslator server.
---

# Software Supply Chain

## Current state

The tree audits clean at every severity:

```bash
npm audit          # found 0 vulnerabilities
npm outdated       # empty
```

Three transitive packages are held at fixed versions through `overrides` in
`package.json` because their parents ship outdated ranges:

```json
"overrides": {
  "brace-expansion": "^5.0.8",
  "tar": "^7.5.22",
  "uuid": "^11.1.1"
}
```

Removing these reintroduces known advisories, including a critical arbitrary
file write in `tar`. Do not drop them without confirming the parent packages
have caught up.

## Rules

1. **`package-lock.json` is committed and installs use it.** The Docker build
   runs `npm ci`, which installs exactly what the lockfile pins. A build must
   never resolve a different tree than the one that was tested.
2. **Install scripts are disabled in the image build** with `--ignore-scripts`,
   so a compromised package cannot execute code during deployment.
3. **Audit before merging a dependency change.** `npm run audit:security` fails
   at high severity.
4. **Prefer fewer dependencies.** Every addition is a trust decision. The mailer
   loads `nodemailer` lazily so a deployment that never sends mail does not pay
   for it at boot.
5. **Justify each direct dependency.** The current set is deliberately small:
   express, sequelize, sqlite3, pg, jsonwebtoken, bcryptjs, multer, zod, helmet,
   cors, express-rate-limit, dotenv, nodemailer.
6. **Pin the base image by release tag, and prefer a digest** for production
   builds so a rebuild cannot silently pull different bytes.

## Written here rather than installed

`src/core/zip.js` builds the archive download. It is roughly two hundred lines
against a dependency that would pull a tree of its own, and the hard part,
DEFLATE, already ships in Node's `zlib`. The archive this application produces
is the simple case of the format: a few small text entries, written in one pass,
held in memory.

It refuses rather than guesses on everything it does not implement, including
ZIP64 sizes, entry counts above 65535, duplicate names and any entry name that
is absolute, traverses upward or carries a null byte. `tests/archive.test.js`
reads the bytes back the way an extractor does and recomputes every checksum,
so a format defect fails the suite rather than somebody's download.

## When adding a dependency

- Check its download volume, release recency and open advisory count.
- Prefer a standard library equivalent where one exists. Node's `crypto`,
  `worker_threads` and `fetch` removed the need for three packages here.
- Run `npm audit` and update this file if a new override becomes necessary.

## Recommended additions

Generate a software bill of materials in CI (`npm sbom --sbom-format cyclonedx`)
and archive it with each release, so a future advisory can be traced to the
exact deployed tree.
