import { parentPort } from 'node:worker_threads';
import { runTranslationPipeline } from './pipeline';
import type { TranslationJob } from './pipeline';
import type { KeyAttemptEvent } from '../infrastructure/ai/types';
import type { WorkerReply } from './pool';

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

const port = parentPort;

/** An error as the pipeline may raise it: an application error or a provider one. */
type PipelineFailure = Error & { kind?: string; code?: string; statusCode?: number };

port.on('message', async (message: { taskId: string; job: TranslationJob }) => {
  const { taskId, job } = message;
  const attempts: KeyAttemptEvent[] = [];

  try {
    const result = await runTranslationPipeline(job, (event) => attempts.push(event));
    port.postMessage({ taskId, ok: true, result, attempts } satisfies WorkerReply);
  } catch (error) {
    const failure = error as PipelineFailure;
    port.postMessage({
      taskId,
      ok: false,
      attempts,
      error: {
        message: failure.message,
        kind: failure.kind ?? null,
        code: failure.code ?? null,
        statusCode: failure.statusCode ?? null,
      },
    } satisfies WorkerReply);
  }
});
