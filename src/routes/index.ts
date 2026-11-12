import express from 'express';
import config from '../config';
import asyncHandler from '../core/asyncHandler';
import { listProviders } from '../infrastructure/ai/providers';
import authRoutes from '../modules/auth/auth.routes';
import accountRoutes from '../modules/accounts/account.routes';
import namespaceRoutes from '../modules/namespaces/namespace.routes';
import projectRoutes from '../modules/projects/project.routes';
import fileRoutes from '../modules/files/file.routes';

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

export default router;
