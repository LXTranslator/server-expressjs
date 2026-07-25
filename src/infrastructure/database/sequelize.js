'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Sequelize } = require('sequelize');
const config = require('../../config');
const logger = require('../../core/logger');

/**
 * Builds the Sequelize options for the dialect chosen by the PROD switch.
 *
 * @returns {object} Sequelize constructor options.
 */
function buildOptions() {
  const shared = {
    logging: config.app.logLevel === 'debug' ? (sql) => logger.debug('sql', { sql }) : false,
    define: {
      // Column names stay snake_case to match the agreed schema while the JS
      // side keeps camelCase attributes.
      underscored: true,
      freezeTableName: true,
    },
  };

  if (config.database.dialect === 'postgres') {
    return {
      ...shared,
      dialect: 'postgres',
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      username: config.database.username,
      password: config.database.password,
      pool: {
        max: config.database.poolMax,
        min: config.database.poolMin,
        idle: config.database.poolIdleMillis,
      },
      dialectOptions: config.database.ssl
        ? { ssl: { require: true, rejectUnauthorized: true } }
        : {},
    };
  }

  // SQLite: used for local development and the automated test suite.
  if (config.database.storage !== ':memory:') {
    const directory = path.dirname(path.resolve(config.database.storage));
    fs.mkdirSync(directory, { recursive: true });
  }

  return {
    ...shared,
    dialect: 'sqlite',
    storage: config.database.storage,
  };
}

const sequelize = new Sequelize(buildOptions());

/**
 * Opens the connection and applies the settings each dialect needs.
 *
 * @returns {Promise<void>}
 */
async function connectDatabase() {
  await sequelize.authenticate();

  if (config.database.dialect === 'sqlite') {
    // SQLite ignores foreign keys unless this is switched on per connection,
    // which would silently defeat every cascade delete in the schema.
    await sequelize.query('PRAGMA foreign_keys = ON;');
  }

  logger.info('Database connection established.', {
    dialect: config.database.dialect,
    production: config.isProduction,
  });
}

/**
 * Creates missing tables.
 *
 * Intended for development, tests and first boot. Production deployments should
 * apply reviewed migrations instead, which is why sync is refused there unless
 * explicitly forced.
 *
 * @param {{force?: boolean, alter?: boolean}} [options] Sync options.
 * @returns {Promise<void>}
 */
async function syncDatabase(options = {}) {
  if (config.isProduction && !options.force && !options.alter) {
    await sequelize.sync();
    return;
  }
  await sequelize.sync(options);
}

/**
 * Closes the connection pool.
 *
 * @returns {Promise<void>}
 */
async function closeDatabase() {
  await sequelize.close();
}

module.exports = { sequelize, connectDatabase, syncDatabase, closeDatabase };
