// scripts/load/collect.mjs
// Periodically samples gateway telemetry, health endpoints, and capacity indicators during a load tier.

export class MetricsCollector {
  constructor(options = {}) {
    this.gatewayUrl = (options.gatewayUrl || 'https://92.4.146.91.sslip.io').replace(/\/$/, '');
    this.intervalMs = options.intervalMs || 1000;
    this.samples = [];
    this.timer = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  async sample() {
    try {
      const res = await fetch(`${this.gatewayUrl}/gateway/health`, {
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        const data = await res.json();
        const entry = {
          timestamp: Date.now(),
          connectedClients: data.connectedClients,
          queueDepth: data.queueDepth,
          totalQueued: data.totalQueued,
          durableSinkConfigured: data.durableSinkConfigured,
          eventLoopLagMs: data.capacity?.eventLoopLagMs ?? 0,
          p50AckMs: data.capacity?.p50AckMs ?? 0,
          p95AckMs: data.capacity?.p95AckMs ?? 0,
          errorCount: data.capacity?.errorCount ?? 0,
          errorRatePercent: data.capacity?.errorRatePercent ?? 0,
          capacityStatus: data.capacity?.status ?? 'unknown'
        };
        this.samples.push(entry);
      }
    } catch (err) {
      this.samples.push({
        timestamp: Date.now(),
        fetchError: err.message
      });
    }
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSummary() {
    if (!this.samples.length) return null;
    const valid = this.samples.filter(s => !s.fetchError);
    if (!valid.length) return { error: 'No successful health samples' };

    const maxQueue = Math.max(...valid.map(s => s.queueDepth));
    const maxLag = Math.max(...valid.map(s => s.eventLoopLagMs));
    const maxErrors = Math.max(...valid.map(s => s.errorCount));
    const worstStatus = valid.some(s => s.capacityStatus === 'red') ? 'red' : valid.some(s => s.capacityStatus === 'amber') ? 'amber' : 'green';

    return {
      sampleCount: valid.length,
      maxQueueDepth: maxQueue,
      maxEventLoopLagMs: maxLag,
      peakErrorCount: maxErrors,
      worstCapacityStatus: worstStatus,
      lastSample: valid[valid.length - 1]
    };
  }
}
