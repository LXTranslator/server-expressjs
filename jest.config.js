/**
 * Jest configuration for the LXTranslator server.
 *
 * Tests run against an isolated in memory SQLite database so that the suite is
 * executable with zero configuration, matching the "runs without secrets"
 * requirement of the project.
 *
 * The suite runs the TypeScript sources directly. SWC strips the types and
 * emits CommonJS, the same module format `tsc` builds, so a test exercises the
 * code that ships without waiting on a build. It does not type check: that is
 * `npm run typecheck`, which is part of `npm test`.
 *
 * This file stays JavaScript because Jest reads it before any transform is in
 * place, and a TypeScript config would need a TypeScript runtime just to start.
 */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setupEnv.ts'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
        module: { type: 'commonjs' },
      },
    ],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/types/**'],
  testTimeout: 30000,
  verbose: true,
};
