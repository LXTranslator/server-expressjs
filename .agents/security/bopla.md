---
name: Broken Object Property Level Authorization
description: Prevent mass assignment and excessive data exposure in the LXTranslator server.
---

# Broken Object Property Level Authorization

Two failure modes: accepting a property the caller should not be able to set,
and returning a property the caller should not be able to read.

## Mass assignment

1. **Every request schema is `.strict()`.** An undeclared field fails validation
   with 422 rather than being silently ignored. This is what stops a
   registration payload from carrying `type: "ORG"` or a membership payload from
   carrying an unexpected privilege field.
2. **Validation replaces the payload.** `src/middleware/validate.js` assigns the
   parsed result over `req.body`, so a handler sees only declared fields even if
   the schema were loosened later.
3. **Never spread a request body into a model.** Build the update object field
   by field:

   ```js
   // Wrong.
   await account.update(req.body);

   // Right.
   await account.update({
     ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
   });
   ```

4. **Privileged columns are set by the server, never by the payload.** `type` is
   hard coded to `USER` on registration. `role` comes from an enum and is
   additionally capped by the caller's own rank.

## Excessive data exposure

1. **Serialisation is an explicit allowlist.** Every model has a
   `toPublicJson`, and some have a narrower `toMemberJson`. Never return a model
   instance directly; a column added later would leak by simply existing.
2. **`password_hash` appears in no serializer.**
3. **`api_key` is excluded from every default query** by the model's
   `defaultScope`, so reading it requires the explicit `withSecret` scope.
   Responses carry `masked_key` instead.
4. **Organization members see less than owners do.** `toMemberJson` omits the
   email address.

## When adding a column

Decide immediately whether it belongs in `toPublicJson`. If it is sensitive, add
it to the model's excluded attributes and to the logger's redaction list at the
same time.
