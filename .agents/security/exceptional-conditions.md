---
name: Mishandling of Exceptional Conditions
description: Handle every error without leaking internal detail to clients in the LXTranslator server.
---

# Mishandling of Exceptional Conditions

## The rule

Only errors the application raised deliberately are described to a client.
Anything else becomes a generic message, with the full detail logged server
side.

```js
if (error instanceof AppError) {
  // Written to be read by a client.
  res.status(error.statusCode).json({ error: { code, message } });
} else {
  // Could carry a table name, a file path, or a fragment of a query.
  logger.error('Unhandled error.', { message, stack });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
}
```

## Rules

1. **Raise a typed error from `src/core/errors.js`.** Never throw a bare
   `Error` from a service and expect a useful status code.
2. **Never put an internal message in an `AppError`.** Its text goes straight to
   the client. Database messages, stack traces and vendor response bodies do not
   belong there.
3. **A vendor error body is logged, never returned.** The provider adapters read
   the body for the operator log and raise a categorised `ProviderError` with a
   message of our own wording.
4. **Async handlers are wrapped.** `asyncHandler` forwards a rejection into the
   Express error pipeline instead of leaving it as an unhandled rejection.
5. **Worker threads post structured errors, not error objects.** A stack trace
   crossing the thread boundary can carry file paths, so
   `translation.worker.js` posts a plain description.
6. **File processing never rejects.** It records `FAILED` and a client safe
   message on the file, because the HTTP response has usually already been sent.
7. **Unhandled rejections and uncaught exceptions are fatal.** They are logged
   and the process exits, because continuing in an unknown state is worse than
   restarting.
8. **Stack traces appear in a response only outside production**, and only as a
   `debug` field.

## When adding a failure path

Ask what the client learns from the message. If the answer includes anything
about the schema, the filesystem or a third party, rewrite it.
