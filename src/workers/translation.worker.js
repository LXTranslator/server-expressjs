'use strict';

const { parentPort } = require('node:worker_threads');
const { runTranslationPipeline } = require('./pipeline');

/**
 * Worker thread entry point.
 *
 * The thread stays alive across jobs and handles one message at a time. Each
 * message is a translation job; each reply is either a result or a client safe
 * error description. Raw error objects are never posted back, because a stack
 * trace can carry file paths and, in the worst case, fragments of a credential.
 */

if (parentPort === null) {
  throw new Error('translation.worker.js must be started as a worker thread.');
}

parentPort.on('message', async (message) => {
  const { taskId, job } = message;
  const attempts = [];

  try {
    const result = await runTranslationPipeline(job, (event) => attempts.push(event));
    parentPort.postMessage({ taskId, ok: true, result, attempts });
  } catch (error) {
    parentPort.postMessage({
      taskId,
      ok: false,
      attempts,
      error: {
        message: error.message,
        kind: error.kind ?? null,
        code: error.code ?? null,
        statusCode: error.statusCode ?? null,
      },
    });
  }
});
