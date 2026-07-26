'use strict';

const express = require('express');
const config = require('../config');
const asyncHandler = require('../core/asyncHandler');
const { listProviders } = require('../infrastructure/ai/providers');
const authRoutes = require('../modules/auth/auth.routes');
const accountRoutes = require('../modules/accounts/account.routes');
const namespaceRoutes = require('../modules/namespaces/namespace.routes');
const projectRoutes = require('../modules/projects/project.routes');
const fileRoutes = require('../modules/files/file.routes');

const router = express.Router();

/**
 * API surface, version one.
 *
 * Versioning the prefix means a future breaking change can ship alongside this
 * one rather than replacing it, which matters for a client that may not update
 * at the same moment as the server.
 */

/** Liveness probe. Deliberately free of any build or dependency detail. */
router.get('/health', (req, res) => {
  res.json({ data: { status: 'ok', timestamp: new Date().toISOString() } });
});

/** Provider and model catalogue for the project settings page. */
router.get(
  '/providers',
  asyncHandler(async (req, res) => {
    res.json({
      data: {
        providers: listProviders(),
        default_provider: config.ai.defaultProvider,
        default_model: config.ai.defaultModel,
      },
    });
  }),
);

router.use('/auth', authRoutes);
router.use('/settings', accountRoutes);
router.use('/namespaces', namespaceRoutes);
router.use('/projects', projectRoutes);
router.use('/files', fileRoutes);

module.exports = router;
