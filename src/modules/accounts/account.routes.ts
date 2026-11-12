import express from 'express';
import asyncHandler from '../../core/asyncHandler';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/authenticate';
import { authLimiter } from '../../middleware/rateLimit';
import * as schemas from './account.schemas';
import * as service from './account.service';

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
    const result = await service.updatePassword(req.account, req.body, req.session?.id);
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

export default router;
