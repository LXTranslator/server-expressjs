import config from './config';
import logger from './core/logger';
import createApp from './app';
import { connectDatabase, syncDatabase, closeDatabase } from './infrastructure/database/sequelize';
import { translationPool } from './workers/pool';
import * as usageService from './modules/usage/usage.service';
import { purgeExpiredTokens } from './modules/auth/token.service';
import { purgeExpiredChallenges } from './modules/auth/mfa.service';
import { purgeExpiredStates } from './modules/auth/oauth.service';

// Loading the model registry applies every association before the first query.
import './infrastructure/database/models';

/**
 * Process entry point.
 *
 * Boots in a deliberate order: connect the database, apply the schema, start
 * the worker pool, then accept traffic. Failing any earlier step exits rather
 * than serving requests from a half configured process.
 */

/** Hourly cleanup of spent and expired action tokens. */
const TOKEN_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Starts the server.
 *
 * @returns {Promise<void>}
 */
async function start(): Promise<void> {
  await connectDatabase();
  await syncDatabase();

  translationPool.start();
  usageService.startFlushing();

  const app = createApp();
  const server = app.listen(config.app.port, config.app.host, () => {
    logger.info('Server listening.', {
      host: config.app.host,
      port: config.app.port,
      production: config.isProduction,
      dialect: config.database.dialect,
    });

    if (!config.isProduction) {
      logger.warn(
        'Running with development defaults. Set PROD=true and provide real secrets before deploying.',
        {},
      );
    }
  });

  const purgeTimer = setInterval(() => {
    purgeExpiredTokens().catch((error) =>
      logger.error('Token purge failed.', { message: error.message }),
    );
    // Expired sign in challenges ride the same timer rather than starting a
    // second one. They are short lived and small, but an abandoned sign in
    // leaves a row behind every time.
    purgeExpiredChallenges().catch((error) =>
      logger.error('Challenge purge failed.', { message: error.message }),
    );
    purgeExpiredStates().catch((error) =>
      logger.error('Provider state purge failed.', { message: error.message }),
    );
  }, TOKEN_PURGE_INTERVAL_MS);
  purgeTimer.unref();

  /**
   * Drains in flight work before exiting so a deploy does not cut a request
   * or a translation job in half.
   *
   * @param {string} signal Signal that triggered the shutdown.
   * @returns {Promise<void>}
   */
  async function shutdown(signal: string): Promise<void> {
    logger.info('Shutdown signal received.', { signal });
    clearInterval(purgeTimer);

    server.close(async () => {
      try {
        // Drained before the connection closes, so a shutdown does not throw
        // away the last few seconds of the record.
        await usageService.stopFlushing();
        await translationPool.shutdown();
        await closeDatabase();
        logger.info('Shutdown complete.', {});
        process.exit(0);
      } catch (error) {
        logger.error('Shutdown failed.', { message: (error as Error).message });
        process.exit(1);
      }
    });

    // Backstop for a connection that refuses to close.
    setTimeout(() => {
      logger.error('Shutdown timed out; exiting.', {});
      process.exit(1);
    }, 15000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// An unhandled rejection leaves the process in an unknown state, so it is
// logged and treated as fatal rather than ignored.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection.', {
    message: reason instanceof Error ? reason.message : String(reason),
  });
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception.', { message: error.message, stack: error.stack });
  process.exit(1);
});

start().catch((error) => {
  logger.error('The server failed to start.', { message: error.message, stack: error.stack });
  process.exit(1);
});
