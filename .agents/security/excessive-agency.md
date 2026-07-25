---
name: Excessive Agency
description: Keep the AI model constrained to producing text with no ability to act in the LXTranslator server.
---

# Excessive Agency

## The current boundary

The model in this system has exactly one capability: **return an array of
translated strings**. It cannot:

- Call a tool or a function.
- Read or write the database.
- Read or write the filesystem.
- Make a network request.
- Choose which provider or credential is used.
- Decide what gets translated, or into which languages.

Every one of those decisions is made by application code before the provider is
ever contacted. The model is a pure text transformer at the end of a fixed
pipeline.

## Rules

1. **Do not add tool calling or function calling to the translation path.**
   Translation does not need it, and adding it would turn a text transformer
   into an actor with reach into the system.
2. **The reply is validated before it is used.** An array of strings of the
   expected length, or the batch fails. Never write an unvalidated model
   response into the database.
3. **The model never selects a destination.** Provider endpoints are constants
   and the registry is fixed. See `ssrf.md`.
4. **The model never influences authorization.** Access decisions are made
   before any provider call and are never revisited afterwards.
5. **Human review is available and protected.** The translation editor lets a
   person correct any output, and a corrected row is flagged `is_manual` so a
   later pipeline run leaves it alone. That is the human in the loop for this
   system.

## If an agentic feature is ever proposed

Before adding anything that lets a model trigger an action:

- Enumerate exactly which operations it could invoke.
- Require explicit human approval for anything that writes, deletes or spends.
- Scope its credentials to the minimum, never the project's own provider keys.
- Log every invocation with its inputs.
- Write this file's replacement first, then the feature.
