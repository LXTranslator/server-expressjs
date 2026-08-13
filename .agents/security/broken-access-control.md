---
name: broken-access-control
description: Deny by default authorization enforced through namespace resolution in the LXTranslator server.
---

# Broken Access Control

## The model

Everything in this system hangs off a namespace account, so authorization
reduces to one question: may this account act on this namespace, and at what
role? Answering it in one place is what keeps the rule consistent.

```
resolveNamespaceAccess(account, identifier)  ->  { namespace, role }
resolveProjectAccess(account, projectId)     ->  resolves upward to the above
resolveFileAccess(account, fileId)           ->  resolves upward to the above
```

All three live in `src/modules/namespaces/namespace.service.js`.

## Rules

1. **Deny by default.** Access requires either owning the personal namespace or
   holding a membership row. Nothing is inferred from the request.
2. **Resolve upward, never sideways.** A project is fetched, then its namespace
   is authorised. Never query by an identifier taken from the request and assume
   ownership.
3. **Resolve once per route tree.** Both the namespace and project routers
   resolve access in a `router.use` and attach the result to the request. Do not
   repeat the check inside a handler; repetition is where inconsistencies start.
4. **Return 404, not 403, when a 403 would confirm existence.** A caller who is
   not a member of an organization is told it does not exist.
5. **Roles are ranked, and rank is compared, not equality.**
   `assertRole(role, required)` uses `ROLE_RANK`. `OWNER` outranks `ADMIN`
   outranks `MEMBER`.
6. **Nobody grants a role above their own.** Checked on both invitation and role
   change.
7. **An organization always keeps one owner.** Removal and demotion both count
   remaining owners first.
8. **Scope every write by its parent.** Credential and file updates carry the
   `projectId` in the `where` clause, so a guessed identifier from another
   project matches nothing.

## When adding a route

- Mount it under a router that already resolves access, or resolve explicitly.
- Decide the minimum role and call `assertRole`.
- Add a test that a non member receives 404 and that a plain member cannot
  perform a privileged action. `tests/access.test.js` is the pattern.
