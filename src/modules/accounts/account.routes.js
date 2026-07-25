'use strict';

const express = require('express');
const asyncHandler = require('../../core/asyncHandler');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { authLimiter } = require('../../middleware/rateLimit');
const schemas = require('./account.schemas');
const service = require('./account.service');

const router = express.Router();

/**
 * Account settings routes, backing the client's `/settings` page.
 *
 * The sensitive changes follow a two step flow: confirm the current password to
 * mint a ten minute single use token, then spend it on one change.
 */

router.use(authenticate);

/** Returns the signed in account. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ data: { account: req.account.toPublicJson() } });
  }),
);

/** Step one: exchange the current password for a settings token. */
router.post(
  '/confirm',
  authLimiter,
  validate(schemas.confirmPasswordSchema),
  asyncHandler(async (req, res) => {
    const result = await service.issueSettingsToken(req.account, req.body);
    res.json({ data: result });
  }),
);

/** Step two, variant one: change the routing user id. */
router.patch(
  '/identifier',
  validate(schemas.updateUserIdSchema),
  asyncHandler(async (req, res) => {
    const account = await service.updateUserId(req.account, req.body);
    res.json({ data: { account } });
  }),
);

/** Step two, variant two: change the email address. */
router.patch(
  '/email',
  validate(schemas.updateEmailSchema),
  asyncHandler(async (req, res) => {
    const account = await service.updateEmail(req.account, req.body);
    res.json({ data: { account } });
  }),
);

/** Step two, variant three: change the password. */
router.patch(
  '/password',
  validate(schemas.updatePasswordSchema),
  asyncHandler(async (req, res) => {
    const result = await service.updatePassword(req.account, req.body);
    res.json({ data: result });
  }),
);

/** Display fields only, so no settings token is required. */
router.patch(
  '/profile',
  validate(schemas.updateProfileSchema),
  asyncHandler(async (req, res) => {
    const account = await service.updateProfile(req.account, req.body);
    res.json({ data: { account } });
  }),
);

module.exports = router;
