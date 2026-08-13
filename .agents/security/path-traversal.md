---
name: path-traversal
description: Keep every filesystem operation inside the storage root in the LXTranslator server.
---

# Path Traversal Prevention

## Two independent defences

Both are applied. Either alone would be a single point of failure.

### 1. The client filename never becomes a path

`sanitizeFilename` in `src/core/filename.js`:

- Rejects a null byte outright, because it can truncate a name inside a C level
  filesystem call.
- Converts backslashes to forward slashes before taking the basename, so
  `..\evil` is handled on a POSIX server rather than passing through intact.
- Rejects any remaining separator or `..` after flattening.
- Rejects leading dots, control characters and Windows reserved device names.
- Enforces a length ceiling and an extension allowlist.

Stored files are named with a generated UUID regardless, so the sanitised name
is display metadata and never reaches a path join.

### 2. Every resolved path is proven contained

`resolveWithinDirectory(directory, candidate)` resolves both sides and asserts
the result sits inside the root:

```js
resolved === root || resolved.startsWith(root + path.sep)
```

The separator suffix matters. A naive `startsWith(root)` would wrongly accept
`/data/storage_evil` for a root of `/data/storage`. There is a test for exactly
that case.

## Rules

1. **Never call `fs` with a request derived path.** Route it through
   `resolveWithinDirectory` first.
2. **Never `path.join` a client filename.** Use a generated identifier.
3. **Locale codes reach filenames, so validate them.** `LANG_CODE_PATTERN`
   restricts them to lowercase letters, digits and a single underscore before
   they are used in a `Content-Disposition` header, an export filename or a ZIP
   entry name. The language part is two to eight letters rather than exactly
   two, because many translatable locales have no two letter code; that widens
   which names are accepted but not which characters, which is the part that
   matters here. Never relax the character set.
4. **Adding a new filesystem operation?** Add a containment test alongside it.
