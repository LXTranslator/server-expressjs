'use strict';

/**
 * Namespace identifiers the client cannot route to.
 *
 * A namespace occupies the first path segment of a client URL, so `/orgA` is
 * the organization `orgA`. Any account named after a path the client or its
 * static server already claims would be unreachable, because the fixed route
 * matches first and the account's pages never render.
 *
 * They are refused when the identifier is chosen rather than left to collide
 * afterwards, when the account exists, holds projects, and renaming it is the
 * only remedy.
 *
 * This list holds only genuine collisions, not vanity reservations: the client
 * routes `/login`, `/register`, `/settings`, `/namespaces` and
 * `/organizations`, and its static server answers `/api/` and `/assets/` before
 * the application sees them. Paths containing a hyphen, such as
 * `/forgot-password`, cannot collide, since an identifier may not contain one.
 *
 * Keep this in step with the client route table and its nginx configuration.
 */
const RESERVED_IDENTIFIERS = Object.freeze([
  'api',
  'assets',
  'login',
  'namespaces',
  'organizations',
  'register',
  'settings',
]);

/**
 * Reports whether an identifier is reserved for a client path.
 *
 * @param {string} value Candidate identifier.
 * @returns {boolean} True when the identifier may not be used.
 */
function isReservedIdentifier(value) {
  if (typeof value !== 'string') return false;
  return RESERVED_IDENTIFIERS.includes(value.trim().toLowerCase());
}

module.exports = { RESERVED_IDENTIFIERS, isReservedIdentifier };
