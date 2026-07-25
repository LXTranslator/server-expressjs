/**
 * Jest configuration for the LXTranslator server.
 *
 * Tests run against an isolated in memory SQLite database so that the suite is
 * executable with zero configuration, matching the "runs without secrets"
 * requirement of the project.
 */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/index.js'],
  testTimeout: 30000,
  verbose: true,
};
