import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import config from '../config';
import logger from '../core/logger';
import { ServiceUnavailableError } from '../core/errors';
import type { KeyAttemptEvent } from '../infrastructure/ai/types';
import type { PipelineResult, TranslationJob } from './pipeline';

/**
 * Worker thread pool for the translation pipeline.
 *
 * Uploading a locale file kicks off JSON parsing, hashing of every string and a
 * long sequence of provider calls. Running that on the main thread would stall
 * every other request for the duration. The pool keeps a fixed set of threads,
 * queues jobs, and enforces a per task timeout so a hung vendor call cannot
 * occupy a thread forever.
 *
 * Concurrency is bounded on purpose: an unbounded pool would let a burst of
 * uploads exhaust memory and vendor quota at the same time.
 */

/**
 * The worker entry point. The compiled build runs `translation.worker.js`; the
 * test suite and `npm run dev` run the TypeScript source, which a worker thread
 * can only load through the `tsx` loader.
 */
const COMPILED_WORKER_PATH = path.join(__dirname, 'translation.worker.js');
const SOURCE_WORKER_PATH = path.join(__dirname, 'translation.worker.ts');
const RUNS_FROM_SOURCE = !fs.existsSync(COMPILED_WORKER_PATH);
const WORKER_PATH = RUNS_FROM_SOURCE ? SOURCE_WORKER_PATH : COMPILED_WORKER_PATH;
const WORKER_EXEC_ARGV = RUNS_FROM_SOURCE ? ['--import', 'tsx'] : [];

/** What a worker posts back when a task ends. */
type WorkerReply =
  | { taskId: string; ok: true; result: PipelineResult; attempts: KeyAttemptEvent[] }
  | {
      taskId: string;
      ok: false;
      attempts?: KeyAttemptEvent[];
      error?: { message?: string; kind?: string | null; code?: string | null; statusCode?: number | null };
    };

/** A failed task, carrying the failure category and every credential tried. */
type TranslationJobError = Error & { kind: string | null; attempts: KeyAttemptEvent[] };

/** One worker thread and what it is doing. */
interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  taskId: string | null;
}

/** A job waiting for a free worker. */
interface QueuedTask {
  taskId: string;
  job: TranslationJob;
}

/** What one finished task resolves to. */
interface TaskOutcome {
  result: PipelineResult;
  attempts: KeyAttemptEvent[];
}

/** The promise callbacks and deadline of a task in flight. */
interface PendingTask {
  resolve: (outcome: TaskOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class TranslationPool {
  /** Threads kept alive. */
  readonly size: number;

  /** Time budget for one task. */
  readonly taskTimeoutMs: number;

  readonly workers: WorkerSlot[];

  readonly queue: QueuedTask[];

  readonly pending: Map<string, PendingTask>;

  started: boolean;

  draining: boolean;

  /**
   * @param {{size?: number, taskTimeoutMs?: number}} [options] Pool options.
   */
  constructor(options: { size?: number; taskTimeoutMs?: number; } = {}) {
    this.size = options.size ?? config.workers.poolSize;
    this.taskTimeoutMs = options.taskTimeoutMs ?? config.workers.taskTimeoutMs;

    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.started = false;
    this.draining = false;
  }

  /**
   * Spawns the worker threads.
   *
   * @returns {void}
   */
  start(): void {
    if (this.started) return;
    for (let index = 0; index < this.size; index += 1) {
      this.spawn();
    }
    this.started = true;
    logger.info('Translation worker pool started.', { size: this.size });
  }

  /**
   * Creates one worker and wires its lifecycle handlers.
   *
   * @returns {WorkerSlot} The pool slot for the new worker.
   */
  spawn(): WorkerSlot {
    const worker = new Worker(WORKER_PATH, { execArgv: WORKER_EXEC_ARGV });
    const slot: WorkerSlot = { worker, busy: false, taskId: null };

    worker.on('message', (message: WorkerReply) => {
      this.settle(message);
      slot.busy = false;
      slot.taskId = null;
      this.drain();
    });

    worker.on('error', (error) => {
      logger.error('Translation worker crashed.', { error });
      if (slot.taskId !== null) {
        this.settle({
          taskId: slot.taskId,
          ok: false,
          error: { message: 'The translation worker stopped unexpectedly.' },
        });
      }
      this.replace(slot);
    });

    worker.on('exit', (code) => {
      if (code !== 0 && !this.draining) {
        logger.warn('Translation worker exited unexpectedly.', { code });
        this.replace(slot);
      }
    });

    this.workers.push(slot);
    return slot;
  }

  /**
   * Replaces a dead worker so the pool keeps its configured capacity.
   *
   * @param {object} slot The slot holding the dead worker.
   * @returns {void}
   */
  replace(slot: WorkerSlot): void {
    const index = this.workers.indexOf(slot);
    if (index !== -1) this.workers.splice(index, 1);
    if (!this.draining) {
      this.spawn();
      this.drain();
    }
  }

  /**
   * Resolves or rejects the promise belonging to a completed task.
   *
   * @param {object} message Message posted by a worker.
   * @returns {void}
   */
  settle(message: WorkerReply): void {
    const entry = this.pending.get(message.taskId);
    if (entry === undefined) return;

    clearTimeout(entry.timer);
    this.pending.delete(message.taskId);

    if (message.ok) {
      entry.resolve({ result: message.result, attempts: message.attempts ?? [] });
      return;
    }

    const error: TranslationJobError = Object.assign(
      new Error(message.error?.message ?? 'The translation job failed.'),
      { kind: message.error?.kind ?? null, attempts: message.attempts ?? [] },
    );
    entry.reject(error);
  }

  /**
   * Assigns queued jobs to idle workers.
   *
   * @returns {void}
   */
  drain(): void {
    while (this.queue.length > 0) {
      const slot = this.workers.find((candidate) => !candidate.busy);
      if (slot === undefined) return;

      const task = this.queue.shift() as QueuedTask;
      slot.busy = true;
      slot.taskId = task.taskId;
      slot.worker.postMessage({ taskId: task.taskId, job: task.job });
    }
  }

  /**
   * Queues a translation job.
   *
   * @param {object} job Job descriptor consumed by the pipeline.
   * @returns {Promise<TaskOutcome>} Pipeline output.
   * @throws {ServiceUnavailableError} When the pool is shutting down.
   */
  run(job: TranslationJob): Promise<TaskOutcome> {
    if (this.draining) {
      return Promise.reject(new ServiceUnavailableError('The server is shutting down.'));
    }
    if (!this.started) this.start();

    const taskId = crypto.randomUUID();

    return new Promise<TaskOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        reject(new ServiceUnavailableError('The translation job exceeded its time budget.'));
      }, this.taskTimeoutMs);

      // `unref` keeps a long timeout from holding the process open on shutdown.
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(taskId, { resolve, reject, timer });
      this.queue.push({ taskId, job });
      this.drain();
    });
  }

  /**
   * Stops every worker and fails anything still outstanding.
   *
   * @returns {Promise<void>}
   */
  async shutdown(): Promise<void> {
    this.draining = true;

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ServiceUnavailableError('The server is shutting down.'));
    }
    this.pending.clear();
    this.queue.length = 0;

    await Promise.all(this.workers.map((slot) => slot.worker.terminate()));
    this.workers.length = 0;
    this.started = false;
  }
}

/** Process wide pool. One pool per process keeps thread count predictable. */
const translationPool = new TranslationPool();

export { TranslationPool, translationPool };
export type { WorkerReply, TranslationJobError, TaskOutcome };
