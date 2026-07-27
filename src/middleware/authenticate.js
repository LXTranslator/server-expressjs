'use strict';

const { Account } = require('../infrastructure/database/models');
const { verifyAccessToken } = require('../modules/auth/token.service');
const sessionService = require('../modules/auth/session.service');
const apiTokenService = require('../modules/auth/apiToken.service');
const { UnauthorizedError } = require('../core/errors');
const asyncHandler = require('../core/asyncHandler');

/**
 * Extracts a bearer token from the Authorization header.
 *
 * @param {import('express').Request} req Request.
 * @returns {string|null} Raw token, or null when absent or malformed.
 */
function readBearerToken(req) {
  const header = req.get('authorization');
  if (typeof header !== 'string') return null;

  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

/**
 * Resolves a presented token to a live session and its account.
 *
 * A valid signature is not sufficient. The session it names must still exist
 * and still be live, because that is the only thing revocation can act on: a
 * signed token stays verifiable until it expires no matter who has it or what
 * the account holder has since decided.
 *
 * The account is re-read rather than trusted from the claims, so a deleted or
 * locked account loses access immediately rather than when its token happens
 * to run out.
 *
 * @param {string} token Raw bearer token.
 * @returns {Promise<{account: object, claims: object, session: object}>}
 * @throws {UnauthorizedError} When anything about it is no longer good.
 */
async function resolveToken(token) {
  /*
   * Two credential families reach this line, and which one a bearer belongs to
   * is decided by its shape before either is checked. An API token is opaque,
   * so it has no claims and is looked up by digest; a session token is signed,
   * so its signature is verified and its `jti` names its row. Neither is ever
   * run through the other's path.
   */
  if (apiTokenService.isApiToken(token)) {
    const record = await apiTokenService.resolveApiToken(token);
    if (record === null) {
      throw new UnauthorizedError('This API token is invalid, revoked or expired.');
    }

    const owner = await Account.findByPk(record.accountId);
    if (owner === null) {
      throw new UnauthorizedError('The account for this token no longer exists.');
    }
    if (owner.lockedUntil !== null && owner.lockedUntil > new Date()) {
      throw new UnauthorizedError('This account is temporarily locked.');
    }

    // No claims: an opaque token asserts nothing, and everything downstream
    // reads the account rather than the token anyway.
    return { account: owner, claims: null, session: record };
  }

  const claims = verifyAccessToken(token);

  const session = await sessionService.findLiveById(claims.jti);
  if (session === null) {
    throw new UnauthorizedError('This session has ended. Sign in again.');
  }

  const account = await Account.findByPk(claims.sub);
  if (account === null) {
    throw new UnauthorizedError('The account for this session no longer exists.');
  }

  // A session belonging to one account must never authenticate another, however
  // the two identifiers came to disagree.
  if (session.accountId !== account.id) {
    throw new UnauthorizedError('The session token is invalid or has expired.');
  }

  if (account.lockedUntil !== null && account.lockedUntil > new Date()) {
    throw new UnauthorizedError('This account is temporarily locked.');
  }

  return { account, claims, session };
}

/**
 * Requires a valid session and attaches the account to the request.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const token = readBearerToken(req);
  if (token === null) {
    throw new UnauthorizedError('A bearer token is required.');
  }

  const { account, claims, session } = await resolveToken(token);

  // Started, never awaited, and at most once a minute. Recording that a
  // session is in use must not add latency to the request that proves it.
  sessionService.touch(session).catch(() => {});

  req.account = account;
  req.tokenClaims = claims;
  req.session = session;
  next();
});

/**
 * Attaches the account when a token is present but never rejects the request.
 *
 * Used by the home route, which renders differently for a signed in visitor.
 */
const optionalAuthenticate = asyncHandler(async (req, res, next) => {
  const token = readBearerToken(req);
  if (token === null) {
    next();
    return;
  }

  try {
    const { account, claims, session } = await resolveToken(token);
    req.account = account;
    req.tokenClaims = claims;
    req.session = session;
  } catch {
    // A bad token is treated as no token on optional routes.
  }

  next();
});

module.exports = { authenticate, optionalAuthenticate, readBearerToken, resolveToken };
