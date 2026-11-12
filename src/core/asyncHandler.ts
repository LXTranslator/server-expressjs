import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** A request handler that may return a promise. */
type AsyncRequestHandler<P = Record<string, string>> = (
  req: Request<P>,
  res: Response,
  next: NextFunction,
) => unknown;

/**
 * Wraps an async route handler so a rejected promise reaches the Express error
 * pipeline instead of surfacing as an unhandled rejection.
 *
 * Express 5 forwards rejections automatically, but wrapping explicitly keeps
 * the behaviour obvious at every call site and independent of the framework
 * major version.
 *
 * @param {Function} handler Async request handler.
 * @returns {Function} Express compatible handler.
 */
function asyncHandler<P = Record<string, string>>(handler: AsyncRequestHandler<P>): RequestHandler<P> {
  return function wrapped(req: Request<P>, res: Response, next: NextFunction): void {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export default asyncHandler;
export type { AsyncRequestHandler };
