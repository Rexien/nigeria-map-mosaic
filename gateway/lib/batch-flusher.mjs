// NIAC Live Batch Flusher (Phase 3)
// Asynchronously drains answers from SQLite WAL queue to Supabase with ON CONFLICT DO NOTHING.

import { globalMetrics, formatLog } from '../../lib/telemetry.mjs';

export class BatchFlusher {
  constructor(queue, options = {}) {
    this.queue = queue;
    this.options = {
      flushIntervalMs: options.flushIntervalMs || 150,
      batchSize: options.batchSize || 100,
      maxRetries: options.maxRetries || 5,
      sink: options.sink || null,
      ...options
    };

    this.timer = null;
    this.isRunning = false;
    this.isFlushing = false;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this._scheduleNext();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  _scheduleNext() {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      await this.flushOnce();
      this._scheduleNext();
    }, this.options.flushIntervalMs);
  }

  async flushOnce() {
    if (this.isFlushing) return 0;
    this.isFlushing = true;

    try {
      const items = this.queue.getQueuedBatch(this.options.batchSize);
      if (!items || items.length === 0) {
        globalMetrics.setQueueDepth(0);
        return 0;
      }

      globalMetrics.setQueueDepth(this.queue.getQueueDepth());

      if (typeof this.options.sink !== 'function') throw new Error('Durable answer sink is not configured');
      const t0 = Date.now();
      await this.options.sink(items);
      const durationMs = Date.now() - t0;
      globalMetrics.recordDbLatency(durationMs);

      // Mark flushed in SQLite
      const answerIds = items.map(x => x.answer_id);
      this.queue.markFlushed(answerIds);

      const remaining = this.queue.getQueueDepth();
      globalMetrics.setQueueDepth(remaining);

      return answerIds.length;
    } catch (err) {
      globalMetrics.recordError();
      console.error(formatLog('error', 'batch_flusher_error', {
        error: err.message
      }));
      return 0;
    } finally {
      this.isFlushing = false;
    }
  }

  async drainQueue(timeoutMs = 3000) {
    // Flush any pending in-memory group commits first
    this.queue.flushNow();

    const start = Date.now();
    while (this.queue.getQueueDepth() > 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Queue drain timeout exceeded (${timeoutMs}ms). Remaining depth: ${this.queue.getQueueDepth()}`);
      }
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - start));
      let timer;
      try {
        // Keep the active flush locked even when this caller times out.
        await Promise.race([
          this.flushOnce(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Queue drain timeout exceeded (${timeoutMs}ms)`)), remainingMs);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (this.queue.getQueueDepth() > 0) {
        await new Promise(r => setTimeout(r, 20));
      }
    }

    return true;
  }
}
