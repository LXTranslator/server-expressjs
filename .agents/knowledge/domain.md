---
name: Translation Domain
description: Concepts and invariants an agent must understand before changing the LXTranslator server.
---

# Translation Domain

## Vocabulary

| Term | Meaning |
|---|---|
| **Namespace** | An account that owns projects. Either a person (`USER`) or an organization (`ORG`). There is no separate users table. |
| **Project** | A collection of translation files sharing one AI provider, one model and one set of credentials. Belongs to exactly one namespace. Its **name** is unique only within that namespace; its **id** is an integer from a sequence shared by every project in the system. |
| **File** | One uploaded locale document, for example `en_us.json`. |
| **Translation key** | One translatable string, addressed by a dot separated path such as `greeting.hello`. |
| **Master** | The English (`en_us`) text. Every other language is derived from it. |
| **Text hash** | A deterministic 36 character fingerprint of the master text, used to detect that a source string has changed. |
| **Stale translation** | A translation whose recorded `source_hash` no longer matches its key's current `text_hash`. |

## Invariants

Breaking any of these is a defect, not a design choice.

1. **English is always the master.** A non English upload is translated into
   `en_us` first, and every target language is derived from that master rather
   than from the original upload. Translating Thai to Japanese via English is
   more predictable than translating arbitrary pairs.
2. **`text_hash` is exactly 36 characters and deterministic.** The same source
   text always produces the same hash. It is a change detection fingerprint,
   never a security primitive.
3. **Exported leaves carry both value and hash.**

   ```json
   { "hello": { "value": "สวัสดี", "hash": "123e4567-e89b-12d3-a456-426614174000" } }
   ```

4. **Nesting round trips.** A key uploaded as `{"greeting": {"hello": "..."}}`
   is stored as `greeting.hello` and exported nested again.
5. **A manual edit outranks a machine rerun**, unless the master text itself
   changed, in which case the edit is already stale.
6. **Editing the master restamps its hash**, which is precisely how derived
   translations become visibly stale.
7. **The master locale is never a target.** It is the source of the fan out
   step, so it is filtered out of the target list.
8. **A file grows, it does not get rewritten.** Adding a language translates the
   existing keys into that language alone. Merging a dropped document adds only
   the key names the file lacks; a key it already holds is skipped whole, master
   text and translations included, even when the document carries a different
   value for it. Both rules exist so that later work never costs earlier work,
   and both are enforced in the worker so a skipped key is never sent to a
   provider at all.

## Pipeline order

```
parse -> flatten -> normalise to en_us (if needed) -> hash -> fan out
```

Never reorder these. Hashing before normalisation would fingerprint the wrong
text, and every staleness comparison downstream would be meaningless.

## Where the work runs

Everything after parsing runs on a worker thread. The worker performs no
database access at all: it receives a self contained job and returns a plain
result, and the main thread writes it in one transaction. Keep it that way;
opening a connection inside a worker would put a pool in every thread.

## Common mistakes

- Translating a target language from the original upload instead of the master.
- Adding the master locale to its own target list.
- Computing the hash from the uploaded text rather than the English master.
- Overwriting a manual correction on a rerun.
- Returning a decrypted API key in a response, in any endpoint, at any role.
- Doing pipeline work on the main thread.
