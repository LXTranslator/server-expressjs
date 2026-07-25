---
name: Authentication Failures
description: Session handling, credential storage, lockout and single use token rules for the LXTranslator server.
---

# Authentication Failures

## Rules

1. **Passwords are bcrypt digests.** Cost 12 in production, 4 under test so the
   suite is not dominated by key derivation. Never store, log or return a
   password.
2. **Sessions are JWT bearer tokens.** Signed HS256 with issuer and audience
   both asserted on verification. Algorithm is pinned to `['HS256']`, which is
   what prevents an `alg: none` or algorithm confusion attack.
3. **The account is re-read on every request.** `src/middleware/authenticate.js`
   loads the row rather than trusting the token claims, so a deleted or locked
   account loses access immediately instead of when its token expires.
4. **Login responses do not reveal which accounts exist.** A wrong password and
   an unknown identifier return the same message, and a bcrypt comparison
   against a decoy hash runs on the miss so response timing matches.
5. **Repeated failures lock the account.** Five failures produce a fifteen
   minute lock. Both values are configurable.
6. **Short lived tokens are genuinely single use.** A JWT alone cannot do this,
   because a signed token keeps verifying until it expires. Every action token
   is recorded in `auth_tokens` and redeemed with a conditional update
   (`consumed_at IS NULL`), so exactly one of two concurrent redemptions wins.
7. **Ten minutes is fixed, not tunable.** `shortLivedTokenTtlSeconds` is a
   constant because the specification fixes it. Do not turn it into an
   environment variable.
8. **Purpose is checked on redemption.** A session token cannot be redeemed as a
   password reset, and a settings token cannot be redeemed by another account's
   session.
9. **Changing a password invalidates everything else.** `credentialsChangedAt`
   moves forward and every outstanding action token is revoked.

## When adding an authenticated route

Mount `authenticate` before the handler, then resolve access through
`namespace.service.js`. Never read an identifier from the request and query by
it directly.

## Not yet implemented

Multi factor authentication. Lockout and single use action tokens are in place;
a second factor is the natural next step for a financial deployment and is
recorded in `wiki/requirements.md` as out of scope for this iteration.
