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
3. **A valid signature is not enough.** Every session also has a row in
   `account_sessions`, and `authenticate` requires that row to still be live.
   This is what makes revocation possible: a signed token cannot be taken back,
   so signing out, ending one device and "sign out everywhere else" all work by
   marking a row rather than by hoping a client forgets something. A token whose
   row is revoked or expired is a 401 however well it verifies.
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
   moves forward, every outstanding action token is revoked, and every other
   session ends. A settings change keeps the session that made it, so the person
   is not signed out of the screen they just used. A reset keeps nothing at all,
   because a reset is the flow for a password somebody may have lost control of.
10. **Many sessions per account is the ordinary case.** A laptop, a phone and a
   second browser profile are three rows. Nothing may assume one session per
   account, and revoking one must never touch another.
11. **An API token is opaque, and that is the point.** A signed token verifies
   without asking anything, which is the wrong trade for a credential that may
   live a year: its life cannot be shortened once it is out. An opaque token
   means every request consults the row, so revoking one takes effect on the
   next call. Never reissue these as JWTs.
12. **A token cannot manage tokens.** Creating and revoking both require a
   signed in session. A token that can mint tokens can replace itself, and
   revoking the original would achieve nothing.
13. **A token is returned exactly once.** Only a digest and the last four
   characters are stored. There is no endpoint that shows one again, and adding
   one would mean storing something worth stealing.
14. **A session stores a digest, never a token.** Same rule as the action token
   ledger, and it matters more here because these live longer. What is stored
   alongside it is deliberately minimal: the client string, so a list is
   actionable, and not the address, which locates a person and answers the same
   question worse.

## When adding an authenticated route

Mount `authenticate` before the handler, then resolve access through
`namespace.service.js`. Never read an identifier from the request and query by
it directly.

## Not yet implemented

Multi factor authentication. Lockout and single use action tokens are in place;
a second factor is the natural next step for a financial deployment and is
recorded in `wiki/requirements.md` as out of scope for this iteration.
