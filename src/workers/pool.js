'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const config = require('../config');
const logger = require('../core/logger');
const { ServiceUnavailableError } = require('../core/errors');

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

const WORKER_PATH = path.join(__dirname, 'translation.worker.js');

class TranslationPool {
  /**
   * @param {{size?: number, taskTimeoutMs?: number}} [options] Pool options.
   */
  constructor(options = {}) {
    this.size = options.size ?? config.workers.poolSize;
    this.taskTimeoutMs = options.taskTimeoutMs ?? config.workers.taskTimeoutMs;

    /** @type {Array<{worker: Worker, busy: boolean}>} */
    this.workers = [];
    /** @type {Array<object>} */
    this.queue = [];
    /** @type {Map<string, object>} */
    this.pending = new Map();
    this.started = false;
    this.draining = false;
  }

  /**
   * Spawns the worker threads.
   *
   * @returns {void}
   */
  start() {
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
   * @returns {object} The pool slot for the new worker.
   */
  spawn() {
    const worker = new Worker(WORKER_PATH);
    const slot = { worker, busy: false, taskId: null };

    worker.on('message', (message) => {
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
  replace(slot) {
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
  settle(message) {
    const entry = this.pending.get(message.taskId);
    if (entry === undefined) return;

    clearTimeout(entry.timer);
    this.pending.delete(message.taskId);

    if (message.ok) {
      entry.resolve({ result: message.result, attempts: message.attempts ?? [] });
      return;
    }

    const error = new Error(message.error?.message ?? 'The translation job failed.');
    error.kind = message.error?.kind ?? null;
    error.attempts = message.attempts ?? [];
    entry.reject(error);
  }

  /**
   * Assigns queued jobs to idle workers.
   *
   * @returns {void}
   */
  drain() {
    while (this.queue.length > 0) {
      const slot = this.workers.find((candidate) => !candidate.busy);
      if (slot === undefined) return;

      const task = this.queue.shift();
      slot.busy = true;
      slot.taskId = task.taskId;
      slot.worker.postMessage({ taskId: task.taskId, job: task.job });
    }
  }

  /**
   * Queues a translation job.
   *
   * @param {object} job Job descriptor consumed by the pipeline.
   * @returns {Promise<{result: object, attempts: object[]}>} Pipeline output.
   * @throws {ServiceUnavailableError} When the pool is shutting down.
   */
  run(job) {
    if (this.draining) {
      return Promise.reject(new ServiceUnavailableError('The server is shutting down.'));
    }
    if (!this.started) this.start();

    const taskId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
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
  async shutdown() {
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

module.exports = { TranslationPool, translationPool };
