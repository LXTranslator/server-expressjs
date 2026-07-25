---
name: Broken Object Level Authorization
description: Verify ownership of every referenced record on every API call in the LXTranslator server.
---

# Broken Object Level Authorization

The silent identifier swap: a caller changes a UUID in a URL and reaches a
record belonging to somebody else. Every endpoint that accepts an identifier is
a candidate.

## Rules

1. **Never query by a request identifier alone and return the result.** Always
   resolve ownership first.

   ```js
   // Wrong: any authenticated caller reaches any project.
   const project = await Project.findByPk(req.params.projectId);

   // Right: resolves upward to the namespace and authorises it.
   const { project } = await namespaceService.resolveProjectAccess(
     req.account,
     req.params.projectId,
   );
   ```

2. **Scope nested writes by their parent.** Updating a credential filters on
   both the key id and the project id, so an identifier from another project
   matches nothing:

   ```js
   ProjectApiKey.findOne({ where: { id: keyId, projectId } })
   ```

   The same pattern applies to translations, which are scoped by their file, and
   to memberships, which are scoped by their organization.

3. **404, not 403.** When a 403 would confirm that a record exists, return 404.

4. **Resolve in middleware, not in handlers.** Both routers resolve once in a
   `router.use`. A handler that does its own lookup is a defect.

## Endpoints that carry an identifier

| Identifier | Resolver |
|---|---|
| `:namespace` | `resolveNamespaceAccess` |
| `:projectId` | `resolveProjectAccess` |
| `:fileId` | `resolveFileAccess` |
| `:keyId` | Scoped by `projectId` in the query |
| `:translationId` | Scoped by `fileId` through its key |
| `:memberId` | Scoped by `orgAccountId` in the query |

## Verification

`tests/access.test.js` asserts that an unrelated account receives 404 for
another namespace's projects, credentials, files and uploads. Add a case there
for every new identifier bearing route.
