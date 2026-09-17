// NIAC Live Telemetry & Metrics Aggregator (Phase 1)
// Provides structured JSON logging with strict token redaction and sliding-window latency/capacity metrics.

export function getCapacityConfig(env = process.env) {
  const num = (val, fallback) => {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return Object.freeze({
    testPlayers: num(env.TEST_PLAYERS, 500),
    maxActivePlayers: num(env.MAX_ACTIVE_PLAYERS, 1500),
    queueDepthLimit: num(env.QUEUE_DEPTH_LIMIT, 1000),
    ackTimeoutMs: num(env.ACK_TIMEOUT_MS, 2000),
    drainTimeoutMs: num(env.DRAIN_TIMEOUT_MS, 3000),
    greenQueueMax: num(env.GREEN_QUEUE_MAX, 200),
    amberQueueMax: num(env.AMBER_QUEUE_MAX, 800),
    amberP95AckMs: num(env.AMBER_P95_ACK_MS, 1000),
    redP95AckMs: num(env.RED_P95_ACK_MS, 2000)
  });
}

const SENSITIVE_KEYS = new Set([
  'token', 'rawtoken', 'token_hash', 'tokenhash', 'recoverycode',
  'recovery_code', 'recovery_code_hash', 'recoverycodehash',
  'authorization', 'secret', 'password', 'apikey', 'service_role',
  'p_token_hash'
]);

export function redactSensitive(val) {
  if (val == null) return val;
  if (typeof val === 'string') {
    // Redact bearer tokens
    if (/^bearer\s+/i.test(val)) return 'Bearer [REDACTED]';
    // Redact recovery code patterns (4 hex - 4 hex e.g. AB12-CD34)
    if (/^[0-9A-F]{4}-[0-9A-F]{4}$/i.test(val)) return '[REDACTED_CODE]';
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(redactSensitive);
  }
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      const lower = k.toLowerCase().replace(/[-_]/g, '');
      if (SENSITIVE_KEYS.has(lower) || SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitive(v);
      }
    }
    return out;
  }
  return val;
}

export function formatLog(level, event, data = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level: String(level).toUpperCase(),
    event,
    ...redactSensitive(data)
  };
  return JSON.stringify(record);
}

export class MetricsAggregator {
  constructor(config = getCapacityConfig()) {
    this.config = config;
    this.latencies = []; // array of { at: number, ms: number }
    this.dbLatencies = [];
    this.reconnects = []; // timestamps
    this.errors = []; // { at: number, code: string }
    this.activeConnections = 0;
    this.queueDepth = 0;
    this.oldestQueuedAt = null;
    this.eventLoopLagMs = 0;
    this.windowMs = 60000; // 60s sliding window
    this._startLoopLagMonitor();
  }

  _startLoopLagMonitor() {
    let last = Date.now();
    this._lagTimer = setInterval(() => {
      const now = Date.now();
      const delta = now - last - 500;
      this.eventLoopLagMs = Math.max(0, delta);
      last = now;
    }, 500);
    if (this._lagTimer.unref) this._lagTimer.unref();
  }

  stop() {
    if (this._lagTimer) clearInterval(this._lagTimer);
  }

  reset() {
    this.latencies = [];
    this.dbLatencies = [];
    this.reconnects = [];
    this.errors = [];
    this.activeConnections = 0;
    this.queueDepth = 0;
    this.oldestQueuedAt = null;
    this.eventLoopLagMs = 0;
  }

  recordAckLatency(ms) {
    const now = Date.now();
    this.latencies.push({ at: now, ms: Math.max(0, ms) });
    this._prune(this.latencies, now);
  }

  recordDbLatency(ms) {
    const now = Date.now();
    this.dbLatencies.push({ at: now, ms: Math.max(0, ms) });
    this._prune(this.dbLatencies, now);
  }

  recordReconnect() {
    const now = Date.now();
    this.reconnects.push(now);
    this._pruneTimestamps(this.reconnects, now);
  }

  recordError(code = 'UNKNOWN_ERROR') {
    const now = Date.now();
    this.errors.push({ at: now, code });
    this._prune(this.errors, now);
  }

  setActiveConnections(count) {
    this.activeConnections = Math.max(0, count);
  }

  setQueueStatus(depth, oldestAt = null) {
    this.queueDepth = Math.max(0, depth);
    this.oldestQueuedAt = depth > 0 ? oldestAt : null;
  }

  setQueueDepth(depth) {
    this.queueDepth = Math.max(0, depth);
  }

  _prune(arr, now) {
    const cutoff = now - this.windowMs;
    while (arr.length > 0 && arr[0].at < cutoff) {
      arr.shift();
    }
    // Cap memory at 10,000 samples
    if (arr.length > 10000) arr.splice(0, arr.length - 10000);
  }

  _pruneTimestamps(arr, now) {
    const cutoff = now - this.windowMs;
    while (arr.length > 0 && arr[0] < cutoff) {
      arr.shift();
    }
  }

  _percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  }

  getSnapshot() {
    const now = Date.now();
    this._prune(this.latencies, now);
    this._prune(this.dbLatencies, now);
    this._prune(this.errors, now);
    this._pruneTimestamps(this.reconnects, now);

    const latValues = this.latencies.map(x => x.ms);
    const p50 = this._percentile(latValues, 50);
    const p95 = this._percentile(latValues, 95);
    const p99 = this._percentile(latValues, 99);

    const dbValues = this.dbLatencies.map(x => x.ms);
    const dbP95 = this._percentile(dbValues, 95);

    const totalOps = latValues.length + this.errors.length;
    const errorRate = totalOps > 0 ? (this.errors.length / totalOps) * 100 : 0;
    const oldestQueuedAgeMs = this.oldestQueuedAt ? Math.max(0, now - new Date(this.oldestQueuedAt).getTime()) : 0;

    // Status evaluation: green, amber, red
    let status = 'green';
    let reason = 'Healthy throughput and latency';

    if (
      this.queueDepth > this.config.amberQueueMax ||
      p95 > this.config.redP95AckMs ||
      errorRate >= 5 ||
      this.eventLoopLagMs > 150
    ) {
      status = 'red';
      reason = 'High error rate, queue saturation, or latency breach';
    } else if (
      this.queueDepth > this.config.greenQueueMax ||
      p95 > this.config.amberP95AckMs ||
      errorRate >= 1 ||
      this.eventLoopLagMs > 50
    ) {
      status = 'amber';
      reason = 'Elevated latency or queue depth';
    }

    return {
      timestamp: new Date().toISOString(),
      status,
      statusReason: reason,
      activeConnections: this.activeConnections,
      reconnectCountWindow: this.reconnects.length,
      queueDepth: this.queueDepth,
      oldestQueuedAgeMs,
      samples: latValues.length,
      p50AckMs: Math.round(p50),
      p95AckMs: Math.round(p95),
      p99AckMs: Math.round(p99),
      dbP95Ms: Math.round(dbP95),
      errorCount: this.errors.length,
      errorRatePercent: Number(errorRate.toFixed(1)),
      eventLoopLagMs: Math.round(this.eventLoopLagMs),
      limits: {
        testPlayers: this.config.testPlayers,
        maxActivePlayers: this.config.maxActivePlayers,
        queueDepthLimit: this.config.queueDepthLimit
      }
    };
  }
}

export const globalMetrics = new MetricsAggregator();
