'use strict';

const { Account } = require('../infrastructure/database/models');
const { verifyAccessToken } = require('../modules/auth/token.service');
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
 * Requires a valid session and attaches the account to the request.
 *
 * The account is re-read on every request rather than trusted from the token
 * claims, so a deleted or locked account loses access immediately instead of
 * when its token happens to expire.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const token = readBearerToken(req);
  if (token === null) {
    throw new UnauthorizedError('A bearer token is required.');
  }

  const claims = verifyAccessToken(token);
  const account = await Account.findByPk(claims.sub);

  if (account === null) {
    throw new UnauthorizedError('The account for this session no longer exists.');
  }

  if (account.lockedUntil !== null && account.lockedUntil > new Date()) {
    throw new UnauthorizedError('This account is temporarily locked.');
  }

  req.account = account;
  req.tokenClaims = claims;
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
    const claims = verifyAccessToken(token);
    const account = await Account.findByPk(claims.sub);
    if (account !== null) {
      req.account = account;
      req.tokenClaims = claims;
    }
  } catch {
    // A bad token is treated as no token on optional routes.
  }

  next();
});

module.exports = { authenticate, optionalAuthenticate, readBearerToken };
