# 0.26.0

2026-11-12. The server is now written in strict TypeScript, and every dependency is on
its latest release.

The API has not changed. Every response, status code, error message and table
definition is what it was at 0.25.1, and the 600 tests that pinned them still pass.
What changed is how the server is built and started: there is now a compile step, so a
deployment runs `dist/index.js` instead of `src/index.js`. That is why this is a minor
version rather than a patch.

## Added

- `tsconfig.json`, strict, targeting `ES2022` with `NodeNext` modules, compiling `src/`
  into `dist/` with declarations and source maps. `tsconfig.test.json` extends it so the
  tests are type checked too.
- `npm run build` (`tsc`) and `npm run typecheck` (`tsc -p tsconfig.test.json`).
- Types for what had none: attributes, instances and public JSON for every model, the
  provider neutral AI shapes in `src/infrastructure/ai/types.ts`, the OAuth adapter in
  `src/infrastructure/oauth/types.ts`, the chat tool context and result in
  `src/modules/chat/chat.types.ts`, and the request fields the middleware sets in
  `src/types/express.d.ts`.
- `defineTool` in `src/modules/chat/tools/shared.ts`. It returns the tool unchanged and
  exists so each handler's arguments are typed from the zod schema that validates them.
- Development dependencies: `typescript` 7, `tsx`, `@swc/core`, `@swc/jest` and the
  `@types` packages for Node, Express, CORS, jsonwebtoken, multer, nodemailer,
  supertest and Jest.

## Changed

- Every file under `src/` and `tests/` is `.ts`, and uses `import` and `export` instead
  of `require` and `module.exports`. The compiled output is still CommonJS.
- `package.json`: `main` and `types` point at `dist/`. `npm start` builds and then runs
  the compiled server, so `npm install && npm start` still works on a clean clone.
  `npm run dev` runs the sources through `tsx watch`. `npm test` type checks and then
  runs Jest.
- Jest runs the TypeScript sources and tests through `@swc/jest`. `ts-jest` cannot be
  used because TypeScript 7 no longer ships the JavaScript compiler API it needs.
- The translation worker runs the compiled `translation.worker.js` when it exists and
  the `.ts` source through `tsx` otherwise, which is what lets the tests run without a
  build.
- The Dockerfile compiles in its own stage. The runtime image carries `dist/` and no
  compiler, and starts `node dist/index.js`.
- Dependencies moved to their latest releases: `dotenv` 18 (a major), `express` 5.3.0,
  `express-rate-limit` 8.7.4, `multer` 2.5.0, `nodemailer` 10.5.0, `zod` 4.6.7, `pg`
  8.23.1, `jest` 30.5.2 and `supertest` 7.3.2.
- The configuration loads `.env` through `import 'dotenv/config'`, which is quiet by
  default in `dotenv` 18, exactly as `config({ quiet: true })` was.
- Inside the file routes, the loaded file record moved from `req.file` to
  `req.fileRecord`, because multer owns `req.file`. No client can see this.

## Security

`npm audit` reports **0 vulnerabilities**. The dependency updates and `npm audit fix`
cleared `body-parser`, `qs` and `undici`. The advisories left in Jest's own tree are held
off through `overrides` for `glob`, `minimatch` and `deepmerge`, recorded in
`.agents/security/supply-chain.md`.

## Notes

**For a deployment:** build before starting. The Docker image does this itself. Anything
that ran `node src/index.js` directly should run `npm run build` and then
`node dist/index.js`, or simply `npm start`.

**For a contributor:** `npm test` fails on a type error before a single test runs, since
`@swc/jest` strips types without checking them. Response bodies in tests are read through
`ApiJson`, a loose record, the way a client reads them.
